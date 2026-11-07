import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const baseEnv = Object.fromEntries(
  ["PATH", "HOME", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const compose = spawnSync("docker", ["compose", "version"], { env: baseEnv });
const composeCommand = compose.status === 0 ? "docker" : "docker-compose";
const composePrefix = compose.status === 0 ? ["compose"] : [];
assert.equal(
  spawnSync(composeCommand, [...composePrefix, "version"], { env: baseEnv }).status,
  0,
  "Docker Compose is required for this integration check.",
);

function resolveCompose(file, env = {}) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "paperclip-compose-secrets-"));
  const envFile = path.join(temporary, "empty.env");
  writeFileSync(envFile, "");
  try {
    return spawnSync(composeCommand, [
      ...composePrefix, "--env-file", envFile, "-f", file, "config", "--format", "json",
    ], { cwd: repoRoot, env: { ...baseEnv, BETTER_AUTH_SECRET: "test-session-secret", ...env }, encoding: "utf8" });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

for (const [file, service] of [
  ["docker/docker-compose.quickstart.yml", "paperclip"],
  ["docker/docker-compose.yml", "server"],
]) {
  test(`${file} forwards the independent tool signing secret`, () => {
    for (const signingSecret of ["test-tool-signing-secret", undefined]) {
      const env = { POSTGRES_PASSWORD: "test-only-database-password" };
      if (signingSecret !== undefined) env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = signingSecret;
      const result = resolveCompose(file, env);
      assert.equal(result.status, 0, result.stderr);
      const containerEnv = JSON.parse(result.stdout).services[service].environment;
      assert.equal(containerEnv.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET, signingSecret ?? "");
      assert.equal(containerEnv.BETTER_AUTH_SECRET, "test-session-secret");
    }
  });
}

test("full-stack Compose requires an explicit database password", () => {
  for (const password of [undefined, ""]) {
    const env = password === undefined ? {} : { POSTGRES_PASSWORD: password };
    const result = resolveCompose("docker/docker-compose.yml", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /POSTGRES_PASSWORD/);
  }
});

for (const [file, service] of [
  ["docker/docker-compose.yml", "server"],
  ["docker/docker-compose.quickstart.yml", "paperclip"],
  ["docker/docker-compose.untrusted-review.yml", "review"],
]) {
  test(`${file} publishes application ports only on loopback`, () => {
    const password = "test-only-database-password";
    const result = resolveCompose(file, { POSTGRES_PASSWORD: password });
    assert.equal(result.status, 0, result.stderr);
    const services = JSON.parse(result.stdout).services;
    assert.ok(services[service].ports.length > 0);
    for (const port of services[service].ports) assert.equal(port.host_ip, "127.0.0.1");
    if (services.db) {
      assert.equal(services.db.ports, undefined, "Database must remain on the private Compose network.");
      assert.equal(services.db.environment.POSTGRES_PASSWORD, password);
      assert.equal(services.server.environment.DATABASE_URL, `postgres://paperclip:${password}@db:5432/paperclip`);
    }
  });
}
