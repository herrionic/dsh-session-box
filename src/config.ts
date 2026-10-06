/**
 * Plugin configuration for the SessionBox execution-target integration.
 *
 * Every field is `.volatile()`: the settings page edits them in place and the
 * next operation reads the new value, with no remount. No field carries a
 * literal secret — `tokenRef` names an entry in the credential store, so a
 * plaintext token never reaches a configuration file on disk.
 *
 * @module @sessionbox/dsh-plugin/config
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'

/** SessionBox server used until the settings page says otherwise. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'

/** Credential-store entry the token is read from until the settings page says otherwise. */
export const DEFAULT_TOKEN_REF = 'SESSIONBOX_TOKEN'

/** Container-side root the session workspace maps onto. */
export const DEFAULT_CONTAINER_ROOT = '/workspace'

/** Default per-exec deadline; SessionBox caps a single exec at 30 minutes by default. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Upper bound this plugin will ask for; the protocol's wire cap is 4 hours. */
export const MAX_TIMEOUT_MS = 10 * 60_000

/** Retained stdout/stderr bytes per stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** Per-request deadline for the agent-protocol operations the plugin issues. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Programs whose `ctx.subprocess` children are routed into a bound container. */
export const DEFAULT_CONTAINER_PROGRAMS = ['rg', 'ripgrep'] as const

/** Plugin configuration; every field is edited from the settings page. */
export interface Config {
  /** SessionBox server origin. */
  baseUrl: Volatile<string>
  /** Credential-store name holding the API token. */
  tokenRef: Volatile<string>
  /** Container-side root the session workspace maps onto. */
  containerRoot: Volatile<string>
  /** Per-exec deadline in milliseconds. */
  defaultTimeoutMs: Volatile<number>
  /** Upper bound for a caller-supplied exec deadline. */
  maxTimeoutMs: Volatile<number>
  /** Retained bytes per output stream. */
  maxOutputBytes: Volatile<number>
  /** Per-request deadline for agent-protocol operations. */
  requestTimeoutMs: Volatile<number>
  /** Install ripgrep inside a bound container when it is missing (needs network + sudo). */
  provisionRipgrep: Volatile<boolean>
  /**
   * Program basenames whose `ctx.subprocess` children run inside a bound
   * container. The seam is shared with host infrastructure (git probes,
   * `open-in-app`, out-of-process subagents), so container routing is opt-in
   * per program; the default covers the harness's packaged ripgrep, which
   * `glob` and `grep` spawn.
   */
  containerPrograms: Volatile<string[]>
  /**
   * Execution target a newly created session starts on: a container name or id,
   * or `host`. A session created while this names a container is bound to it
   * before its first turn, so a session never runs somewhere the person did not
   * choose; an unresolvable name fails loud rather than falling back to the host.
   */
  defaultTarget: Volatile<string>
}

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  tokenRef: z.string().role('credential-ref').default(DEFAULT_TOKEN_REF).volatile(),
  containerRoot: z.string().default(DEFAULT_CONTAINER_ROOT).volatile(),
  defaultTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS).volatile(),
  maxTimeoutMs: z.number().step(1).min(1000).default(MAX_TIMEOUT_MS).volatile(),
  maxOutputBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_OUTPUT_BYTES).volatile(),
  requestTimeoutMs: z.number().step(1).min(1000).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
  provisionRipgrep: z.boolean().default(true).volatile(),
  containerPrograms: z.array(z.string()).default([...DEFAULT_CONTAINER_PROGRAMS]).volatile(),
  defaultTarget: z.string().default('host').volatile(),
})

/** One consistent read of the volatile configuration, resolved against the credential store. */
export interface ResolvedConfig {
  /** Server origin, trailing slashes stripped. */
  baseUrl: string
  /** Credential name the token was read from. */
  tokenRef: CredentialRef
  /** Token value, or undefined while the credential is unconfigured. */
  token: string | undefined
  /** Container-side root the session workspace maps onto. */
  containerRoot: string
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  requestTimeoutMs: number
  provisionRipgrep: boolean
  /** Program basenames whose children run inside a bound container. */
  containerPrograms: readonly string[]
  /**
   * Identity of the resolved connection settings. A change means every cached
   * runtime was built against a different server or identity and must be dropped.
   */
  signature: string
}

/**
 * Read the volatile configuration and resolve the token from the credential store.
 *
 * Resolution is per call: a token written from the settings page reaches the
 * next operation without a restart, and the pool compares {@link ResolvedConfig.signature}
 * to decide whether its cached connections still belong to these settings.
 *
 * @param ctx - plugin context used to reach the optional credential provider.
 * @param config - the volatile plugin configuration.
 * @returns the resolved settings, with `token: undefined` while unconfigured.
 */
export async function resolveConfig(ctx: Context, config: Config): Promise<ResolvedConfig> {
  const baseUrl = config.baseUrl.get().trim().replace(/\/+$/, '')
  const ref = credentialRef(config.tokenRef.get().trim())
  const credentials = ctx.get('credentials')
  const token = credentials === undefined ? undefined : (await credentials.resolve(ref))?.value
  const containerRoot = normalizeRoot(config.containerRoot.get())
  const defaultTimeoutMs = config.defaultTimeoutMs.get()
  const maxTimeoutMs = Math.max(defaultTimeoutMs, config.maxTimeoutMs.get())
  const maxOutputBytes = config.maxOutputBytes.get()
  const requestTimeoutMs = config.requestTimeoutMs.get()

  return {
    baseUrl,
    tokenRef: ref,
    token,
    containerRoot,
    defaultTimeoutMs,
    maxTimeoutMs,
    maxOutputBytes,
    requestTimeoutMs,
    provisionRipgrep: config.provisionRipgrep.get(),
    containerPrograms: config.containerPrograms.get(),
    signature: [baseUrl, token ?? '', containerRoot].join('\u0000'),
  }
}

/** Right-trim a container root, falling back to `/` for a blank value. */
function normalizeRoot(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}
