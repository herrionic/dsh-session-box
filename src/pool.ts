/**
 * SessionBox connection pool: one client per resolved connection identity and
 * one agent-protocol runtime per bound container.
 *
 * The server multiplexes containers over a single agent socket, but the
 * TypeScript client binds one `containerId` per `ContainerRuntime`, so this
 * pool keeps one runtime per container and one client per
 * `{baseUrl, token}` pair. Settings edits that change either value drop every
 * cached connection instead of serving calls against a stale identity.
 *
 * @module @sessionbox/dsh-plugin/pool
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionBoxClient, SessionBoxClientError, type ContainerRuntime } from '@sessionbox/client'
import type { ResolvedConfig } from './config.ts'

/** Container facts the picker shows. */
export interface ContainerSummary {
  id: string
  name: string
  status: string
  image: string
  workspace: string
}

interface Cached {
  signature: string
  runtime: ContainerRuntime
}

/** Raised for a missing or unusable container; the message is model-facing. */
export class ContainerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ContainerUnavailableError'
  }
}

/** Owns every SessionBox connection this plugin holds. */
export class ContainerPool {
  private client: { signature: string; client: SessionBoxClient } | undefined
  private readonly runtimes = new Map<string, Cached>()
  private readonly provisioning = new Map<string, Promise<void>>()

  /**
   * @param ctx - plugin context, used for logging only.
   * @param readConfig - per-call configuration read (volatile settings + credentials).
   */
  constructor(
    private readonly ctx: Context,
    private readonly readConfig: () => Promise<ResolvedConfig>,
  ) {}

  /**
   * List the containers the configured server currently knows.
   * @returns every container, newest first as the server orders them.
   */
  async listContainers(): Promise<ContainerSummary[]> {
    const client = await this.clientFor()
    const containers = await client.listContainers()
    return containers.map((container) => ({
      id: container.id,
      name: container.name,
      status: container.status,
      image: container.image,
      workspace: container.workspace,
    }))
  }

  /**
   * Resolve a user-supplied container selector to one container.
   *
   * Accepts an exact id, an exact name, or a unique name prefix, so the chip can
   * offer names while `/sessionbox` accepts whatever the user types.
   * @param selector - container id, name, or unique name prefix.
   * @returns the matching container summary.
   * @throws ContainerUnavailableError when nothing matches or the match is ambiguous.
   */
  async resolveContainer(selector: string): Promise<ContainerSummary> {
    const wanted = selector.trim()
    if (wanted === '') throw new ContainerUnavailableError('a container id or name is required')
    const containers = await this.listContainers()
    const exact = containers.find((container) => container.id === wanted || container.name === wanted)
    if (exact !== undefined) return exact
    const prefixed = containers.filter((container) => container.name.startsWith(wanted))
    if (prefixed.length === 1) return prefixed[0] as ContainerSummary
    if (prefixed.length > 1) {
      throw new ContainerUnavailableError(
        `"${wanted}" matches several containers: ${prefixed.map((container) => container.name).join(', ')}`,
      )
    }
    throw new ContainerUnavailableError(
      `no container "${wanted}" (available: ${containers.map((container) => container.name).join(', ') || 'none'})`,
    )
  }

  /**
   * Connect to one container, reusing the live runtime when the settings have not moved.
   * @param containerId - container to reach.
   * @returns the connected agent-protocol runtime.
   * @throws ContainerUnavailableError when the server, token, or container refuses the connection.
   */
  async runtime(containerId: string): Promise<ContainerRuntime> {
    const settings = await this.readConfig()
    this.dropStale(settings.signature)
    const cached = this.runtimes.get(containerId)
    if (cached !== undefined) return cached.runtime

    const client = await this.clientFor(settings)
    try {
      const runtime = await client.connect(containerId)
      this.runtimes.set(containerId, { signature: settings.signature, runtime })
      return runtime
    } catch (error) {
      throw new ContainerUnavailableError(describeConnectionFailure(containerId, settings.baseUrl, error), { cause: error })
    }
  }

  /**
   * Make sure the container can run the harness's search tools.
   *
   * `glob`/`grep` spawn the packaged ripgrep binary by absolute host path, which
   * cannot exist inside the container, so the container needs its own `rg` on
   * `PATH`. The stock image has none; the provisioning step installs it once per
   * container and is memoized, including its failures, so a container without a
   * usable package manager is not retried on every search.
   *
   * @param containerId - container to provision.
   * @returns after the probe (and any install) settles; never rejects.
   */
  async ensureSearchTool(containerId: string): Promise<void> {
    const existing = this.provisioning.get(containerId)
    if (existing !== undefined) return await existing
    const attempt = this.provision(containerId).catch(() => undefined)
    this.provisioning.set(containerId, attempt)
    return await attempt
  }

  /**
   * Whether {@link ensureSearchTool} found a usable search binary.
   * @param containerId - container to report on.
   * @returns true once provisioning proved `rg` is runnable.
   */
  hasSearchTool(containerId: string): boolean {
    return this.searchReady.has(containerId)
  }

  private readonly searchReady = new Set<string>()

  /** Close every cached runtime; used on unload and on a settings change. */
  async close(): Promise<void> {
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    this.provisioning.clear()
    this.searchReady.clear()
    await Promise.allSettled(runtimes.map(async (cached) => { await cached.runtime.close() }))
  }

  private async clientFor(settings?: ResolvedConfig): Promise<SessionBoxClient> {
    const resolved = settings ?? await this.readConfig()
    if (this.client !== undefined && this.client.signature === resolved.signature) return this.client.client
    if (this.client !== undefined) await this.dropStale(resolved.signature)
    const client = new SessionBoxClient({
      baseUrl: resolved.baseUrl,
      ...(resolved.token === undefined ? {} : { token: resolved.token }),
      requestTimeoutMs: resolved.requestTimeoutMs,
    })
    this.client = { signature: resolved.signature, client }
    return client
  }

  /** Drop every cached connection built against a different connection identity. */
  private async dropStale(signature: string): Promise<void> {
    const stale = [...this.runtimes.entries()].filter(([, cached]) => cached.signature !== signature)
    for (const [containerId, cached] of stale) {
      this.runtimes.delete(containerId)
      this.provisioning.delete(containerId)
      this.searchReady.delete(containerId)
      await cached.runtime.close().catch(() => undefined)
    }
  }

  /** Probe the container for `rg`, installing it when the deployment allows that. */
  private async provision(containerId: string): Promise<void> {
    const settings = await this.readConfig()
    const runtime = await this.runtime(containerId)
    const probe = await runtime.exec('command -v rg >/dev/null 2>&1 && echo SESSIONBOX_RG_PRESENT || echo SESSIONBOX_RG_MISSING', {
      timeoutMs: 30_000,
    })
    if (probe.stdout.includes('SESSIONBOX_RG_PRESENT')) {
      this.searchReady.add(containerId)
      return
    }
    if (!settings.provisionRipgrep) return

    this.ctx.logger.info(`sessionbox: installing ripgrep in container ${containerId} (glob/grep need it)`)
    // The stock image ships no package lists, so the install only resolves after
    // a refresh; both steps ride one shell so an early exit cannot leave a
    // half-provisioned container behind.
    const install = await runtime.exec(
      'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq '
      + '&& sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ripgrep',
      { timeoutMs: 300_000 },
    )
    const verify = await runtime.exec('command -v rg >/dev/null 2>&1 && echo SESSIONBOX_RG_PRESENT || echo SESSIONBOX_RG_MISSING', {
      timeoutMs: 30_000,
    })
    if (verify.stdout.includes('SESSIONBOX_RG_PRESENT')) {
      this.searchReady.add(containerId)
      return
    }
    this.ctx.logger.warn(
      `sessionbox: container ${containerId} has no ripgrep and installing it failed `
      + `(exit ${String(install.exitCode)}): ${install.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    )
  }
}

/** Turn a client failure into a message that names what the user can fix. */
function describeConnectionFailure(containerId: string, baseUrl: string, error: unknown): string {
  if (error instanceof SessionBoxClientError) {
    switch (error.code) {
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
        return `SessionBox rejected the token for ${baseUrl} (${error.code}); check the credential named in the plugin settings`
      case 'CONTAINER_NOT_FOUND':
        return `container ${containerId} no longer exists on ${baseUrl}`
      case 'CONTAINER_NOT_RUNNING':
        return `container ${containerId} is not running`
      case 'SSH_UNAVAILABLE':
      case 'OPERATION_TIMEOUT':
        return `cannot reach container ${containerId} on ${baseUrl}: ${error.message}`
      default:
        return `SessionBox refused the connection to ${containerId} (${error.code}): ${error.message}`
    }
  }
  return `cannot reach SessionBox at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
}
