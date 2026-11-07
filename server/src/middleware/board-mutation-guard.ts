import type { Request, RequestHandler } from "express";
import { trustedRequestHost } from "./private-hostname-guard.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function trustedOriginsForRequest(req: Request) {
  // Cookies are not port-scoped. A separate local development service must not
  // receive mutation authority over this listener's authenticated sessions.
  const origins = new Set<string>();
  const host = trustedRequestHost(req);
  if (host) {
    for (const protocol of ["http", "https"]) {
      const origin = parseOrigin(`${protocol}://${host}`);
      if (origin) origins.add(origin);
    }
  }
  // Behind some reverse proxies the Host / X-Forwarded-Host header may
  // not match the public URL (for example when TLS terminates at the
  // edge and the inbound Host is an internal service name). Trust the
  // explicitly-configured PAPERCLIP_PUBLIC_URL when it's set.
  const publicUrl = parseOrigin(process.env.PAPERCLIP_PUBLIC_URL?.trim());
  if (publicUrl) origins.add(publicUrl);
  return origins;
}

/**
 * Return the browser origin only when it is the same origin Paperclip's CSRF
 * guard accepts for this request. Callers may use this as browser-reachability
 * evidence, but must still apply any protocol-specific constraints (for
 * example OAuth requiring HTTPS outside loopback).
 */
export function trustedBoardMutationOrigin(req: Request): string | null {
  const allowedOrigins = trustedOriginsForRequest(req);
  const originHeader = req.header("origin");
  if (originHeader !== undefined) {
    const origin = parseOrigin(originHeader);
    return origin && allowedOrigins.has(origin) ? origin : null;
  }

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return refererOrigin;

  return null;
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local CLI calls have no browser origin or site metadata. Node's fetch
    // does send Sec-Fetch-Mode, so that header alone is not browser evidence.
    if (
      req.actor.source === "local_implicit"
      && req.header("origin") === undefined
      && req.header("referer") === undefined
      && req.header("sec-fetch-site") === undefined
    ) {
      next();
      return;
    }

    // These callers carry explicit credentials rather than ambient local or
    // browser-session authority. Their protocol may omit browser headers.
    if (
      req.actor.source === "board_key"
      || req.actor.source === "mcp_oauth"
      || req.actor.source === "cloud_tenant"
      || req.actor.source === "cloud_control"
    ) {
      next();
      return;
    }

    if (!trustedBoardMutationOrigin(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
