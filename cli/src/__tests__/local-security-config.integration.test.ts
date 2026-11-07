import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorktreeConfig, resolveWorktreeLocalPaths } from "../commands/worktree-lib.js";
import { paperclipConfigSchema } from "../config/schema.js";
import { resolveQuickstartServerConfig } from "../config/server-bind.js";
import { readConfig, writeConfig } from "../config/store.js";

const runFile = promisify(execFile);
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const directories: string[] = [];
const childProbe = `
  import { readConfig, resolveConfigPath } from ${JSON.stringify(new URL("../config/store.ts", import.meta.url).href)};
  import { readConfigFile, resolveDeploymentMode } from ${JSON.stringify(new URL("../../../server/src/config-file.ts", import.meta.url).href)};
  import { resolveRuntimeBind } from ${JSON.stringify(new URL("../../../packages/shared/src/network-bind.ts", import.meta.url).href)};
  import { resolveTelemetryConfig } from ${JSON.stringify(new URL("../../../packages/shared/src/telemetry/config.ts", import.meta.url).href)};
  const cliConfig = readConfig();
  const serverConfig = readConfigFile();
  console.log(JSON.stringify({
    configPath: resolveConfigPath(),
    exists: cliConfig !== null,
    server: cliConfig?.server,
    serverFileMode: resolveDeploymentMode(serverConfig),
    bind: resolveRuntimeBind(cliConfig?.server ?? {}),
    telemetry: cliConfig?.telemetry,
    telemetryEnabled: resolveTelemetryConfig(cliConfig?.telemetry).enabled,
    extension: cliConfig?.localSecurityExtension,
  }));
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-local-config-"));
  directories.push(directory);
  return { directory, configPath: path.join(directory, "config.json") };
}

function minimalConfig() {
  return {
    $meta: { version: 1, updatedAt: "2026-11-07T12:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres" },
    logging: { mode: "file" },
    server: {},
  };
}

async function readInChild(directory: string, configPath: string) {
  const { stdout } = await runFile(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", childProbe], {
    cwd: directory,
    // No provider keys or caller mode overrides enter this config-only process.
    env: {
      PATH: process.env.PATH ?? "",
      PAPERCLIP_HOME: path.join(directory, "instance-home"),
      PAPERCLIP_INSTANCE_ID: "security-integration",
      PAPERCLIP_CONFIG: configPath,
    },
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

describe("local security configuration across files and processes", () => {
  it("keeps missing configuration authenticated, loopback-only, and telemetry-free", async () => {
    const { directory, configPath } = await fixture();
    const result = await readInChild(directory, configPath);
    expect(result).toMatchObject({
      exists: false,
      serverFileMode: "authenticated",
      bind: { bind: "loopback", host: "127.0.0.1", errors: [] },
      telemetryEnabled: false,
    });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(path.join(directory, "instance-home"))).toBe(false);
  });

  it("materializes safe defaults from real JSON and retains them after an atomic config update", async () => {
    const { directory, configPath } = await fixture();
    await writeFile(configPath, JSON.stringify(minimalConfig()), { mode: 0o600 });
    const config = readConfig(configPath)!;
    expect(config.server).toMatchObject({ deploymentMode: "authenticated", host: "127.0.0.1" });
    expect(config.telemetry.enabled).toBe(false);
    expect(writeConfig({ ...config, server: { ...config.server, port: 3211 } }, configPath)).toBe(true);

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved).toMatchObject({
      server: { deploymentMode: "authenticated", host: "127.0.0.1", port: 3211 },
      telemetry: { enabled: false },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(await readInChild(directory, configPath)).toMatchObject({
      serverFileMode: "authenticated",
      bind: { bind: "loopback", host: "127.0.0.1", errors: [] },
      telemetryEnabled: false,
    });
  });

  it("preserves explicit existing settings and extension data through a real read/write cycle", async () => {
    const { directory, configPath } = await fixture();
    const original = JSON.stringify({
      ...minimalConfig(),
      server: { deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1" },
      telemetry: { enabled: true },
      localSecurityExtension: { preserve: "operator-setting" },
    });
    await writeFile(configPath, original, { mode: 0o600 });
    const config = readConfig(configPath)!;
    writeConfig({ ...config, server: { ...config.server, port: 3212 } }, configPath);
    expect(await readFile(`${configPath}.backup`, "utf8")).toBe(original);
    expect(await readInChild(directory, configPath)).toMatchObject({
      server: { deploymentMode: "local_trusted", bind: "loopback", port: 3212 },
      serverFileMode: "local_trusted",
      telemetry: { enabled: true },
      extension: { preserve: "operator-setting" },
    });
  });

  it("writes a new worktree config without enabling telemetry or local implicit authority", async () => {
    const { directory } = await fixture();
    const paths = resolveWorktreeLocalPaths({
      cwd: path.join(directory, "repository"),
      homeDir: path.join(directory, "worktree-home"),
      instanceId: "security-worktree",
    });
    const config = buildWorktreeConfig({ sourceConfig: null, paths, serverPort: 3213, databasePort: 54400 });
    writeConfig(config, paths.configPath);
    expect(await readInChild(directory, paths.configPath)).toMatchObject({
      server: { deploymentMode: "authenticated", bind: "loopback", host: "127.0.0.1", port: 3213 },
      serverFileMode: "authenticated",
      telemetry: { enabled: false },
      telemetryEnabled: false,
    });
    expect(existsSync(paths.embeddedPostgresDataDir)).toBe(false);
    expect(existsSync(paths.secretsKeyFilePath)).toBe(false);
  });

  it("retains explicit source network settings and telemetry consent in a worktree file", async () => {
    const { directory } = await fixture();
    const paths = resolveWorktreeLocalPaths({
      cwd: path.join(directory, "repository"),
      homeDir: path.join(directory, "worktree-home"),
      instanceId: "explicit-worktree",
    });
    const sourceConfig = paperclipConfigSchema.parse({
      ...minimalConfig(),
      server: { deploymentMode: "authenticated", bind: "custom", host: "192.0.2.10", customBindHost: "192.0.2.10" },
      telemetry: { enabled: true },
    });
    writeConfig(buildWorktreeConfig({ sourceConfig, paths, serverPort: 3214, databasePort: 54401 }), paths.configPath);
    expect(await readInChild(directory, paths.configPath)).toMatchObject({
      server: { deploymentMode: "authenticated", bind: "custom", host: "192.0.2.10", customBindHost: "192.0.2.10" },
      bind: { bind: "custom", host: "192.0.2.10", errors: [] },
      telemetry: { enabled: true },
    });
  });

  it.each([
    { name: "no mode or bind", deploymentMode: undefined },
    { name: "authentication selected without a network choice", deploymentMode: "authenticated" as const },
  ])("persists loopback quickstart defaults with $name", async ({ deploymentMode }) => {
    const { directory, configPath } = await fixture();
    const defaults = resolveQuickstartServerConfig({ deploymentMode, port: 3215, allowedHostnames: [], serveUi: true });
    writeConfig(paperclipConfigSchema.parse({ ...minimalConfig(), ...defaults }), configPath);
    expect(await readInChild(directory, configPath)).toMatchObject({
      server: { deploymentMode: "authenticated", bind: "loopback", host: "127.0.0.1" },
      serverFileMode: "authenticated",
      telemetryEnabled: false,
    });
  });

  it("preserves an explicit LAN bind when writing quickstart configuration", async () => {
    const { directory, configPath } = await fixture();
    const defaults = resolveQuickstartServerConfig({ bind: "lan", port: 3216, allowedHostnames: [], serveUi: true });
    writeConfig(paperclipConfigSchema.parse({ ...minimalConfig(), ...defaults }), configPath);
    expect(await readInChild(directory, configPath)).toMatchObject({
      server: { deploymentMode: "authenticated", bind: "lan", host: "0.0.0.0" },
      telemetryEnabled: false,
    });
  });

  it("refuses automatic test-drive setup before changing files or telemetry opt-out", async () => {
    const { directory } = await fixture();
    const dataDir = path.join(directory, "unused-test-drive");
    const script = `
      import { existsSync } from 'node:fs';
      import { prepareTestDriveEnvironment } from ${JSON.stringify(new URL("../commands/test-drive.ts", import.meta.url).href)};
      let message = '';
      try { await prepareTestDriveEnvironment({ dataDir: ${JSON.stringify(dataDir)} }); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ message, exists: existsSync(${JSON.stringify(dataDir)}),
        mode: process.env.PAPERCLIP_DEPLOYMENT_MODE,
        telemetryOptOut: process.env.PAPERCLIP_TELEMETRY_DISABLED }));
    `;
    const { stdout } = await runFile(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", script], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        PAPERCLIP_HOME: path.join(directory, "instance-home"),
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
        PAPERCLIP_TELEMETRY_DISABLED: "1",
      },
      timeout: 15_000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ exists: false, mode: "authenticated", telemetryOptOut: "1" });
    expect(JSON.parse(stdout).message).toMatch(/onboard --yes.*browser sign-in/);
    expect(existsSync(path.join(directory, "instance-home"))).toBe(false);
  });
});
