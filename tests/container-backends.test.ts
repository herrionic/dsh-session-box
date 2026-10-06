/**
 * Container backend behaviour: the protocol semantics the routing layer relies
 * on, exercised against a double that speaks the same operations.
 */
import { describe, expect, it } from 'vitest'
import type { ContainerRuntime } from '@sessionbox/client'
import { SessionBoxClientError } from '@sessionbox/client'
import { ContainerFileSystem } from '../src/container-fs.ts'
import { ContainerShell } from '../src/container-shell.ts'
import { ContainerSubprocess } from '../src/container-subprocess.ts'
import { FakeRuntime } from './fake-runtime.ts'

const OPEN = { policy: { mode: 'danger-full-access', workspaceRoot: '/workspace' } as never, workspace: '/workspace' }

function files(runtime: FakeRuntime): ContainerFileSystem {
  return new ContainerFileSystem(runtime as unknown as ContainerRuntime)
}

describe('container filesystem', () => {
  it('passes the protocol version through instead of synthesizing one', async () => {
    const runtime = new FakeRuntime()
    runtime.file('/workspace/a.txt', 'hello', '2492450:5:1791187998000000000:1791188004076825949')

    const info = await files(runtime).stat('/workspace/a.txt')
    expect(String(info?.version)).toBe('2492450:5:1791187998000000000:1791188004076825949')
    expect(info?.size).toBe(5)
  })

  it('reports a symlink from lstat without following it', async () => {
    const runtime = new FakeRuntime()
    runtime.entries.set('/workspace/link', { content: '', type: 'symlink', version: 'v:1', size: 0, mode: 0o777 })

    const info = await files(runtime).lstat('/workspace/link')
    expect(info?.type).toBe('symlink')
    expect(runtime.calls.at(-1)?.follow).toBe(false)
  })

  it('lists a directory whose children the caller may not read', async () => {
    const runtime = new FakeRuntime()
    runtime.directory('/etc')
    runtime.file('/etc/shadow', 'secret')
    runtime.binaryPaths.add('/etc/shadow')

    const entries = await files(runtime).listDir('/etc')
    expect(entries.map((entry) => entry.name)).toEqual(['shadow'])
    // Listing never read the file, so the invariant holds by construction.
    expect(runtime.calls.some((call) => call.operation === 'readFile')).toBe(false)
  })

  it('reads binary content as bytes', async () => {
    const runtime = new FakeRuntime()
    runtime.entries.set('/workspace/logo.png', { content: '\u007fELF', type: 'file', version: 'v:1', size: 4, mode: 0o644 })

    const bytes = await files(runtime).readBytes('/workspace/logo.png', undefined, 1024)
    expect([...bytes]).toEqual([0x7f, 0x45, 0x4c, 0x46])
  })

  it('maps FS_NOT_TEXT and FS_TOO_LARGE onto the closed error vocabulary', async () => {
    const runtime = new FakeRuntime()
    runtime.binaryPaths.add('/workspace/bin')
    runtime.file('/workspace/bin', 'binary')

    await expect(files(runtime).readText('/workspace/bin')).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(files(runtime).readBytes('/workspace/bin', undefined, 2)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('fences a workspace-write mutation inside the container', async () => {
    const runtime = new FakeRuntime()
    runtime.file('/workspace/a.txt', 'old')
    const fs = files(runtime)
    const fence = { policy: { mode: 'workspace-write', workspaceRoot: '/workspace' } as never, workspace: '/workspace' }

    // The container is the security boundary: its own system files are fair
    // game, and the backend reports the real permission error when the
    // container's user may not write there. Only `read-only` refuses.
    await expect(fs.writeText('/etc/passwd', 'nope', undefined, undefined, fence))
      .resolves.toMatchObject({ after: 'nope' })
    await expect(fs.writeText('/workspace/a.txt', 'new', undefined, undefined, fence)).resolves.toMatchObject({
      operation: 'update',
      before: 'old',
      after: 'new',
    })
    await expect(fs.writeText('/workspace/b.txt', 'x', undefined, undefined, { policy: { mode: 'read-only', workspaceRoot: '/workspace' } as never, workspace: '/workspace' }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('guards a versioned write and reports the conflict as stale', async () => {
    const runtime = new FakeRuntime()
    runtime.file('/workspace/a.txt', 'one', 'v1')
    const fs = files(runtime)

    await expect(fs.writeText('/workspace/a.txt', 'two', { kind: 'replaceIfVersion', version: 'stale' as never }, undefined, OPEN))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.writeText('/workspace/a.txt', 'two', { kind: 'replaceIfVersion', version: 'v1' as never }, undefined, OPEN))
      .resolves.toMatchObject({ after: 'two' })
    await expect(fs.writeText('/workspace/new.txt', 'x', { kind: 'createIfAbsent' }, undefined, OPEN))
      .resolves.toMatchObject({ operation: 'create', before: null })
  })

  it('edits literal text and rejects an ambiguous match', async () => {
    const runtime = new FakeRuntime()
    runtime.file('/workspace/a.txt', 'x x')
    const fs = files(runtime)

    await expect(fs.editText('/workspace/a.txt', { oldString: 'x', newString: 'y', replaceAll: false }, undefined, undefined, OPEN))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    await expect(fs.editText('/workspace/a.txt', { oldString: 'x', newString: 'y', replaceAll: true }, undefined, undefined, OPEN))
      .resolves.toMatchObject({ before: 'x x', after: 'y y' })
  })
})

describe('container shell', () => {
  const limits = { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, maxOutputBytes: 1024 }

  function spec(command: string, extra: Record<string, unknown> = {}) {
    return {
      command,
      workdir: '/workspace',
      timeoutMs: 1_000,
      onExpiry: 'kill' as const,
      stdoutMaxBytes: 1024,
      ...extra,
    } as never
  }

  it('forwards the caller signal so the server can kill the process group', async () => {
    const runtime = new FakeRuntime()
    runtime.execError = new SessionBoxClientError('OPERATION_CANCELLED', 'cancelled')
    const controller = new AbortController()

    const execution = await new ContainerShell(runtime as unknown as ContainerRuntime, limits)
      .execute(spec('sleep 600', { signal: controller.signal }), '/workspace')
    const result = await execution.result()

    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(runtime.calls[0]?.signal).toBe(controller.signal)
  })

  it('reports a protocol deadline as a timeout, not a failure', async () => {
    const runtime = new FakeRuntime()
    runtime.execError = new SessionBoxClientError('OPERATION_TIMEOUT', 'too slow')

    const execution = await new ContainerShell(runtime as unknown as ContainerRuntime, limits)
      .execute(spec('sleep 600'), '/workspace')
    const result = await execution.result()

    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  it('runs the command in the mapped container directory', async () => {
    const runtime = new FakeRuntime()
    runtime.execResults.push({ exitCode: 0, stdout: '/workspace\n', stderr: '' })

    const execution = await new ContainerShell(runtime as unknown as ContainerRuntime, limits)
      .execute(spec('pwd'), '/workspace')
    const result = await execution.result()

    expect(result.stdout.text).toBe('/workspace\n')
    expect(runtime.calls[0]?.cwd).toBe('/workspace')
  })
})

describe('container subprocess', () => {
  const limits = { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000 }

  it('serves collected output to the offset reader after settlement', async () => {
    const runtime = new FakeRuntime()
    runtime.execResults.push({ exitCode: 0, stdout: 'match\n', stderr: '' })
    const backend = new ContainerSubprocess(runtime as unknown as ContainerRuntime, limits)

    const handle = backend.spawn({
      argv: ['/host/node_modules/@vscode/ripgrep/bin/rg.exe', '--files'],
      cwd: 'C:\\work',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 1000,
    } as never, {
      workdir: '/workspace',
      translateArgv: (argv) => ['rg', ...argv.slice(1)],
      timeoutMs: 1_000,
    })

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('match\n')
    // The host-resolved ripgrep path cannot exist in the container.
    expect(runtime.calls[0]?.content).toContain('rg')
    expect(runtime.calls[0]?.content).not.toContain('rg.exe')
  })

  it('reports a killed child as a signal death', async () => {
    const runtime = new FakeRuntime()
    runtime.execError = new SessionBoxClientError('OPERATION_CANCELLED', 'cancelled')
    const backend = new ContainerSubprocess(runtime as unknown as ContainerRuntime, limits)

    const handle = backend.spawn({
      argv: ['rg', '--files'],
      cwd: 'C:\\work',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
      graceMs: 1000,
    } as never, { workdir: '/workspace', translateArgv: (argv) => argv, timeoutMs: 1_000 })

    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })
})
