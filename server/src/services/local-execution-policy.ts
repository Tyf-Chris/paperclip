import { adapterSupportsRemoteManagedEnvironments } from "@paperclipai/shared/environment-support";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { forbidden } from "../errors.js";

const NETWORK_ADAPTERS = new Set(["http", "openclaw_gateway", "hermes_gateway", "cursor_cloud"]);

export const LEGACY_LOCAL_EXECUTION_DISABLED_CODE = "legacy_local_agent_execution_disabled";
export const LEGACY_LOCAL_EXECUTION_DISABLED_MESSAGE =
  "Legacy agents cannot run on this host. Use Paperclip Runner, select a supported remote environment, " +
  "or start the server with PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS=1.";

export const HOST_WORKSPACE_COMMANDS_DISABLED_CODE = "host_workspace_commands_disabled";
export const HOST_WORKSPACE_COMMANDS_DISABLED_MESSAGE =
  "Host workspace commands are disabled. Run the command inside the agent's execution environment, " +
  "or start the server with PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1 only for trusted workspace code.";

/** A run, workspace binding, or agent configuration cannot grant host execution. */
export function assertHostWorkspaceCommandsAllowed(): void {
  if (process.env.PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS !== "1") {
    throw forbidden(HOST_WORKSPACE_COMMANDS_DISABLED_MESSAGE, { code: HOST_WORKSPACE_COMMANDS_DISABLED_CODE });
  }
}

export interface LocalExecutionPolicyInput {
  /** The persisted adapter type, never the provider's legacy harness name. */
  adapterType: string;
  /** A server-resolved environment driver, available before workspace creation. */
  environmentDriver?: string | null;
  /** When resolved, this target takes precedence over the selected driver. */
  executionTarget?: AdapterExecutionTarget | null;
}

export function legacyLocalAgentExecutionAllowed(input: LocalExecutionPolicyInput): boolean {
  if (input.adapterType === "paperclip_runner" || NETWORK_ADAPTERS.has(input.adapterType)) return true;
  if (process.env.PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS === "1") return true;

  const remote = input.executionTarget !== undefined
    ? input.executionTarget?.kind === "remote" && ["ssh", "sandbox"].includes(input.executionTarget.transport)
    : input.environmentDriver === "ssh" || input.environmentDriver === "sandbox";
  // Process and unknown external adapters can ignore a remote target and still
  // spawn on the host. Only the declared remote-capable adapters qualify.
  return Boolean(remote && adapterSupportsRemoteManagedEnvironments(input.adapterType));
}

export function assertLegacyLocalAgentExecutionAllowed(input: LocalExecutionPolicyInput): void {
  if (!legacyLocalAgentExecutionAllowed(input)) {
    throw forbidden(LEGACY_LOCAL_EXECUTION_DISABLED_MESSAGE, { code: LEGACY_LOCAL_EXECUTION_DISABLED_CODE });
  }
}
