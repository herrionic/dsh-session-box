/**
 * Live verification against a real SessionBox deployment.
 *
 * Everything here needs a server, a token, and one running container, so the
 * suite skips itself when `SESSIONBOX_URL` is unset — the same shape the harness
 * uses for keyed suites. It drives the plugin's own container backends over the
 * real agent protocol, which is the half of the integration a fake server cannot
 * prove: real `version` tokens, real symlinks, real process-group cancellation,
 * and the real ripgrep provisioning path that `glob`/`grep` depend on.
 *
 *   $env:SESSIONBOX_URL='http://host:8787'; $env:SESSIONBOX_TOKEN='sbt_…';
 *   pnpm --filter @sessionbox/dsh-plugin test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionBoxClient, type ContainerRuntime } from '@sessionbox/client'
import { ContainerFileSystem } from '../src/container-fs.ts'
import { ContainerShell } from '../src/container-shell.ts'
import { ContainerSubprocess } from '../src/container-subprocess.ts'
import { ContainerPool } from '../src/pool.ts'

const baseUrl = process.env.SESSIONBOX_URL
const token = process.env.SESSIONBOX_TOKEN
const containerId = process.env.SESSIONBOX_CONTAINER

const limits = { defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024 }
const workspace = '/workspace'
const fence = { policy: { mode: 'workspace-write', workspaceRoot: workspace } as never, workspace }
const open = { policy: { mode: 'danger-full-access', workspaceRoot: workspace } as never, workspace }

let client: SessionBoxClient
let runtime: ContainerRuntime
let fs: ContainerFileSystem
let shell: ContainerShell
let subprocess: ContainerSubprocess
let target: string

describe.skipIf(baseUrl === undefined || token === undefined)('live container', () => {
  beforeAll(async () => {
    client = new SessionBoxClient({ baseUrl: baseUrl as string, token })
    const containers = await client.listContainers()
    const container = containerId === undefined
      ? containers.find((candidate) => candidate.status === 'running')
      : containers.find((candidate) => candidate.id === containerId)
    if (container === undefined) throw new Error('no running container to verify against')
    runtime = await client.connect(container.id)
    fs = new ContainerFileSystem(runtime)
    shell = new ContainerShell(runtime, limits)
    subprocess = new ContainerSubprocess(runtime, limits)
    target = `${workspace}/sessionbox-verification.txt`
  })

  afterAll(async () => {
    await runtime?.close()
  })

  it('reports the server version token unchanged across write, stat, and read', async () => {
    const written = await fs.writeText(target, 'first line\n', undefined, undefined, open)
    const stat = await fs.stat(target)
    const listing = await fs.listDir(workspace)

    expect(String(stat?.version)).toBe(String(written.version))
    expect(String(listing.find((entry) => entry.path === target)?.version)).toBe(String(written.version))
  })

  it('edits literal text with a version guard', async () => {
    const before = await fs.stat(target)
    const edited = await fs.editText(target, { oldString: 'first', newString: 'second', replaceAll: false }, { version: before?.version as never }, undefined, open)
    expect(edited.after).toBe('second line\n')

    const stale = await fs.editText(target, { oldString: 'second', newString: 'third', replaceAll: false }, { version: before?.version as never }, undefined, open)
      .then(() => undefined, (error: { code?: string }) => error.code)
    expect(stale).toBe('FS_STALE_VERSION')
  })

  it('separates binary from text exactly as the protocol promises', async () => {
    const text = await fs.readText('/etc/hostname')
    expect(text.length).toBeGreaterThan(0)

    const notText = await fs.readText('/usr/bin/mawk').then(() => undefined, (error: { code?: string }) => error.code)
    expect(notText).toBe('FS_NOT_TEXT')

    const bytes = await fs.readBytes('/usr/bin/mawk', undefined, 8 * 1024 * 1024)
    expect([...bytes.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46])
  })

  it('reports a symlink from lstat without following it', async () => {
    const link = await fs.lstat('/etc/alternatives/awk')
    expect(link?.type).toBe('symlink')
  })

  it('lists a directory whose children the caller may not read', async () => {
    const entries = await fs.listDir('/etc')
    expect(entries.length).toBeGreaterThan(10)
  })

  it('refuses a write outside the container workspace under workspace-write', async () => {
    const denied = await fs.writeText('/etc/sessionbox-verification', 'x', undefined, undefined, fence)
      .then(() => undefined, (error: { code?: string }) => error.code)
    expect(denied).toBe('FS_SANDBOX_DENIED')
    expect(await fs.stat('/etc/sessionbox-verification')).toBeUndefined()
  })

  it('runs commands in the workspace and reports the container identity', async () => {
    const execution = await shell.execute(shellSpec('pwd; id -u; test -w /workspace && echo WRITABLE', workspace), workspace)
    const result = await execution.result()

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain(workspace)
    expect(result.stdout.text).toContain('WRITABLE')
  })

  it('cancels a long command and leaves no process behind', async () => {
    const controller = new AbortController()
    // `execute` resolves only once the exec settles, so the abort has to be
    // scheduled against the in-flight call rather than after it.
    const started = shell.execute(shellSpec('sleep 600 & sleep 600; echo never', workspace, controller.signal), workspace)
    setTimeout(() => { controller.abort() }, 1_500)

    const result = await (await started).result()
    expect(result.aborted).toBe(true)
    expect(result.stdout.text).not.toContain('never')

    // The process group must be gone, not merely detached from this connection.
    // The bracket keeps the probe from matching its own command line.
    const survivors = await shell.execute(shellSpec("pgrep -f 'sleep 6[0]0' | wc -l", workspace), workspace)
    const count = Number((await survivors.result()).stdout.text.trim() || '0')
    expect(count).toBe(0)
  })

  it('provisions ripgrep and runs a search through the subprocess seam', async () => {
    const ctx = new Context()
    const pool = new ContainerPool(ctx, async () => ({
      baseUrl: baseUrl as string,
      token,
      tokenRef: 'SESSIONBOX_TOKEN' as never,
      containerRoot: workspace,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024,
      requestTimeoutMs: 30_000,
      provisionRipgrep: true,
      containerPrograms: ['rg'],
      signature: 'live',
    }))

    await pool.ensureSearchTool((await client.getContainer(containerId ?? (await client.listContainers())[0]?.id ?? '')).id)
    expect(pool.hasSearchTool((await client.listContainers())[0]?.id ?? '')).toBe(true)
    await pool.close()

    // The harness spawns ripgrep by an absolute host path; the router rewrites
    // it to the container's own binary. This is that path, end to end.
    const handle = subprocess.spawn({
      argv: ['C:\\host\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', '--no-config', '--files', '--glob=*.txt', '--', workspace],
      cwd: workspace,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 4096 } },
      graceMs: 2_000,
    } as never, {
      workdir: workspace,
      translateArgv: (argv) => ['rg', ...argv.slice(2)],
      timeoutMs: 20_000,
    })

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
    expect(handle.collected.stdout?.readFrom(0).text).toContain('sessionbox-verification.txt')
  })
})

/** One shell spec with the plugin's own defaults. */
function shellSpec(command: string, workdir: string, signal?: AbortSignal) {
  return {
    command,
    workdir,
    timeoutMs: 30_000,
    onExpiry: 'kill' as const,
    stdoutMaxBytes: 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  } as never
}
