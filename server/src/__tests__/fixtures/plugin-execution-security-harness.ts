import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const [mode, root] = process.argv.slice(2);
if (!root) throw new Error("Missing isolated fixture directory");
const marker = path.join(root, "plugin-code-ran");
const packageRoot = path.join(root, "packages", "plugins", "paperclip-plugin-security-fixture");
mkdirSync(packageRoot, { recursive: true });
const manifest: PaperclipPluginManifestV1 = {
  id: "security.fixture", apiVersion: 1, version: "1.0.0", displayName: "Security fixture",
  description: "Isolated integration test fixture", author: "Paperclip", categories: ["automation"],
  capabilities: ["http.outbound"], entrypoints: { worker: "dist/worker.cjs" },
};
const packageJson = {
  name: "paperclip-plugin-security-fixture", version: "1.0.0", private: true,
  paperclipPlugin: { manifest: "dist/manifest.mjs", worker: "dist/worker.cjs" },
  scripts: { build: "node build.cjs" },
};
writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(packageJson));
const workerSource = `
  const fs = require("node:fs");
  fs.writeFileSync(process.env.PLUGIN_TEST_MARKER, "worker");
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    const result = message.method === "initialize" ? { ok: true, supportedMethods: ["health"] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "shutdown") setImmediate(() => process.exit(0));
  });
`;

let error: string | null = null;
try {
  if (mode === "worker") {
    const workerPath = path.join(packageRoot, "worker.cjs");
    writeFileSync(workerPath, workerSource);
    const { createPluginWorkerHandle } = await import("../../services/plugin-worker-manager.js");
    const worker = createPluginWorkerHandle("security.fixture", {
      entrypointPath: workerPath, manifest, config: { PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS: "1" },
      instanceInfo: { instanceId: "isolated-test", hostVersion: "1.0.0" }, apiVersion: 1,
      hostHandlers: {}, autoRestart: false, rpcTimeoutMs: 3_000,
      env: { PLUGIN_TEST_MARKER: marker, PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS: "1" },
    });
    try { await worker.start(); await worker.call("health", {}); }
    finally { await worker.stop(); }
  } else if (mode === "build") {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/plugins/*\n");
    writeFileSync(path.join(packageRoot, "build.cjs"), `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(marker)}, "build");
      fs.mkdirSync("dist", { recursive: true });
      fs.writeFileSync("dist/manifest.mjs", "export default {};");
      fs.writeFileSync("dist/worker.cjs", "");
    `);
    const { ensureLocalPluginBuilt } = await import("../../services/plugin-loader.js");
    await ensureLocalPluginBuilt(packageRoot, packageJson, {
      repoRoot: root, processEnv: { PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS: "1" },
    });
  } else if (mode === "adapter" || mode === "adapter-reload") {
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: packageJson.name, version: "1.0.0", type: "module", main: "adapter.mjs",
    }));
    writeFileSync(path.join(packageRoot, "adapter.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(mode)});
      export function createServerAdapter() { return {
        type: "security_fixture", label: "Isolated adapter fixture", execute: async () => ({ exitCode: 0 }),
      }; }
    `);
    const { loadExternalAdapterPackage, reloadExternalAdapter } = await import("../../adapters/plugin-loader.js");
    if (mode === "adapter") {
      await loadExternalAdapterPackage(packageJson.name, packageRoot);
    } else {
      const { addAdapterPlugin } = await import("../../services/adapter-plugin-store.js");
      addAdapterPlugin({
        type: "security_fixture", packageName: packageJson.name, localPath: packageRoot,
        version: "1.0.0", installedAt: new Date().toISOString(),
      });
      await reloadExternalAdapter("security_fixture");
    }
  } else if (mode === "manifest") {
    mkdirSync(path.join(packageRoot, "dist"));
    writeFileSync(path.join(packageRoot, "dist", "manifest.mjs"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "manifest");
      export default ${JSON.stringify(manifest)};
    `);
    const { pluginLoader } = await import("../../services/plugin-loader.js");
    await pluginLoader(null as never, { enableNpmDiscovery: false }).loadManifest(packageRoot);
  } else throw new Error("Unknown isolated fixture mode");
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}

process.stdout.write(JSON.stringify({
  error, executed: existsSync(marker), marker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
}) + "\n");
