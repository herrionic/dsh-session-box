/**
 * Browser-half contract test.
 *
 * `client/index.js` is served into the page as-is, so nothing compiles it and
 * nothing type-checks it: its only guarantees are the module-loader registration
 * the client module registry reads, and the shape the slot registry accepts. This
 * test stands in for both — it loads the real file, captures the registrations,
 * builds the factory's exports with a minimal React, applies the plugin against a
 * fake page context, and renders each contribution once.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

interface LoaderEntry {
  id: string
  factory: (require: (specifier: string) => unknown) => {
    inject?: readonly string[]
    apply?: (ctx: unknown) => Promise<void> | void
  }
}

interface Registration {
  name: string
  options: Record<string, unknown>
  component: (props: unknown) => unknown
}

/** A React stand-in: enough for two hook-driven controls. */
const reactStub = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => {},
}

/** Load the shipped client file and return its module-loader registration. */
async function loadClientHalf(): Promise<LoaderEntry> {
  const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')
  let captured: LoaderEntry | undefined
  const globalWindow = globalThis as { window?: unknown }
  const previous = globalWindow.window
  globalWindow.window = {
    __ModuleLoader__: {
      load: (entry: LoaderEntry) => { captured = entry },
    },
  }
  try {
    // The file is a side-effecting script: importing it must register, not
    // export. Each load carries a unique tail so the module cache cannot make a
    // later test's import a no-op.
    const unique = `${source}\n// load ${String(Math.random())}\n`
    await import(`data:text/javascript,${encodeURIComponent(unique)}`)
  } finally {
    globalWindow.window = previous
  }
  if (captured === undefined) throw new Error('client/index.js registered nothing with the module loader')
  return captured
}

/** Apply the client half against a fake page and collect what it registered. */
async function mount(overrides: {
  remote?: Record<string, unknown>
  services?: Record<string, unknown>
  primitives?: Record<string, unknown>
} = {}): Promise<{ entries: Registration[]; mounted: { package: string; descriptors: Array<Record<string, unknown>> } | undefined }> {
  const entry = await loadClientHalf()
  const plugin = entry.factory((specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives' && overrides.primitives !== undefined) return overrides.primitives
    throw new Error(`unexpected require(${specifier})`)
  })

  const entries: Registration[] = []
  let mounted: { package: string; descriptors: Array<Record<string, unknown>> } | undefined

  const ctx = {
    effect: (body: () => unknown) => body(),
    get: (name: string) => overrides.services?.[name],
    remote: {
      $mount: async (contribution: typeof mounted) => {
        mounted = contribution
        return async () => {}
      },
      ...overrides.remote,
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        entries.push({ name: String(options.name), options, component: component as Registration['component'] })
        return () => {}
      },
    },
    sessions: { binding: () => undefined },
  }

  await plugin.apply?.(ctx)
  return { entries, mounted }
}

describe('browser half', () => {
  it('registers under the package name the manifest declares', async () => {
    const entry = await loadClientHalf()
    expect(entry.id).toBe('@sessionbox/dsh-plugin')
    expect(typeof entry.factory).toBe('function')
  })

  it('mounts its own Remote namespace and contributes both surfaces', async () => {
    const { entries, mounted } = await mount()

    expect(mounted?.package).toBe('@sessionbox/dsh-plugin')
    expect(mounted?.descriptors[0]).toMatchObject({
      namespace: 'sessionbox',
      method: 'containers',
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })

    const chip = entries.find((registration) => registration.name === 'conversation.input.left')
    expect(chip?.options).toMatchObject({ id: 'sessionbox-execution-target' })

    const section = entries.find((registration) => registration.name === 'settings.section')
    expect(section?.options).toMatchObject({ id: 'sessionbox', locale: 'settings.sessionbox' })
    expect(typeof section?.options.label).toBe('function')
  })

  it('renders the chip from an injected face without a live session', async () => {
    const { entries } = await mount()
    const chip = entries.find((registration) => registration.name === 'conversation.input.left')
    const inject = chip?.options.inject as (sessionId: string) => Record<string, unknown>
    const face = inject('session-1')
    const element = chip?.component({ sessionId: 'session-1', ...face }) as { type: unknown; children: unknown[] }

    // Without the shell's primitives the control falls back to native elements:
    // one trigger, and no popup until it is opened.
    expect(element.type).toBe('span')
    expect((element.children[0] as { type: unknown }).type).toBe('button')
    expect(element.children[1]).toBeNull()
  })

  it('opens the shell menu for the execution target when the page seeds it', async () => {
    const UiButton = (props: Record<string, unknown>) => ({ type: 'ui-button', props })
    const UiMenu = (props: Record<string, unknown>) => ({ type: 'ui-menu', props })
    const { entries } = await mount({ primitives: { Button: UiButton, Menu: UiMenu } })

    const chip = entries.find((registration) => registration.name === 'conversation.input.left')
    const inject = chip?.options.inject as (sessionId: string) => Record<string, unknown>
    const element = chip?.component({ sessionId: 'session-1', ...inject('session-1') }) as {
      children: Array<{ type: unknown; props: Record<string, unknown> }>
    }
    // `createElement` keeps the component itself as `type`, so identity is the check.
    const menu = element.children.find((child) => child.type === UiMenu)

    expect(menu).toBeDefined()
    expect(menu?.props.selectedId).toBe('__sessionbox_host__')
    expect((menu?.props.items as Array<Record<string, unknown>>)[0]).toMatchObject({ id: '__sessionbox_host__', label: 'host' })
    // The trigger is the shell's button, not a native select.
    const trigger = menu?.props.anchor as { type: unknown }
    expect(trigger.type).toBe(UiButton)
  })

  it('renders the settings section and writes through the published mutation', async () => {
    const mutations: Array<{ namespace: string; ops: unknown; revision: unknown }> = []
    const credentials: Array<{ ref: string; value: string }> = []
    const values = { baseUrl: 'http://127.0.0.1:8787', tokenRef: 'SESSIONBOX_TOKEN', provisionRipgrep: true }

    const { entries } = await mount({
      services: {
        configForms: {
          get: (namespace: string) => ({
            getSnapshot: () => ({ value: values, revision: 7 }),
            mutate: async (ops: unknown, revision: unknown) => {
              mutations.push({ namespace, ops, revision })
              return true
            },
          }),
        },
      },
      remote: {
        settings: {
          describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'sessionbox', revision: 7, value: values }] } }),
          mutate: async (namespace: string, ops: unknown, revision: unknown) => {
            mutations.push({ namespace, ops, revision })
            return { ok: true }
          },
        },
        credentials: {
          set: async (ref: string, value: string) => {
            credentials.push({ ref, value })
            return { ok: true }
          },
        },
      },
    })

    const section = entries.find((registration) => registration.name === 'settings.section')
    const inject = section?.options.inject as () => Record<string, unknown>
    const face = inject().sessionbox as Record<string, unknown>
    const element = section?.component({ sessionbox: face }) as { type: unknown }

    expect(element.type).toBe('div')
    // The namespace is discovered from the host, not guessed.
    await (face.refresh as () => Promise<void>)()
    expect((face.snapshot as () => { namespace?: string })().namespace).toBe('sessionbox')

    await (face.save as (changes: Record<string, unknown>) => Promise<void>)({ baseUrl: 'http://example.test:8787' })
    expect(mutations[0]).toMatchObject({
      namespace: 'sessionbox',
      revision: 7,
      ops: [{ op: 'set', path: ['baseUrl'], value: 'http://example.test:8787' }],
    })

    await (face.saveCredential as (ref: string, value: string) => Promise<void>)('SESSIONBOX_TOKEN', 'sbt_secret')
    expect(credentials[0]).toEqual({ ref: 'SESSIONBOX_TOKEN', value: 'sbt_secret' })
  })
})
