import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { createClaudeAcpExecutor } from "./acp.js";

const cliProvider = String.raw`
require("node:fs").writeFileSync(process.env.SECURITY_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Fixture completed.",usage:{input_tokens:0,output_tokens:0}})));
`;

// Real ACP transport, with one harmless protected operation. Only an allow
// decision can create the marker. There is no network or real provider access.
const acpProvider = String.raw`
const fs = require("node:fs");
const rl = require("node:readline").createInterface({input:process.stdin});
const send = message => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...message}) + "\n");
let promptId;
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id:request.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
  else if (request.method === "session/new") send({id:request.id,result:{sessionId:"security-fixture",models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture"}]}}});
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

describe("legacy Claude local security integration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-security-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "claude-home");
    const capture = path.join(root, "capture.json");
    const marker = path.join(root, "protected-command-ran");
    await mkdir(workspace);
    await mkdir(home);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", home);
    const command = path.join(root, "provider.cjs");
    await writeFile(command, `#!${process.execPath}\n${cliProvider}`);
    await chmod(command, 0o700);
    const acpCommand = path.join(root, "acp-provider.cjs");
    await writeFile(acpCommand, acpProvider);
    const env = { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "assigned-fixture-key", SECURITY_CAPTURE: capture, SECURITY_MARKER: marker };
    const context = (config: Record<string, unknown>): AdapterExecutionContext => ({
      runId: "claude-security-integration",
      agent: { id: "security-agent", companyId: "security-company", name: "Fixture", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command, cwd: workspace, env, paperclipRuntimeSkills: [], ...config },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async () => {},
    });
    return { root, workspace, capture, marker, command, acpCommand, context };
  }

  it("starts a real CLI child without permission bypass by default", async () => {
    const f = await fixture();
    const result = await execute(f.context({}));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    const args = JSON.parse(await readFile(f.capture, "utf8"));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it.each([undefined, false])("denies ACP command permission when bypass is %s", async bypass => {
    const f = await fixture();
    await mkdir(path.join(f.workspace, ".claude"));
    const settingsPath = path.join(f.workspace, ".claude", "settings.local.json");
    await writeFile(settingsPath, JSON.stringify({ permissions: {
      defaultMode: "bypassPermissions", allow: ["Bash(*)"], additionalDirectories: ["/"],
    } }));
    const run = createClaudeAcpExecutor();
    const result = await run(f.context({
      engine: "acp", mode: "oneshot", timeoutSec: 10, model: "fixture-model",
      agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(f.acpCommand)}`,
      stateDir: path.join(f.root, "state"), dangerouslySkipPermissions: bypass,
      permissionMode: "approve-all",
    }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    const decision = JSON.parse(await readFile(f.capture, "utf8"));
    expect(decision.outcome).toEqual({ outcome: "selected", optionId: "deny" });
    await expect(access(f.marker)).rejects.toThrow();
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.allow).toEqual([]);
    expect(settings.permissions.additionalDirectories).toEqual([]);
  }, 20_000);

  it("allows the same fixture command only after an explicit ACP bypass opt-in", async () => {
    const f = await fixture();
    const result = await createClaudeAcpExecutor()(f.context({
      engine: "acp", mode: "oneshot", timeoutSec: 10, model: "fixture-model",
      agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(f.acpCommand)}`,
      stateDir: path.join(f.root, "state"), dangerouslySkipPermissions: true,
    }));
    expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
    expect(await readFile(f.marker, "utf8")).toBe("command ran");
  }, 20_000);
});
