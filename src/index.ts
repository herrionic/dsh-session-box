/**
 * SessionBox execution targets for DeepSeek Harness.
 *
 * The plugin keeps the harness on the host and adds a second execution world:
 * a session can be bound to a SessionBox container, after which `ctx.fs`,
 * `ctx.shell`, and the agent's share of `ctx.subprocess` run inside that
 * container while everything else —he GUI, session storage, host-side
 * observers —eeps working unchanged.
 *
 * Everything the user does happens on a page:
 *
 * - `baseUrl` and the credential name are plugin settings, editable in place;
 * - `/sessionbox <container>` is the single write path that binds a session;
 * - the session projection `executionTarget` is what the input-bar chip reads.
 *
 * Host providers are not discarded. They are loaded into isolated service
 * realms (`ctx.isolate('fs')` and friends) and the routing providers delegate
 * to them, so a session on the host behaves exactly as it did before the
 * plugin was installed.
 *
 * @module @sessionbox/dsh-plugin
 */

import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import * as bashToolPlugin from '@deepseek-ai/dsh-tool-bash'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { Config as configSchema, resolveConfig, type Config as PluginConfig, type ResolvedConfig } from './config.ts'
import { deferredBackend } from './deferred.ts'
import { ContainerPool } from './pool.ts'
import { ContainerAccessImpl } from './access.ts'
import { ExecutionTargetRegistry } from './target.ts'
import { RoutingFileSystem } from './routing-fs.ts'
import { RoutingShellExecutor } from './routing-shell.ts'
import { RoutingSubprocessProvider } from './routing-subprocess.ts'
import type { ContainerBoundary, ContainerSummaryView, ExecutionTarget, ExecutionTargetState } from './types.ts'

export type { Config } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionbox: SessionBoxService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The execution-target reminder this plugin injects on every switch. */
    'sessionbox-target': { kind: 'sessionbox-target'; target: ExecutionTarget } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The session's binding plus whether the transcript already explains it. */
    executionTarget: ExecutionTargetState
  }
  interface SessionProjectionMap {
    /** Client view of the execution target, read by the input-bar chip. */
    executionTarget: ExecutionTargetView
  }
}

/** Client view of one session's execution target. */
export interface ExecutionTargetView {
  kind: 'host' | 'container'
  containerId?: string
  name?: string
  workspace?: string
  hostRoot?: string
  announced: boolean
}

/** What the browser half reads to populate the container picker. */
export interface ContainerCatalog {
  /** Whether a server and a token are configured at all. */
  configured: boolean
  /** Human-readable reason the catalog is empty, when it is. */
  problem?: string
  /** The container list, newest first as the server orders it. */
  containers: ContainerSummaryView[]
  /** The target each session is currently bound to, keyed by session id. */
  targets: Record<string, ExecutionTargetView>
  /** Target a newly created session starts on, so a draft can show the choice. */
  defaultTarget: string
}

const targetSchema: zod.ZodType<ExecutionTarget> = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('host') }),
  zod.object({
    kind: zod.literal('container'),
    containerId: zod.string().min(1),
    name: zod.string(),
    workspace: zod.string().min(1),
    hostRoot: zod.string().min(1),
  }),
])

/**
 * The durable session→target store.
 *
 * The binding is plugin state, not session data: a custom session event type
 * cannot be marked ignorable through `append`, so a harness reading the log
 * without this plugin would refuse it outright. A storage domain keeps it
 * durable without touching the session format, and it works for a session that
 * has no log content yet — exactly the new-session case.
 */
const BINDINGS_DOMAIN = defineDomain({
  name: 'sessionbox',
  version: 1,
  tables: { bindings: domainTable(targetSchema) },
})

const targetViewSchema: zod.ZodType<ExecutionTargetView> = zod.object({
  kind: zod.union([zod.literal('host'), zod.literal('container')]),
  containerId: zod.string().optional(),
  name: zod.string().optional(),
  workspace: zod.string().optional(),
  hostRoot: zod.string().optional(),
  announced: zod.boolean(),
})

const stateSchema: zod.ZodType<ExecutionTargetState> = zod.object({
  target: targetSchema.nullable(),
  announced: targetSchema.nullable(),
})

/**
 * Execution targets for DeepSeek Harness: one session at a time, on the host or
 * inside a SessionBox container.
 */
export class SessionBoxService extends TypertRemoteService {
  static Config = configSchema
  /**
   * The one hard dependency: the projection registry is what makes a binding
   * durable and readable by the browser half.
   *
   * Every other collaborator —`sessions`, `agents`, `tools`, `systemPrompt`,
   * `sandboxPolicy`, `credentials`, `commands` —is read with `ctx.get()`.
   * Injection blocks activation until a service appears, and this plugin's own
   * patch removes host rows, so a blocked activation would leave the harness
   * waiting on services only this plugin provides.
   */
  static inject = ['sessionProjections']

  private readonly pool: ContainerPool
  private readonly access: ContainerAccessImpl
  private readonly targets = new ExecutionTargetRegistry()
  /** Per-agent tool-surface disposers, keyed by the agent that owns them. */
  private surfaces = new WeakMap<Agent, Array<() => void>>()
  private readonly config: PluginConfig

  /**
   * @param ctx - plugin context; owns the routers, the isolated host realms, and every listener.
   * @param config - volatile plugin configuration.
   */
  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, 'sessionbox')
    this.config = config
    this.pool = new ContainerPool(ctx, () => this.settings())
    this.access = new ContainerAccessImpl(ctx, this.pool, () => this.settings())

    this.registerProjection()
    this.reseed()
    ctx.on('session/created', (session) => {
      this.reseedSession(session)
      void this.applyDefaultTarget(session)
    })
    ctx.on('session/event', (session, event) => {
      const reminded = targetOfReminder(event)
      if (reminded !== undefined) {
        this.bind(session, reminded)
        this.pending.delete(session.id)
        return
      }
      // The person's first real message makes the surface safe for a reminder a
      // blank session could not take: the log format refuses a reminder that
      // would precede the protected head, so the binding waited in memory.
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      const waiting = this.pending.get(session.id)
      if (waiting === undefined) return
      this.pending.delete(session.id)
      session.append('user/message', reminderMessage(waiting, session.header.cwd ?? process.cwd()), { surfaceOp: 'append' })
    })
    ctx.on('session/disposed', (session) => { this.targets.forget(session.id) })
    ctx.on('agent/created', ({ agent }) => { this.installAgent(agent) })

    this.registerCommand()

    ctx.effect(() => {
      try {
        this.install()
      } catch (error: unknown) {
        this.ctx.logger.error(`sessionbox: activation failed: ${message(error)}`)
        this.restoreUnrouted()
      }
      void this.bindingsDomain()
      return () => {
        this.surfaces = new WeakMap()
        for (const boundary of this.targets.list()) this.access.forget(boundary.containerId)
        void this.pool.close()
      }
    }, 'sessionbox: routing providers')
  }

  /**
   * The open bindings domain, or undefined while the facility is not mounted.
   *
   * `ctx.storage` is only a backend registry — it performs no IO — so the domain
   * facility is the entry point, and it routes the domain to a backend itself.
   * The absence of the facility is *not* cached: this plugin's row is applied
   * before the base bundle's storage rows, so the first attempt legitimately
   * finds nothing, and caching that would leave every binding in memory only —
   * the session would come back on the host after a restart.
   *
   * @returns the domain, or undefined when storage is not up yet or failed to open.
   */
  private async bindingsDomain(): Promise<Domain<typeof BINDINGS_DOMAIN> | undefined> {
    if (this.domain !== undefined) return this.domain
    if (this.domainPending === undefined) {
      const pending = this.openDomain()
      this.domainPending = pending
      void pending.then((domain) => { if (domain === undefined) this.domainPending = undefined })
    }
    return await this.domainPending
  }

  /** Open the domain once the facility exists, applying whatever it already holds. */
  private async openDomain(): Promise<Domain<typeof BINDINGS_DOMAIN> | undefined> {
    const facility = this.ctx.get('storageDomain') as StorageDomainFacility | undefined
    if (facility === undefined) return undefined
    try {
      const domain = await facility.open(BINDINGS_DOMAIN)
      this.domain = domain
      const table = domain.table('bindings')
      this.hydrating = true
      try {
        for (const [sessionId, target] of table.entries()) {
          this.stored.set(sessionId, target)
          const session = this.ctx.get('sessions')?.get(SessionId(sessionId))
          if (session !== undefined) this.bind(session, target)
        }
      } finally {
        this.hydrating = false
      }
      this.ctx.logger.info(`sessionbox: ${String([...table.keys()].length)} stored binding(s) loaded`)
      return domain
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `sessionbox: the binding store is unavailable (${message(error)}); `
        + 'bindings will not survive a restart',
      )
      return undefined
    }
  }

  /** Record one binding durably, without blocking the caller. */
  private persist(sessionId: string, target: ExecutionTarget): void {
    if (this.hydrating) return
    void this.bindingsDomain().then(
      async (domain) => { await domain?.table('bindings').put(sessionId, target) },
      () => {},
    )
  }

  /**
   * The selectable containers plus every session's current binding.
   *
   * Read on demand rather than pushed: the browser's forwarded-event allowlist
   * lives in `@deepseek-ai/dsh-api-remotes`, which a plugin cannot extend, so
   * the picker re-reads this every time it opens.
   *
   * @returns the catalog the browser half renders.
   */
  @Remote('containers')
  async containers(): Promise<ContainerCatalog> {
    const targets: Record<string, ExecutionTargetView> = {}
    // Every durable binding first. The live session list is not the authority on
    // what a session is bound to — the binding store is — and a session the host
    // has not listed yet left the browser with no entry, which it then showed as
    // "host" while the session was running in a container.
    for (const [sessionId, target] of this.stored) {
      const view = viewOf({ target, announced: target })
      targets[sessionId] = view
      // The browser half identifies a session by the bare id in some views and
      // by the `session-`-prefixed form in others, so both keys are published.
      const bare = sessionId.replace(/^session-/, '')
      if (bare !== sessionId) targets[bare] = view
    }
    for (const session of this.ctx.get('sessions')?.list() ?? []) {
      const target = this.targetOf(session)
      const view = viewOf({ target, announced: target === null ? null : target })
      targets[session.id] = view
      const bare = session.id.replace(/^session-/, '')
      if (bare !== session.id) targets[bare] = view
    }
    let settings: ResolvedConfig
    const defaultTarget = this.config.defaultTarget.get()
    try {
      settings = await this.settings()
    } catch (error) {
      return { configured: false, problem: message(error), containers: [], targets, defaultTarget }
    }
    if (settings.baseUrl === '') {
      return { configured: false, problem: 'no SessionBox server is configured', containers: [], targets, defaultTarget }
    }
    try {
      const containers = await this.pool.listContainers()
      return {
        configured: settings.token !== undefined,
        ...(settings.token === undefined
          ? { problem: `credential "${String(settings.tokenRef)}" is not set` }
          : {}),
        containers: containers.map((container) => ({
          id: container.id,
          name: container.name,
          status: container.status,
          image: container.image,
          workspace: container.workspace,
        })),
        targets,
        defaultTarget,
      }
    } catch (error) {
      return { configured: true, problem: message(error), containers: [], targets, defaultTarget }
    }
  }

  /**
   * Load the host providers in isolated realms and publish the routing providers.
   *
   * Order is load-bearing. The patch disables the host rows for `fs`, `shell`,
   * and `subprocess`, so those services only exist once this method provides
   * them —and the host shell executors themselves `inject: ['subprocess']`.
   * Loading the shell realm first would therefore park it forever on a service
   * that can only appear after it finishes, taking the whole composition down
   * with it: `tool-bash` and `tool-fs` inject `shell` and `fs`, so a router that
   * never registers leaves the harness permanently unloaded.
   *
   * The publication is therefore synchronous and the delegates are deferred: the
   * three routers exist the moment this returns, and each one resolves the host
   * backend behind it on first use. Awaiting the realms here instead would make
   * activation depend on timing —the loader reports services that have not
   * appeared yet as "did not activate" and rolls the composition back, which is
   * exactly what a slow first load used to do.
   */
  private install(): void {
    const containers = this.access
    const targets = this.targets
    const resolvePolicy = (sessionId: string | undefined, supplied: SandboxExecutionPolicy | undefined) =>
      this.resolvePolicy(sessionId, supplied)
    const fallbackCwd = process.cwd()
    // Synchronous members have no way to wait, so they answer from the policy
    // service until the host backend behind the router is up. The read stays
    // lazy: this runs while the composition is still assembling, so the policy
    // service may not be registered yet, and throwing here would take the whole
    // composition down instead of leaving one getter unanswered.
    const hostFallback = {
      get sandboxMode() {
        try {
          return resolvePolicy(undefined, undefined).mode
        } catch {
          return 'workspace-write' as const
        }
      },
    }

    // 1. Subprocess first, then its router: the host shell executors inject
    //    `subprocess`, and that service is now ours to provide.
    const subprocessRealm = this.ctx.isolate('subprocess')
    void subprocessRealm.plugin(LocalSubprocessRuntime)
    new RoutingSubprocessProvider(this.ctx, {
      local: deferredBackend(
        () => subprocessRealm.get('subprocess'),
        'subprocess',
        { spawn: () => { throw new Error('the host subprocess runtime is still activating') } },
      ),
      targets,
      containers,
      defaultTimeoutMs: this.config.defaultTimeoutMs.get(),
      containerPrograms: this.config.containerPrograms.get(),
    })

    // 2. Filesystem: the host backend injects `sandboxPolicy` only.
    const fsRealm = this.ctx.isolate('fs')
    void fsRealm.plugin(SandboxedFileSystem, {})
    new RoutingFileSystem(this.ctx, {
      local: deferredBackend(() => fsRealm.get('fs'), 'filesystem', hostFallback),
      targets,
      containers,
      fallbackCwd,
      resolvePolicy,
    })

    // 3. Shell last: its host backend now finds the `subprocess` router.
    const shellRealm = this.ctx.isolate('shell')
    const shellPlugin = process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor
    void shellRealm.plugin(shellPlugin, {})
    new RoutingShellExecutor(this.ctx, {
      local: deferredBackend(() => shellRealm.get('shell'), 'shell', hostFallback),
      targets,
      containers,
    })

    this.ctx.logger.info('sessionbox: routing providers are live (fs, shell, subprocess)')
    for (const boundary of targets.list()) this.access.prepare(boundary)
  }

  /**
   * Last resort: serve every still-missing host capability unrouted.
   *
   * The plugin's patch removes the host `fs`, `shell`, and `subprocess` rows, so
   * any failure that leaves one of them unprovided would hang every consumer
   * that injects it instead of reporting an error. Restoring the provider in the
   * outer realm trades per-session routing for a harness that still works.
   */
  private restoreUnrouted(): void {
    if (this.ctx.get('subprocess') === undefined) void this.ctx.plugin(LocalSubprocessRuntime)
    if (this.ctx.get('fs') === undefined) void this.ctx.plugin(SandboxedFileSystem, {})
    if (this.ctx.get('shell') === undefined) {
      void this.ctx.plugin(process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor, {})
    }
  }

  /** Register the client-visible execution-target projection. */
  private registerProjection(): void {
    this.ctx.sessionProjections.register({
      key: 'executionTarget',
      stateVersion: 1,
      stateSchema,
      init: () => ({ target: null, announced: null }),
      apply: (state, event) => {
        // The reminder is the binding's only durable record: a custom event
        // type would make the log unreadable to any harness without this
        // plugin, and `append` cannot mark a non-surface event ignorable.
        const target = targetOfReminder(event)
        return target === undefined ? state : { target, announced: target }
      },
      wire: {
        viewSchema: targetViewSchema,
        view: (state) => viewOf(state),
      },
    })
  }

  /** Rebuild every live session's binding from its own log. */
  private reseed(): void {
    for (const session of this.ctx.get('sessions')?.list() ?? []) this.reseedSession(session)
  }

  /** Rebuild one session's binding from its log. */
  private reseedSession(session: Session): void {
    const target = this.targetOf(session)
    if (target === null) return
    this.bind(session, target)
  }

  /**
   * Bind a session that has no binding of its own to the configured default.
   *
   * A session created while `defaultTarget` names a container starts there, so
   * a choice made before the session existed is honoured instead of quietly
   * running on the host. An unresolvable name is reported rather than
   * substituted: a session that runs somewhere the person did not choose is the
   * one outcome worth failing over.
   *
   * @param session - the session just created.
   */
  private async applyDefaultTarget(session: Session): Promise<void> {
    if (this.stored.has(session.id)) return
    const wanted = this.config.defaultTarget.get().trim()
    if (wanted === '' || wanted === 'host') return
    try {
      const container = await this.pool.resolveContainer(wanted)
      this.bind(session, {
        kind: 'container',
        containerId: container.id,
        name: container.name,
        workspace: this.config.containerRoot.get(),
        hostRoot: session.header.cwd ?? process.cwd(),
      })
    } catch (error: unknown) {
      this.ctx.logger.error(
        `sessionbox: defaultTarget "${wanted}" could not be resolved (${message(error)}); `
        + 'this session starts on the host',
      )
    }
  }

  /** The binding recorded in one session's own log, or null while it runs on the host. */
  private targetOf(session: Session): ExecutionTarget | null {
    const stored = this.stored.get(session.id)
    if (stored !== undefined) return stored
    const state = this.ctx.sessionProjections.stateOf(session, 'executionTarget')
    if (state !== undefined) return state.target
    for (const event of [...session.ownEvents()].reverse()) {
      const target = targetOfReminder(event)
      if (target !== undefined) return target
    }
    return null
  }

  /**
   * Apply one binding: registry, per-agent tool surface, and connection warm-up.
   * @param session - the session whose execution world changes.
   * @param target - the new target.
   */
  private bind(session: Session, target: ExecutionTarget): void {
    const hostRoot = session.header.cwd ?? process.cwd()
    this.targets.set(session.id, target, hostRoot)
    this.stored.set(session.id, target)
    this.persist(session.id, target)
    const agent = this.ctx.get('agents')?.get(session.id)
    if (agent !== undefined) void this.installAgent(agent)
    if (target.kind !== 'container') return
    this.access.prepare(target)
    void this.access.ensureSearchTool(target)
  }

  /** Register the `/sessionbox` command: the one write path that binds a session. */
  private registerCommand(): void {
    this.ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@sessionbox/dsh-plugin'),
        name: 'sessionbox',
        description: 'Run this session on the harness host or inside a SessionBox container',
        input: { hint: '<container|host>' },
        handler: async ({ agent, rawInput }) => {
          const wanted = rawInput.trim()
          if (wanted === '') {
            const current = describeTarget(this.targets.containerOf(agent.session.id))
            try {
              const containers = await this.pool.listContainers()
              const names = containers.map((container) => container.name)
              return {
                kind: 'success',
                text: `current ${current} (available: host${names.length === 0 ? '' : `, ${names.join(', ')}`})`,
              }
            } catch (error) {
              return { kind: 'success', text: `current ${current} (containers unavailable: ${message(error)})` }
            }
          }
          if (wanted === 'host' || wanted === 'local') {
            this.switchTo(agent, { kind: 'host' })
            return { kind: 'success', text: 'host' }
          }
          try {
            const container = await this.pool.resolveContainer(wanted)
            const workspace = container.workspace === '' ? this.config.containerRoot.get() : container.workspace
            this.switchTo(agent, {
              kind: 'container',
              containerId: container.id,
              name: container.name,
              workspace,
              hostRoot: agent.session.header.cwd ?? process.cwd(),
            })
            return { kind: 'success', text: `container ${container.name}` }
          } catch (error) {
            return { kind: 'error', text: message(error) }
          }
        },
      })
    })
  }

  /**
   * Move one session to a new execution world and tell the model about it.
   *
   * The binding itself is durable in the binding store; the reminder is a
   * best-effort notice on top of it, because the log refuses some appends and a
   * refused notice must not fail the switch the person just made. A session with
   * no protected first surface head cannot take the reminder yet, so it waits in
   * memory and is appended with the first real message — the earliest safe
   * moment.
   */
  private switchTo(agent: Agent, target: ExecutionTarget): void {
    const session = agent.session
    this.bind(session, target)
    if (this.hasProtectedHead(session)) {
      try {
        session.append('user/message', reminderMessage(target, session.header.cwd ?? process.cwd()), { surfaceOp: 'append' })
      } catch (error: unknown) {
        // The switch already happened and is durable; only the transcript notice
        // is lost, and the standing runtime-context line still tells the model
        // where it runs.
        this.ctx.logger.warn(`sessionbox: could not record the switch notice: ${message(error)}`)
      }
      this.pending.delete(session.id)
    } else {
      this.pending.set(session.id, target)
    }
    void this.installAgent(agent)
  }

  /**
   * Whether the session's surface already carries a protected head.
   *
   * The log format refuses a `system/message` that arrives while the surface is
   * non-empty and no protected head exists, and this plugin's reminder is not
   * one: binding a container before the person has said anything would leave the
   * session unloadable the moment the harness appends its own system message.
   * The reminder is therefore skipped until a real message exists — the standing
   * runtime-context line still tells the model where it runs, and the binding
   * itself is recorded either way.
   *
   * @param session - the session the reminder would join.
   * @returns whether appending the reminder keeps the log valid.
   */
  private hasProtectedHead(session: Session): boolean {
    return session.ownEvents().some((event) =>
      event.type === 'system/message'
      || (event.type === 'user/message' && event.data.source.kind === 'user'))
  }

  /** Bindings whose reminder had to wait for the session's first real message. */
  private readonly pending = new Map<string, ExecutionTarget>()

  /** Durable bindings mirrored in memory, so routing reads stay synchronous. */
  private readonly stored = new Map<string, ExecutionTarget>()

  /** The open bindings domain; cleared while the facility is not up yet. */
  private domain: Domain<typeof BINDINGS_DOMAIN> | undefined

  /** An in-flight open, so concurrent callers share one attempt. */
  private domainPending: Promise<Domain<typeof BINDINGS_DOMAIN> | undefined> | undefined

  /** Whether stored bindings are being applied, so hydration does not rewrite them. */
  private hydrating = false

  /** Give one agent the tool surface its execution world needs, and a standing target note. */
  private async installAgent(agent: Agent): Promise<void> {
    const boundary = this.targets.containerOf(agent.session.id)
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return

    if (boundary === undefined) {
      for (const dispose of (this.surfaces.get(agent) ?? []).reverse()) dispose()
      this.surfaces.delete(agent)
      return
    }
    if (this.surfaces.has(agent)) return

    const disposers: Array<() => void> = []
    try {
      // `pwsh` runs on a Windows host and does not exist in a Linux container;
      // restricting it masks the inherited registration for this agent only.
      disposers.push(tools.restrict({ deny: ['pwsh', ...CONTAINER_DENIED_TOOLS] }))
    } catch {
      // The preset may not offer a PowerShell tool at all.
    }
    try {
      // The container is always Linux, so this session needs the bash tool even
      // on a Windows host whose preset only ever enables PowerShell.
      const fiber = agent.ctx.plugin(bashToolPlugin as unknown as { apply: (ctx: Context) => void })
      disposers.push(() => { void fiber.dispose() })
    } catch (error) {
      this.ctx.logger.warn(`sessionbox: could not add the bash tool to session ${agent.session.id}: ${message(error)}`)
    }
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      // The standing fact behind the switch reminder: every request assembled
      // for this agent states which world its tools touch.
      disposers.push(systemPrompt.context({
        name: 'sessionbox:execution-target',
        order: systemPrompt.getContextOrder('SANDBOX_POLICY') - 5,
        text: () => contextText(this.targets.containerOf(agent.session.id), agent.session.header.cwd ?? process.cwd()),
      }))
    }
    this.surfaces.set(agent, disposers)
  }

  /** Read the volatile settings, with the credential resolved. */
  private async settings(): Promise<ResolvedConfig> {
    return await resolveConfig(this.ctx, this.config)
  }

  /**
   * Resolve the per-call file-effect policy for a routed write.
   *
   * Tool calls pass the policy the sandbox-policy service already resolved for
   * their session; a direct caller gets the same resolution here so the fence
   * inside the container is never skipped.
   */
  private resolvePolicy(
    sessionId: string | undefined,
    supplied: SandboxExecutionPolicy | undefined,
  ): SandboxExecutionPolicy {
    if (supplied !== undefined) return supplied
    const policy = this.ctx.get('sandboxPolicy')
    if (policy === undefined) return { mode: 'workspace-write', workspaceRoot: process.cwd() }
    const session = sessionId === undefined ? undefined : this.ctx.get('sessions')?.get(SessionId(sessionId))
    return policy.resolve(session === undefined ? {} : { session })
  }
}

/**
 * The standing runtime-context line for one execution world.
 *
 * Unlike the switch reminder this is part of every assembled request, so the
 * mapping stays visible after compaction, forks, and resumes.
 */
function contextText(boundary: ContainerBoundary | undefined, hostRoot: string): string {
  if (boundary === undefined) {
    return `Execution target: the machine hosting the harness. File and shell tools work under ${hostRoot}.`
  }
  return 'Execution target: SessionBox container '
    + `"${boundary.name}" (${boundary.containerId}, Linux). The read, write, edit, glob, grep, and shell tools `
    + `operate on that container's filesystem, where ${boundary.workspace} is this session's workspace; `
    + `${hostRoot} is only the harness-side identity of that workspace and is not shared with the container.`
}

/**
 * Tools that cannot work inside a container and must not fall back to the host.
 *
 * The terminal tools open their shell through `ctx.subprocess.spawnTerminal`,
 * and the subprocess seam forwards an allowlist of programs, so an unrestricted
 * terminal in a bound session would open the *host's* shell — the one outcome
 * the boundary exists to prevent. Denying them here makes the boundary honest:
 * the tools are absent from a bound session instead of quietly reaching the host.
 */
const CONTAINER_DENIED_TOOLS = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
] as const

/** The slice of the storage-domain facility this plugin uses. */
interface StorageDomainFacility {
  open(spec: typeof BINDINGS_DOMAIN): Promise<Domain<typeof BINDINGS_DOMAIN>>
}

/** The execution target one reminder event carries, or undefined for any other event. */
function targetOfReminder(event: SessionEvent): ExecutionTarget | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source
  return source.kind === 'sessionbox-target' ? source.target : undefined
}

function reminderMessage(target: ExecutionTarget, hostRoot: string): ReturnType<typeof createUserMessage> {
  const summary = `Execution target: ${target.kind === 'host' ? 'harness host' : `container "${target.name}"`}`
  return createUserMessage({
    content: [{ type: 'text', text: reminderText(target, hostRoot) }],
    source: {
      kind: 'sessionbox-target',
      target,
      form: 'notice',
      summary,
    },
  })
}

/**
 * The model-facing explanation of one execution world.
 *
 * It states the two facts a model cannot infer: which paths exist in the world
 * its tools now touch, and that the host spelling of the session workspace is
 * an identity on the harness side rather than a shared directory.
 */
function reminderText(target: ExecutionTarget, hostRoot: string): string {
  if (target.kind === 'host') {
    return [
      '<system-reminder>',
      'Execution target changed: this session now runs on the machine hosting the agent harness.',
      '',
      `- The read, write, edit, glob, grep, and shell tools operate on the host filesystem again, with ${hostRoot} as the working directory.`,
      '- The container from before this switch is no longer reachable from these tools; anything written inside it stayed there.',
      '</system-reminder>',
    ].join('\n')
  }
  return [
    '<system-reminder>',
    `Execution target changed: this session now runs inside the SessionBox container "${target.name}" (${target.containerId}, Linux).`,
    '',
    `- The read, write, edit, glob, grep, and shell tools operate on the container's filesystem, not on the machine hosting the harness.`,
    `- The container path ${target.workspace} is this session's workspace.`,
    `- ${hostRoot} is only the harness-side identity of that workspace. It is NOT a shared directory: files that lived there before this switch are not visible in the container, and files you create in the container do not appear there.`,
    `- Relative paths resolve under ${target.workspace}; absolute container paths such as /etc/hostname are read from the container.`,
    '- Commands run under Linux bash. The host shell tool is not available on this target.',
    '</system-reminder>',
  ].join('\n')
}

/** Projection state to wire view. */
function viewOf(state: ExecutionTargetState): ExecutionTargetView {
  const target = state.target
  if (target === null || target.kind === 'host') {
    return { kind: 'host', announced: state.announced !== null && state.announced.kind === 'host' }
  }
  return {
    kind: 'container',
    containerId: target.containerId,
    name: target.name,
    workspace: target.workspace,
    hostRoot: target.hostRoot,
    announced: state.announced !== null && state.announced.kind === 'container'
      && state.announced.containerId === target.containerId,
  }
}

/** One-line description of a boundary for command output. */
function describeTarget(boundary: ContainerBoundary | undefined): string {
  return boundary === undefined ? 'host' : `container ${boundary.name}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default SessionBoxService
