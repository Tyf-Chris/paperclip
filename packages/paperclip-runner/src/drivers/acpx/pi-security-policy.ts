export const PI_SECURITY_BLOCKED_MESSAGE =
  "Pi is disabled because its bundled dependencies have known vulnerabilities. " +
  "Use native Codex, Claude, or OpenCode until the Pi distribution is patched and qualified.";

/** No environment or provider configuration may bypass this release decision. */
export function assertPiRuntimeAvailable(): void {
  throw Object.assign(new Error(PI_SECURITY_BLOCKED_MESSAGE), {
    code: "PI_SECURITY_BLOCKED",
    retryable: false,
  });
}
