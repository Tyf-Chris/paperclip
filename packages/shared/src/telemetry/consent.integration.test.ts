import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import { loadOrCreateState } from "./state.js";

describe("telemetry consent with a real HTTP receiver and state directory", () => {
  const envKeys = ["PAPERCLIP_TELEMETRY_DISABLED", "DO_NOT_TRACK", "PAPERCLIP_TELEMETRY_ENDPOINT",
    "CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function receiver() {
    for (const key of envKeys) delete process.env[key];
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200).end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
    process.env.PAPERCLIP_TELEMETRY_ENDPOINT = `http://127.0.0.1:${address.port}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-consent-"));
    directories.push(directory);
    return { requests, directory };
  }

  it("sends nothing and creates no state without explicit consent", async () => {
    const { requests, directory } = await receiver();
    const client = new TelemetryClient(resolveTelemetryConfig(), () => loadOrCreateState(directory, "test"), "test");
    client.track("install.started");
    await client.flush();
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("sends a registered event only after explicit consent", async () => {
    const { requests, directory } = await receiver();
    const client = new TelemetryClient(resolveTelemetryConfig({ enabled: true }), () => loadOrCreateState(directory, "test"), "test");
    client.track("install.started");
    await client.flush();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!).events).toMatchObject([{ name: "install.started" }]);
    expect(await readdir(directory)).not.toEqual([]);
  });

  it("keeps the environment opt-out stronger than saved consent", async () => {
    const { requests, directory } = await receiver();
    process.env.DO_NOT_TRACK = "1";
    const client = new TelemetryClient(resolveTelemetryConfig({ enabled: true }), () => loadOrCreateState(directory, "test"), "test");
    client.track("install.started");
    await client.flush();
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
});
