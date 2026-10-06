/**
 * SessionBox execution-target chip — the browser half of `@sessionbox/dsh-plugin`.
 *
 * Hand-written and shipped as-is: the client module registry serves
 * `exports["./client"]` bytes into the page, where the file's only job is to
 * register itself with `window.__ModuleLoader__` and hand back a plugin. No
 * bundler, no React compilation — `React.createElement` is enough for one
 * compact control.
 *
 * Two things it needs from the host are already on the client:
 *
 * - the current binding arrives through the `executionTarget` session
 *   projection, which the session controller forwards with every other one;
 * - the write path is the `/sessionbox` command, submitted through the same
 *   `session.command()` call the permission chip uses.
 *
 * The container *list* is the one thing that needs a new Remote namespace. The
 * client mounts it itself: a plugin may call `ctx.remote.$mount(...)` with its
 * own descriptors (the pattern `client-ui-voice-input` uses), and the host side
 * needs no generated artifact because the gateway derives descriptors for a
 * `TypertRemoteService` binding at runtime from its `@Remote` markers.
 */
window.__ModuleLoader__.load({
  id: '@sessionbox/dsh-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /**
     * The shell's own controls, when the page exposes them.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is a platform module (the shell
     * seeds it under its scoped package name), so a dynamic plugin can require
     * it — but a page that does not seed it must still render something usable
     * rather than losing the whole plugin, so the fallbacks are the native
     * elements with the same props.
     */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (error) {
        console.warn('sessionbox: ui primitives are unavailable, falling back to native controls', error)
        return undefined
      }
    })()
    const UiButton = primitives?.Button ?? 'button'
    const UiInput = primitives?.Input ?? 'input'
    const UiMenu = primitives?.Menu

    /** Endpoint `sessionbox/containers`, matching the host's `@Remote('containers')`. */
    const CONTAINERS_CONTRIBUTION = {
      package: '@sessionbox/dsh-plugin',
      descriptors: [{
        id: '@sessionbox/dsh-plugin#sessionbox/containers',
        service: 'sessionbox',
        namespace: 'sessionbox',
        method: 'containers',
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      }],
    }

    const HOST_VALUE = '__sessionbox_host__'

    /**
     * One process-wide container catalog shared by every session's chip.
     *
     * The host cannot push an invalidation for its own event (the forwarded
     * event allowlist lives in `@deepseek-ai/dsh-api-remotes` and a plugin
     * cannot extend it), so this caches briefly and re-reads whenever a chip
     * mounts or a switch succeeds.
     */
    function createCatalog(ctx) {
      let value = { state: 'loading', containers: [], problem: undefined }
      let loadedAt = 0
      let inflight
      const listeners = new Set()
      const publish = (next) => {
        value = next
        for (const listener of [...listeners]) listener()
      }

      const refresh = async (force = false) => {
        if (!force && value.state === 'ready' && Date.now() - loadedAt < 3000) return
        if (inflight !== undefined) return await inflight
        inflight = (async () => {
          try {
            // This namespace is mounted by this plugin rather than by the shell,
            // so it cannot appear in `inject`: the fiber would wait for a service
            // that only exists after apply runs. Read it from the service store.
            const namespace = ctx.get('remote.sessionbox')
            if (namespace === undefined) throw new Error('the sessionbox remote namespace is not mounted')
            // The caller's session id is not sent: a diagnostic on the critical
            // path is how the container list itself broke once already.
            const result = await namespace.containers()
            if (!result.ok) {
              publish({ state: 'failed', containers: [], problem: `${result.error.code}: ${result.error.message}` })
            } else {
              publish({
                state: 'ready',
                containers: result.value.containers,
                configured: result.value.configured,
                problem: result.value.problem,
                // The per-session bindings and the configured default are part
                // of the answer: dropping them here left every lookup empty, so
                // the control always fell back to "host" no matter what the
                // host had stored.
                targets: result.value.targets,
                defaultTarget: result.value.defaultTarget,
              })
            }
          } catch (error) {
            publish({ state: 'failed', containers: [], problem: describe(error) })
          } finally {
            loadedAt = Date.now()
            inflight = undefined
          }
        })()
        return await inflight
      }

      return {
        subscribe: (listener) => {
          listeners.add(listener)
          void refresh()
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => value,
        refresh,
        dispose: () => { listeners.clear() },
      }
    }

    /** Submit one target switch through the command that owns the write path. */
    async function choose(ctx, sessionId, container) {
      const live = ctx.sessions.binding(sessionId)?.session
      if (live === undefined) throw new Error('this session is not materialized yet')
      const line = container === HOST_VALUE ? '/sessionbox host' : `/sessionbox ${container}`
      const result = await live.command(line)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (!result.value.matched) throw new Error('this host offers no /sessionbox command')
      // The command's own outcome, not just its delivery: a handler that refused
      // the switch answered with an error result, and accepting that as success
      // is how a control ends up looking wired while nothing happened.
      const outcome = result.value.result
      if (outcome !== undefined && outcome.kind === 'error') throw new Error(outcome.text)
    }

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * The chip itself.
     *
     * It renders one select: the current execution target, with the harness host
     * and every selectable container as options. Selecting an option submits the
     * equivalent `/sessionbox` line, so the control is a view over the command
     * rather than a second write path.
     */
    function TargetChip(props) {
      const { sessionId, sessionbox } = props
      const catalog = React.useSyncExternalStore(sessionbox.subscribe, sessionbox.getSnapshot)
      const projected = React.useSyncExternalStore(
        sessionbox.targetSubscribe,
        sessionbox.targetSnapshot,
      )
      // The host is authoritative: it reads the durable binding store, while the
      // session's own projection only knows what its log happened to record.
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [chosen, setChosen] = React.useState(undefined)
      // This slot renders only for a real session — the composer skips it while
      // `sessionId` is undefined, and a blank "new session" view already carries
      // the host-minted id — so there is no draft case to special-case. The
      // host's catalog is the current answer, and the session's own projection
      // is the fallback when that catalog is unavailable.
      const listed = catalog.state === 'ready' && (catalog.targets ?? {})[sessionId] !== undefined
      const bound = (catalog.targets ?? {})[sessionId]
      const hostSays = listed
        ? (bound?.kind === 'container' ? bound.name : 'host')
        : (projected?.kind === 'container' ? projected.name : 'host')
      // A selection is shown the moment it is made and keeps the display until
      // the host reports the same thing. Without this the control fell back to
      // the host's stale view and looked like it ignored the click, even when
      // the switch itself worked.
      const shownName = chosen ?? hostSays
      const defaultContainer = shownName === 'host'
        ? undefined
        : (catalog.containers ?? []).find((container) => container.name === shownName || container.id === shownName)
          ?? { id: shownName, name: shownName, status: 'unknown' }
      const target = shownName === 'host'
        ? undefined
        : { kind: 'container', containerId: defaultContainer.id, name: defaultContainer.name }
      React.useEffect(() => {
        if (chosen !== undefined && hostSays === chosen) setChosen(undefined)
      }, [chosen, hostSays])

      const selectedId = target?.kind === 'container' ? target.containerId : HOST_VALUE
      // A session created with the configured default is bound by the host after
      // this chip's shared catalog snapshot was taken, so a mount that trusted
      // the cache showed the target the session had *before* the binding. The
      // TTL refresh re-reads only when the snapshot is actually old.
      React.useEffect(() => { void sessionbox.ensureFresh() }, [sessionbox, sessionId])

      const items = [{ id: HOST_VALUE, label: 'host' }].concat(
        (catalog.containers ?? []).map((container) => ({
          id: container.id,
          label: container.status === 'running' ? container.name : `${container.name} · ${container.status}`,
        })),
      )
      // A bound container the catalog no longer lists must stay visible, or the
      // control would silently show a target the session is not using.
      if (target?.kind === 'container' && !items.some((item) => item.id === target.containerId)) {
        items.push({ id: target.containerId, label: `${target.name ?? target.containerId} (unavailable)` })
      }
      if (items.length === 1) {
        items.push({
          id: '__sessionbox_loading__',
          label: catalog.state === 'failed' ? (catalog.problem ?? 'unavailable') : '…',
          disabled: true,
        })
      }

      const select = (id) => {
        setOpen(false)
        if (id === selectedId) return
        setBusy(true)
        setFailure(undefined)
        // The selection owns the display until the write and the refresh land.
        const value = id === HOST_VALUE ? 'host' : id
        setChosen(value)
        // This control always switches the session it is rendered for. The slot
        // it lives in is session-scoped and the composer skips it while no
        // session exists, so a "draft" branch was never reachable — and while it
        // existed it wrote the new-session default instead of switching, which
        // is how that setting moved without anyone asking.
        const run = choose(sessionbox.context, sessionId, id)
        void run.then(
          async () => {
            // The host has re-read the bindings by now, so its answer is
            // authoritative and the optimistic value must go: an override that
            // outlives its write is how the control ends up showing a target the
            // session is not using.
            await sessionbox.refresh()
            setChosen(undefined)
          },
          (error) => {
            // A failed selection must not keep owning the display.
            setFailure(describe(error))
            setChosen(undefined)
          },
        ).finally(() => { setBusy(false) })
      }

      // The trailing bracket is the control's own reading of its two sources.
      // It exists because "the chip says host while the session runs in a
      // container" is otherwise indistinguishable from a stale page, a missing
      // catalog entry, and an empty projection — and hovering costs nothing.
      const reading = ` [id=${sessionId} catalog=${catalog.state} listed=${String(listed)}`
        + ` projection=${projected === undefined ? 'none' : (projected.kind ?? 'unknown')}]`
      const title = failure !== undefined
        ? failure
        : (target?.kind === 'container'
            ? `This session runs inside container ${target.name} (${target.workspace ?? '/workspace'})`
            : 'This session runs on the machine hosting the harness') + reading

      const trigger = h(UiButton, {
        variant: 'toolbar',
        size: 'sm',
        onClick: () => { setOpen((current) => !current) },
        disabled: busy,
        title,
        'aria-label': 'Execution target',
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        statusDot(target?.kind === 'container'),
        target?.kind === 'container' ? target.name : 'host',
      ))

      // A failure is shown as text, not only in the tooltip: a control that
      // silently reverts is indistinguishable from one that is not wired up.
      const failureNote = failure === undefined
        ? null
        : h('span', {
            style: {
              marginLeft: 6,
              fontSize: '0.78em',
              color: 'var(--dsw-alias-state-error-primary)',
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: failure,
          }, failure)

      // Without the shell's menu the control still works, and still looks like
      // the page: a native select's popup ignores the theme entirely, so the
      // fallback is a small token-styled list instead.
      if (UiMenu === undefined) {
        return h('span', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' }, title },
          trigger,
          failureNote,
          open
            ? h('div', {
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: 0,
                  zIndex: 40,
                  minWidth: 170,
                  display: 'grid',
                  gap: 2,
                  padding: 4,
                  borderRadius: 10,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-overlay)',
                  boxShadow: '0 8px 24px rgb(0 0 0 / 0.28)',
                },
              }, items.map((item) => h('button', {
                key: item.id,
                type: 'button',
                disabled: item.disabled === true,
                onClick: () => { select(item.id) },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 8px',
                  border: 'none',
                  borderRadius: 6,
                  textAlign: 'left',
                  font: 'inherit',
                  cursor: 'pointer',
                  background: item.id === selectedId ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  opacity: item.disabled === true ? 0.5 : 1,
                },
              }, h('span', { style: { width: 10 } }, item.id === selectedId ? '✓' : ''), item.label)))
            : null,
        )
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
        h(UiMenu, {
          open,
          anchor: trigger,
          items,
          selectedId,
          onSelect: select,
          onClose: () => { setOpen(false) },
          side: 'top',
          align: 'start',
          portal: true,
          compact: true,
        }),
        failureNote,
      )
    }

    /**
     * Settings copy. The page is a settings *section*, so its labels follow the
     * same locale-owned rule the shipped sections use.
     */
    const DICTIONARY = {
      zh: {
        nav: 'SessionBox',
        title: 'SessionBox 执行环境',
        intro: '把会话绑定到容器后，该会话的文件与命令操作都在容器内执行；未绑定的会话仍在本机。',
        connection: '连接',
        baseUrl: '服务地址',
        baseUrlHint: 'SessionBox 服务端地址，例如 http://127.0.0.1:8787。',
        tokenRef: '凭据名',
        tokenRefHint: '配置里只保存这个名字；真正的 token 存在凭据库里，不进配置文件。',
        token: 'Token 值',
        tokenHint: '写入上面「凭据名」指定的那条凭据；留空表示不改动。',
        saveToken: '保存 Token',
        container: '容器',
        containerRoot: '容器工作目录',
        defaultTarget: '新会话默认环境',
        defaultTargetHint: '容器名/id，或 host。新建会话会直接落在它上面；解析不出来会报错，不会静默跑在 host。',
        limits: '超时与输出',
        defaultTimeoutMs: '默认超时（毫秒）',
        maxTimeoutMs: '最大超时（毫秒）',
        requestTimeoutMs: '单次请求超时（毫秒）',
        maxOutputBytes: '单条输出上限（字节）',
        search: '搜索工具',
        provisionRipgrep: '自动安装 ripgrep',
        provisionRipgrepHint: '容器缺少 rg 时用 apt 安装一次，glob/grep 依赖它。',
        containerPrograms: '走容器的程序',
        containerProgramsHint: '逗号分隔；只有这些程序的子进程会被转发到容器。',
        save: '保存',
        saved: '已保存',
        reload: '重新读取',
        advanced: '高级设置',
        advancedHint: '容器目录、超时、输出上限、搜索工具与凭据名。',
        containers: '可用容器',
        noContainers: '没有读到容器（先填好服务地址与 token）。',
        loading: '读取中…',
        unavailable: '设置服务不可用',
      },
      en: {
        nav: 'SessionBox',
        title: 'SessionBox execution targets',
        intro: 'A session bound to a container runs its file and shell work inside it; unbound sessions stay on this machine.',
        connection: 'Connection',
        baseUrl: 'Server URL',
        baseUrlHint: 'SessionBox server origin, for example http://127.0.0.1:8787.',
        tokenRef: 'Credential name',
        tokenRefHint: 'Only this name is stored in configuration; the token itself lives in the credential store.',
        token: 'Token value',
        tokenHint: 'Written to the credential named above; leave blank to keep it unchanged.',
        saveToken: 'Save token',
        container: 'Container',
        containerRoot: 'Container working directory',
        defaultTarget: 'Default target for new sessions',
        defaultTargetHint: 'A container name/id, or host. New sessions start there; an unresolvable name is reported instead of quietly running on the host.',
        limits: 'Timeouts and output',
        defaultTimeoutMs: 'Default timeout (ms)',
        maxTimeoutMs: 'Maximum timeout (ms)',
        requestTimeoutMs: 'Request timeout (ms)',
        maxOutputBytes: 'Output limit (bytes)',
        search: 'Search tooling',
        provisionRipgrep: 'Install ripgrep automatically',
        provisionRipgrepHint: 'Installs rg once with apt when the image lacks it; glob and grep need it.',
        containerPrograms: 'Programs routed to the container',
        containerProgramsHint: 'Comma separated; only these programs are forwarded to the container.',
        save: 'Save',
        saved: 'Saved',
        reload: 'Reload',
        advanced: 'Advanced settings',
        advancedHint: 'Container directory, timeouts, output limit, search tooling, and the credential name.',
        containers: 'Available containers',
        noContainers: 'No containers read yet — set the server URL and token first.',
        loading: 'Loading…',
        unavailable: 'The settings service is unavailable',
      },
    }

    /** Editable fields, in page order. */
    const FIELDS = [
      { key: 'baseUrl', group: 'connection', kind: 'text' },
      { key: 'tokenRef', group: 'connection', kind: 'text', hint: 'tokenRefHint' },
      { key: 'containerRoot', group: 'container', kind: 'text' },
      { key: 'defaultTarget', group: 'container', kind: 'text', hint: 'defaultTargetHint' },
      { key: 'defaultTimeoutMs', group: 'limits', kind: 'number' },
      { key: 'maxTimeoutMs', group: 'limits', kind: 'number' },
      { key: 'requestTimeoutMs', group: 'limits', kind: 'number' },
      { key: 'maxOutputBytes', group: 'limits', kind: 'number' },
      { key: 'provisionRipgrep', group: 'search', kind: 'boolean', hint: 'provisionRipgrepHint' },
      { key: 'containerPrograms', group: 'search', kind: 'list', hint: 'containerProgramsHint' },
    ]

    /** Fields that stay on the front page; everything else is advanced. */
    const PRIMARY_KEYS = ['baseUrl']

    /** Inline styles over the application's own design tokens. */
    const styles = {
      root: { maxWidth: 620, display: 'grid', gap: 16 },
      title: { margin: 0, fontSize: '1.05em', color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: '0.9em', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
      problem: { margin: 0, fontSize: '0.85em', color: 'var(--dsw-alias-state-error-primary)' },
      group: { display: 'grid', gap: 12 },
      groupTitle: { margin: 0, fontSize: '0.85em', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      label: { display: 'grid', gap: 6 },
      labelText: { fontSize: '0.85em', color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '0.78em', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', opacity: 0.75 },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      note: { fontSize: '0.82em', color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'grid',
        gap: 6,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardTitle: { margin: 0, fontSize: '0.85em', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      containerRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.88em', color: 'var(--dsw-alias-label-primary)' },
      details: {
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      summary: { cursor: 'pointer', fontSize: '0.85em', color: 'var(--dsw-alias-label-secondary)' },
      meta: { margin: 0, fontSize: '0.76em', color: 'var(--dsw-alias-label-secondary)', opacity: 0.7 },
    }

    /** A status dot for one container row. */
    function statusDot(running) {
      return h('span', {
        style: {
          width: 7,
          height: 7,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: running ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
        },
      })
    }

    /** Names the host may use for this entry's configuration namespace. */
    const SETTINGS_KEYS = ['sessionbox', 'include:sessionbox', '@sessionbox/dsh-plugin']

    /**
     * Read and write this plugin's host configuration.
     *
     * Both surfaces are published client namespaces, so the section writes where
     * the plugin manager's own form would: `configForms` for values and
     * revisions, `remote.settings.mutate` when that face is not mounted, and
     * `remote.credentials.set` for the token literal, which never enters the
     * configuration file. Everything it cannot do is reported instead of
     * silently swallowed, because a form that appears to save and does not is
     * worse than a form that says it cannot.
     *
     * @param ctx - the page plugin context.
     * @returns the face the section renders from.
     */
    function createSettingsFace(ctx) {
      let cache = { state: 'loading', values: {}, revision: undefined, problem: undefined, namespace: undefined }
      const listeners = new Set()
      let inflight
      const publish = (next) => {
        cache = next
        for (const listener of [...listeners]) listener()
      }

      /** The configuration namespace and its values, or why neither is available. */
      const locate = async () => {
        const forms = ctx.get('configForms')
        const settings = ctx.remote?.settings
        if (settings === undefined && forms === undefined) {
          return { problem: 'neither configForms nor remote.settings is mounted in this page' }
        }
        let names = []
        if (settings !== undefined && typeof settings.describe === 'function') {
          const described = await settings.describe()
          if (described?.ok !== true) {
            return { problem: `${described?.error?.code ?? 'ERROR'}: ${described?.error?.message ?? 'describe failed'}` }
          }
          names = (described.value?.namespaces ?? []).map((view) => view.ns)
        }
        const namespace = SETTINGS_KEYS.find((candidate) => names.includes(candidate))
          ?? names.find((name) => typeof name === 'string' && name.includes('sessionbox'))
        if (namespace === undefined) {
          return { problem: `no configuration namespace for this plugin (host offers: ${names.join(', ') || 'none'})` }
        }
        if (forms !== undefined && typeof forms.get === 'function') {
          const form = forms.get(namespace)
          if (form !== undefined && typeof form.getSnapshot === 'function') {
            const snapshot = form.getSnapshot()
            return {
              namespace,
              revision: snapshot?.revision,
              values: snapshot?.value ?? snapshot?.values ?? {},
              form,
              settings,
            }
          }
        }
        const view = (settings !== undefined && typeof settings.describe === 'function')
          ? (await settings.describe()).value?.namespaces?.find((candidate) => candidate.ns === namespace)
          : undefined
        return { namespace, revision: view?.revision, values: view?.value ?? view?.values ?? {}, settings }
      }

      const load = async () => {
        try {
          const found = await locate()
          if (found.problem !== undefined) {
            publish({ state: 'failed', values: {}, revision: undefined, problem: found.problem, namespace: found.namespace })
            return
          }
          publish({ state: 'ready', values: found.values ?? {}, revision: found.revision, problem: undefined, namespace: found.namespace })
        } catch (error) {
          publish({ state: 'failed', values: {}, revision: undefined, problem: describe(error), namespace: undefined })
        }
      }

      const refresh = async () => {
        if (inflight !== undefined) return await inflight
        inflight = load().finally(() => { inflight = undefined })
        return await inflight
      }

      /**
       * Write the given fields through the same mutation the manager's form uses.
       *
       * The outcome is published *and* thrown: a caller with its own feedback
       * surface (the input-bar chip) must be able to say why nothing happened,
       * and a write that fails silently is how a control ends up looking broken.
       *
       * @param changes - field name to new value.
       * @returns resolution once the host accepted the change.
       */
      const save = async (changes) => {
        try {
          const found = await locate()
          if (found.problem !== undefined) {
            publish({ ...cache, state: 'failed', problem: found.problem })
            throw new Error(found.problem)
          }
          const ops = Object.entries(changes).map(([field, value]) => ({ op: 'set', path: [field], value }))
          let ok
          if (found.form !== undefined) ok = await found.form.mutate(ops, found.revision)
          else ok = (await found.settings.mutate(found.namespace, ops, found.revision))?.ok === true
          if (ok === false) {
            publish({ ...cache, state: 'failed', problem: 'the host rejected the change' })
            throw new Error('the host rejected the change')
          }
          await refresh()
        } catch (error) {
          publish({ ...cache, state: 'failed', problem: describe(error) })
          throw error
        }
      }

      /**
       * Store the token literal under the configured credential name.
       * @param ref - credential name.
       * @param value - the secret.
       */
      const saveCredential = async (ref, value) => {
        const credentials = ctx.remote?.credentials
        if (credentials === undefined || typeof credentials.set !== 'function') {
          publish({ ...cache, state: 'failed', problem: 'remote.credentials is not mounted in this page' })
          return
        }
        try {
          const response = await credentials.set(ref, value)
          if (response?.ok !== true) {
            publish({ ...cache, state: 'failed', problem: `${response?.error?.code ?? 'ERROR'}: ${response?.error?.message ?? 'set failed'}` })
            return
          }
          publish({ ...cache, state: 'ready', problem: undefined })
        } catch (error) {
          publish({ ...cache, state: 'failed', problem: describe(error) })
        }
      }

      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        snapshot: () => cache,
        refresh,
        save,
        saveCredential,
      }
    }

    /** One labelled row of the settings form. */
    function fieldRow(t, field, values, onChange) {
      const value = values[field.key]
      const input = field.kind === 'boolean'
        ? h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.88em', color: 'var(--dsw-alias-label-primary)' } },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => { onChange(field.key, event.target.checked) },
            }),
            t(field.key),
          )
        : h(UiInput, {
            type: field.kind === 'number' ? 'number' : 'text',
            value: field.kind === 'list'
              ? (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
              : (value === undefined || value === null ? '' : String(value)),
            onChange: (event) => {
              onChange(field.key, field.kind === 'number' ? Number(event.target.value) : event.target.value)
            },
          })
      return h('div', { key: field.key, style: styles.label },
        field.kind === 'boolean' ? input : h('span', { style: styles.labelText }, t(field.key)),
        field.kind === 'boolean' ? null : input,
        field.hint === undefined ? null : h('span', { style: styles.hint }, t(field.hint)),
      )
    }

    /**
     * The SessionBox settings section: connection, container, limits, search
     * tooling, the token literal, and the container list the chip also reads.
     * @param props - settings.section owner props plus the injected face.
     * @returns the rendered section.
     */
    function SessionBoxSection(props) {
      const face = props.sessionbox
      const t = face.t
      const state = React.useSyncExternalStore(face.subscribe, face.snapshot)
      const catalog = React.useSyncExternalStore(face.catalogSubscribe, face.catalogSnapshot)
      const [draft, setDraft] = React.useState(undefined)
      const [token, setToken] = React.useState('')
      const [note, setNote] = React.useState(undefined)

      React.useEffect(() => { void face.refresh() }, [face])
      React.useEffect(() => { void face.refreshCatalog() }, [face])

      const values = draft ?? state.values ?? {}
      const change = (field, value) => { setDraft({ ...values, [field]: value }) }

      const submit = async () => {
        const changes = {}
        for (const field of FIELDS) {
          const next = values[field.key]
          if (next === undefined) continue
          changes[field.key] = field.kind === 'list'
            ? String(next).split(',').map((part) => part.trim()).filter((part) => part !== '')
            : next
        }
        setNote(t('loading'))
        await face.save(changes)
        setDraft(undefined)
        setNote(t('saved'))
      }

      const advancedFields = FIELDS.filter((field) => !PRIMARY_KEYS.includes(field.key))
      const advanced = ['connection', 'container', 'limits', 'search']
        .map((group) => advancedFields.filter((field) => field.group === group))
        .filter((fields) => fields.length > 0)
        .map((fields) => h('div', { key: fields[0].group, style: styles.group },
          h('h4', { style: styles.groupTitle }, t(fields[0].group)),
          fields.map((field) => fieldRow(t, field, values, change)),
        ))

      const containers = catalog.state === 'ready' && catalog.containers.length > 0
        ? catalog.containers.map((container) => h('div', { key: container.id, style: styles.containerRow },
            statusDot(container.status === 'running'),
            h('span', { style: { fontWeight: 500 } }, container.name),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '0.85em' } }, container.status),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '0.78em', marginLeft: 'auto' } }, container.id),
          ))
        : h('span', { style: styles.hint }, t('noContainers'))

      return h('div', { style: styles.root },
        h('h3', { style: styles.title }, t('title')),
        h('p', { style: styles.intro }, t('intro')),
        state.problem === undefined ? null : h('p', { style: styles.problem }, `${t('unavailable')}: ${state.problem}`),

        // The two values a first run actually needs, then the rest on demand.
        h('div', { style: styles.group },
          FIELDS.filter((field) => PRIMARY_KEYS.includes(field.key)).map((field) => fieldRow(t, field, values, change)),
          h('div', { style: styles.label },
            h('span', { style: styles.labelText }, t('token')),
            h(UiInput, {
              type: 'password',
              value: token,
              placeholder: values.tokenRef ?? 'SESSIONBOX_TOKEN',
              onChange: (event) => { setToken(event.target.value) },
            }),
            h('span', { style: styles.hint }, t('tokenHint')),
          ),
        ),

        h('div', { style: styles.actions },
          h(UiButton, { variant: 'primary', onClick: submit }, t('save')),
          h(UiButton, {
            variant: 'outline',
            onClick: async () => {
              setNote(t('loading'))
              await face.saveCredential(values.tokenRef ?? 'SESSIONBOX_TOKEN', token)
              setToken('')
              setNote(t('saved'))
              void face.refreshCatalog()
            },
          }, t('saveToken')),
          h(UiButton, { variant: 'ghost', onClick: () => { void face.refresh() } }, t('reload')),
          note === undefined ? null : h('span', { style: styles.note }, note),
        ),

        // A dictionary that did not reach the locale service silently reduced
        // this section to English while the rest of the application stayed
        // translated. Saying so on the page beats leaving it to be noticed.
        t('nav') === 'nav'
          ? h('p', { style: { ...styles.hint, color: 'var(--dsw-alias-state-warning-primary, inherit)' } },
              'locale dictionary unavailable — showing built-in English copy')
          : null,

        h('details', { style: styles.details },
          h('summary', { style: styles.summary }, t('advanced')),
          h('p', { style: styles.hint }, t('advancedHint')),
          h('div', { style: { ...styles.group, marginTop: 12 } }, advanced),
          state.namespace === undefined ? null : h('p', { style: { ...styles.meta, marginTop: 10 } },
            `${state.namespace}${state.revision === undefined ? '' : ` · revision ${state.revision}`}`),
        ),

        h('div', { style: styles.card },
          h('h4', { style: styles.cardTitle }, t('containers')),
          catalog.problem === undefined ? null : h('p', { style: styles.problem }, catalog.problem),
          containers,
        ),
      )
    }

    return {
      // `remote.settings` and `remote.credentials` are namespace services: the
      // property proxy refuses them without a matching declaration, and the
      // section writes configuration and the token through exactly those two.
      inject: ['slots', 'sessions', 'remote', 'remote.settings', 'remote.credentials', 'locale'],
      /**
       * Mount the container namespace, then the chip.
       *
       * Every step is contained: a browser half that throws while loading its
       * own namespace would take the page's plugin load with it, and this
       * control is an addition to the input bar rather than a prerequisite for
       * a session working. A failure leaves a console diagnostic and no chip.
       * @param ctx - the page plugin context.
       */
      async apply(ctx) {
        try {
          const disposeRemote = await ctx.remote.$mount(CONTAINERS_CONTRIBUTION)
          ctx.effect(() => () => { void disposeRemote() })

          const catalog = createCatalog(ctx)
          ctx.effect(() => () => { catalog.dispose() })

          const settingsFace = createSettingsFace(ctx)
          ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'sessionbox-execution-target',
            order: 20,
            inject: (sessionId) => ({
              sessionbox: {
                context: ctx,
                subscribe: catalog.subscribe,
                getSnapshot: catalog.getSnapshot,
                refresh: () => catalog.refresh(true),
                ensureFresh: () => catalog.refresh(),
                targetSubscribe: (listener) => targetFace(ctx, sessionId).subscribe(listener),
                targetSnapshot: () => targetFace(ctx, sessionId).getSnapshot(),
              },
            }),
          }, TargetChip))

          // The settings section is a second registration into a slot the
          // settings shell declares, so it needs no change to any other plugin.
          const settings = settingsFace
          // Declared injection, so the provider is ACTIVE before this runs: an
          // uninjected `ctx.get` lost the activation race and permanently froze
          // the identity fallback, which is why the section stayed English while
          // the rest of the application was Chinese.
          const locale = ctx.locale
          if (locale === undefined) {
            console.warn('sessionbox: the locale service is unavailable; the settings section falls back to English')
          }
          if (locale !== undefined) {
            ctx.effect(
              () => locale.register('settings.sessionbox', { zh: DICTIONARY.zh, en: DICTIONARY.en }),
              'sessionbox: settings dictionaries',
            )
          }
          const bound = locale === undefined ? (key) => key : locale.bind('settings.sessionbox')
          // A dictionary that failed to register must not leave a blank nav row:
          // fall back to the shipped English copy, then to the key itself.
          const t = (key) => {
            const value = bound(key)
            return typeof value === 'string' && value !== '' && value !== key ? value : (DICTIONARY.en[key] ?? key)
          }
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'sessionbox',
            order: 30,
            label: () => t('nav'),
            locale: 'settings.sessionbox',
            inject: () => ({
              sessionbox: {
                t,
                subscribe: settings.subscribe,
                snapshot: settings.snapshot,
                refresh: settings.refresh,
                save: settings.save,
                saveCredential: settings.saveCredential,
                catalogSubscribe: catalog.subscribe,
                catalogSnapshot: catalog.getSnapshot,
                refreshCatalog: () => catalog.refresh(true),
                saveDefault: (value) => settings.save({ defaultTarget: value }),
              },
            }),
          }, SessionBoxSection))
        } catch (error) {
          console.error('sessionbox: the execution-target chip did not load', error)
        }
      },
    }

    /** The session's execution-target projection face, or an inert stand-in. */
    function targetFace(ctx, sessionId) {
      const face = ctx.sessions.binding(sessionId)?.session?.projections.faceOf('executionTarget')
      if (face !== undefined) return face
      return {
        getSnapshot: () => undefined,
        subscribe: () => () => {},
      }
    }
  },
})
