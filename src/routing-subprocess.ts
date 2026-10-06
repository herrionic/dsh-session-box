/**
 * `ctx.subprocess`: one subprocess service that dispatches per call to either
 * the harness host or a session's container.
 *
 * This seam is shared by two kinds of caller: agent work that belongs in the
 * container (ripgrep behind `glob`/`grep`) and host infrastructure that must
 * stay on the host (the git probes behind change snapshots, `open-in-app`,
 * out-of-process subagents, and the local shell executors themselves). The
 * initiator alone cannot separate them —an in-turn git probe and an in-turn
 * ripgrep look identical —so routing is opt-in per program: a call runs in the
 * container only when a turn owns it, its working directory maps into the
 * container, and its program is on the configured list.
 *
 * Everything else stays on the host, which is the safe direction: an
 * unrouted program degrades a container session's convenience, while a
 * misrouted host probe would corrupt host-side observations.
 *
 * @module @sessionbox/dsh-plugin/routing-subprocess
 */

import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { toContainerPath } from './target.ts'
import { hostContains } from './target.ts'
import type { ContainerAccess, ContainerBoundary } from './types.ts'
import type { ExecutionTargetRegistry } from './target.ts'

/** Subprocess service that routes each child to the session's execution world. */
export class RoutingSubprocessProvider extends SubprocessRuntime {
  /**
   * @param ctx - plugin context that owns the `subprocess` registration.
   * @param config - the host runtime, the binding registry, container access, and the program allowlist.
   */
  constructor(
    ctx: Context,
    private readonly config: {
      /** The host implementation, mounted in its own service realm. */
      local: SubprocessRuntime
      targets: ExecutionTargetRegistry
      containers: ContainerAccess
      /** Deadline applied to one container child. */
      defaultTimeoutMs: number
      /** Program basenames whose children run inside a container session's container. */
      containerPrograms: readonly string[]
    },
  ) {
    super(ctx)
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    // A routeable program resolves inside the container's own PATH; anything
    // else resolves however the host would resolve it.
    if (this.routeable(command) !== undefined) return path.basename(command)
    return await this.config.local.resolveExecutable(command, env, signal)
  }

  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    const boundary = this.inTurnBoundary()
    if (boundary !== undefined) return { platform: 'posix', defaultShell: '/bin/bash' }
    return await this.config.local.terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const boundary = this.boundaryFor(spec.argv[0], spec.cwd)
    if (boundary === undefined) return this.config.local.spawn(spec)

    const backends = this.config.containers.ready(boundary)
    if (backends === undefined) {
      // `spawn` is synchronous by contract, so an unconnected container cannot
      // be awaited here. Preparing in the background makes a retry succeed
      // instead of leaving the session permanently broken.
      this.config.containers.prepare(boundary)
      throw new Error(`the container "${boundary.name}" for this session is not connected yet; retry in a moment`)
    }

    return backends.subprocess.spawn(spec, {
      // A working directory outside the mapped root has no container meaning,
      // and the host must not run the child either: it runs in the container
      // from the workspace root, where a host path argument simply does not
      // exist — the same absence `read` and `write` report.
      workdir: hostContains(boundary.hostRoot, spec.cwd)
        ? toContainerPath(boundary, spec.cwd, boundary.hostRoot)
        : boundary.workspace,
      translateArgv: (argv) => this.translateArgv(argv, boundary),
      timeoutMs: this.config.defaultTimeoutMs,
    })
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const boundary = this.boundaryFor(spec.argv[0], spec.cwd)
    if (boundary === undefined) return await this.config.local.spawnTerminal(spec)
    throw new Error(
      `persistent terminals are not available inside container "${boundary.name}"; `
      + 'run commands with the shell tool instead',
    )
  }

  /**
   * Rewrite one argv vector for the container's own filesystem.
   *
   * `glob`/`grep` spawn ripgrep by the absolute path of the harness's packaged
   * binary, which cannot exist in a Linux container, and they pass a
   * model-supplied search root straight through as an argv element. Both are
   * rewritten here; every other element is left exactly as the caller wrote it.
   */
  private translateArgv(argv: readonly string[], boundary: ContainerBoundary): readonly string[] {
    return argv.map((element, index) => {
      if (index === 0) return path.basename(element).replace(/\.exe$/i, '')
      if (!path.isAbsolute(element) || element.startsWith('/')) return element
      try {
        return toContainerPath(boundary, element, boundary.hostRoot)
      } catch {
        return element
      }
    })
  }

  /** The container boundary for one child, when its program is routeable and a turn owns it. */
  private boundaryFor(program: string | undefined, cwd: string): ContainerBoundary | undefined {
    if (program === undefined || this.routeable(program) === undefined) return undefined
    // A routeable program in a bound session always runs in the container: the
    // host is not an option, or `glob` and `grep` would reach the host
    // filesystem that `read` and `write` refuse. `cwd` only decides where the
    // child starts inside the container.
    return this.inTurnBoundary()
  }

  /** Whether one program name is on the container routing list. */
  private routeable(program: string): string | undefined {
    const base = path.basename(program).replace(/\.exe$/i, '').toLowerCase()
    return this.config.containerPrograms.includes(base) ? base : undefined
  }

  /** The boundary of the session owning this call, when a turn owns it. */
  private inTurnBoundary(): ContainerBoundary | undefined {
    const initiator = this.ctx.get('agents')?.currentInitiator()
    return initiator === undefined ? undefined : this.config.targets.containerOf(initiator.session.id)
  }
}
