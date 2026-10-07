# @sessionbox/dsh-plugin

**English** | [中文](README.md)

Run a DeepSeek Harness session inside a [SessionBox](https://github.com/herrionic/session-box) container.

One session, one execution world. Bind a session to a container and its file, shell, and
search work happens inside that container, while the harness, its session storage, and every
other session keep running on the machine hosting it. Switch the session back to the host and
it behaves exactly as it did before this plugin existed.

- **Per session, not per process.** Two sessions can run in two different containers at the
  same time, and a third can stay on the host.
- **Bindings are plugin state, never session data.** They live in a storage domain
  (`~/.dsh/storages/sessionbox.json`), so the session log stays readable by a harness that
  does not have this plugin installed.
- **The host stays intact.** The host filesystem, shell, and subprocess providers are loaded
  into isolated realms and the routing providers delegate to them, so a session on the host
  behaves as before.
- **No silent fallback.** A target that cannot be resolved is reported instead of quietly
  running the session somewhere the person did not choose.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Use](#use)
- [How it works](#how-it-works)
- [Path mapping](#path-mapping)
- [What stays on the host](#what-stays-on-the-host)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- **DeepSeek Harness** `0.2.0-rc.2`. Every harness package this plugin declares is published
  on npm, so no harness checkout is needed to install or build it.
- **Node.js** `^22.19` or `>=24`.
- A reachable **SessionBox server** and an API token for it.
- A Linux container image with `bash`. `ripgrep` is installed once with `apt` when the image
  lacks it (`provisionRipgrep`).

## Install

The plugin is an ordinary DeepSeek Harness plugin package: the harness profile names it in a
row and provides the package.

1. Make the package available to the profile. Until it is published, use a local checkout or a
   git dependency in the profile's `package.json`:

   ```json
   {
     "dependencies": {
       "@sessionbox/dsh-plugin": "link:/absolute/path/to/dsh-session-box"
     }
   }
   ```

2. Add the row to the profile's `cordis.patch.yml`:

   ```yaml
   - id: sessionbox
     name: "@sessionbox/dsh-plugin"
     config:
       baseUrl: http://127.0.0.1:8787
       tokenRef: SESSIONBOX_TOKEN
   ```

3. Restart the harness.

**Enable the row before startup.** The plugin replaces the host `fs`, `shell`, and `subprocess`
rows, and a live enable re-composes the running harness, which the session controller rejects
(`file-upload: Agent resolver is already registered`). Enable it in configuration and start the
harness with it already in place.

## Configure

All settings are editable from the GUI: **Settings → SessionBox**. The token itself never
enters the configuration file; it is written to the credential store under the configured name.

| Setting | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | SessionBox server origin. |
| `tokenRef` | `SESSIONBOX_TOKEN` | Name of the credential holding the API token. |
| `containerRoot` | `/workspace` | Working directory inside a bound container. |
| `defaultTarget` | `host` | Target a newly created session starts on: a container name or id, or `host`. |
| `defaultTimeoutMs` | `120000` | Default timeout for container operations. |
| `maxTimeoutMs` | `600000` | Upper bound a caller may request. |
| `requestTimeoutMs` | `30000` | Per-request deadline for agent-protocol calls. |
| `maxOutputBytes` | `1048576` | Retained bytes per output stream. |
| `provisionRipgrep` | `true` | Install `ripgrep` in a bound container when it is missing. |
| `containerPrograms` | `rg`, `ripgrep` | Program basenames whose subprocesses run inside a bound container. |

`defaultTarget` applies when a session is created. A name that cannot be resolved is reported
and the session starts on the host; the plugin never substitutes a target silently.

## Use

The execution target is chosen per session, from the input bar.

- **The chip** next to the composer shows the session's current target and switches it. It
  re-reads the container list when it mounts and after every switch.
- **The command** does the same thing and is the single write path:

  ```
  /sessionbox new-world     # bind this session to that container
  /sessionbox host          # send it back to the machine hosting the harness
  /sessionbox               # report the current target and the available containers
  ```

A switch takes effect immediately: the next tool call in that session runs in the new world.
The model is told about the change, both as a standing line in every assembled request and as a
one-off notice in the transcript.

## How it works

A session's binding is one record in the plugin's own storage. Routing reads it synchronously
from memory, so no tool call has to wait on the store.

```
Session -> binding -+- ctx.fs         -> container filesystem | host filesystem
                    +- ctx.shell      -> bash in container     | host shell
                    +- ctx.subprocess -> allowlisted programs  | host runtime
```

- **Routing providers, not replacements.** The host providers are loaded into isolated realms
  and the routers delegate to them. Nothing about a host session changes.
- **Per-agent tool surface.** A container session has `pwsh` denied (it is a Windows host tool
  and the container is Linux) and gains `bash`. Switching back restores the original surface.
- **Allowlisted subprocesses.** `ctx.subprocess` is shared with host infrastructure — git
  probes, out-of-process agents — so container routing is opt-in per program. The default
  covers the harness's packaged `ripgrep`, which `glob` and `grep` spawn.
- **One record per session.** The binding survives a restart because it is stored; the session
  log only carries the notices that explain the switch to the model.

## Path mapping

A bound session sees the container, not the host.

| The session asks for | It gets |
| --- | --- |
| a relative path | the path under `containerRoot` in the container |
| an absolute POSIX path (`/etc/hostname`) | that path in the container |
| the host workspace path | `containerRoot` in the container — the host spelling is an identity, not a shared directory |
| any other host path | nothing: reads report the file does not exist, writes are refused |

The last row is deliberate. The host path does not exist in the container, so reporting
"not found" is the truthful answer, and a write is refused rather than silently landing
somewhere the person did not intend.

## What stays on the host

The harness never moves. Sessions, the session log, projections, storage, credentials, the
GUI, the model connection, and host-side observers all keep running on the machine hosting the
harness. Only the three seams listed above are routed.

## Security notes

- The API token is stored in the credential store, not in configuration.
- A bound session can write anywhere inside its container, subject to the session's own file
  policy. Container-wide writes are intentional: the container is the boundary, and a
  permission error from the container's own user account is reported as such.
- Host paths outside the session workspace are not reachable from a bound session.
- The host file sandbox is unchanged for sessions that run on the host.

## Known limitations

- **A bound session has no terminal tools.** A terminal opens the host's shell, so the
  `terminal_*` tools are absent once a session is bound to a container. Use the `bash` tool for
  interactive commands; it runs inside the container.
- **`run_code` (PTC) still executes on the host in a bound session.** The harness reserves that
  tool against plugin restriction, so it cannot be switched off per session. For strict
  isolation, leave PTC disabled in the Agent preset.
- **After a switch made with `/sessionbox`, the input-bar chip can still show the old target.**
  Switching away and back refreshes it.
- **Two deployment conditions inside a container:** reading a file above 8 MiB reports
  `FS_TOO_LARGE`, and `glob` and `grep` are unavailable when the image lacks `ripgrep` and it
  cannot be installed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The chip shows `host` while the session runs in a container | Hover the chip: the tooltip ends with `[id=... catalog=... listed=... projection=...]`. `listed=true` means the host reported the binding. |
| No containers in the picker | Settings → SessionBox: the server URL and the token, then the container list at the bottom of that page. |
| The plugin did not activate | The row must be enabled before startup; a live enable is rejected by the session controller. |
| `glob` and `grep` fail in a container | `ripgrep` is missing and could not be installed. Check `provisionRipgrep` and the container's network. |
| A tool call reports a permission error | The container's own user account cannot write that path. Raise it inside the container (`sudo`) as you would on any Linux host. |

## Development

This repository is self-contained: `pnpm install` resolves every dependency from npm except the
three `@sessionbox/*` packages vendored under `vendor/` (client, protocol, shared), which this
plugin imports directly.

```sh
pnpm install
pnpm build       # esbuild bundle (dist/index.mjs)
pnpm typecheck
pnpm test        # activation, routing, and container-backend behaviour
pnpm probe       # read-only container capability probe against a real deployment
```

The container tests self-skip without credentials. To run them, set `SESSIONBOX_URL` and
`SESSIONBOX_TOKEN` in the environment.

`client/index.js` is the browser half. It is written by hand — the client module registry
serves the file's bytes straight into the page, where it registers itself with
`window.__ModuleLoader__` — so it needs no build step. It mounts its own Remote namespace
(`ctx.remote.$mount`) because the client's namespace list is fixed in
`@deepseek-ai/dsh-api-remotes`.

## License

MIT — see [LICENSE](LICENSE).
