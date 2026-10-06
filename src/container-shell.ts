/**
 * `ctx.shell` backend for one SessionBox container.
 *
 * The agent protocol is request/response with preview frames, so one
 * `runtime.exec` call settles the whole execution: foreground results,
 * incremental reads from the retained buffers, and observed streams all work.
 * Cancellation is real — the caller's `AbortSignal` is forwarded to the client,
 * which sends `exec.cancel` and the server kills the whole process group.
 *
 * @module @sessionbox/dsh-plugin/container-shell
 */

import type { CollectedOutput, ShellExecSpec, ShellExecution, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SessionBoxClientError, type ContainerRuntime } from '@sessionbox/client'

/** Output/timeout bounds this backend applies on top of the caller's spec. */
export interface ContainerShellLimits {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
}

/** Runs one shell spec inside a container. */
export class ContainerShell {
  /**
   * @param runtime - the connected agent-protocol runtime for this container.
   * @param limits - plugin-configured bounds.
   */
  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly limits: ContainerShellLimits,
  ) {}

  /**
   * Run one resolved spec inside the container.
   * @param spec - the spec the router resolved (already carrying defaults).
   * @param containerWorkdir - the spec's workdir translated into the container.
   * @returns a settled execution; the agent protocol never returns a live process.
   */
  async execute(spec: ShellExecSpec, containerWorkdir: string): Promise<ShellExecution> {
    const limits = {
      stdoutMaxBytes: Math.min(spec.stdoutMaxBytes || this.limits.maxOutputBytes, this.limits.maxOutputBytes),
      stderrMaxBytes: this.limits.maxOutputBytes,
    }
    const timeoutMs = Math.min(spec.timeoutMs || this.limits.defaultTimeoutMs, this.limits.maxTimeoutMs)

    if (isAborted(spec.signal)) {
      return completedExecution({
        result: { exitCode: null, stdout: '', stderr: '' },
        aborted: true,
        timedOut: false,
        timeoutMs,
        ...limits,
      })
    }

    try {
      const result = await this.runtime.exec(withStdin(spec.command, spec.stdin), {
        cwd: containerWorkdir,
        timeoutMs,
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      })
      return completedExecution({
        result,
        aborted: isAborted(spec.signal),
        timedOut: false,
        timeoutMs,
        ...limits,
      })
    } catch (error) {
      if (error instanceof SessionBoxClientError && error.code === 'OPERATION_TIMEOUT') {
        // The server killed the command at its own deadline: a timeout result,
        // not an infrastructure failure.
        return completedExecution({
          result: { exitCode: null, stdout: '', stderr: '' },
          aborted: false,
          timedOut: true,
          timeoutMs,
          ...limits,
        })
      }
      if (error instanceof SessionBoxClientError && error.code === 'OPERATION_CANCELLED') {
        // The caller's abort reached the container and the process group died.
        return completedExecution({
          result: { exitCode: null, stdout: '', stderr: '' },
          aborted: true,
          timedOut: false,
          timeoutMs,
          ...limits,
        })
      }
      return failedExecution(error)
    }
  }
}

interface CompletedOptions {
  result: { exitCode: number | null; stdout: string; stderr: string }
  aborted: boolean
  timedOut: boolean
  timeoutMs: number
  stdoutMaxBytes: number
  stderrMaxBytes: number
}

function completedExecution(options: CompletedOptions): ShellExecution {
  const stdout = collect(options.result.stdout, options.stdoutMaxBytes)
  const stderr = collect(options.result.stderr, options.stderrMaxBytes)
  const settled = options.aborted || options.timedOut
  const exitCode = settled ? null : options.result.exitCode

  let consumed = false
  return {
    status: settled ? 'killed' : 'completed',
    exitCode,
    signal: null,
    done: Promise.resolve(),
    readOutput(): ShellProcessRead {
      if (consumed) return { delta: '', lossy: false }
      consumed = true
      const parts: string[] = []
      if (stdout.text !== '') parts.push(stdout.text)
      if (stderr.text !== '') parts.push(`[stderr]\n${stderr.text}`)
      return { delta: parts.join(''), lossy: stdout.truncated || stderr.truncated }
    },
    observed: {
      stdout: outputReader(stdout.text),
      stderr: outputReader(stderr.text),
    },
    kill: () => false,
    result: async (): Promise<ShellRunResult> => ({
      exitCode,
      signal: null,
      timedOut: options.timedOut,
      aborted: options.aborted,
      timeoutMs: options.timeoutMs,
      stdout,
      stderr,
    }),
  }
}

function failedExecution(error: unknown): ShellExecution {
  const message = error instanceof Error ? error.message : String(error)
  const note: CollectedOutput = { text: `sessionbox: ${message}`, truncated: false }

  return {
    status: 'killed',
    exitCode: null,
    signal: null,
    done: Promise.resolve(),
    readOutput: (): ShellProcessRead => ({ delta: note.text, lossy: false }),
    observed: {
      stdout: outputReader(''),
      stderr: outputReader(note.text),
    },
    kill: () => false,
    result: async (): Promise<ShellRunResult> => {
      throw error instanceof Error ? error : new Error(message)
    },
  }
}

/** Tail-truncating collection, matching the `CollectedOutput` contract. */
function collect(text: string, maxBytes: number): CollectedOutput {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  return { text: buffer.subarray(buffer.length - maxBytes).toString('utf8'), truncated: true }
}

function outputReader(text: string): ShellExecution['observed']['stdout'] {
  const buffer = Buffer.from(text, 'utf8')
  return {
    readFrom(fromByte: number) {
      const offset = Math.max(0, Math.min(fromByte, buffer.length))
      return { text: buffer.subarray(offset).toString('utf8'), nextOffset: buffer.length, lossy: false }
    },
  }
}

/** Reads the abort state without TypeScript's control-flow narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The agent protocol has no stdin channel; feed it through a base64 pipe so any
 * bytes survive the shell round-trip.
 */
export function withStdin(command: string, stdin: string | undefined): string {
  if (stdin === undefined) return command
  const encoded = Buffer.from(stdin, 'utf8').toString('base64')
  return `printf '%s' '${encoded}' | base64 -d | sh -c ${shellQuote(command)}`
}

/** Single-quote one string for `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
