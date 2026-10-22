/**
 * Routing integration: the real harness services, the real plugin, and a fake
 * SessionBox deployment on the other end of the wire.
 *
 * This is the test that proves the product claim end to end without a browser or
 * a GUI: a session bound to a container reads, writes, lists, and executes
 * *inside that container*, a session that is not bound keeps using the host, and
 * the binding is durable enough to rebuild from the session log.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionBoxService } from '../src/index.ts'
import type { ExecutionTarget } from '../src/types.ts'
import { FakeSessionBox } from './fake-server.ts'

let server: FakeSessionBox
let ctx: Context
let hostRoot: string
let baseUrl: string

/** The six terminal tools the plugin withholds from a container session. */
const CONTAINER_TOOL_NAMES = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
] as const

/** The per-call policy the tools would stamp, carrying the session identity. */
function policy(sessionId: string) {
  return { mode: 'danger-full-access' as const, workspaceRoot: hostRoot, sessionId: SessionId(sessionId) }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition never became true')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

beforeEach(async () => {
  server = new FakeSessionBox()
  baseUrl = await server.listen()
  hostRoot = await mkdtemp(join(tmpdir(), 'sessionbox-routing-'))

  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: hostRoot })
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(CommandRuntime)
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'test-token', source: 'store' }),
  } as never)
  await ctx.plugin(SessionBoxService, { baseUrl, tokenRef: 'SESSIONBOX_TEST_TOKEN' })
  await until(() => ctx.get('fs') !== undefined && ctx.get('shell') !== undefined)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await server.close()
  await rm(hostRoot, { recursive: true, force: true })
})

/** Record one binding the way the plugin does: a reminder after a real message. */
function rememberTarget(
  session: { append: (type: 'user/message', data: unknown, options: { surfaceOp: 'append' }) => unknown },
  target: ExecutionTarget,
): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '<system-reminder>target</system-reminder>' }],
    source: { kind: 'sessionbox-target', target, form: 'notice', summary: 'target' },
  }), { surfaceOp: 'append' })
}

/** Create one session rooted at `hostRoot` and bind it to the fake container. */
async function boundSession(): Promise<SessionId> {
  const session = ctx.sessions.create(SessionId('bound'), { meta: { cwd: hostRoot } })
  rememberTarget(session as never, {
    kind: 'container',
    containerId: 'ctr_test',
    name: 'test-box',
    workspace: '/workspace',
    hostRoot,
  })
  await until(() => ctx.get('sessionbox') !== undefined)
  return session.id
}

describe('container routing', () => {
  it('writes, reads, and lists inside the container, with the host path mapped', async () => {
    await boundSession()

    const target = await ctx.fs.resolve('notes/today.txt', { cwd: hostRoot })
    await ctx.fs.writeText(target, 'hello container\n')
    // The write landed on the container path, not on the host path.
    expect(server.files.get('/workspace/notes/today.txt')?.content).toBe('hello container\n')

    const read = await ctx.fs.readText(target)
    expect(read).toBe('hello container\n')

    const info = await ctx.fs.stat(target)
    expect(info?.type).toBe('file')
    // The version is the server's opaque token, passed through untouched.
    expect(String(info?.version)).toBe(server.files.get('/workspace/notes/today.txt')?.version)

    // A sibling at the workspace root, so the listing has a direct child.
    await ctx.fs.writeText(await ctx.fs.resolve('readme.md', { cwd: hostRoot }), 'top level')
    const entries = await ctx.fs.listDir(await ctx.fs.resolve('.', { cwd: hostRoot }))
    expect(entries.map((entry) => entry.name)).toEqual(['readme.md'])
  })

  it('never touches the host directory for a bound session', async () => {
    await boundSession()
    const target = await ctx.fs.resolve('only-in-container.txt', { cwd: hostRoot })
    await ctx.fs.writeText(target, 'x')

    await expect(readFile(join(hostRoot, 'only-in-container.txt'), 'utf8')).rejects.toThrow()
  })

  it('runs commands in the container with the mapped working directory', async () => {
    await boundSession()
    server.execImpl = (command) => ({ exitCode: 0, stdout: `${command} @ /workspace\n`, stderr: '' })

    const execution = await ctx.shell.execute(ctx.shell.resolve({
      command: 'pwd',
      workdir: hostRoot,
      sandboxPolicy: policy('bound'),
    }))
    const result = await execution.result()

    expect(result.stdout.text).toContain('pwd @ /workspace')
    expect(server.execs.at(-1)?.cwd).toBe('/workspace')
  })

  it('keeps a relative path inside the container when the working directory left the project', async () => {
    const sessionId = await boundSession()
    const outside = await mkdtemp(join(tmpdir(), 'sessionbox-outside-'))
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { id: sessionId } }),
    } as never)
    try {
      const target = await ctx.fs.resolve('after-cd.txt', { cwd: outside })
      await ctx.fs.writeText(target, 'still routed')
      expect(server.files.get('/workspace/after-cd.txt')?.content).toBe('still routed')
      await expect(readFile(join(hostRoot, 'after-cd.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('resolves a relative path under the container directory a change named', async () => {
    const sessionId = await boundSession()
    ctx.provide('agents', {
      currentInitiator: () => ({ session: { id: sessionId } }),
    } as never)

    // A `working_directory({ cd })` inside a bound session resolves through the
    // router, so the service stores this container path, not a host path.
    const target = await ctx.fs.resolve('inside.txt', { cwd: '/workspace/sub' })
    await ctx.fs.writeText(target, 'nested')
    expect(server.files.get('/workspace/sub/inside.txt')?.content).toBe('nested')
  })

  it('starts a command at the workspace root when its working directory left the project', async () => {
    await boundSession()
    server.execImpl = (command) => ({ exitCode: 0, stdout: `${command}\n`, stderr: '' })
    const outside = await mkdtemp(join(tmpdir(), 'sessionbox-outside-'))
    try {
      const execution = await ctx.shell.execute(ctx.shell.resolve({
        command: 'pwd',
        workdir: outside,
        sandboxPolicy: policy('bound'),
      }))
      await execution.result()
      expect(server.execs.at(-1)?.cwd).toBe('/workspace')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('keeps an unbound session on the host filesystem', async () => {
    await writeFile(join(hostRoot, 'host-file.txt'), 'on the host\n', 'utf8')

    const target = await ctx.fs.resolve('host-file.txt', { cwd: hostRoot })
    expect(await ctx.fs.readText(target)).toBe('on the host\n')
    // Nothing reached the container.
    expect(server.files.size).toBe(0)
    expect(server.operations).toEqual([])
  })

  it('reports the binding through the projection and the Remote catalog', async () => {
    const id = await boundSession()
    const session = ctx.sessions.get(id)
    expect(session).toBeDefined()

    const state = ctx.sessionProjections.stateOf(session!, 'executionTarget')
    expect(state?.target).toMatchObject({ kind: 'container', containerId: 'ctr_test', name: 'test-box' })

    const catalog = await ctx.sessionbox.containers()
    expect(catalog.problem).toBeUndefined()
    expect(catalog.containers.map((container) => container.name)).toEqual(['test-box'])
    expect(catalog.targets[id]).toMatchObject({ kind: 'container', name: 'test-box' })
  })

  it('rebuilds the binding from the session log when the plugin reloads', async () => {
    await boundSession()
    const target = await ctx.fs.resolve('after-reload.txt', { cwd: hostRoot })
    await ctx.fs.writeText(target, 'still routed')

    // A fresh service instance folds the same session log back into routing.
    const reloaded = new Context()
    await reloaded.plugin(SessionStore)
    await reloaded.plugin(SessionProjectionRegistry)
    await reloaded.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: hostRoot })
    await reloaded.plugin(LocalSandboxProvider)
    reloaded.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'store' }) } as never)
    const restored = reloaded.sessions.create(SessionId('bound'), { meta: { cwd: hostRoot } })
    rememberTarget(restored as never, {
      kind: 'container', containerId: 'ctr_test', name: 'test-box', workspace: '/workspace', hostRoot,
    })
    await reloaded.plugin(SessionBoxService, { baseUrl, tokenRef: 'SESSIONBOX_TEST_TOKEN' })
    await until(() => reloaded.get('fs') !== undefined)

    const readBack = await reloaded.fs.resolve('after-reload.txt', { cwd: hostRoot })
    expect(await reloaded.fs.readText(readBack)).toBe('still routed')

    await reloaded.fiber.dispose()
  })
})

describe('the /sessionbox command', () => {
  /** The command service reads only the receiving agent's session and scope. */
  function agentFor(session: ReturnType<Context['sessions']['create']>) {
    return { id: session.id, session, ctx } as never
  }

  async function run(line: string, session: ReturnType<Context['sessions']['create']>) {
    const execution = await ctx.commands.execute(agentFor(session), line, [], new AbortController().signal)
    return execution?.result
  }

  it('lists the current target and the containers it can bind', async () => {
    const session = ctx.sessions.create(SessionId('listing'), { meta: { cwd: hostRoot } })
    const result = await run('/sessionbox', session)

    expect(result).toMatchObject({ kind: 'success' })
    expect((result as { text: string }).text).toContain('current host')
    expect((result as { text: string }).text).toContain('test-box')
  })

  it('binds without a reminder while the session has no protected head', async () => {
    const session = ctx.sessions.create(SessionId('fresh'), { meta: { cwd: hostRoot } })
    const result = await run('/sessionbox test-box', session)

    expect(result).toMatchObject({ kind: 'success' })
    // Routing is live immediately; only the durable record waits, because the
    // log format refuses a reminder that would precede the protected head.
    const target = await ctx.fs.resolve('fresh.txt', { cwd: hostRoot })
    await ctx.fs.writeText(target, 'routed')
    expect(server.files.has('/workspace/fresh.txt')).toBe(true)
    expect(session.ownEvents().some(
      (event) => event.type === 'user/message' && event.data.source.kind === 'sessionbox-target',
    )).toBe(false)
  })

  it('binds a session, records the target, and tells the model what changed', async () => {
    const session = ctx.sessions.create(SessionId('switching'), { meta: { cwd: hostRoot } })
    // A real message first: the reminder may only join a surface that already
    // has a protected head, or the log becomes unloadable.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = await run('/sessionbox test-box', session)

    expect(result).toMatchObject({ kind: 'success', text: 'container test-box' })
    expect(ctx.sessionProjections.stateOf(session, 'executionTarget')?.target)
      .toMatchObject({ kind: 'container', containerId: 'ctr_test' })

    // The model-visible reminder: which filesystem, which root, and the fact
    // that the host spelling is not a shared directory.
    const reminder = session.ownEvents().find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'sessionbox-target',
    )
    expect(reminder).toBeDefined()
    const text = (reminder as { data: { content: Array<{ text: string }> } }).data.content
      .map((block) => block.text).join('\n')
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('test-box')
    expect(text).toContain('/workspace')
    expect(text).toContain('NOT a shared directory')
    expect(text).toContain(hostRoot)

    // And the session is routed now.
    const target = await ctx.fs.resolve('from-command.txt', { cwd: hostRoot })
    await ctx.fs.writeText(target, 'routed')
    expect(server.files.has('/workspace/from-command.txt')).toBe(true)
  })

  it('reports the current directory beside the workspace identity', async () => {
    // The harness tracks the session's directory separately from the original
    // project (`header.cwd`), so a switch reminder names both.
    ctx.provide('workingDirectory', { get: () => '/moved/elsewhere' } as never)
    const session = ctx.sessions.create(SessionId('moved-directory'), { meta: { cwd: hostRoot } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await run('/sessionbox test-box', session)

    const reminder = session.ownEvents().find(
      (event) => event.type === 'user/message' && event.data.source.kind === 'sessionbox-target',
    )
    const text = (reminder as { data: { content: Array<{ text: string }> } }).data.content
      .map((block) => block.text).join('\n')
    expect(text).toContain('The current directory is /moved/elsewhere.')
    expect(text).toContain(hostRoot)
  })

  it('switches back to the host and says so', async () => {
    const session = ctx.sessions.create(SessionId('returning'), { meta: { cwd: hostRoot } })
    // A real message first, so both switches can record their reminder.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await run('/sessionbox test-box', session)
    const result = await run('/sessionbox host', session)

    expect(result).toMatchObject({ kind: 'success', text: 'host' })
    expect(ctx.sessionProjections.stateOf(session, 'executionTarget')?.target).toEqual({ kind: 'host' })

    // The host backend is in charge again: this reads the real file written below.
    await writeFile(join(hostRoot, 'back-on-host.txt'), 'host content\n', 'utf8')
    const target = await ctx.fs.resolve('back-on-host.txt', { cwd: hostRoot })
    expect(await ctx.fs.readText(target)).toBe('host content\n')
  })

  it('reports an unknown container instead of binding anything', async () => {
    const session = ctx.sessions.create(SessionId('unknown'), { meta: { cwd: hostRoot } })
    const result = await run('/sessionbox no-such-box', session)

    expect(result).toMatchObject({ kind: 'error' })
    expect((result as { text: string }).text).toContain('no-such-box')
    expect(ctx.sessionProjections.stateOf(session, 'executionTarget')?.target).toBeNull()
  })

  it('withholds the terminal tools from a session bound to a container', async () => {
    // The terminal tools open their shell through `ctx.subprocess.spawnTerminal`,
    // and the subprocess seam forwards an allowlist of programs — so an
    // unrestricted terminal in a bound session would open the host's shell.
    const registered = new Set(['pwsh', ...CONTAINER_TOOL_NAMES])
    const restrictions: Array<{ deny?: readonly string[] }> = []
    ctx.provide('tools', {
      // `restrict()` refuses a name this harness does not register, so the
      // plugin asks the registry which tools exist before building the mask.
      get: (name: string) => registered.has(name) ? { name } : undefined,
      restrict: (options: { deny?: readonly string[] }) => {
        restrictions.push(options)
        return () => {}
      },
    } as never)

    const session = ctx.sessions.create(SessionId('bound-tools'), { meta: { cwd: hostRoot } })
    await run('/sessionbox test-box', session)
    const agent = {
      session,
      ctx: { get: (name: string) => (name === 'tools' ? ctx.get('tools') : undefined) },
    }
    ctx.emit('agent/created', { agent } as never)

    const denied = restrictions.at(-1)?.deny ?? []
    for (const name of CONTAINER_TOOL_NAMES) expect(denied).toContain(name)
    // The Windows host shell does not exist in a Linux container either.
    expect(denied).toContain('pwsh')
  })

  it('keeps the rest of the boundary when an optional tool is not registered', async () => {
    // The `terminal_*` tools ship in an optional bundle. When that bundle is
    // absent, `restrict()` would reject their names and discard the whole
    // mask — including `pwsh` — so the plugin only names tools the registry
    // actually has.
    const restrictions: Array<{ deny?: readonly string[] }> = []
    ctx.provide('tools', {
      get: (name: string) => name === 'pwsh' ? { name } : undefined,
      restrict: (options: { deny?: readonly string[] }) => {
        restrictions.push(options)
        return () => {}
      },
    } as never)

    const session = ctx.sessions.create(SessionId('bound-optional-tools'), { meta: { cwd: hostRoot } })
    await run('/sessionbox test-box', session)
    const agent = {
      session,
      ctx: { get: (name: string) => (name === 'tools' ? ctx.get('tools') : undefined) },
    }
    ctx.emit('agent/created', { agent } as never)

    expect(restrictions.at(-1)?.deny).toEqual(['pwsh'])
  })
})
