export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Commands receive only basic process settings. Credentials must come from
  // the authorized workspace bindings, never the server's ambient environment.
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "TERM", "COLORTERM", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (allowed.has(key) || /^LC_[A-Z_]+$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}
