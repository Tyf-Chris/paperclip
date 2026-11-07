# Local security setup

This fork is based on Paperclip `v2026.1106.0`. It can run directly on a Mac.
It does not require a VM. It does not make arbitrary agent or plugin code safe.

Use this checkout to run the fixes. `npx paperclipai` installs the upstream
package. An upstream npm update can replace the fixes in this fork.

## New local instance

Install Node.js 24.11 or later, pnpm 9.15.4, and Rust 1.97.1. The repository's
Rust toolchain file selects the required compiler. Use a supported Mac for the
native runner. Run the following commands from this checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
PAPERCLIP_HOME="$HOME/.paperclip-local-secure" pnpm paperclipai onboard --yes
```

Use a new state directory. Do not copy a work instance into it for an initial
trial. Onboarding starts the local app. Follow its browser sign-in and first
owner setup. New instances require login, listen on loopback, and have telemetry
off. Select the native runner and an explicit model account connection.

Keep `PAPERCLIP_HOME` set to that same directory for later commands. Do not
enable LAN access unless you intend to share the instance. Do not place a
public proxy in front of an instance without reviewing its access settings.

The changes preserve existing instance settings. An old `local_trusted` value
still disables login. Upstream also wrote telemetry `true` automatically, so
an old `true` value does not prove that the user gave consent. For a reused
instance, choose authenticated mode and loopback in `configure`, and set
`telemetry.enabled` to `false`. `PAPERCLIP_TELEMETRY_DISABLED=1` always disables
telemetry, including when an old file has `true`.

## Execution controls

The native runner is the local default on supported targets. Its filesystem,
network, provider, and account controls remain in place.

Legacy local agents require `PAPERCLIP_ALLOW_LEGACY_LOCAL_AGENTS=1` in the
server's process environment. The normal UI cannot grant this permission.
Legacy agents and custom processes can access the computer as the server user.
An approval flag is not an operating-system sandbox. Keep this opt-in off for
work use. The gate also applies to local adapter probes before they launch code.

Host workspace provision, seed, and runtime-service commands require the separate
`PAPERCLIP_ALLOW_HOST_WORKSPACE_COMMANDS=1` operator opt-in. Keep it off for work
use. An agent can change a script inside its workspace, so even a previously
configured command can execute new code. Run task commands through the native
runner's controls instead. Ordinary Git metadata and worktree operations remain
available.
Internal Git commands disable hooks for each call without changing stored
configuration. Repository and global Git settings, including filters and
credential helpers, still require trust.

Legacy Codex and Claude no longer bypass permissions by default. ACP denies
protected operations unless bypass is explicitly enabled. Legacy Codex requires
an explicit key, account connection, or dedicated credential home. It does not
import the host's configuration or login. Native account selection is unchanged.

Plugin workers, plugin builds, executable plugin manifests, and external adapter
imports require `PAPERCLIP_ALLOW_UNSANDBOXED_PLUGINS=1` in the server process.
Plugin configuration cannot grant this permission. This flag grants host code
execution; it does not create a sandbox. Leave it off unless you trust the code.
External adapter package operations also disable npm lifecycle scripts.

Workspace commands receive basic process settings and authorized workspace
bindings. They do not receive ambient model keys, cloud keys, database secrets,
session secrets, SSH agent sockets, or `NODE_OPTIONS`. An operator-configured
workspace command is still trusted host code. It can read files permitted by
the server's operating-system account.

## Network controls

The hostname guard checks the actual Host authority before body parsing. It
cannot promote an unapproved Host through `X-Forwarded-Host`. Forwarded authority
is considered only for a configured trusted proxy. That proxy must overwrite
the header with one allowed value. Do not use broad proxy trust settings.

Browser mutations require the current listener's origin or the configured
public origin. A different service on port 3100 is not automatically trusted.
Local command-line requests without browser headers still work in explicitly
selected trusted-local mode. Bearer-key callers retain their explicit authority.

Plugin HTTP requests accept public unicast IP addresses only. IPv4-mapped IPv6,
loopback, private, link-local, multicast, and reserved ranges are rejected.
Validated IP addresses remain pinned for the connection.

The optional PostgreSQL Compose setup no longer publishes the database port.
It requires `POSTGRES_PASSWORD`. Use a unique URL-safe value, such as the output
of `openssl rand -hex 32`, and retain it across restarts. Do not change an
existing database's password by replacing its data volume. App ports publish
on loopback. The single-container path does not need this separate database.

## Packages and limits

The fork pins security fixes and retains the resolved dependency lockfiles.
Docker agent CLIs use explicit versions. The legacy Cursor adapter requires an
approved preinstalled CLI instead of a changing shell installer. OpenCode uses
a pinned npm package. Native verified provider installation remains separate.

The main workspace npm scan has no high or critical alerts after the updates.
One low-severity dependency alert remains: `deepmerge` 4.3.1, advisory
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
There is no published fixed version. It is used by optional plugin build tools,
whose automatic host execution is disabled. The npm audit command can also
misidentify the local `cli` workspace as the unrelated npm package `cli` 0.3.1.
That entry has no dependency path and is not a downloaded package.

This review does not qualify the optional remote sandbox-provider packages.
Their standalone dependency trees need a separate scan before use. Those
plugins cannot execute by default in this local setup.

Pi is disabled in both native and legacy modes. Its pinned distribution bundles
affected Undici, Zod, and minimatch versions. Replacing the top-level lockfile
does not replace that bundled code. Re-enabling Pi requires a patched distribution
and new integrity and runtime qualification. This fork keeps the existing
integrity checks and refuses execution. Use native Codex, Claude, or OpenCode.

The optional Daytona standalone tree also has known package alerts, including a
critical shell-quote alert. It was not changed for this local-only fork. Do not
enable it under the plugin opt-in without a separate update and review.

Telemetry off does not mean offline. Selected model providers receive the task
data authorized for a run. Announcements and update checks can make network
requests. This work did not use real provider accounts or work credentials.

Automatic `test-drive` is disabled because it depends on implicit local
administrator access. Use normal onboarding and browser sign-in. Run
`pnpm test:security:local` for the file, HTTP, Git-worktree, and process integration
checks. These checks do not test real provider sign-in or a complete work task.

Do not treat a passing package scan as proof of safety. New vulnerabilities,
malicious task content, dangerous explicit permissions, and unsafe workspace
commands can still cause harm. Keep the allowed files, network access, account
permissions, and spending limits as narrow as the work permits.
