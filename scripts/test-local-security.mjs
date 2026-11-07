import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmEntry = process.env.npm_execpath;
const javascriptEntry = pnpmEntry && /\.(?:cjs|mjs|js)$/i.test(pnpmEntry);
const pnpm = javascriptEntry ? process.execPath : pnpmEntry || "pnpm";
const prefix = javascriptEntry ? [pnpmEntry] : [];
const suites = [
  ["packages/shared", ["src/telemetry/consent.integration.test.ts"]],
  ["packages/adapters/codex-local", ["src/server/local-security.integration.test.ts"]],
  ["packages/adapters/claude-local", ["src/server/local-security.integration.test.ts"]],
  ["cli", ["src/__tests__/local-security-config.integration.test.ts"]],
  ["server", [
    "src/__tests__/local-http-security.integration.test.ts",
    "src/__tests__/legacy-local-execution.integration.test.ts",
    "src/__tests__/local-command-env.integration.test.ts",
    "src/__tests__/workspace-provision-security.integration.test.ts",
    "src/__tests__/host-workspace-command-security.integration.test.ts",
    "src/__tests__/plugin-execution-security.integration.test.ts",
    "src/__tests__/plugin-http-security.integration.test.ts",
    "src/__tests__/pi-execution-security.integration.test.ts",
  ]],
];

for (const [directory, files] of suites) {
  const result = spawnSync(pnpm, [...prefix, "--dir", directory, "exec", "vitest", "run", ...files], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
