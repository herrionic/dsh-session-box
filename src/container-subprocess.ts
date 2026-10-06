/**
 * `ctx.subprocess` backend for one SessionBox container.
 *
 * `SubprocessHandle` is a live-process interface and the agent protocol has no
 * live handle, so a child is expressed as one `exec` and its handle projects
 * that request: `terminate()` sends `exec.cancel`, buffered output is served
 * through the offset readers the seam expects, and preview frames feed the raw
 * `Readable`s when a caller asks for pipes.
 *
 * @module @sessionbox/dsh-plugin/container-subprocess
 */

import { PassThrough, type Readable, type Writable } from 'node:stream'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SessionBoxClientError, type ContainerRuntime } from '@sessionbox/client'
import { shellQuote } from './container-shell.ts'

/** Caps this backend applies to one container child. */
export interface ContainerSubprocessLimits {
  /** Deadline used when the caller's spec carries no useful one. */
  defaultTimeoutMs: number
  /** Upper bound for one container child. */
  maxTimeoutMs: number
}

/** Facts the router supplies per spawn. */
export interface ContainerSpawnContext {
  /** Container working directory the spec's host `cwd` maps onto. */
  workdir: string
  /** Rewrite a host-resolved executable into the container's own (`rg` and friends). */
  translateArgv(argv: readonly string[]): readonly string[]
  /** Deadline for this child, already bounded by the plugin's limits. */
  timeoutMs: number
}

/** Runs container children for the subprocess seam. */
export class ContainerSubprocess {
  /**
   * @param runtime - the connected agent-protocol runtime for this container.
   * @param limits - plugin-configured bounds.
   */
  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly limits: ContainerSubprocessLimits,
  ) {}

  /**
   * Start one container child.
   * @param spec - the fully-specified spawn request.
   * @param context - container workdir, argv translation, and deadline.
   * @returns a handle whose `done` settles with the exec's exit facts.
   */
  spawn(spec: SubprocessSpawnSpec, context: ContainerSpawnContext): SubprocessHandle {
    const controller = new AbortController()
    const out = collectorFor(spec.stdio.stdout)
    const err = collectorFor(spec.stdio.stderr)
    const stdoutPipe = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderrPipe = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdinData = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined

    const command = buildCommand(context.translateArgv(spec.argv), stdinData)
    let streamedOut = ''
    let streamedErr = ''

    const done = this.runtime.exec(command, {
      cwd: context.workdir,
      timeoutMs: Math.min(context.timeoutMs, this.limits.maxTimeoutMs),
      signal: controller.signal,
      onOutput: (event) => {
        if (event.stream === 'stdout') {
          streamedOut += event.data
          stdoutPipe?.write(event.data)
        } else {
          streamedErr += event.data
          stderrPipe?.write(event.data)
        }
      },
    }).then((result): SubprocessOutcome => {
      // Preview frames are incremental chunks, so their concatenation is a
      // prefix of the terminal result; only the remainder is still missing.
      out.absorb(result.stdout)
      err.absorb(result.stderr)
      stdoutPipe?.end(result.stdout.slice(streamedOut.length))
      stderrPipe?.end(result.stderr.slice(streamedErr.length))
      return { exitCode: result.exitCode, signal: null }
    }, (error: unknown) => {
      stdoutPipe?.destroy()
      stderrPipe?.destroy()
      if (error instanceof SessionBoxClientError && error.code === 'OPERATION_CANCELLED') {
        // The seam reports a signal death for a killed child; the caller reads
        // its own signal to classify the cause.
        return { exitCode: null, signal: 'SIGTERM' } satisfies SubprocessOutcome
      }
      throw error
    })

    if (spec.signal !== undefined) {
      if (spec.signal.aborted) controller.abort()
      else spec.signal.addEventListener('abort', () => { controller.abort() }, { once: true })
    }

    return {
      stdin: stdin as Writable | undefined,
      stdout: stdoutPipe as Readable | undefined,
      stderr: stderrPipe as Readable | undefined,
      control: undefined,
      collected: collectedOf(out, err),
      done,
      terminate: () => { controller.abort() },
      waitForExit: async (signal?: AbortSignal) => {
        const settled = done.then(() => true, () => true)
        if (signal === undefined) return await settled
        return await Promise.race([
          settled,
          new Promise<boolean>((resolve) => {
            signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          }),
        ])
      },
    }
  }
}

/** Build the container command line for one argv vector. */
function buildCommand(argv: readonly string[], stdinData: string | undefined): string {
  const line = argv.map(shellQuote).join(' ')
  if (stdinData === undefined) return line
  const encoded = Buffer.from(stdinData, 'utf8').toString('base64')
  return `printf '%s' '${encoded}' | base64 -d | ${line}`
}

interface Collector {
  absorb(text: string): void
  readonly reader: SubprocessOutputReader | undefined
}

/**
 * One output stream projected onto the seam's collect path.
 *
 * The retained text is the TAIL once the caller's cap is exceeded, matching
 * `CollectedOutput`; `nextOffset` stays the whole-stream byte offset, and
 * `lossy` reports that the head was dropped.
 */
function collectorFor(mode: SubprocessOutputMode): Collector {
  if (mode === 'inherit' || mode === 'pipe') return { absorb: () => {}, reader: undefined }
  const maxBytes = mode.maxBytes
  let text = ''
  let dropped = 0
  return {
    absorb(chunk) {
      text += chunk
      const bytes = Buffer.from(text, 'utf8')
      if (bytes.length <= maxBytes) return
      const overflow = bytes.length - maxBytes
      text = bytes.subarray(overflow).toString('utf8')
      dropped += overflow
    },
    reader: {
      readFrom(fromByte: number) {
        const bytes = Buffer.from(text, 'utf8')
        const lossy = dropped > 0
        const offset = lossy ? 0 : Math.max(0, Math.min(fromByte, bytes.length))
        return { text: bytes.subarray(offset).toString('utf8'), nextOffset: bytes.length, lossy }
      },
    },
  }
}

/** Assemble the per-stream reader map the handle exposes. */
function collectedOf(out: Collector, err: Collector): SubprocessCollectedOutputs {
  return {
    ...(out.reader === undefined ? {} : { stdout: out.reader }),
    ...(err.reader === undefined ? {} : { stderr: err.reader }),
  }
}
