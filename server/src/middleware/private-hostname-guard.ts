import type { Request, RequestHandler } from "express";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseHost(value: string | undefined): string | null {
  const raw = value?.trim();
  // A Host is an authority, not a URL. Reject userinfo, paths, lists, and
  // escaped delimiters before URL parsing can normalize them into a safe host.
  if (!raw || !/^(?:\[[\da-f:.]+\]|[a-z\d._-]+)(?::\d+)?$/i.test(raw)) return null;

  try {
    const parsed = new URL(`http://${raw}`);
    const explicitPort = /:(\d+)$/.exec(raw)?.[1];
    // Keep an explicit port 80: the request may use HTTPS, whose default port
    // differs from the HTTP URL used only to validate the authority here.
    return parsed.hostname + (explicitPort === undefined ? "" : `:${Number(explicitPort)}`);
  } catch {
    return null;
  }
}

/** Use forwarded authority only when the operator trusts the immediate peer. */
export function trustedRequestHost(req: Request): string | null {
  const host = parseHost(req.header("host"));
  if (!host) return null;

  const remoteAddress = req.socket?.remoteAddress;
  const trustProxy = req.app?.get("trust proxy fn") as
    | ((address: string, hop: number) => boolean)
    | undefined;
  const forwardedHost = req.header("x-forwarded-host");
  if (forwardedHost !== undefined && remoteAddress && typeof trustProxy === "function" && trustProxy(remoteAddress, 0)) {
    // The trusted proxy must supply one authority. Do not accept a list that
    // could retain a client-supplied value before a proxy's appended value.
    return parseHost(forwardedHost);
  }

  return host;
}

function extractHostname(req: Request): string | null {
  const host = trustedRequestHost(req);
  if (!host) return null;
  return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = opts.bindHost.trim().toLowerCase();
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

// The hostname comes from the request Host header, so an unauthenticated
// requester controls it. Never put that value into the guidance command. An
// operator or an agent can paste the guidance into a shell, and that outer
// shell evaluates a backtick, `$( )`, or `$NAME` span in the host before any
// CLI receives argv. A direct-exec form such as `npx` does not stop the
// outer shell. Emit a static `<host>` placeholder and do not echo the raw request
// value. The operator supplies the real hostname.
const BLOCKED_HOSTNAME_MESSAGE =
  "This hostname is not allowed for this Paperclip instance. " +
  "If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    const hostname = extractHostname(req);
    const directHost = parseHost(req.header("host"));
    const directHostname = directHost
      ? new URL(`http://${directHost}`).hostname.replace(/^\[|\]$/g, "").toLowerCase()
      : null;
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (!hostname || !directHostname) {
      const error = "Missing or invalid Host header. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    // A loopback proxy and a rebinding browser can share the same peer address.
    // Forwarded authority must never promote an unapproved actual Host. A
    // legitimate proxy must use an allowed upstream Host as well as an allowed
    // forwarded hostname.
    if ((isLoopbackHostname(directHostname) || allowSet.has(directHostname))
      && (isLoopbackHostname(hostname) || allowSet.has(hostname))) {
      next();
      return;
    }

    const error = BLOCKED_HOSTNAME_MESSAGE;
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
