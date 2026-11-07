import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runChild = promisify(execFile);
const harness = fileURLToPath(new URL("./fixtures/plugin-execution-security-harness.ts", import.meta.url));
const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

async function runFixture(mode: string, optIn?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-security-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, NODE_ENV: "production", PAPERCLIP_LOG_LEVEL: "silent",
    PAPERCLIP_HOME: path.join(root, "paperclip-home"), PAPERCLIP_TELEMETRY_ENABLED: "false",
  };
  if (optIn !== undefined) env.PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS = optIn;
  try {
    const result = await runChild(process.execPath, ["--import", tsxLoader, harness, mode, root], {
      cwd: root, env, timeout: 20_000, maxBuffer: 1_000_000,
    });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { error: string | null; executed: boolean; marker: string | null };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("host process permission for unsandboxed plugins", () => {
  for (const mode of ["worker", "build", "manifest", "adapter", "adapter-reload"]) {
    it(`does not execute hostile ${mode} code through plugin-supplied permission`, async () => {
      const denied = await runFixture(mode);
      expect(denied.executed).toBe(false);
      expect(denied.error).toMatch(/PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS=1/);
    }, 30_000);

    it(`executes isolated ${mode} fixture code only with the host process opt-in`, async () => {
      const allowed = await runFixture(mode, "1");
      expect(allowed.error).toBeNull();
      expect(allowed.executed).toBe(true);
      expect(allowed.marker).toBe(mode);
    }, 30_000);
  }

  it("requires the exact opt-in value", async () => {
    for (const value of ["0", "true", "01"]) {
      const denied = await runFixture("worker", value);
      expect(denied.executed).toBe(false);
      expect(denied.error).toMatch(/PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS=1/);
    }
  }, 30_000);
});
