/**
 * `ctx.fs` backend for one SessionBox container: path-based operations over the
 * agent protocol, expressed in container paths.
 *
 * The router owns target identity (one container path means different files in
 * different containers), so this backend takes and returns plain container
 * paths and raw directory entries.
 *
 * SessionBox returns an opaque `version` (`<ino>:<size>:<mtimeNs>:<ctimeNs>`
 * from container metadata) that is cheaper and strictly better than the
 * mtime+size token the first plugin version synthesized, so it is passed
 * through verbatim; `read`/`stat`/`list` agree on it by construction.
 *
 * @module @sessionbox/dsh-plugin/container-fs
 */

import { posix } from 'node:path'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { FsError, FsVersion as brandVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionBoxClientError, type ContainerRuntime } from '@sessionbox/client'

/** One raw directory child, in container terms. */
export interface ContainerDirEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  version?: string
  size?: number
}

/** Per-call fence facts: the mode plus the roots a confined write may touch. */
export interface FenceContext {
  policy: SandboxExecutionPolicy | undefined
  /** Container-side root a `workspace-write` write may touch. */
  workspace: string
}

/** Operations one container filesystem performs on container paths. */
export class ContainerFileSystem {
  /** @param runtime - the connected agent-protocol runtime for this container. */
  constructor(private readonly runtime: ContainerRuntime) {}

  /** Container-side root that maps onto the session workspace. */
  async stat(path: string, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const entry = await this.runtime.statFile(path)
      return { version: versionOf(entry), type: narrowType(entry.type), ...sizeOf(entry) }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw toFsError(error)
    }
  }

  /** Path-level metadata that does not follow a final symbolic link. */
  async lstat(path: string, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const entry = await this.runtime.statFile(path, { follow: false })
      return { version: versionOf(entry), type: entry.type, ...sizeOf(entry) }
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw toFsError(error)
    }
  }

  /**
   * Read one regular text file whole.
   *
   * A single `file.read` is used deliberately: SessionBox decodes each response
   * independently, so paging a file through `offset`/`length` windows could
   * split a multi-byte character at a window boundary and corrupt it. The
   * protocol's 8 MiB per-response bound therefore also bounds the largest text
   * file this backend reads; the failure is reported as `FS_TOO_LARGE`.
   */
  async readText(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    try {
      return (await this.runtime.readFile(path)).content
    } catch (error) {
      throw toFsError(error)
    }
  }

  /** Stream a text file; SessionBox delivers it in one response, so this yields once. */
  async streamText(path: string, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(path, signal)
    return (async function* () {
      signal?.throwIfAborted()
      yield text
    })()
  }

  /** Read a regular file as raw bytes, rejecting a target larger than `maxBytes`. */
  async readBytes(path: string, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    try {
      const file = await this.runtime.readBytes(path, { maxBytes })
      return new Uint8Array(Buffer.from(file.contentBase64, 'base64'))
    } catch (error) {
      throw toFsError(error)
    }
  }

  /**
   * Read one byte window of a regular file.
   *
   * `file.readBytes` has no `offset`, so the window is taken from a whole-file
   * byte read bounded by the file's own size. Files larger than the protocol's
   * 8 MiB response bound cannot be windowed and fail with `FS_TOO_LARGE`.
   */
  async readByteRange(
    path: string,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const info = await this.stat(path, signal)
    if (info === undefined) throw new FsError(`no such file: ${path}`, 'FS_NOT_FOUND')
    if (info.type === 'directory') throw new FsError(`not a regular file: ${path}`, 'FS_NOT_REGULAR_FILE')
    const size = info.size ?? 0
    const bytes = await this.readBytes(path, signal, Math.max(size, 1))
    return bytes.subarray(range.offset, range.offset + range.length)
  }

  /** List one directory; listing never requires read permission on its children. */
  async listDir(path: string, signal?: AbortSignal): Promise<ContainerDirEntry[]> {
    signal?.throwIfAborted()
    try {
      const listing = await this.runtime.listFiles(path)
      return listing.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        size: entry.size,
      }))
    } catch (error) {
      throw toFsError(error)
    }
  }

  /** Write one file whole, honouring the caller's guard and the session's file-effect policy. */
  async writeText(
    path: string,
    content: string,
    expected: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
    fence: FenceContext,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted()
    this.assertWritable(path, fence)

    const before = await this.readOptionalText(path)
    const exists = before !== null

    if (expected?.kind === 'createIfAbsent' && exists) {
      throw new FsError(`file already exists and the write required absence: ${path}`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (!exists) {
        throw new FsError(`file does not exist and the write required a version: ${path}`, 'FS_STALE_VERSION')
      }
    }

    try {
      await this.runtime.writeFile(
        path,
        content,
        expected?.kind === 'replaceIfVersion' ? { expected: { version: expected.version } } : {},
      )
    } catch (error) {
      throw toFsError(error)
    }

    const after = await this.runtime.statFile(path)
    return {
      operation: exists ? 'update' : 'create',
      version: versionOf(after),
      before,
      after: content,
    }
  }

  /** Replace literal text in one file, guarded by the caller's observed version. */
  async editText(
    path: string,
    edit: FsEditRequest,
    expected: { version: FsVersion } | undefined,
    signal: AbortSignal | undefined,
    fence: FenceContext,
  ): Promise<FsEditOutcome> {
    signal?.throwIfAborted()
    this.assertWritable(path, fence)

    if (edit.oldString === '') {
      throw new FsError('oldString must not be empty', 'FS_IO_ERROR')
    }

    const before = await this.readOptionalText(path)
    if (before === null) throw new FsError(`no such file: ${path}`, 'FS_NOT_FOUND')

    if (expected !== undefined) {
      const current = await this.runtime.statFile(path)
      if (versionOf(current) !== expected.version) {
        throw new FsError(`file changed since version ${String(expected.version)} was observed`, 'FS_STALE_VERSION')
      }
    }

    const occurrences = countOccurrences(before, edit.oldString)
    if (occurrences === 0) {
      throw new FsError(`oldString was not found in ${path}`, 'FS_EDIT_NOT_FOUND')
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new FsError(`oldString matches ${String(occurrences)} times in ${path}; set replaceAll`, 'FS_AMBIGUOUS_EDIT')
    }

    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString)

    try {
      await this.runtime.writeFile(
        path,
        after,
        expected === undefined ? {} : { expected: { version: String(expected.version) } },
      )
    } catch (error) {
      throw toFsError(error)
    }

    const info = await this.runtime.statFile(path)
    return { version: versionOf(info), before, after }
  }

  /** Create a directory, reporting success for one that already exists. */
  async mkdir(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    try {
      await this.runtime.mkdir(path, { recursive })
    } catch (error) {
      throw toFsError(error)
    }
  }

  /** Read text, treating an absent file or a binary file as "no text basis". */
  private async readOptionalText(path: string): Promise<string | null> {
    try {
      return (await this.runtime.readFile(path)).content
    } catch (error) {
      if (isNotFound(error)) return null
      if (isCode(error, 'FS_NOT_TEXT') || isCode(error, 'FS_IS_DIRECTORY')) return null
      throw toFsError(error)
    }
  }

  /**
   * Enforce the session's file-effect policy inside the container.
   *
   * The container is the security boundary, so `workspace-write` means "write
   * anywhere in the container": the paths outside `/workspace` are the
   * container's own system files, and an agent that installs a package and then
   * edits its configuration is doing exactly what the container is for. Whether
   * the container's user may write there is the backend's answer, not this
   * fence's — the agent protocol reports the real permission error, and the
   * model can escalate with `sudo` through the shell tool. `read-only` still
   * refuses every mutation, and the host fence is untouched.
   */
  private assertWritable(path: string, fence: FenceContext): void {
    const mode = fence.policy?.mode ?? 'workspace-write'
    if (mode === 'danger-full-access' || mode === 'workspace-write') return
    if (mode === 'read-only') {
      throw new FsError(`${path} cannot be modified: this session is read-only`, 'FS_SANDBOX_DENIED')
    }
    const roots = [fence.workspace, '/tmp']
    if (roots.some((root) => contains(root, path))) return
    throw new FsError(
      `the sandbox policy allows writes only under ${roots.join(' and ')}; ${path} is outside them`,
      'FS_SANDBOX_DENIED',
    )
  }
}

/** Whether `child` is `parent` or a descendant of it, on `/` boundaries. */
export function contains(parent: string, child: string): boolean {
  if (parent === child) return true
  const normalized = parent.endsWith('/') ? parent.slice(0, -1) : parent
  return child.startsWith(`${normalized}/`)
}

/** The container path of `child` inside `parent`, or undefined when outside it. */
export function relativeInside(parent: string, child: string): string | undefined {
  if (!contains(parent, child)) return undefined
  const normalized = parent.endsWith('/') ? parent.slice(0, -1) : parent
  return child.slice(normalized.length).replace(/^\/+/, '')
}

/** Join a container root with a relative container path. */
export function joinContainer(root: string, relative: string): string {
  const normalized = root.endsWith('/') ? root.slice(0, -1) : root
  return relative === '' ? normalized : posix.join(normalized, relative)
}

/** Map an agent-protocol entry type onto `FsInfo`'s coarser vocabulary. */
function narrowType(type: 'file' | 'directory' | 'symlink' | 'other'): 'file' | 'directory' | 'other' {
  return type === 'symlink' ? 'other' : type
}

/** The protocol's opaque freshness token, branded for DSH. */
function versionOf(entry: { version?: string; modifiedAt: number; size: number }): FsVersion {
  return brandVersion(entry.version ?? `${entry.modifiedAt}:${entry.size}`)
}

/** Include `size` only for entries whose size the protocol reported. */
function sizeOf(entry: { size?: number }): { size?: number } {
  return entry.size === undefined ? {} : { size: entry.size }
}

function isNotFound(error: unknown): boolean {
  return isCode(error, 'NOT_FOUND')
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof SessionBoxClientError && error.code === code
}

/**
 * Map an agent-protocol failure onto the closed `FsErrorCode` vocabulary.
 *
 * `details.reason` from `RUNTIME_ERROR` is folded into the message so an
 * unclassifiable container failure still says what happened.
 */
export function toFsError(error: unknown): FsError {
  if (error instanceof FsError) return error
  if (!(error instanceof SessionBoxClientError)) {
    return new FsError(error instanceof Error ? error.message : String(error), 'FS_IO_ERROR', { cause: error })
  }
  const code: string = error.code
  const reason = (error.details as { reason?: string } | undefined)?.reason
  const detail = reason === undefined ? error.message : `${error.message} (${reason})`
  switch (code) {
    case 'NOT_FOUND':
      return new FsError(detail, 'FS_NOT_FOUND', { cause: error })
    case 'FS_NOT_TEXT':
      return new FsError(detail, 'FS_NOT_TEXT', { cause: error })
    case 'FS_TOO_LARGE':
      return new FsError(detail, 'FS_TOO_LARGE', { cause: error })
    case 'FS_IS_DIRECTORY':
    case 'FS_NOT_REGULAR_FILE':
      return new FsError(detail, 'FS_NOT_REGULAR_FILE', { cause: error })
    case 'FS_PERMISSION_DENIED':
      return new FsError(detail, 'FS_PERMISSION_DENIED', { cause: error })
    case 'VERSION_CONFLICT':
      return new FsError(detail, 'FS_STALE_VERSION', { cause: error })
    case 'OPERATION_CANCELLED':
      return new FsError(detail, 'FS_ABORTED', { cause: error })
    default:
      return new FsError(detail, 'FS_IO_ERROR', { cause: error })
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
