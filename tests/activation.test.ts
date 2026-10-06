/**
 * Activation regression test.
 *
 * The plugin's patch disables the host `fs`, `shell`, and `subprocess` rows and
 * re-mounts those providers inside isolated service realms. The host shell
 * executors themselves `inject: ['subprocess']`, so a load order that starts
 * with the shell realm parks it forever on a service only this plugin can
 * provide — and because `tool-fs`/`tool-bash` inject `fs`/`shell`, a router that
 * never registers leaves the whole harness unloaded instead of failing loudly.
 *
 * This suite boots the real providers in the real shape (host rows absent) and
 * asserts that activation completes, that all three routing providers end up in
 * the outer realm, that a host-path call still reaches a working backend, and
 * that the Remote endpoint the browser half mounts is declared.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { SessionBoxService } from '../src/index.ts'

/** Boot the minimal real composition the plugin activates against. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(CommandRuntime)
  return ctx
}

/** Wait for one condition, bounded. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition never became true')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

describe('sessionbox activation', () => {
  it('publishes all three routing providers without the host rows', async () => {
    const ctx = await boot()
    await ctx.plugin(SessionBoxService, {})

    // Immediately, with no waiting: the loader's activation barrier must see
    // these services the moment the plugin loads. Awaiting the isolated realms
    // first is what made a slow first load report `fs`/`shell` as never
    // activated — and roll the whole composition back with them.
    expect(ctx.get('fs')?.constructor.name).toBe('RoutingFileSystem')
    expect(ctx.get('shell')?.constructor.name).toBe('RoutingShellExecutor')
    expect(ctx.get('subprocess')?.constructor.name).toBe('RoutingSubprocessProvider')
    // The routing filesystem reports the host backend's confinement fact.
    expect(ctx.fs.sandboxMode).toBe('workspace-write')

    // And the deferred delegate becomes transparent once the realm finishes.
    await until(() => ctx.get('fs') !== undefined && ctx.get('shell') !== undefined)
    const target = await ctx.fs.resolve('package.json', { cwd: process.cwd() })
    expect((await ctx.fs.stat(target))?.type).toBe('file')

    await ctx.fiber.dispose()
  })

  it('serves a host-path read through the isolated host backend', async () => {
    const ctx = await boot()
    await ctx.plugin(SessionBoxService, {})
    await until(() => ctx.get('fs') !== undefined)

    // No session is bound to a container, so this must land on the host
    // backend: the isolated realm holds the delegate, not a replacement.
    const target = await ctx.fs.resolve('package.json', { cwd: process.cwd() })
    const info = await ctx.fs.stat(target)
    expect(info?.type).toBe('file')
    expect(await ctx.fs.readText(target)).toContain('@sessionbox/dsh-plugin')
    expect(ctx.fs.processPath(target)).toBe(String(target.targetKey))

    await ctx.fiber.dispose()
  })

  it('declares the Remote endpoint and the execution-target projection', async () => {
    const ctx = await boot()
    await ctx.plugin(SessionBoxService, {})
    await until(() => ctx.get('sessionbox') !== undefined)

    expect(remoteMethods(ctx.sessionbox)).toEqual([
      { method: 'containers', invocation: { kind: 'direct' } },
    ])

    const session = ctx.sessions.create()
    expect(ctx.sessionProjections.stateOf(session, 'executionTarget'))
      .toEqual({ target: null, announced: null })

    await ctx.fiber.dispose()
  })
})
