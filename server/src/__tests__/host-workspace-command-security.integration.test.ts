import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  realizeExecutionWorkspace,
  resetRuntimeServicesForTests,
  runWorkspaceJobForControl,
} from "../services/workspace-runtime.js";

const runFile = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe("host workspace command permission with real files and processes", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-host-command-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "repository");
    const capture = path.join(root, "child-environment.json");
    await mkdir(cwd);
    const script = path.join(root, "capture.cjs");
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.env)); if (process.argv[3] === 'keep-alive') setInterval(() => {}, 1000);\n");
    vi.stubEnv("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS", undefined);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    vi.stubEnv("SHELL", "/bin/sh");
    const command = `${quote(process.execPath)} ${quote(script)} ${quote(capture)}`;
    const actor = { id: "fixture-agent", name: "Fixture", companyId: "fixture-company" };
    const workspace = { baseCwd: cwd, source: "project_primary" as const, projectId: "fixture-project",
      workspaceId: "fixture-workspace", repoUrl: null, repoRef: null, strategy: "project_primary" as const,
      cwd, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false };
    const git = (args: string[]) => runFile("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
      "-c", "user.name=Security Fixture", "-c", "user.email=security-fixture@example.invalid", ...args,
    ], { cwd, timeout: 5_000 });
    async function initializeRepository() {
      await git(["init", "--initial-branch=main"]);
      await writeFile(path.join(cwd, "README.txt"), "Isolated host command fixture\n");
      await git(["add", "README.txt"]);
      await git(["commit", "-m", "Fixture"]);
    }
    const realization = (strategy: Record<string, unknown>, skipHostProvision = false) => realizeExecutionWorkspace({
      base: { baseCwd: cwd, source: "project_primary", projectId: workspace.projectId,
        workspaceId: workspace.workspaceId, repoUrl: null, repoRef: "main" },
      agent: actor, issue: null, skipHostProvision,
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "fixture-work",
        worktreeParentDir: path.join(root, "worktrees"), ...strategy } },
    });
    const startService = (config: Record<string, unknown> = {}, adapterEnv: Record<string, string> = {}) => ensureRuntimeServicesForRun({
      runId: "fixture-run", agent: actor, issue: null, workspace, adapterEnv,
      config: { workspaceRuntime: { services: [{ name: "fixture-service", lifecycle: "ephemeral", command: `${command} keep-alive` }] }, ...config },
    });
    return { root, cwd, capture, command, actor, workspace, git, initializeRepository, realization, startService };
  }

  it("creates Git metadata but rejects a configured host provisioner by default", async () => {
    const f = await fixture();
    await f.initializeRepository();
    await expect(f.realization({ provisionCommand: f.command,
      env: { PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS: "1" } }))
      .rejects.toThrow("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1");
    await expect(access(f.capture)).rejects.toThrow();
    expect((await f.git(["worktree", "list", "--porcelain"])).stdout).toContain("fixture-work");
  });

  it("allows a metadata-only worktree when host provision is skipped", async () => {
    const f = await fixture();
    await f.initializeRepository();
    const workspace = await f.realization({ provisionCommand: f.command }, true);
    expect(workspace.created).toBe(true);
    await expect(access(f.capture)).rejects.toThrow();
  });

  it("does not execute mutable repository hooks during internal worktree creation", async () => {
    const f = await fixture();
    await f.initializeRepository();
    const hooks = path.join(f.root, "hostile-hooks");
    const marker = path.join(f.root, "hook-ran");
    await mkdir(hooks);
    const hook = path.join(hooks, "post-checkout");
    await writeFile(hook, `#!/bin/sh\nprintf 'hook ran' > ${quote(marker)}\n`);
    await chmod(hook, 0o700);
    // Change only this temporary repository. The server must override the hook
    // for its invocation without changing the stored repository setting.
    await f.git(["config", "core.hooksPath", hooks]);
    const workspace = await f.realization({});
    expect(workspace.created).toBe(true);
    await expect(access(marker)).rejects.toThrow();
    expect((await f.git(["config", "--local", "--get", "core.hooksPath"])).stdout.trim()).toBe(hooks);
  });

  it("does not accept a workspace binding as host job permission", async () => {
    const f = await fixture();
    await expect(runWorkspaceJobForControl({ actor: f.actor, issue: null, workspace: f.workspace,
      command: { name: "fixture-job", command: f.command },
      adapterEnv: { PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS: "1" },
    })).rejects.toThrow("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1");
    await expect(access(f.capture)).rejects.toThrow();
  });

  it.each([false, true])("blocks a host runtime service before spawning (provision: %s)", async provision => {
    const f = await fixture();
    await expect(f.startService(provision ? { runtimeProvisionCommand: f.command } : {},
      { PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS: "1" }))
      .rejects.toThrow("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1");
    await expect(access(f.capture)).rejects.toThrow();
  });

  it("skips arbitrary host teardown commands while retaining fixed cleanup behavior", async () => {
    const f = await fixture();
    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace: { id: "fixture-execution", companyId: f.actor.companyId, providerType: "local_fs", providerRef: f.cwd,
        cwd: f.cwd, branchName: null, repoUrl: null, baseRef: null, projectId: f.workspace.projectId,
        projectWorkspaceId: f.workspace.workspaceId, sourceIssueId: null, metadata: { createdByRuntime: false } },
      cleanupCommand: f.command,
    });
    expect(result.warnings.join(" ")).toContain("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1");
    await expect(access(f.capture)).rejects.toThrow();
    await expect(access(f.cwd)).resolves.toBeUndefined();
  });

  it("starts an explicitly permitted harmless service with sanitized and assigned values", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS", "1");
    vi.stubEnv("BETTER_AUTH_SECRET", "ambient-session-canary");
    vi.stubEnv("OPENAI_API_KEY", "ambient-provider-canary");
    const services = await f.startService({}, { ASSIGNED_WORKSPACE_TOKEN: "assigned-canary" });
    expect(services).toHaveLength(1);
    await vi.waitFor(async () => {
      const received = JSON.parse(await readFile(f.capture, "utf8"));
      expect(received.ASSIGNED_WORKSPACE_TOKEN).toBe("assigned-canary");
      expect(received).not.toHaveProperty("BETTER_AUTH_SECRET");
      expect(received).not.toHaveProperty("OPENAI_API_KEY");
    }, { timeout: 5_000 });
  });
});
