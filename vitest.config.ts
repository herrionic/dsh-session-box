/**
 * Test-runner configuration.
 *
 * The plugin declares its Remote endpoint with a standard TypeScript decorator
 * (`@Remote`), which `tsc` accepts without `experimentalDecorators`. Vite's
 * default transform hands that syntax to a parser that rejects it, so this
 * suite pre-transforms any decorated source file with esbuild — the same
 * compiler the production bundle uses — before Vite sees it.
 */
import { transform } from 'esbuild'
import { defineConfig } from 'vitest/config'

/** Cheap pre-filter: a decorator can only appear at the start of a line. */
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$]/mu

/** Lower standard decorators before Vite's own parser sees the file. */
function standardDecorators() {
  return {
    name: 'sessionbox-standard-decorators',
    enforce: 'pre' as const,
    async transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return undefined
      const result = await transform(code, {
        loader: 'ts',
        target: 'node22',
        format: 'esm',
        sourcemap: true,
        sourcefile: file,
      })
      return { code: result.code, map: result.map }
    },
  }
}

export default defineConfig({
  plugins: [standardDecorators()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The live suite talks to a real container: provisioning installs a package
    // and the cancellation case waits out a real process group.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
