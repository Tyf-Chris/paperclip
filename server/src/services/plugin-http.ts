import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

// ---------------------------------------------------------------------------
// SSRF protection for plugin HTTP fetch
// ---------------------------------------------------------------------------

/** Maximum time (ms) a plugin fetch request may take before being aborted. */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/** Only these protocols are allowed for plugin HTTP requests. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Only public unicast addresses may receive plugin HTTP requests. */
function isPublicAddress(address: string): boolean {
  try {
    // process() converts both dotted and hexadecimal IPv4-mapped IPv6 to IPv4.
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

/**
 * Validate a URL for plugin fetch: protocol whitelist + private IP blocking.
 *
 * SSRF Prevention Strategy:
 * 1. Parse and validate the URL syntax
 * 2. Enforce protocol whitelist (http/https only)
 * 3. Resolve the hostname to IP(s) via DNS
 * 4. Select an address in the public unicast range
 * 5. Connect directly to that address without a second DNS lookup
 *
 * This prevents DNS rebinding attacks where an attacker controls DNS to
 * resolve to a safe IP during validation, then to a private IP when fetch() runs.
 *
 * @returns Request-routing metadata used to connect directly to the resolved IP
 *          while preserving the original hostname for HTTP Host and TLS SNI.
 */
interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

async function validateAndResolveFetchUrl(urlString: string): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`,
    );
  }

  // Resolve the hostname to an IP and check for private ranges.
  // We pin the resolved IP into the URL to eliminate the TOCTOU window
  // between DNS resolution here and the second resolution fetch() would do.
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  // when DNS is misconfigured or unresponsive.
  const dnsPromise = dnsLookup(originalHostname, { all: true });
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    dnsTimeout = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${originalHostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    // Filter to only non-private IPs instead of rejecting the entire request
    // when some IPs are private. This handles multi-homed hosts that resolve
    // to both private and public addresses.
    const safeResults = results.filter((entry) => isPublicAddress(entry.address));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: parsed.protocol === "https:" && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls: parsed.protocol === "https:",
    };
  } catch (err) {
    // Re-throw our own errors; wrap DNS failures
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  } finally {
    clearTimeout(dnsTimeout);
  }
}

function buildPinnedRequestOptions(
  target: ValidatedFetchTarget,
  init?: RequestInit,
): { options: HttpRequestOptions & { servername?: string }; body: string | undefined } {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  const body = init?.body === undefined || init?.body === null
    ? undefined
    : typeof init.body === "string"
      ? init.body
      : String(init.body);

  headers.set("Host", target.hostHeader);
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  const pathname = `${target.parsedUrl.pathname}${target.parsedUrl.search}`;
  const auth = target.parsedUrl.username || target.parsedUrl.password
    ? `${decodeURIComponent(target.parsedUrl.username)}:${decodeURIComponent(target.parsedUrl.password)}`
    : undefined;

  return {
    options: {
      protocol: target.parsedUrl.protocol,
      host: target.resolvedAddress,
      port: target.parsedUrl.port
        ? Number(target.parsedUrl.port)
        : target.useTls
          ? 443
          : 80,
      path: pathname,
      method,
      headers: Object.fromEntries(headers.entries()),
      auth,
      servername: target.tlsServername,
    },
    body,
  };
}

async function executePinnedHttpRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const { options, body } = buildPinnedRequestOptions(target, init);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const requestFn = target.useTls ? httpsRequest : httpRequest;
    const req = requestFn({ ...options, signal }, resolve);

    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });

  const MAX_RESPONSE_BODY_BYTES = 200 * 1024 * 1024; // 200 MB
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        chunks.length = 0;
        response.destroy(new Error(`Response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buf);
    });
    response.on("end", resolve);
    response.on("error", reject);
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  return {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}

/** Plugin HTTP capability transport. Redirects are returned without following them. */
export async function fetchPluginHttp(url: string, init?: RequestInit) {
  const target = await validateAndResolveFetchUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);
  try {
    return await executePinnedHttpRequest(target, init, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
