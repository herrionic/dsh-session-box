/**
 * Domain types shared by the execution-target binding, the routing providers,
 * and the container backends.
 *
 * @module @sessionbox/dsh-plugin/types
 */

import type { ContainerFileSystem } from './container-fs.ts'
import type { ContainerShell } from './container-shell.ts'
import type { ContainerSubprocess } from './container-subprocess.ts'

/**
 * Reads a host backend that is installed just after the router that uses it.
 * @returns the backend, or undefined while it is still activating.
 */
export type LocalGetter<T> = () => T | undefined

/** The harness host is the execution world: every capability stays local. */
export interface HostBoundary {
  kind: 'host'
}

/**
 * A SessionBox container is the execution world for one session.
 *
 * `hostRoot` is the session's own `header.cwd`. DSH keeps that host path in the
 * session header because a set of host-side observers (workspace validation,
 * git snapshots, file-reference indexing, AGENTS.md discovery, skill discovery)
 * read it with `node:fs` directly; the path stays real and readable, and the
 * container simply never shares its contents. Path routing uses it as the
 * namespace anchor, not as a mirror.
 */
export interface ContainerBoundary {
  kind: 'container'
  /** SessionBox container id. */
  containerId: string
  /** Container name as shown in the picker. */
  name: string
  /** Container-side root the session workspace maps onto. */
  workspace: string
  /** Host directory that maps onto {@link workspace}. */
  hostRoot: string
}

/** Where one session's file and command work actually happens. */
export type ExecutionTarget = HostBoundary | ContainerBoundary

/** Plain-JSON projection state: the current binding plus what the model has been told. */
export interface ExecutionTargetState {
  /** The binding currently in force; `null` means the harness host. */
  target: ExecutionTarget | null
  /**
   * The binding described by the most recent execution-target reminder in the
   * transcript. Differs from {@link target} only for a log whose binding moved
   * without a reminder (an externally edited or truncated session).
   */
  announced: ExecutionTarget | null
}

/** Client view of {@link ExecutionTargetState}. */
export interface ExecutionTargetView {
  /** `'host'` or `'container'`. */
  kind: 'host' | 'container'
  /** Container id, present for a container target. */
  containerId?: string
  /** Container name, present for a container target. */
  name?: string
  /** Container-side root, present for a container target. */
  workspace?: string
  /** Host directory mapped onto the container root, present for a container target. */
  hostRoot?: string
  /** Whether the transcript already explains this target to the model. */
  announced: boolean
}

/** One selectable container, as the picker sees it. */
export interface ContainerSummaryView {
  id: string
  name: string
  status: string
  image: string
  workspace: string
}

/**
 * The container-side capabilities the routing providers dispatch into.
 *
 * One method per seam: a routing provider asks for the backends it needs and
 * never touches the pool, the credentials, or the container protocol itself.
 */
export interface ContainerAccess {
  /** The three backends for one container, connected on first use. */
  backends(boundary: ContainerBoundary): Promise<ContainerBackends>
  /**
   * The backends for one container **without** awaiting a connection.
   *
   * `ctx.subprocess.spawn()` is synchronous and must return a live handle, so
   * the subprocess router reads this cache and fails loudly when a container
   * session's connection is not up yet, rather than silently running the child
   * on the harness host.
   */
  ready(boundary: ContainerBoundary): ContainerBackends | undefined
  /** Start connecting and provisioning in the background; never rejects. */
  prepare(boundary: ContainerBoundary): void
  /**
   * Make sure the container can run the harness's packaged search tools.
   * `glob`/`grep` spawn ripgrep by absolute host path, so the container needs
   * its own `rg`; this resolves once the probe (and any install) has settled.
   */
  ensureSearchTool(boundary: ContainerBoundary): Promise<void>
  /** Whether the search binary was proven runnable in this container. */
  hasSearchTool(boundary: ContainerBoundary): boolean
}

/** The three capability backends of one connected container. */
export interface ContainerBackends {
  files: ContainerFileSystem
  shell: ContainerShell
  subprocess: ContainerSubprocess
}
