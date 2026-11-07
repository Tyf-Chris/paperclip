export const type = "opencode_local";
export const label = "OpenCode";

// Match the reviewed runner package version. Require npm in the sandbox;
// never execute a changing shell script from the vendor's install endpoint.
// A non-root sandbox image must include the user prefix's bin directory on PATH.
export const SANDBOX_INSTALL_COMMAND =
  'if [ "$(id -u)" -eq 0 ]; then ' +
  'npm install --global --omit=dev --registry=https://registry.npmjs.org opencode-ai@1.18.34; ' +
  'else npm install --global --omit=dev --registry=https://registry.npmjs.org --prefix "$HOME/.local" opencode-ai@1.18.34; fi';

export const DEFAULT_OPENCODE_LOCAL_MODEL = "openai/gpt-5.2-codex";

export function isValidOpenCodeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  return Boolean(trimmed) && slashIndex > 0 && slashIndex !== trimmed.length - 1;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENCODE_LOCAL_MODEL, label: DEFAULT_OPENCODE_LOCAL_MODEL },
  { id: "openai/gpt-6-astra", label: "openai/gpt-6-astra" },
  { id: "openai/gpt-6.1-sol", label: "openai/gpt-6.1-sol" },
  { id: "openai/gpt-6-sol", label: "openai/gpt-6-sol" },
  { id: "openai/gpt-6-luna", label: "openai/gpt-6-luna" },
  { id: "openai/gpt-5.6-sol", label: "openai/gpt-5.6-sol" },
  { id: "openai/gpt-5.6-terra", label: "openai/gpt-5.6-terra" },
  { id: "openai/gpt-5.6-luna", label: "openai/gpt-5.6-luna" },
  { id: "anthropic/claude-opus-5-5", label: "anthropic/claude-opus-5-5" },
  { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
  { id: "anthropic/claude-fable-5-1", label: "anthropic/claude-fable-5-1" },
  { id: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" },
  { id: "anthropic/claude-sonnet-5", label: "anthropic/claude-sonnet-5" },
  { id: "google/gemini-3.8-flash", label: "google/gemini-3.8-flash" },
  { id: "xai/grok-4.7", label: "xai/grok-4.7" },
  { id: "openai/gpt-5.5", label: "openai/gpt-5.5" },
  { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  { id: "openai/gpt-5.2", label: "openai/gpt-5.2" },
  { id: "openai/gpt-5.1-codex-max", label: "openai/gpt-5.1-codex-max" },
  { id: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
];

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Paperclip to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- variant (string, optional): provider-specific reasoning/profile variant passed as --variant (for example minimal|low|medium|high|xhigh|max)
- dangerouslySkipPermissions (boolean, optional): inject a runtime OpenCode config with \`permission=allow\` for all tools and connections; defaults to true for unattended Paperclip runs
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Paperclip requires an explicit \`model\` value for \`opencode_local\` agents.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
- The adapter sets OPENCODE_DISABLE_PROJECT_CONFIG=true to prevent OpenCode from \
  writing an opencode.json config file into the project working directory. Model \
  selection is passed via the --model CLI flag instead.
- When \`dangerouslySkipPermissions\` is enabled, Paperclip injects a temporary \
  runtime config with \`permission=allow\` so headless runs do \
  not stall on approval prompts.
`;
