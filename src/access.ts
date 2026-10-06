/**
 * Container access: the layer that turns a session's binding into connected,
 * cacheable capability backends.
 *
 * Backends are cached per container id and prepared eagerly when a session
 * binds, because `ctx.subprocess.spawn()` is synchronous and must be able to
 * hand back a live handle without awaiting a WebSocket connection.
 *
 * @module @sessionbox/dsh-plugin/access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContainerRuntime } from '@sessionbox/client'
import { ContainerFileSystem } from './container-fs.ts'
import { ContainerShell } from './container-shell.ts'
import { ContainerSubprocess } from './container-subprocess.ts'
import type { ResolvedConfig } from './config.ts'
import type { ContainerPool } from './pool.ts'
import type { ContainerAccess, ContainerBackends, ContainerBoundary } from './types.ts'

/** Connects and caches one container's three capability backends. */
export class ContainerAccessImpl implements ContainerAccess {
  private readonly cache = new Map<string, ContainerBackends>()
  private readonly problems = new Map<string, string>()

  /**
   * @param ctx - plugin context, used for logging.
   * @param pool - the connection pool.
   * @param readConfig - per-call configuration read.
   */
  constructor(
    private readonly ctx: Context,
    private readonly pool: ContainerPool,
    private readonly readConfig: () => Promise<ResolvedConfig>,
  ) {}

  async backends(boundary: ContainerBoundary): Promise<ContainerBackends> {
    const cached = this.cache.get(boundary.containerId)
    if (cached !== undefined) return cached
    const failure = this.problems.get(boundary.containerId)
    if (failure !== undefined) throw new Error(failure)

    const settings = await this.readConfig()
    const runtime = await this.pool.runtime(boundary.containerId)
    const created = this.create(runtime, settings)
    this.cache.set(boundary.containerId, created)
    return created
  }

  ready(boundary: ContainerBoundary): ContainerBackends | undefined {
    return this.cache.get(boundary.containerId)
  }

  prepare(boundary: ContainerBoundary): void {
    void this.backends(boundary).then(
      async () => { await this.ensureSearchTool(boundary) },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.problems.set(boundary.containerId, message)
        this.ctx.logger.warn(`sessionbox: container ${boundary.name} is not usable: ${message}`)
      },
    )
  }

  async ensureSearchTool(boundary: ContainerBoundary): Promise<void> {
    await this.pool.ensureSearchTool(boundary.containerId)
  }

  hasSearchTool(boundary: ContainerBoundary): boolean {
    return this.pool.hasSearchTool(boundary.containerId)
  }

  /** Drop one container's cached backends after its connection was released. */
  forget(containerId: string): void {
    this.cache.delete(containerId)
    this.problems.delete(containerId)
  }

  private create(runtime: ContainerRuntime, settings: ResolvedConfig): ContainerBackends {
    return {
      files: new ContainerFileSystem(runtime),
      shell: new ContainerShell(runtime, {
        defaultTimeoutMs: settings.defaultTimeoutMs,
        maxTimeoutMs: settings.maxTimeoutMs,
        maxOutputBytes: settings.maxOutputBytes,
      }),
      subprocess: new ContainerSubprocess(runtime, {
        defaultTimeoutMs: settings.defaultTimeoutMs,
        maxTimeoutMs: settings.maxTimeoutMs,
      }),
    }
  }
}
