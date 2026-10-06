/**
 * A SessionBox deployment in one process: the REST surface the client lists
 * containers through, and the agent WebSocket it runs operations over.
 *
 * The frames are validated with the published protocol schemas before they go
 * out, so this double cannot drift from the wire contract the plugin is written
 * against — a wrong field name fails the test that produced it rather than
 * silently teaching the plugin a shape the real server never sends.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { AgentResponseSchema, AgentWelcomeSchema, type AgentResponse } from '@sessionbox/protocol'

/** One container this fake server reports. */
export interface FakeContainer {
  id: string
  name: string
  status: string
  image: string
  workspace: string
}

/** Result of one `exec`. */
export interface FakeExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

interface FakeFile {
  content: string
  version: string
}

/** A scriptable SessionBox server. */
export class FakeSessionBox {
  readonly files = new Map<string, FakeFile>()
  readonly execs: Array<{ command: string; cwd?: string; timeoutMs?: number }> = []
  readonly operations: string[] = []
  readonly containers: FakeContainer[] = [
    { id: 'ctr_test', name: 'test-box', status: 'running', image: 'sessionbox/base:latest', workspace: '/workspace' },
  ]
  /** Overrides the reply to one `exec`. */
  execImpl: ((command: string, cwd: string | undefined) => FakeExecResult | Error) | undefined
  /** Set to make every request fail with this code. */
  failWith: { code: string; message: string } | undefined

  private http: Server | undefined
  private sockets: WebSocketServer | undefined
  private readonly open = new Set<WebSocket>()
  private versionCounter = 0

  /** Seed one file. */
  file(path: string, content: string): void {
    this.files.set(path, { content, version: this.nextVersion() })
  }

  /** Start listening on a loopback port and return the base URL. */
  async listen(): Promise<string> {
    const http = createServer((request, response) => { this.route(request, response) })
    const sockets = new WebSocketServer({ server: http, path: '/api/ws/agent' })
    sockets.on('connection', (socket) => {
      this.open.add(socket)
      socket.on('message', (data) => { this.handle(socket, String(data)) })
      socket.on('close', () => { this.open.delete(socket) })
    })
    this.http = http
    this.sockets = sockets
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address() as AddressInfo
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** Stop listening and drop every connection. */
  async close(): Promise<void> {
    for (const socket of this.open) socket.terminate()
    this.open.clear()
    await new Promise<void>((resolve) => { this.sockets?.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { this.http?.close(() => { resolve() }) })
  }

  /** The version token a freshly written file gets. */
  private nextVersion(): string {
    this.versionCounter += 1
    return `1:${String(this.versionCounter)}:1791187998000000000:1791188004076825949`
  }

  /** Serve the two REST endpoints the client uses. */
  private route(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/containers') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(this.containers))
      return
    }
    const match = /^\/api\/containers\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'GET' && match !== null) {
      const container = this.containers.find((candidate) => candidate.id === match[1])
      if (container === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'CONTAINER_NOT_FOUND', message: 'no such container' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(container))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }))
  }

  /** Dispatch one agent-protocol frame. */
  private handle(socket: WebSocket, raw: string): void {
    let frame: { type?: string; requestId?: string; [key: string]: unknown }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return
    }
    if (frame.type === 'hello') {
      // The handshake has its own schema: `welcome` is not an agent response.
      const welcome = AgentWelcomeSchema.parse({ type: 'welcome', protocolVersion: 2 })
      socket.send(JSON.stringify(welcome))
      return
    }
    const requestId = frame.requestId
    if (requestId === undefined) return
    this.operations.push(String(frame.type))

    if (this.failWith !== undefined) {
      this.send(socket, { type: 'error', requestId, code: this.failWith.code, message: this.failWith.message })
      return
    }

    const reply = this.reply(frame, requestId)
    if (reply instanceof Error) {
      this.send(socket, {
        type: 'error',
        requestId,
        code: (reply as Error & { code?: string }).code ?? 'INTERNAL_ERROR',
        message: reply.message,
      })
      return
    }
    if (reply !== undefined) this.send(socket, reply)
  }

  /** Build the response frame for one request, or an Error to answer with `error`. */
  private reply(
    frame: { type?: string; requestId?: string; [key: string]: unknown },
    requestId: string,
  ): AgentResponse | Error | undefined {
    const path = typeof frame.path === 'string' ? frame.path : ''
    switch (frame.type) {
      case 'exec': {
        const command = String(frame.command ?? '')
        const cwd = typeof frame.cwd === 'string' ? frame.cwd : undefined
        this.execs.push({ command, ...(cwd === undefined ? {} : { cwd }), ...(typeof frame.timeoutMs === 'number' ? { timeoutMs: frame.timeoutMs } : {}) })
        const outcome = this.execImpl?.(command, cwd) ?? { exitCode: 0, stdout: '', stderr: '' }
        if (outcome instanceof Error) return outcome
        return { type: 'exec.result', requestId, ...outcome }
      }
      case 'file.read': {
        const entry = this.files.get(path)
        if (entry === undefined) return notFound(path)
        const offset = typeof frame.offset === 'number' ? frame.offset : 0
        const length = typeof frame.length === 'number' ? frame.length : entry.content.length
        const content = entry.content.slice(offset, offset + length)
        return {
          type: 'file.read.result',
          requestId,
          file: {
            path,
            content,
            size: Buffer.byteLength(entry.content),
            modifiedAt: 1,
            version: entry.version,
            offset,
            length: content.length,
            eof: offset + content.length >= entry.content.length,
          },
        }
      }
      case 'file.readBytes': {
        const entry = this.files.get(path)
        if (entry === undefined) return notFound(path)
        const bytes = Buffer.from(entry.content, 'utf8')
        const maxBytes = typeof frame.maxBytes === 'number' ? frame.maxBytes : bytes.length
        if (bytes.length > maxBytes) {
          const error = new Error('the file exceeds the requested bound') as Error & { code?: string }
          error.code = 'FS_TOO_LARGE'
          return error
        }
        return {
          type: 'file.readBytes.result',
          requestId,
          file: {
            path,
            contentBase64: bytes.toString('base64'),
            size: bytes.length,
            modifiedAt: 1,
            version: entry.version,
          },
        }
      }
      case 'file.write': {
        const expected = frame.expected as { version?: string } | undefined
        const current = this.files.get(path)
        if (expected?.version !== undefined && current?.version !== expected.version) {
          return { type: 'error', requestId, code: 'VERSION_CONFLICT', message: 'the file changed', details: { current: current?.version ?? null } }
        }
        const content = String(frame.content ?? '')
        const version = this.nextVersion()
        this.files.set(path, { content, version })
        return {
          type: 'file.write.result',
          requestId,
          file: { path, size: Buffer.byteLength(content), modifiedAt: 1, version },
        }
      }
      case 'file.stat': {
        const entry = this.files.get(path)
        if (entry === undefined) return notFound(path)
        return {
          type: 'file.stat.result',
          requestId,
          entry: {
            name: path.split('/').pop() ?? path,
            path,
            type: 'file',
            size: Buffer.byteLength(entry.content),
            mode: 0o644,
            modifiedAt: 1,
            version: entry.version,
            ...(frame.follow === false ? { linkTarget: '/target' } : {}),
          },
        }
      }
      case 'file.list': {
        const prefix = path.endsWith('/') ? path : `${path}/`
        const entries = [...this.files.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
          .map(([candidate, entry]) => ({
            name: candidate.slice(prefix.length),
            path: candidate,
            type: 'file' as const,
            size: Buffer.byteLength(entry.content),
            mode: 0o644,
            modifiedAt: 1,
            version: entry.version,
          }))
        return { type: 'file.list.result', requestId, path, entries }
      }
      case 'file.mkdir':
        return { type: 'file.mkdir.result', requestId, path }
      case 'file.remove':
        this.files.delete(path)
        return { type: 'file.remove.result', requestId, path }
      case 'file.rename':
        return {
          type: 'file.rename.result',
          requestId,
          from: String(frame.from ?? ''),
          to: String(frame.to ?? ''),
        }
      case 'file.chmod':
        return { type: 'file.chmod.result', requestId, path, mode: Number(frame.mode ?? 0o644) }
      case 'file.symlink':
        return { type: 'file.symlink.result', requestId, path, target: String(frame.target ?? '') }
      case 'exec.cancel':
        return { type: 'exec.cancel.result', requestId, targetRequestId: String(frame.targetRequestId ?? '') }
      default:
        return { type: 'error', requestId, code: 'INVALID_REQUEST', message: `unsupported ${String(frame.type)}` }
    }
  }

  /** Validate and send one frame. */
  private send(socket: WebSocket, frame: unknown): void {
    const parsed = AgentResponseSchema.safeParse(frame)
    if (!parsed.success) {
      const type = (frame as { type?: string }).type
      throw new Error(
        `fake SessionBox produced an invalid "${String(type)}" frame: ${JSON.stringify(frame)}\n`
        + parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
      )
    }
    socket.send(JSON.stringify(parsed.data))
  }
}

/** One `NOT_FOUND` error frame body. */
function notFound(path: string): Error {
  const error = new Error(`${path} was not found`) as Error & { code?: string }
  error.code = 'NOT_FOUND'
  return error
}
