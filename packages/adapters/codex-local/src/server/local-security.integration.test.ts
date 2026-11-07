import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { createCodexAcpExecutor } from "./acp.js";

// These providers are real child processes. They use only temporary files and
// JSON-RPC; they never load a provider CLI, contact a model, or use real keys.
const cliProvider = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
fs.writeFileSync(process.env.SECURITY_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), home,
  auth: JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")),
  config: fs.existsSync(path.join(home, "config.toml")) ? fs.readFileSync(path.join(home, "config.toml"), "utf8") : "",
  copiedInstructions: fs.existsSync(path.join(home, "instructions.md")),
  openaiKey: process.env.OPENAI_API_KEY, codexKey: process.env.CODEX_API_KEY,
}));
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Fixture completed."}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}));
});
`;

const acpProvider = String.raw`
const fs = require("node:fs");
const rl = require("node:readline").createInterface({input:process.stdin});
const send = message => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message}) + "\n");
let promptId;
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id:request.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
  else if (request.method === "session/new") send({id:request.id,result:{sessionId:"security-fixture"}});
  else if (request.method === "session/prompt") {
    promptId = request.id;
    send({id:9000,method:"session/request_permission",params:{sessionId:"security-fixture",
      toolCall:{toolCallId:"protected-command",title:"Run a protected command",kind:"execute",status:"pending"},
      options:[{optionId:"allow",name:"Allow",kind:"allow_once"},{optionId:"deny",name:"Deny",kind:"reject_once"}]}});
  } else if (request.id === 9000) {
    fs.writeFileSync(process.env.SECURITY_CAPTURE, JSON.stringify(request.result));
    if (request.result.outcome.optionId === "allow") fs.writeFileSync(process.env.SECURITY_MARKER,"command ran");
    send({method:"session/update",params:{sessionId:"security-fixture",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture completed."}}}});
    send({id:promptId,result:{stopReason:"end_turn"}});
  } else if (request.id !== undefined && request.method) send({id:request.id,result:{}});
});
`;

describe("legacy Codex local security integration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-local-security-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const hostHome = path.join(root, "host-codex");
    const capture = path.join(root, "capture.json");
    const marker = path.join(root, "protected-command-ran");
    await mkdir(workspace);
    await mkdir(hostHome);
    await writeFile(path.join(hostHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "host-key-canary" }));
    await writeFile(path.join(hostHome, "config.toml"), "# host-mcp-canary\n");
    await writeFile(path.join(hostHome, "instructions.md"), "host-instructions-canary");
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    vi.stubEnv("CODEX_HOME", hostHome);
    vi.stubEnv("OPENAI_API_KEY", "host-key-canary");
    vi.stubEnv("CODEX_API_KEY", "host-alternate-key-canary");
    const command = path.join(root, "provider.cjs");
    await writeFile(command, `#!${process.execPath}\n${cliProvider}`);
    await chmod(command, 0o700);
    const acpCommand = path.join(root, "acp-provider.cjs");
    await writeFile(acpCommand, acpProvider);
    const context = (config: Record<string, unknown>): AdapterExecutionContext => ({
      runId: "security-integration",
      agent: { id: "security-agent", companyId: "security-company", name: "Fixture", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: workspace, paperclipRuntimeSkills: [], ...config },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async () => {},
    });
    const env = { OPENAI_API_KEY: "assigned-key-canary", SECURITY_CAPTURE: capture, SECURITY_MARKER: marker };
    return { root, workspace, hostHome, capture, marker, command, acpCommand, context, env };
  }

  it("runs a real CLI child without bypass or copied host configuration", async () => {
    const f = await fixture();
    const result = await execute(f.context({ env: f.env }));
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(await readFile(f.capture, "utf8"));
    expect(captured.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(captured.args).toContain('sandbox_mode="workspace-write"');
    expect(captured.auth).toEqual({ OPENAI_API_KEY: "assigned-key-canary" });
    expect(captured.config).not.toContain("host-mcp-canary");
    expect(captured.copiedInstructions).toBe(false);
    expect(captured.codexKey).toBe("");
    expect(JSON.parse(await readFile(path.join(f.hostHome, "auth.json"), "utf8")))
      .toEqual({ OPENAI_API_KEY: "host-key-canary" });
  });

  it("rejects an ambient host login before starting a provider process", async () => {
    const f = await fixture();
    await expect(execute(f.context({ env: { SECURITY_CAPTURE: f.capture } })))
      .rejects.toThrow("requires an explicit agent API key");
    await expect(access(f.capture)).rejects.toThrow();
  });

  it("rejects a dedicated home whose login links to the host account", async () => {
    const f = await fixture();
    const selectedHome = path.join(f.root, "selected-home");
    await mkdir(selectedHome);
    await symlink(path.join(f.hostHome, "auth.json"), path.join(selectedHome, "auth.json"));
    await expect(execute(f.context({ env: { ...f.env, CODEX_HOME: selectedHome } })))
      .rejects.toThrow("shared login");
    await expect(access(f.capture)).rejects.toThrow();
  });

  it("keeps an explicitly selected dedicated account instead of the host account", async () => {
    const f = await fixture();
    const selectedHome = path.join(f.root, "selected-home");
    await mkdir(selectedHome);
    await writeFile(path.join(selectedHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "selected-account-key" }));
    const result = await execute(f.context({ env: {
      CODEX_HOME: selectedHome, SECURITY_CAPTURE: f.capture,
    } }));
    expect(result.exitCode).toBe(0);
    const captured = JSON.parse(await readFile(f.capture, "utf8"));
    expect(captured.auth).toEqual({ OPENAI_API_KEY: "selected-account-key" });
    expect(captured.openaiKey).toBe("");
    expect(captured.codexKey).toBe("");
  });

  it.each([undefined, false])("denies a real ACP permission request when bypass is %s", async bypass => {
    const f = await fixture();
    const run = createCodexAcpExecutor();
    const result = await run(f.context({
      engine: "acp", mode: "oneshot", timeoutSec: 10,
      agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(f.acpCommand)}`,
      stateDir: path.join(f.root, "state"), env: f.env,
      dangerouslyBypassApprovalsAndSandbox: bypass,
      // A stale saved value must not override the visible bypass switch.
      permissionMode: "approve-all",
    }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    const decision = JSON.parse(await readFile(f.capture, "utf8"));
    expect(decision.outcome).toEqual({ outcome: "selected", optionId: "deny" });
    await expect(access(f.marker)).rejects.toThrow();
  }, 20_000);

  it("allows the same fixture command only after an explicit ACP bypass opt-in", async () => {
    const f = await fixture();
    const result = await createCodexAcpExecutor()(f.context({
      engine: "acp", mode: "oneshot", timeoutSec: 10,
      agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(f.acpCommand)}`,
      stateDir: path.join(f.root, "state"), env: f.env,
      dangerouslyBypassApprovalsAndSandbox: true,
    }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    expect(await readFile(f.marker, "utf8")).toBe("command ran");
  }, 20_000);
});
