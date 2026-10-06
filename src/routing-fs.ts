/**
 * `ctx.fs`: one filesystem service that dispatches per call to either the
 * harness host's own backend or a session's container.
 *
 * The seam carries no session identity —every method receives only a `cwd`
 * and a signal —so the router resolves the target from the initiator when a
 * turn owns the call and from the path prefix otherwise. Target identity is
 * encoded in the opaque `targetKey` (the pattern `fs-ssh` uses), which is what
 * lets a later `stat`/`readText`/`contains` find the same container and session
 * again without re-deriving them.
 *
 * @module @sessionbox/dsh-plugin/routing-fs
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { contains as containerContains } from './container-fs.ts'
import { hostContains, toContainerPath, toHostPath } from './target.ts'
import type { ContainerFileSystem } from './container-fs.ts'
import type { ContainerAccess, ContainerBoundary } from './types.ts'
import type { ExecutionTargetRegistry } from './target.ts'

/** Field separator inside a routed target key. No filesystem path contains NUL. */
const SEP = '\u0000'

/** Root that stands in for a host path this session cannot reach. */
const UNMAPPED_ROOT = '/__sessionbox_unmapped__'

/** Marker that distinguishes a routed target key from a backend-local one. */
const TARGET_PREFIX = `sessionbox${SEP}`

/** A routed target, fully decoded from its own key. */
interface Routed {
  sessionId: string | undefined
  boundary: ContainerBoundary
  path: string
}

/** Encode a routed target key. */
function encode(boundary: ContainerBoundary, sessionId: string | undefined, containerPath: string): FsTargetKey {
  return FsTargetKey([
    TARGET_PREFIX + boundary.containerId,
    boundary.name,
    boundary.workspace,
    boundary.hostRoot,
    sessionId ?? '',
    containerPath,
  ].join(SEP))
}

/** Decode a routed target key, or undefined for a backend-local target. */
function decode(target: FsTarget): Routed | undefined {
  const key = String(target.targetKey)
  if (!key.startsWith(TARGET_PREFIX)) return undefined
  const parts = key.slice(TARGET_PREFIX.length).split(SEP)
  if (parts.length !== 6) return undefined
  const [containerId, name, workspace, hostRoot, sessionId, containerPath] = parts as [
    string, string, string, string, string, string,
  ]
  return {
    sessionId: sessionId === '' ? undefined : sessionId,
    boundary: { kind: 'container', containerId, name, workspace, hostRoot },
    path: containerPath,
  }
}

/** Filesystem service that routes each call to the session's execution world. */
export class RoutingFileSystem extends FileSystem {
  /**
   * @param ctx - plugin context that owns the `fs` registration.
   * @param config - the host backend, the binding registry, and container access.
   */
  constructor(
    ctx: Context,
    private readonly config: {
      /** The host implementation, mounted in its own service realm. */
      local: FileSystem
      targets: ExecutionTargetRegistry
      containers: ContainerAccess
      /** Working directory for a call that arrives with neither `cwd` nor an initiator. */
      fallbackCwd: string
      /** Resolve the per-call file-effect policy for a routed write. */
      resolvePolicy: (sessionId: string | undefined, supplied: SandboxExecutionPolicy | undefined) => SandboxExecutionPolicy
    },
  ) {
    super(ctx)
  }

  /** The host backend's default mode: the capability fact the tool layer advertises. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.config.local.sandboxMode
  }

  override async resolve(
    filePath: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const bound = this.boundContainer()
    if (bound !== undefined && !filePath.startsWith('/')) {
      const absolute = path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(opts?.cwd ?? this.config.fallbackCwd, filePath)
      if (!mapsInto(bound, absolute)) {
        // A host path outside the mapped workspace does not exist in this
        // session's world. Answering as the filesystem does for a missing path
        // keeps the host unreadable — and leaves the harness's own probes (a git
        // repository above the workspace, a file-tree walk) degraded rather than
        // failing the turn.
        const synthetic = `${UNMAPPED_ROOT}/${absolute.replace(/[\\/]+/gu, '_')}`
        return { targetKey: encode(bound, this.initiatorId(), synthetic), displayPath: synthetic }
      }
    }
    const boundary = this.boundaryFor(opts?.cwd, filePath)
    if (boundary === undefined) return await this.config.local.resolve(filePath, opts)
    const containerPath = toContainerPath(boundary, filePath, opts?.cwd ?? boundary.hostRoot)
    return {
      targetKey: encode(boundary, this.initiatorId(), containerPath),
      displayPath: toHostPath(boundary, containerPath) ?? containerPath,
    }
  }

  /** The container bound to the turn's session, if any. */
  private boundContainer(): ContainerBoundary | undefined {
    const initiator = this.ctx.get('agents')?.currentInitiator()
    return initiator === undefined ? undefined : this.config.targets.containerOf(initiator.session.id)
  }

  override processPath(target: FsTarget): string {
    const routed = decode(target)
    return routed === undefined ? this.config.local.processPath(target) : routed.path
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    const boundary = this.config.targets.containerForPath(hostPath)
    if (boundary === undefined) return this.config.local.processPathFromHostPath(hostPath)
    return toContainerPath(boundary, hostPath, boundary.hostRoot)
  }

  override fileUrl(target: FsTarget): string {
    const routed = decode(target)
    // Container paths are POSIX; `pathToFileURL` would read `/workspace/x` as a
    // drive-relative path on a Windows host.
    return routed === undefined ? this.config.local.fileUrl(target) : new URL(`file://${routed.path}`).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const left = decode(parent)
    const right = decode(child)
    if (left === undefined && right === undefined) return this.config.local.contains(parent, child)
    if (left === undefined || right === undefined) return false
    if (left.boundary.containerId !== right.boundary.containerId) return false
    return containerContains(left.path, right.path)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.stat(target, signal)
    return await (await this.files(routed)).stat(routed.path, signal)
  }

  override async lstat(
    filePath: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const boundary = this.boundaryFor(opts?.cwd, filePath)
    if (boundary === undefined) return await this.config.local.lstat(filePath, opts, signal)
    const containerPath = toContainerPath(boundary, filePath, opts?.cwd ?? boundary.hostRoot)
    return await (await this.config.containers.backends(boundary)).files.lstat(containerPath, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.readText(target, signal)
    return await (await this.files(routed)).readText(routed.path, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.streamText(target, signal)
    return await (await this.files(routed)).streamText(routed.path, signal)
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.readBytes(target, signal, maxBytes)
    return await (await this.files(routed)).readBytes(routed.path, signal, maxBytes)
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.readByteRange(target, range, signal)
    return await (await this.files(routed)).readByteRange(routed.path, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const routed = decode(target)
    if (routed === undefined) return await this.config.local.listDir(target, signal)
    const entries = await (await this.files(routed)).listDir(routed.path, signal)
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.type === 'symlink' ? 'other' : entry.type,
      target: {
        targetKey: encode(routed.boundary, routed.sessionId, entry.path),
        displayPath: toHostPath(routed.boundary, entry.path) ?? entry.path,
      },
      ...(entry.version === undefined ? {} : { version: entry.version as FsVersion }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const routed = decode(target)
    if (routed === undefined) {
      // A mutation that names a host path outside the bound container's
      // workspace would land on the host filesystem — the leak the binding
      // exists to prevent. Reads of the same path still reach the host, because
      // the harness's own observers (git probes, file trees) read there.
      const hostPath = this.config.local.processPath(target)
      if (this.outsideWorkspace(undefined, hostPath)) throw outsideWorkspaceError(hostPath)
      return await this.config.local.writeText(target, content, expected, signal, sandboxPolicy)
    }
    if (routed.path.startsWith(UNMAPPED_ROOT)) throw outsideWorkspaceError(routed.path)
    const files = await this.files(routed)
    return await files.writeText(routed.path, content, expected, signal, {
      policy: this.config.resolvePolicy(routed.sessionId, sandboxPolicy),
      workspace: routed.boundary.workspace,
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const routed = decode(target)
    if (routed === undefined) {
      const hostPath = this.config.local.processPath(target)
      if (this.outsideWorkspace(undefined, hostPath)) throw outsideWorkspaceError(hostPath)
      return await this.config.local.editText(target, edit, expected, signal, sandboxPolicy)
    }
    if (routed.path.startsWith(UNMAPPED_ROOT)) throw outsideWorkspaceError(routed.path)
    const files = await this.files(routed)
    return await files.editText(routed.path, edit, expected, signal, {
      policy: this.config.resolvePolicy(routed.sessionId, sandboxPolicy),
      workspace: routed.boundary.workspace,
    })
  }

  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    // The agent protocol has no watch operation, so a container session's file
    // tree refreshes on an explicit re-read rather than on filesystem events.
    if (decode(target) !== undefined) {
      throw new FsError(
        'filesystem watching is not available inside a SessionBox container; re-read the directory instead',
        'FS_IO_ERROR',
      )
    }
    return await this.config.local.watch(target, changed, signal)
  }

  private async files(routed: Routed): Promise<ContainerFileSystem> {
    return (await this.config.containers.backends(routed.boundary)).files
  }

  /** The calling agent's session id, when a turn owns this call. */
  private initiatorId(): string | undefined {
    return this.ctx.get('agents')?.currentInitiator()?.session.id
  }

  /**
   * Which execution world owns one call.
   *
   * The initiator is authoritative whenever a turn owns the call, including
   * when it says "host" for a path another session's container happens to
   * cover; the path prefix is the fallback for calls that arrive from outside
   * any turn (GUI previews, background work).
   */
  private boundaryFor(cwd: string | undefined, filePath: string): ContainerBoundary | undefined {
    const initiator = this.ctx.get('agents')?.currentInitiator()
    const bound = initiator === undefined ? undefined : this.config.targets.containerOf(initiator.session.id)

    // A POSIX-absolute path names the container's own tree. On Windows
    // `path.isAbsolute('/etc/hosts')` is true and normalizes to `C:\etc\hosts`,
    // which would silently send a container read to the host filesystem.
    if (filePath.startsWith('/') && bound !== undefined) return bound

    const base = cwd ?? this.config.fallbackCwd
    const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(base, filePath)
    if (bound !== undefined) {
      // The binding owns the session's workspace, not the whole filesystem.
      // Host infrastructure reaches paths the mapping cannot express — the git
      // probe above a workspace that sits inside a larger repository, the
      // workspace registry, a file-tree walk — and refusing reads of those would
      // fail the turn instead of leaving one path on the host. Mutations are
      // refused separately by `outsideWorkspace`.
      return mapsInto(bound, absolute) ? bound : undefined
    }
    return this.config.targets.containerForPath(absolute)
  }

  /**
   * Whether this call names a host path the bound container cannot serve.
   *
   * Reads of such a path fall back to the host so the harness's own observers
   * keep working, but a write must not: the container is the boundary, and a
   * mutation reaching the host filesystem from a container session is the leak
   * the binding exists to prevent.
   *
   * @param cwd - the call's working directory.
   * @param filePath - the path the call names.
   * @returns whether a bound container session is active and the path is outside it.
   */
  private outsideWorkspace(cwd: string | undefined, filePath: string): boolean {
    if (filePath.startsWith('/')) return false
    const initiator = this.ctx.get('agents')?.currentInitiator()
    const bound = initiator === undefined ? undefined : this.config.targets.containerOf(initiator.session.id)
    if (bound === undefined) return false
    const base = cwd ?? this.config.fallbackCwd
    const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(base, filePath)
    return !mapsInto(bound, absolute)
  }
}

/** Whether one container's mapping can express this host or container path. */
function mapsInto(boundary: ContainerBoundary, absolute: string): boolean {
  return hostContains(boundary.hostRoot, absolute) || containerContains(boundary.workspace, absolute)
}

/** The refusal a mutation outside the bound container's workspace receives. */
function outsideWorkspaceError(hostPath: string): Error {
  return new Error(
    `${hostPath} is outside the session workspace and is not a container path; `
    + 'this session executes inside a container, so it cannot write to the host filesystem',
  )
}
