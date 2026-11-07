import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { execute as executeProcessAdapter } from "../adapters/process/execute.js";
import { HttpError } from "../errors.js";
import {
  assertLegacyLocalAgentExecutionAllowed,
  type LocalExecutionPolicyInput,
} from "../services/local-execution-policy.js";

const originalOptIn = process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS;
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  if (originalOptIn === undefined) delete process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS;
  else process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS = originalOptIn;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function consumer(selection: LocalExecutionPolicyInput) {
  delete process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS;
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-execution-policy-"));
  directories.push(directory);
  const marker = path.join(directory, "process-started");
  const app = express();
  app.use(express.json());
  let admitted = 0;
  app.post("/consume/:operation", async (req, res) => {
    // The selection is server-owned, as it is after environment resolution in
    // dispatch and probe consumers. An agent's env cannot opt in the host.
    assertLegacyLocalAgentExecutionAllowed(selection);
    admitted += 1;
    if (selection.adapterType === "process") {
      const result = await executeProcessAdapter({
        runId: "security-integration",
        agent: { id: "security-agent", companyId: "security-company", name: "Security test", adapterType: "process", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        context: {},
        config: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'started');", marker],
          cwd: directory,
          env: req.body?.env ?? {},
          timeoutSec: 5,
        },
        onLog: async () => {},
      });
      if (result.exitCode !== 0) throw new Error("The harmless process consumer failed");
    }
    res.json({ admitted: true });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({
      error: error instanceof Error ? error.message : "Execution failed",
      details: error instanceof HttpError ? error.details : undefined,
    });
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing integration listener");
  return {
    marker,
    admitted: () => admitted,
    async request(operation = "dispatch", body: unknown = {}) {
      const response = await fetch(`http://127.0.0.1:${address.port}/consume/${operation}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

describe("legacy host execution with real HTTP and a process consumer", () => {
  it.each(["claude_local", "codex_local", "cursor", "process", "unknown_local_adapter"])(
    "blocks %s before the task consumer starts", async (adapterType) => {
      const instance = await consumer({ adapterType, environmentDriver: "local" });
      expect(await instance.request()).toMatchObject({
        status: 403, body: { details: { code: "legacy_local_agent_execution_disabled" } },
      });
      expect(instance.admitted()).toBe(0);
      expect(existsSync(instance.marker)).toBe(false);
    },
  );

  it("cannot enable a legacy probe from agent configuration environment values", async () => {
    const instance = await consumer({ adapterType: "process", executionTarget: null });
    expect((await instance.request("probe", { env: { PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS: "1" } })).status).toBe(403);
    expect(instance.admitted()).toBe(0);
    expect(existsSync(instance.marker)).toBe(false);
  });

  it("runs the harmless process adapter only after the host explicitly opts in", async () => {
    const instance = await consumer({ adapterType: "process", environmentDriver: "local" });
    process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS = "1";
    expect((await instance.request()).status).toBe(200);
    expect(instance.admitted()).toBe(1);
    expect(await readFile(instance.marker, "utf8")).toBe("started");
  });

  it("requires the explicit value 1 for host opt-in", async () => {
    const instance = await consumer({ adapterType: "process" });
    process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS = "true";
    expect((await instance.request()).status).toBe(403);
    expect(existsSync(instance.marker)).toBe(false);
  });

  it.each(["paperclip_runner", "http", "openclaw_gateway", "hermes_gateway", "cursor_cloud"])(
    "keeps %s admission available without legacy host opt-in", async (adapterType) => {
      const instance = await consumer({ adapterType, environmentDriver: "local" });
      expect((await instance.request("probe")).status).toBe(200);
      expect(instance.admitted()).toBe(1);
    },
  );

  it.each<LocalExecutionPolicyInput>([
    { adapterType: "process", environmentDriver: "ssh" },
    { adapterType: "unknown_external", environmentDriver: "sandbox" },
    { adapterType: "claude_local", environmentDriver: "plugin" },
    { adapterType: "codex_local", environmentDriver: "ssh", executionTarget: { kind: "local", environmentId: null, leaseId: null } },
  ])("does not treat an unreliable remote selection as host opt-in: $adapterType/$environmentDriver", async (selection) => {
    const instance = await consumer(selection);
    expect((await instance.request()).status).toBe(403);
    expect(instance.admitted()).toBe(0);
    expect(existsSync(instance.marker)).toBe(false);
  });

  it("admits a declared remote-capable adapter before SSH workspace preparation", async () => {
    const instance = await consumer({ adapterType: "codex_local", environmentDriver: "ssh" });
    expect((await instance.request()).status).toBe(200);
    expect(instance.admitted()).toBe(1);
  });
});
