import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sanitizeRuntimeServiceBaseEnv } from "../services/runtime-service-env.js";

describe("local workspace command environment", () => {
  it("passes system settings to a real child without server or provider credentials", () => {
    const env = sanitizeRuntimeServiceBaseEnv({
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      BETTER_AUTH_SECRET: "test-session-secret",
      DATABASE_URL: "postgresql://test-only",
      PAPERCLIP_AGENT_JWT_SECRET: "test-agent-secret",
      OPENAI_API_KEY: "test-model-key",
      AWS_SECRET_ACCESS_KEY: "test-cloud-key",
      SSH_AUTH_SOCK: "/tmp/test-only-socket",
      NODE_OPTIONS: "--require /tmp/test-only-preload.cjs",
      CUSTOM_CREDENTIAL: "test-unknown-secret",
    });
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const received = JSON.parse(result.stdout) as Record<string, string>;
    expect(received.PATH).toBe(process.env.PATH);
    expect(received.LC_ALL).toBe("C");
    for (const key of ["BETTER_AUTH_SECRET", "DATABASE_URL", "PAPERCLIP_AGENT_JWT_SECRET", "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS", "CUSTOM_CREDENTIAL"]) {
      expect(received).not.toHaveProperty(key);
    }
  });
});
