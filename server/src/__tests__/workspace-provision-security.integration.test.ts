import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";

const runFile = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe("workspace provisioning environment integration", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it("creates a real Git worktree and runs its provision child without ambient server credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-provision-security-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    const captured = path.join(root, "environment.json");
    const preloadMarker = path.join(root, "preload-ran");
    await mkdir(repository);
    const git = (args: string[]) => runFile("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
      "-c", "user.name=Security Fixture", "-c", "user.email=security-fixture@example.invalid", ...args,
    ], { cwd: repository, timeout: 5_000 });
    await git(["init", "--initial-branch=main"]);
    await writeFile(path.join(repository, "README.txt"), "Isolated provision fixture\n");
    await git(["add", "README.txt"]);
    await git(["commit", "-m", "Fixture"]);
    const captureScript = path.join(root, "capture.cjs");
    await writeFile(captureScript, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.env));\n");
    const preloadScript = path.join(root, "preload.cjs");
    await writeFile(preloadScript, `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'loaded');\n`);

    const sentinels = {
      BETTER_AUTH_SECRET: "fixture-session-secret",
      DATABASE_URL: "postgresql://fixture-only",
      PAPERCLIP_AGENT_JWT_SECRET: "fixture-agent-secret",
      OPENAI_API_KEY: "fixture-model-key",
      AWS_SECRET_ACCESS_KEY: "fixture-cloud-key",
      SSH_AUTH_SOCK: path.join(root, "fixture-only-socket"),
      NODE_OPTIONS: `--require ${preloadScript}`,
      CUSTOM_CREDENTIAL: "fixture-unknown-secret",
    };
    for (const [key, value] of Object.entries(sentinels)) vi.stubEnv(key, value);
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS", "1");

    const workspace = await realizeExecutionWorkspace({
      base: { baseCwd: repository, source: "project_primary", projectId: "fixture-project",
        workspaceId: "fixture-workspace", repoUrl: null, repoRef: "main" },
      agent: { id: "fixture-agent", name: "Fixture", companyId: "fixture-company" },
      issue: { id: "fixture-issue", identifier: "FIX-1", title: "Security fixture" },
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "fixture-provision",
        worktreeParentDir: path.join(root, "worktrees"),
        provisionCommand: `${quote(process.execPath)} ${quote(captureScript)} ${quote(captured)}` } },
    });
    expect(workspace.created).toBe(true);
    const received = JSON.parse(await readFile(captured, "utf8")) as Record<string, string>;
    for (const key of Object.keys(sentinels)) expect(received).not.toHaveProperty(key);
    await expect(access(preloadMarker)).rejects.toThrow();
    // Runtime-owned workspace values remain available to the provisioner.
    expect(received.PAPERCLIP_WORKSPACE_CWD).toBe(workspace.cwd);
    expect(received.PAPERCLIP_WORKSPACE_BASE_CWD).toBe(repository);
    expect(received.PAPERCLIP_WORKSPACE_BRANCH).toBe("fixture-provision");
    expect(received.PAPERCLIP_PROJECT_ID).toBe("fixture-project");
    expect(received.PAPERCLIP_COMPANY_ID).toBe("fixture-company");
    expect(received.PAPERCLIP_ISSUE_ID).toBe("fixture-issue");
    expect(received.PATH).toBeTruthy();
  });
});
