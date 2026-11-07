import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const servers: Server[] = [];
const originalPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;

afterEach(async () => {
  if (originalPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
  else process.env.PAPERCLIP_PUBLIC_URL = originalPublicUrl;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer(options: {
  trustedProxy?: boolean;
  allowedHostnames?: string[];
  source?: "local_implicit" | "session" | "board_key";
} = {}) {
  delete process.env.PAPERCLIP_PUBLIC_URL;
  const app = express();
  if (options.trustedProxy) app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use(privateHostnameGuard({
    enabled: true,
    allowedHostnames: options.allowedHostnames ?? [],
    bindHost: "127.0.0.1",
  }));
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "local-board", source: options.source ?? "local_implicit" };
    next();
  });
  app.use(boardMutationGuard());
  let mutations = 0;
  app.post("/api/mutate", (_req, res) => {
    mutations += 1;
    res.status(204).end();
  });
  app.get("/api/read", (req, res) => res.json({ host: req.header("host") }));

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    mutations: () => mutations,
    async request(headers: Record<string, string> = {}, method: "POST" | "GET" = "POST") {
      const url = `${baseUrl}/api/${method === "GET" ? "read" : "mutate"}`;
      // Node fetch ignores Host overrides. Use a real HTTP request for the
      // authority cases so they exercise the header a rebinding browser sends.
      if (Object.keys(headers).some((name) => name.toLowerCase() === "host")) {
        return new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = httpRequest(url, { method, headers }, (response) => {
            response.setEncoding("utf8");
            let body = "";
            response.on("data", (chunk: string) => { body += chunk; });
            response.on("end", () => resolve({ status: response.statusCode!, body }));
            response.on("error", reject);
          });
          request.on("error", reject);
          request.end();
        });
      }
      const response = await fetch(url, {
        method,
        headers,
      });
      // Drain each response so shutdown also tests that no connection is left active.
      return { status: response.status, body: await response.text() };
    },
  };
}

describe("local HTTP security integration", () => {
  it("exercises a real listener with the caller's Host header", async () => {
    const instance = await startServer();
    const result = await instance.request({ Host: "localhost:3100" }, "GET");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ host: "localhost:3100" });
  });

  it("blocks a DNS-rebinding authority even with a forged forwarded localhost", async () => {
    const instance = await startServer();
    const result = await instance.request({
      Host: "attacker.invalid:3100",
      "X-Forwarded-Host": "localhost:3100",
      Origin: "http://attacker.invalid:3100",
    });
    expect(result.status).toBe(403);
    expect(instance.mutations()).toBe(0);
    expect(result.body).not.toContain("attacker.invalid");
  });

  it.each([
    "attacker.invalid@localhost:3100",
    "localhost:3100/foreign",
    "localhost:3100?foreign",
    "localhost:3100,attacker.invalid",
    "localhost:65536",
  ])("rejects a malformed Host authority: %s", async (host) => {
    const instance = await startServer();
    expect((await instance.request({ Host: host })).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("preserves IPv6 loopback browser requests", async () => {
    const instance = await startServer();
    expect((await instance.request({ Host: "[::1]:3100", Origin: "http://[::1]:3100" })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("uses an allowed forwarded hostname from a configured trusted proxy", async () => {
    const instance = await startServer({ trustedProxy: true, allowedHostnames: ["work.tail.example"] });
    expect((await instance.request({
      "X-Forwarded-Host": "work.tail.example:42000",
      Origin: "https://work.tail.example:42000",
    })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("blocks a rebinding GET even when loopback peers are configured as trusted proxies", async () => {
    const instance = await startServer({ trustedProxy: true });
    const result = await instance.request({
      Host: "attacker.invalid:3100",
      "X-Forwarded-Host": "localhost:3100",
    }, "GET");
    expect(result.status).toBe(403);
    expect(result.body).not.toContain("attacker.invalid");
    expect(instance.mutations()).toBe(0);
  });

  it("rejects an unapproved forwarded hostname even from a trusted proxy", async () => {
    const instance = await startServer({ trustedProxy: true });
    expect((await instance.request({ "X-Forwarded-Host": "attacker.invalid" })).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("rejects forwarded-host lists rather than trusting a retained client value", async () => {
    const instance = await startServer({ trustedProxy: true });
    expect((await instance.request({ "X-Forwarded-Host": "localhost:3100,attacker.invalid" })).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("still validates the actual Host before a trusted proxy header", async () => {
    const instance = await startServer({ trustedProxy: true });
    expect((await instance.request({ Host: "attacker.invalid@localhost", "X-Forwarded-Host": "localhost" })).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("preserves local CLI mutations without browser headers", async () => {
    const instance = await startServer();
    expect((await instance.request()).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("allows a local browser's same-origin mutation", async () => {
    const instance = await startServer();
    expect((await instance.request({ Origin: instance.baseUrl })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("uses a trusted Referer when the browser sends no Origin", async () => {
    const instance = await startServer();
    expect((await instance.request({ Referer: `${instance.baseUrl}/tasks` })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it.each<{ name: string; headers: (baseUrl: string) => Record<string, string> }>([
    { name: "hostile Origin", headers: () => ({ Origin: "https://attacker.invalid" }) },
    { name: "hostile Referer", headers: () => ({ Referer: "https://attacker.invalid/tasks" }) },
    { name: "forged forwarded origin", headers: () => ({ "X-Forwarded-Host": "attacker.invalid", Origin: "https://attacker.invalid" }) },
    { name: "opaque Origin with trusted Referer", headers: (baseUrl: string) => ({ Origin: "null", Referer: `${baseUrl}/tasks` }) },
    { name: "hostile Origin with trusted Referer", headers: (baseUrl: string) => ({ Origin: "https://attacker.invalid", Referer: `${baseUrl}/tasks` }) },
    { name: "malformed Origin with trusted Referer", headers: (baseUrl: string) => ({ Origin: "not an origin", Referer: `${baseUrl}/tasks` }) },
    { name: "originless browser request", headers: () => ({ "Sec-Fetch-Site": "cross-site" }) },
    { name: "a different local development listener", headers: () => ({ Origin: "http://localhost:3100" }) },
  ])("blocks $name before a local administrator mutation", async ({ headers }) => {
    const instance = await startServer();
    expect((await instance.request(headers(instance.baseUrl))).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("keeps safe reads available without accepting browser mutations", async () => {
    const instance = await startServer();
    expect((await instance.request({ Origin: "https://attacker.invalid" }, "GET")).status).toBe(200);
    expect(instance.mutations()).toBe(0);
  });

  it("honors an explicitly configured public origin", async () => {
    const instance = await startServer();
    process.env.PAPERCLIP_PUBLIC_URL = "https://board.example";
    expect((await instance.request({ Origin: "https://board.example" })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("preserves explicit board-key callers without browser headers", async () => {
    const instance = await startServer({ source: "board_key" });
    expect((await instance.request()).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });

  it("still requires browser evidence for session-authenticated mutations", async () => {
    const instance = await startServer({ source: "session" });
    expect((await instance.request()).status).toBe(403);
    expect(instance.mutations()).toBe(0);
  });

  it("rejects a different local development port for authenticated browser sessions", async () => {
    const instance = await startServer({ source: "session" });
    expect((await instance.request({ Origin: "http://localhost:3100" })).status).toBe(403);
    expect(instance.mutations()).toBe(0);
    expect((await instance.request({ Origin: instance.baseUrl })).status).toBe(204);
    expect(instance.mutations()).toBe(1);
  });
});
