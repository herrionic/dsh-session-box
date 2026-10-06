/**
 * A stand-in for a host backend that activates just after its router.
 *
 * The plugin's patch removes the host `fs`, `shell`, and `subprocess` rows, so
 * those service names only exist once the routers provide them — and the host
 * shell executors `inject: ['subprocess']`, which means the routers have to be
 * published *before* the isolated realms can finish loading. Waiting for a realm
 * first inverts that dependency: the loader sees services that never appear,
 * reports the dependents as "did not activate", and rolls the whole composition
 * back.
 *
 * So a router is published synchronously with a deferred delegate. Every
 * asynchronous member waits, bounded, for the real backend; the handful of
 * synchronous members answer from `fallback` until it exists, because a sync
 * member has no way to wait.
 *
 * @module
 */
import type { LocalGetter } from './types.ts'

/** How long a call waits for the host backend behind a router. */
export const HOST_BACKEND_TIMEOUT_MS = 20_000

/**
 * Wrap a lazily installed host backend in a transparent delegate.
 *
 * @param read - reads the real backend, or undefined while it is still loading.
 * @param what - the capability name, for the failure message.
 * @param fallback - answers for synchronous members while the backend loads.
 * @returns the backend, or a stand-in that forwards to it.
 */
export function deferredBackend<T extends object>(
  read: LocalGetter<T>,
  what: string,
  fallback: Partial<T> = {},
): T {
  // Kept by reference, never copied: a fallback may be a getter whose value is
  // only knowable once the composition has finished assembling.
  const placeholder = fallback as T
  return new Proxy(placeholder, {
    get(target, property, receiver) {
      const real = read()
      if (real !== undefined) {
        const value = Reflect.get(real, property) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value
      }
      // A proxy that answers `then` would be mistaken for a promise.
      if (property === 'then') return undefined
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      return (...args: unknown[]) =>
        waitForBackend(read, what).then((impl) =>
          (Reflect.get(impl, property) as (...args: unknown[]) => unknown).apply(impl, args))
    },
  })
}

/**
 * Wait, bounded, for a host backend that is loading right now.
 *
 * @param read - reads the backend, or undefined while it is absent.
 * @param what - the capability name, for the failure message.
 * @returns the backend.
 */
export async function waitForBackend<T>(read: LocalGetter<T>, what: string): Promise<T> {
  const deadline = Date.now() + HOST_BACKEND_TIMEOUT_MS
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      throw new Error(`the host ${what} backend did not activate within ${HOST_BACKEND_TIMEOUT_MS} ms`)
    }
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}
