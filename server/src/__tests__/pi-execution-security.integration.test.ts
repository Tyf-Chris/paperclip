import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PAPERCLIP_RUNNER_ACPX_PROFILES } from "@paperclipai/adapter-utils";
import { execute } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { testEnvironment } from "../../../packages/adapters/pi-local/src/server/test.js";
import { discoverPiModels } from "../../../packages/adapters/pi-local/src/server/models.js";
import { probeAcpxPiInstallation } from "../../../packages/paperclip-runner/src/drivers/acpx/profile-installation.js";

const run = promisify(execFile);

describe("Pi security release block", () => {
  it("blocks legacy execution, model discovery and environment tests before starting a real executable fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-security-"));
    const marker = path.join(root, "pi-ran");
    const command = path.join(root, "pi");
    await writeFile(command, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nconsole.log("fixture  model");\n`, { mode: 0o700 });
    const config = { command, cwd: root, model: "fixture/model" };
    try {
      await run(command, ["--list-models"]);
      expect(existsSync(marker)).toBe(true);
      await rm(marker);

      await expect(execute({ config } as never)).rejects.toMatchObject({ code: "PI_SECURITY_BLOCKED", retryable: false });
      await expect(discoverPiModels(config)).rejects.toMatchObject({ code: "PI_SECURITY_BLOCKED" });
      const result = await testEnvironment({ adapterType: "pi_local", config } as never);
      expect(result.status).toBe("fail");
      expect(result.checks).toContainEqual(expect.objectContaining({ code: "pi_security_blocked", level: "error" }));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks the native installation probe and disables the existing provider selection", async () => {
    await expect(probeAcpxPiInstallation("fixture/model")).rejects.toMatchObject({
      code: "PI_SECURITY_BLOCKED", retryable: false,
      message: expect.stringMatching(/Use native Codex, Claude, or OpenCode/),
    });
    expect(PAPERCLIP_RUNNER_ACPX_PROFILES.find(profile => profile.value === "pi")?.qualified).toBe(false);
  });
});
