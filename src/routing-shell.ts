/**
 * `ctx.shell`: one shell service that dispatches per call to either the harness
 * host's own executor or a session's container.
 *
 * Unlike `ctx.fs`, this seam *does* carry session identity —`ShellExecSpec`
 * carries the per-call `SandboxExecutionPolicy`, whose `sessionId` the sandbox
 * policy service stamps in —so routing here is exact for every tool call and
 * only falls back to the initiator or the workdir prefix for direct callers.
 *
 * @module @sessionbox/dsh-plugin/routing-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { toContainerPath } from './target.ts'
import type { ContainerAccess, ContainerBoundary } from './types.ts'
import type { ExecutionTargetRegistry } from './target.ts'

/** Shell service that routes each execution to the session's execution world. */
export class RoutingShellExecutor extends ShellExecutor {
  /**
   * @param ctx - plugin context that owns the `shell` registration.
   * @param config - the host executor, the binding registry, and container access.
   */
  constructor(
    ctx: Context,
    private readonly config: {
      /** The host implementation, mounted in its own service realm. */
      local: ShellExecutor
      targets: ExecutionTargetRegistry
      containers: ContainerAccess
    },
  ) {
    super(ctx)
  }

  /** The host executor's default mode: the capability fact the tool layer advertises. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.config.local.sandboxMode
  }

  /**
   * Resolve through the host executor so its configured defaults (timeouts,
   * output caps, and the fallback sandbox policy) are the single source of
   * truth for every call, whichever world executes it.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return this.config.local.resolve(request)
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const boundary = this.boundaryFor(spec)
    if (boundary === undefined) return await this.config.local.execute(spec)
    const shell = (await this.config.containers.backends(boundary)).shell
    return await shell.execute(spec, toContainerPath(boundary, spec.workdir, boundary.hostRoot))
  }

  /**
   * Which execution world owns one execution.
   *
   * The per-call policy's `sessionId` is authoritative; the initiator covers a
   * caller that passed no policy, and the workdir prefix covers a call that has
   * neither (a plugin invoking the seam directly).
   */
  private boundaryFor(spec: ShellExecSpec): ContainerBoundary | undefined {
    const sessionId = spec.sandboxPolicy?.sessionId
    if (sessionId !== undefined) return this.config.targets.containerOf(sessionId)
    const initiator = this.ctx.get('agents')?.currentInitiator()
    if (initiator !== undefined) return this.config.targets.containerOf(initiator.session.id)
    return this.config.targets.containerForPath(spec.workdir)
  }
}
