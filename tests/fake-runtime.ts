/**
 * In-memory double for one container's agent-protocol runtime.
 *
 * The container backends are pure protocol adapters, so a fake runtime that
 * speaks the same operations is enough to test version passthrough, the write
 * fence, cancellation, and binary handling without a SessionBox deployment.
 */
import { SessionBoxClientError } from '@sessionbox/client'

/** One recorded call, for assertions about what the backend asked for. */
export interface RecordedCall {
  operation: string
  path?: string
  content?: string
  expected?: string
  offset?: number
  length?: number
  maxBytes?: number
  follow?: boolean
  signal?: AbortSignal | undefined
  timeoutMs?: number
  cwd?: string
}

interface Entry {
  content: string
  type: 'file' | 'directory' | 'symlink'
  version: string
  size: number
  mode: number
}

/** A scriptable container runtime double. */
export class FakeRuntime {
  readonly calls: RecordedCall[] = []
  readonly entries = new Map<string, Entry>()
  /** Results the next `exec` calls resolve with, in order. */
  readonly execResults: Array<{ exitCode: number | null; stdout: string; stderr: string }> = []
  /** Error the next `exec` call rejects with, if set. */
  execError: Error | undefined
  /** Text this runtime pretends is not UTF-8. */
  readonly binaryPaths = new Set<string>()

  /** Seed one file. */
  file(path: string, content: string, version = `v:${path}:1`): void {
    this.entries.set(path, {
      content,
      type: 'file',
      version,
      size: Buffer.byteLength(content),
      mode: 0o644,
    })
  }

  /** Seed one directory. */
  directory(path: string): void {
    this.entries.set(path, { content: '', type: 'directory', version: `v:${path}`, size: 4096, mode: 0o755 })
  }

  async exec(command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}) {
    this.calls.push({
      operation: 'exec',
      content: command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal: options.signal,
    })
    if (this.execError !== undefined) throw this.execError
    return this.execResults.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
  }

  async readFile(path: string, options: { offset?: number; length?: number } = {}) {
    this.calls.push({
      operation: 'readFile',
      path,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.length === undefined ? {} : { length: options.length }),
    })
    if (this.binaryPaths.has(path)) {
      throw new SessionBoxClientError('FS_NOT_TEXT', `${path} is not valid UTF-8 text`)
    }
    const entry = this.require(path)
    if (entry.type === 'directory') {
      throw new SessionBoxClientError('FS_IS_DIRECTORY', `${path} is a directory`)
    }
    const content = entry.content.slice(options.offset ?? 0, (options.offset ?? 0) + (options.length ?? entry.content.length))
    return { path, content, size: entry.size, modifiedAt: 1, offset: options.offset ?? 0, length: content.length, eof: true }
  }

  async readBytes(path: string, options: { maxBytes?: number } = {}) {
    this.calls.push({ operation: 'readBytes', path, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) })
    const entry = this.require(path)
    const bytes = Buffer.from(entry.content, 'utf8')
    if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
      throw new SessionBoxClientError('FS_TOO_LARGE', 'the file exceeds the protocol limit')
    }
    return { path, size: bytes.length, contentBase64: bytes.toString('base64') }
  }

  async writeFile(path: string, content: string, options: { expected?: { version: string } } = {}) {
    this.calls.push({
      operation: 'writeFile',
      path,
      content,
      ...(options.expected === undefined ? {} : { expected: options.expected.version }),
    })
    const existing = this.entries.get(path)
    if (options.expected !== undefined && existing?.version !== options.expected.version) {
      throw new SessionBoxClientError('VERSION_CONFLICT', 'the file changed', { current: existing?.version ?? null })
    }
    const version = `v:${path}:${String((existing === undefined ? 1 : 2))}`
    this.entries.set(path, { content, type: 'file', version, size: Buffer.byteLength(content), mode: 0o644 })
    return { path, size: Buffer.byteLength(content), modifiedAt: 1, version }
  }

  async listFiles(path: string) {
    this.calls.push({ operation: 'listFiles', path })
    const prefix = path.endsWith('/') ? path : `${path}/`
    const entries = [...this.entries.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
      .map(([candidate, entry]) => ({
        name: candidate.slice(prefix.length),
        path: candidate,
        type: entry.type,
        size: entry.size,
        mode: entry.mode,
        modifiedAt: 1,
        version: entry.version,
      }))
    return { path, entries }
  }

  async statFile(path: string, options: { follow?: boolean } = {}) {
    this.calls.push({ operation: 'statFile', path, ...(options.follow === undefined ? {} : { follow: options.follow }) })
    const entry = this.require(path)
    return {
      name: path.split('/').pop() ?? path,
      path,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      modifiedAt: 1,
      version: entry.version,
      ...(entry.type === 'symlink' ? { linkTarget: '/target' } : {}),
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}) {
    this.calls.push({ operation: 'mkdir', path, ...(options.recursive === undefined ? {} : {}) })
    this.directory(path)
  }

  async remove(path: string): Promise<void> {
    this.calls.push({ operation: 'remove', path })
    this.entries.delete(path)
  }

  async close(): Promise<void> {
    this.calls.push({ operation: 'close' })
  }

  private require(path: string): Entry {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new SessionBoxClientError('NOT_FOUND', `${path} was not found`)
    return entry
  }
}
