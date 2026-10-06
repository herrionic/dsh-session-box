# `@sessionbox/dsh-plugin`

SessionBox execution targets for DeepSeek Harness: bind a session to a
SessionBox container and that session's file and shell work happens inside it,
while every other session keeps running on the host.

```text
one DSH host process
  ├─ ctx.fs         ──► container session → SessionBox;  otherwise → host backend
  ├─ ctx.shell      ──► same
  ├─ ctx.subprocess ──► same, opt-in per program (ripgrep)
  └─ sessionProjection 'executionTarget'
        ├─ Host command `/sessionbox <container>`   ← the only write path
        └─ input-bar chip                           ← reads the Remote catalog, submits the command
```

Nothing about the model's tool set changes: `read`, `write`, `edit`, `glob`,
`grep`, and the shell tool keep their names and schemas and simply execute in
whichever world the session is bound to.

## Install

Install the package as a profile bundle (the plugin manager, or `dsh` profile
tooling) and enable it. The bundle patch disables the host `fs`, `shell`, and
`subprocess` rows — a Cordis service name allows exactly one provider per realm,
and the routers have to be that provider — and the plugin re-mounts those same
host implementations inside isolated realms (`ctx.isolate('fs')` and friends) so
nothing is lost: an unbound session behaves exactly as it did before.

## Configure

Everything is on the settings page, under the namespace of the installed entry
(`sessionbox`). No YAML editing, no environment variables.

| Field | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8787` | SessionBox server origin |
| `tokenRef` | `SESSIONBOX_TOKEN` | **name** of the credential holding the API token |
| `containerRoot` | `/workspace` | container-side root the session workspace maps onto |
| `defaultTimeoutMs` | `120000` | per-exec deadline |
| `maxTimeoutMs` | `600000` | upper bound for a caller-supplied deadline |
| `maxOutputBytes` | `1048576` | retained bytes per output stream |
| `requestTimeoutMs` | `30000` | per-request deadline for agent-protocol operations |
| `provisionRipgrep` | `true` | install ripgrep inside a bound container when missing |
| `containerPrograms` | `["rg", "ripgrep"]` | programs whose `ctx.subprocess` children run in the container |

`tokenRef` is a `credential-ref`, not a secret: the settings form writes the
token into the credential store, and no plaintext token ever reaches a
configuration file. Every field is volatile, so an edit applies to the next
operation with no restart.

## Use

In a session, either type the command or use the chip at the left of the input
bar (next to the permission controls):

```text
/sessionbox                 # current target + the containers you can pick
/sessionbox new-world       # run this session inside container "new-world"
/sessionbox host            # go back to the host
```

Selecting a container records two things on the session: a log-only
`sessionbox/target` event (the durable binding, replayed on resume) and a
user-role reminder that tells the model what changed. The session then has

- `executionTarget` = `{ kind: 'container', containerId, name, workspace, hostRoot }`,
  which the chip and any other client read through the session projection;
- a standing runtime-context line in every assembled request naming the
  container and the path mapping;
- a switched tool catalog: `bash` in the container, `pwsh` on a Windows host.

Containers are never created implicitly. The plugin only ever connects to a
container that already exists, chosen by name or id.

## How paths map

A container session's `header.cwd` stays a real host directory. DSH validates
that path with `node:fs` on every workspace load, and a container path there
would make the session invalid and drop it from the sidebar, so the host
spelling stays and the plugin translates:

```text
host  <session cwd>\src\main.ts   ⇄   container  /workspace/src/main.ts
```

Input may be written either way: a host path below the session workspace, a
relative path, or an absolute container path such as `/etc/hostname`. Tool
results keep showing the host spelling so the model's own working directory
stays consistent, and the standing context line states the container root.

The two filesystems are **not** the same data. The container has its own
`/workspace`; files that were in the host directory before the switch are not
visible in the container, and files written in the container do not appear on
the host.

## What stays on the host

| Seam | Behaviour |
| --- | --- |
| `ctx.fs`, `ctx.shell` | routed per session, exactly |
| `ctx.subprocess` | routed only for the configured programs, in a turn whose cwd maps into the container |
| git probes behind change snapshots, `open-in-app`, out-of-process subagents | always the host |

`ctx.subprocess` is deliberately opt-in per program. The seam is shared by agent
work and host infrastructure, and an in-turn `git` probe is indistinguishable
from an in-turn `rg`; routing an unrouted program to the host degrades a
container session's convenience, while misrouting a host probe would corrupt
host-side observations.

`glob` and `grep` spawn ripgrep by the absolute path of the harness's packaged
binary, which cannot exist in a Linux container. The router rewrites that
argument to the container's own `rg`, and the plugin provisions ripgrep into a
bound container when the image lacks it (`sudo apt-get install -y ripgrep`,
once per container; `provisionRipgrep: false` disables it).

## Known limitations

- **Out-of-turn calls in a shared workspace.** `ctx.fs` receives only a `cwd`,
  so a call that arrives outside an agent turn (GUI file preview, background
  work) is routed by longest path prefix over the bound sessions' host roots. If
  two container sessions share one workspace directory, the most recently bound
  one wins. Calls made *inside* a turn are always exact, because the initiator
  identifies the session.
- **Paths outside the session workspace stay on the host.** The binding owns the
  session's *workspace*, not the whole filesystem: `header.cwd` maps onto
  `/workspace`, and a path the mapping cannot express — a git repository
  enclosing the workspace, the workspace registry, a file-tree walk — is served
  by the host backend. Refusing those would fail the turn rather than leave one
  path behind, because the harness's own observers run through the same seam
  (change snapshots read `.git` above the workspace). A container session
  therefore still sees host paths outside its workspace.
- **No push invalidation for the picker.** The browser's forwarded-event
  allowlist lives in `@deepseek-ai/dsh-api-remotes`, which a plugin cannot
  extend, so the chip re-reads the container list each time it opens instead of
  being notified when the list changes.
- **No `watch`.** The agent protocol has no watch operation, so a container
  session's file tree refreshes on re-read rather than on filesystem events.
- **Host-side observers see the host directory.** The workspace registry, change
  snapshots, the `@` file index, AGENTS.md discovery, and skill discovery all
  read `header.cwd` with `node:fs`. They keep working, but they describe the host
  directory, not the container's workspace. The model is told the mapping.
- **Text reads are bounded by the protocol.** One `file.read` response is capped
  at 8 MiB, and paging a file through offset windows could split a multi-byte
  character, so a text file larger than that fails with `FS_TOO_LARGE` rather
  than arriving corrupted. Binary reads have no offset, so `readByteRange`
  reads the whole file (bounded the same way) and slices.
- **Shell confinement inside the container is the container.** `read-only` and
  `workspace-write` are enforced on `writeText`/`editText` — a write outside the
  container workspace fails with `FS_SANDBOX_DENIED` — but a command that writes
  is not intercepted: the container is the boundary.
- **Persistent terminals and PTC are not routed.** `spawnTerminal` reports that
  terminals are unavailable in a container, and the PTC runtime needs Node
  inside the container, which the stock image does not ship.

## Model experience

Token and cache effects:

- Switching target changes the tool catalog (`bash` ⇄ `pwsh`) and adds one
  user-role reminder, so the first request after a switch rebuilds its prompt
  prefix. Steady state — no switches — is prefix-stable.
- The standing execution-target line is part of the runtime context, which the
  harness already re-renders per request.

The model is told three things it cannot infer: which filesystem its tools now
touch, that the container root is `/workspace`, and that the host spelling of
the workspace is an identity rather than a shared directory.

## Development

This repository is self-contained: `pnpm install` resolves every dependency
from npm except the three `@sessionbox/*` packages vendored under `vendor/`
(client, protocol, shared), which this plugin imports directly.

```sh
pnpm build      # esbuild bundle (dist/index.mjs)
pnpm typecheck
pnpm test       # activation + backend behaviour
pnpm probe      # read-only container capability probe
```

`client/index.js` is the browser half. It is written by hand — the client module
registry serves the file's bytes straight into the page, where it registers
itself with `window.__ModuleLoader__` — so it needs no build step. It mounts its
own Remote namespace (`ctx.remote.$mount`) because the client's namespace list is
fixed in `@deepseek-ai/dsh-api-remotes`.
