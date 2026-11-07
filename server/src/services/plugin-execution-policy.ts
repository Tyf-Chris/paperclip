/** Plugins use normal host processes; capability checks are not an OS sandbox. */
export function assertUnsandboxedPluginExecutionAllowed(): void {
  // Read only the host process environment. Plugin config and worker env must
  // never grant permission to execute code on the host.
  if (process.env.PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS !== "1") {
    throw new Error(
      "Plugin code can access this computer as the Paperclip OS user. " +
      "Set PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS=1 in the server process environment " +
      "only for plugins you trust.",
    );
  }
}
