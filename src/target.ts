/**
 * Execution-target registry and host↔container path mapping.
 *
 * Routing answers one question for every capability call: which session is
 * this, and does that session run on the harness host or inside a container?
 *
 * Session identity comes from two places, in this order:
 *
 * 1. `ctx.agents.currentInitiator()` — reliable inside an agent turn, and
 *    `undefined` outside one (GUI file previews, background GC, webhook
 *    warm-up).
 * 2. A path prefix over the bound sessions' host roots — the fallback for
 *    out-of-turn calls, and the only signal `ctx.fs` ever gets besides `cwd`.
 *
 * Two container sessions that share one host root are indistinguishable to
 * (2); the most recently bound one wins, and the limitation is documented
 * rather than papered over.
 *
 * @module @sessionbox/dsh-plugin/target
 */

import path from 'node:path'
import { posix } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { ContainerBoundary, ExecutionTarget } from './types.ts'

/** Lowercased, separator-normalized host path used as a prefix key. */
function hostKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` is `parent` or lives below it in the host path namespace. */
export function hostContains(parent: string, child: string): boolean {
  const from = hostKey(parent)
  const to = hostKey(child)
  if (from === to) return true
  const relative = path.relative(from, to)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** The host-relative portion of `child` inside `parent`, or undefined when outside. */
export function hostRelative(parent: string, child: string): string | undefined {
  if (!hostContains(parent, child)) return undefined
  return path.relative(path.resolve(parent), path.resolve(child))
}

/** Convert a host-relative path into a container path segment. */
function toContainerRelative(relative: string): string {
  return relative.split(path.sep).join('/')
}

/** Join a container root with a container-relative path. */
export function joinContainer(root: string, relative: string): string {
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root
  return relative === '' ? normalized : posix.join(normalized, relative)
}

/**
 * Translate one caller-supplied path into a container path.
 *
 * Accepted inputs, in order:
 * 1. an absolute host path below the session's host root;
 * 2. a path relative to the caller's `cwd` that lands below that root;
 * 3. an absolute POSIX path, taken as a container path in its own right (the
 *    agent protocol is not confined, and the model legitimately reads images
 *    outside the workspace).
 *
 * Anything else — most often a Windows path outside the session workspace —
 * has no container meaning, so it fails with a message that states the mapping
 * instead of silently reading the wrong file.
 *
 * @param boundary - the session's container binding.
 * @param input - the path the caller supplied.
 * @param cwd - the caller's working directory in host terms.
 * @returns the container-absolute path.
 */
export function toContainerPath(boundary: ContainerBoundary, input: string, cwd: string): string {
  if (input === '') throw new FsError('path must not be empty', 'FS_IO_ERROR')
  const absolute = path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input)
  const relative = hostRelative(boundary.hostRoot, absolute)
  if (relative !== undefined) return joinContainer(boundary.workspace, toContainerRelative(relative))
  if (posix.isAbsolute(input) && !/^[A-Za-z]:/.test(input)) return posix.normalize(input)
  throw new FsError(
    `${input} is outside the session workspace (${boundary.hostRoot}) and is not a container path; `
    + `this session executes inside container "${boundary.name}", whose workspace is ${boundary.workspace}`,
    'FS_IO_ERROR',
  )
}

/**
 * Translate a container path back into host terms for display.
 * @param boundary - the session's container binding.
 * @param containerPath - absolute container path.
 * @returns the host path when the container path is inside the mapped root, else undefined.
 */
export function toHostPath(boundary: ContainerBoundary, containerPath: string): string | undefined {
  const root = boundary.workspace.endsWith('/') ? boundary.workspace.slice(0, -1) : boundary.workspace
  if (containerPath !== root && !containerPath.startsWith(`${root}/`)) return undefined
  const relative = containerPath.slice(root.length).replace(/^\/+/, '')
  if (relative === '') return path.resolve(boundary.hostRoot)
  return path.join(path.resolve(boundary.hostRoot), ...relative.split('/'))
}

/**
 * Whether a container path is already inside the session's mapped root.
 * @param boundary - the session's container binding.
 * @param containerPath - absolute container path.
 * @returns true for the root itself and every descendant.
 */
export function containerContains(boundary: ContainerBoundary, containerPath: string): boolean {
  const root = boundary.workspace.endsWith('/') ? boundary.workspace.slice(0, -1) : boundary.workspace
  return containerPath === root || containerPath.startsWith(`${root}/`)
}

/** A bound session and the host root whose paths route to it. */
interface Entry {
  sessionId: SessionId
  boundary: ContainerBoundary
  /** Monotonic binding order; the newest wins an ambiguous path-prefix match. */
  order: number
}

/** Which execution world each bound session uses. */
export class ExecutionTargetRegistry {
  private readonly entries = new Map<SessionId, Entry>()
  private nextOrder = 1

  /**
   * Bind one session to a container, or clear its binding back to the host.
   * @param sessionId - the session whose execution world changes.
   * @param target - the new target; `{kind:'host'}` removes the binding.
   * @param hostRoot - the session's `header.cwd`, used as the routing prefix.
   */
  set(sessionId: SessionId, target: ExecutionTarget, hostRoot: string): void {
    if (target.kind === 'host') {
      this.entries.delete(sessionId)
      return
    }
    this.entries.set(sessionId, {
      sessionId,
      boundary: { ...target, hostRoot },
      order: this.nextOrder++,
    })
  }

  /** Forget one session's binding, e.g. when the container is gone. */
  forget(sessionId: SessionId): void {
    this.entries.delete(sessionId)
  }

  /**
   * Read one session's container binding.
   * @param sessionId - session to look up.
   * @returns the binding, or undefined when the session runs on the host.
   */
  containerOf(sessionId: SessionId): ContainerBoundary | undefined {
    return this.entries.get(sessionId)?.boundary
  }

  /**
   * Resolve a host path to the bound session that owns it, longest prefix first.
   * @param hostPath - absolute host path in either the session root or a descendant.
   * @returns the owning boundary, or undefined when no bound session covers the path.
   */
  containerForPath(hostPath: string): ContainerBoundary | undefined {
    let best: Entry | undefined
    for (const entry of this.entries.values()) {
      if (!hostContains(entry.boundary.hostRoot, hostPath)) continue
      if (best === undefined) {
        best = entry
        continue
      }
      const longer = hostKey(entry.boundary.hostRoot).length > hostKey(best.boundary.hostRoot).length
      const newer = entry.order > best.order
      if (longer || (hostKey(entry.boundary.hostRoot).length === hostKey(best.boundary.hostRoot).length && newer)) {
        best = entry
      }
    }
    return best?.boundary
  }

  /** Every live binding, for rebuilding per-agent tool surfaces. */
  list(): readonly ContainerBoundary[] {
    return [...this.entries.values()].map((entry) => entry.boundary)
  }
}
