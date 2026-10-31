/**
 * Client half of `dsh-background-compaction`.
 *
 * The ModuleLoader serves this file verbatim as `/plugins/dsh-background-compaction/client.js`,
 * so it is written directly in the lazy-CJS factory form instead of being
 * bundled: one file, no build step, no source map to keep in sync.
 *
 * It contributes exactly one thing: a `settings.section` page with three
 * fields. Everything else (compaction itself, `/bcompact`) lives on the host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-background-compaction',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const NAME = 'dsh-background-compaction'
    // Visible build stamp: the settings panel is the only surface that can tell
    // which client bundle the renderer actually loaded, and Electron keeps the
    // previous bundle until the window itself reloads.
    const BUILD = 'b5'
    const NS = 'background-compaction'

    /* ------------------------------------------------------------------ */
    /* i18n                                                                */
    /* ------------------------------------------------------------------ */

    const zh = {
      nav: '后台压缩',
      title: '后台压缩',
      description:
        '在上下文到达阈值之前，先在后台把较早的历史总结好；下一次对话直接使用摘要，不用等待。',
      autoTrigger: '自动触发比例',
      autoTriggerHint: '达到压缩阈值的这个比例时，开始在后台生成摘要。默认 0.85。',
      model: '摘要模型',
      modelHint: '默认跟随当前对话正在使用的模型。',
      modelFollow: '跟随当前对话',
      modelUnavailable: '模型目录不可用，请手动填写 provider 与 model。',
      provider: 'provider',
      modelId: 'model',
      failures: '失败熔断次数',
      failuresHint: '后台摘要连续失败达到这个次数后停止尝试，直到一次压缩成功。0 表示立即停止。',
      loading: '加载中…',
      saving: '保存中…',
      saved: '已保存，立即生效',
      loadFailed: '读取设置失败',
      saveFailed: '保存设置失败',
      fileHint: '设置保存在这个文件里，可以直接编辑：',
      invalidRatio: '比例必须在 0 与 1 之间',
      invalidFailures: '熔断次数必须是 0 到 10 的整数',
      invalidPair: 'provider 与 model 必须同时填写或同时留空',
      apply: '应用',
    }

    const en = {
      nav: 'Background compaction',
      title: 'Background compaction',
      description:
        'Summarize older history in the background before the context hits the threshold, so the next turn can use the summary without waiting.',
      autoTrigger: 'Auto trigger ratio',
      autoTriggerHint: 'Fraction of the compaction threshold that starts background summarization. Default 0.85.',
      model: 'Summarization model',
      modelHint: 'Defaults to the model the conversation is currently using.',
      modelFollow: 'Follow the conversation',
      modelUnavailable: 'Model catalog unavailable; enter provider and model manually.',
      provider: 'provider',
      modelId: 'model',
      failures: 'Failure circuit breaker',
      failuresHint: 'Stop background attempts after this many consecutive failures, until one compaction succeeds. 0 stops immediately.',
      loading: 'Loading…',
      saving: 'Saving…',
      saved: 'Saved and applied',
      loadFailed: 'Failed to read settings',
      saveFailed: 'Failed to save settings',
      fileHint: 'Settings live in this file and can be edited by hand:',
      invalidRatio: 'Ratio must be between 0 and 1',
      invalidFailures: 'Failure limit must be an integer from 0 to 10',
      invalidPair: 'provider and model must be set together or both left empty',
      apply: 'Apply',
    }

    /* ------------------------------------------------------------------ */
    /* remote contribution                                                 */
    /* ------------------------------------------------------------------ */

    // The client gateway does not project host Typert registrations on its own:
    // every client half mounts its own descriptor table with `$mount`, exactly
    // like `dsh-ops` does. This table mirrors `src/host/remote.js`;
    // `test/remote.test.js` keeps the two in sync.
    const REMOTE_PACKAGE = 'dsh-background-compaction'
    const REMOTE_NAMESPACE = 'backgroundCompaction'
    /** Cordis service name of the mounted namespace. */
    const REMOTE_SERVICE = `remote.${REMOTE_NAMESPACE}`

    const strictCodec = (name, parse) => ({
      mode: 'strict',
      typeSymbol: `${REMOTE_PACKAGE}#${name}`,
      create: () => ({ parse }),
    })

    const RESULT_CODEC = strictCodec('SettingsResult', (value) => value)
    const PATCH_CODEC = strictCodec('SettingsPatch', (value) =>
      value === undefined || value === null ? {} : value,
    )

    const remoteDescriptor = (method, parameter) => ({
      id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
      service: REMOTE_NAMESPACE,
      namespace: REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      result: RESULT_CODEC,
      parameters:
        parameter === undefined
          ? []
          : [{ name: parameter.wire, wire: parameter.wire, source: 'json', codec: parameter.codec }],
    })

    const REMOTE_CONTRIBUTION = Object.freeze({
      package: REMOTE_PACKAGE,
      descriptors: Object.freeze([
        remoteDescriptor('get'),
        remoteDescriptor('update', { wire: 'patch', codec: PATCH_CODEC }),
      ]),
    })

    /* ------------------------------------------------------------------ */
    /* styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.bgc-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary, #1f2328); }
.bgc-head { display: flex; flex-direction: column; gap: 6px; }
.bgc-title { font-size: 15px; font-weight: 600; margin: 0; }
.bgc-desc { font-size: 12.5px; line-height: 1.6; margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); }
.bgc-card { display: flex; flex-direction: column; gap: 20px; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.bgc-row { display: flex; flex-direction: column; gap: 8px; }
.bgc-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.bgc-label { font-size: 13px; font-weight: 550; }
.bgc-value { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.bgc-hint { font-size: 11.5px; line-height: 1.55; margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); }
.bgc-slider { display: flex; align-items: center; gap: 12px; }
.bgc-slider input[type="range"] { flex: 1; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.bgc-number { width: 84px; padding: 5px 8px; font: inherit; font-size: 12.5px; color: inherit; text-align: right; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px; background: var(--dsw-alias-bg-base, #fff); }
.bgc-number:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }
.bgc-select { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 8px 12px; font: inherit; font-size: 12.5px; color: inherit; text-align: left; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 9px; background: var(--dsw-alias-bg-base, #fff); }
.bgc-select:hover { border-color: var(--dsw-alias-border-l2, #d1d5db); }
.bgc-select-caret { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 10px; }
.bgc-menu { max-height: 280px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, #fafafa); padding: 4px; }
.bgc-group-label { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #6b7280); }
.bgc-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; font-size: 12.5px; color: inherit; text-align: left; cursor: pointer; border: 0; border-radius: 7px; background: transparent; }
.bgc-option:hover { background: var(--dsw-alias-bg-layer-1, #fff); }
.bgc-option[data-selected="true"] { color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 550; }
.bgc-check { font-size: 11px; }
.bgc-manual { display: flex; gap: 8px; }
.bgc-manual input { flex: 1; padding: 7px 10px; font: inherit; font-size: 12.5px; color: inherit; border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); border-radius: 8px; background: var(--dsw-alias-bg-base, #fff); }
.bgc-foot { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); }
.bgc-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.bgc-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #16a34a); }
.bgc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
`

    /** Install the stylesheet once per page and remove it on dispose. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const element = document.createElement('style')
      element.setAttribute('data-plugin', NAME)
      element.textContent = CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Unwrap one remote response envelope.
     * @param {{ok: boolean, value?: unknown, error?: {message?: string}}} response - remote envelope.
     * @param {string} fallback - message used when the envelope carries none.
     * @returns {unknown} the value.
     */
    function unwrap(response, fallback) {
      if (response === undefined || response === null) throw new Error(fallback)
      if (response.ok === false) throw new Error(response.error?.message ?? fallback)
      return response.value
    }

    /**
     * Format the stored pair for display.
     * @param {{provider: string, model: string}} pair - stored pair.
     * @param {(key: string) => string} t - translator.
     * @returns {string} display label.
     */
    function pairLabel(pair, t) {
      if (pair.provider.length === 0) return t('modelFollow')
      return `${pair.provider} / ${pair.model}`
    }

    /* ------------------------------------------------------------------ */
    /* page                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Build the settings page component bound to one plugin context.
     * @param {object} ctx - client plugin context.
     * @returns {Function} React component.
     */
    function makeSettingsPage(ctx, mountError) {
      const t = ctx.locale.bind(NS)
      // `ctx.remote.<namespace>` is a Cordis service accessor and requires
      // `remote.<namespace>` in this plugin's static `inject` table — which is a
      // chicken-and-egg here, because this very plugin mounts the namespace.
      // `ctx.get()` resolves the same instance without that declaration.
      const api = () => {
        const namespace = ctx.get(REMOTE_SERVICE)
        if (namespace === undefined) {
          throw new Error(mountError?.message ?? 'settings remote is not mounted')
        }
        return namespace
      }

      return function SettingsPage() {
        const [settings, setSettings] = useState(undefined)
        const [catalog, setCatalog] = useState(undefined)
        const [catalogFailed, setCatalogFailed] = useState(false)
        const [settingsFile, setSettingsFile] = useState('')
        const [status, setStatus] = useState({ tone: 'idle', text: '' })
        const [menuOpen, setMenuOpen] = useState(false)
        const [manualPair, setManualPair] = useState(undefined)
        const saveTimer = useRef(undefined)
        const mounted = useRef(true)

        useEffect(() => {
          mounted.current = true
          return () => {
            mounted.current = false
            if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
          }
        }, [])

        useEffect(() => {
          let cancelled = false
          ;(async () => {
            try {
              const snapshot = unwrap(await api().get(), t('loadFailed'))
              if (cancelled) return
              setSettings(snapshot.settings)
              setSettingsFile(snapshot.paths?.settings ?? '')
            } catch (error) {
              if (!cancelled) setStatus({ tone: 'error', text: `${t('loadFailed')}: ${error?.message ?? error}` })
              return
            }
            try {
              const value = unwrap(await ctx.remote.session.modelCatalog(), 'catalog unavailable')
              if (cancelled) return
              setCatalog(Array.isArray(value?.groups) ? value.groups : [])
            } catch {
              if (!cancelled) setCatalogFailed(true)
            }
          })()
          return () => {
            cancelled = true
          }
        }, [])

        const commit = useCallback(
          async (patch) => {
            try {
              setStatus({ tone: 'busy', text: t('saving') })
              const snapshot = unwrap(await api().update(patch), t('saveFailed'))
              if (!mounted.current) return
              setSettings(snapshot.settings)
              setStatus({ tone: 'ok', text: t('saved') })
            } catch (error) {
              if (!mounted.current) return
              setStatus({ tone: 'error', text: `${t('saveFailed')}: ${error?.message ?? error}` })
              // Re-read so the UI never shows a value that failed to persist.
              try {
                const snapshot = unwrap(await api().get(), t('loadFailed'))
                if (mounted.current) setSettings(snapshot.settings)
              } catch {
                /* keep the previous value */
              }
            }
          },
          [],
        )

        const scheduleCommit = useCallback(
          (patch) => {
            if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => {
              saveTimer.current = undefined
              void commit(patch)
            }, 350)
          },
          [commit],
        )

        const ratio = settings?.autoTriggerRatio ?? 0.85
        const failures = settings?.maxFailures ?? 2
        const pair = settings?.summarizationModel ?? { provider: '', model: '' }

        const groups = useMemo(() => {
          if (!Array.isArray(catalog)) return []
          return catalog
            .map((group) => ({
              id: group.id,
              name: group.name ?? group.id,
              models: Array.isArray(group.models) ? group.models : [],
            }))
            .filter((group) => group.models.length > 0)
        }, [catalog])

        if (settings === undefined) {
          return h(
            'div',
            { className: 'bgc-root' },
            h('div', { className: 'bgc-status', 'data-tone': status.tone === 'error' ? 'error' : 'idle' }, status.text || t('loading')),
            // The stamp must be visible on failure too: it is the only way to
            // tell whether the renderer loaded the current bundle.
            h('div', { className: 'bgc-mono', style: { opacity: 0.6 } }, `build ${BUILD}`),
          )
        }

        const ratioValid = ratio > 0 && ratio < 1
        const failuresValid = Number.isInteger(failures) && failures >= 0 && failures <= 10

        const rows = [
          h(
            'div',
            { className: 'bgc-row', key: 'ratio' },
            h(
              'div',
              { className: 'bgc-row-head' },
              h('span', { className: 'bgc-label' }, t('autoTrigger')),
              h('span', { className: 'bgc-value' }, `${Math.round(ratio * 100)}%`),
            ),
            h(
              'div',
              { className: 'bgc-slider' },
              h('input', {
                type: 'range',
                min: 0.1,
                max: 0.99,
                step: 0.01,
                value: ratio,
                'aria-label': t('autoTrigger'),
                onChange: (event) => {
                  const next = Number(event.target.value)
                  setSettings({ ...settings, autoTriggerRatio: next })
                  scheduleCommit({ autoTriggerRatio: next })
                },
              }),
              h('input', {
                className: 'bgc-number',
                type: 'number',
                min: 0.1,
                max: 0.99,
                step: 0.05,
                value: ratio,
                'aria-label': t('autoTrigger'),
                onChange: (event) => {
                  const next = Number(event.target.value)
                  setSettings({ ...settings, autoTriggerRatio: next })
                  if (next > 0 && next < 1) scheduleCommit({ autoTriggerRatio: next })
                },
              }),
            ),
            h('p', { className: 'bgc-hint' }, ratioValid ? t('autoTriggerHint') : t('invalidRatio')),
          ),
          h(
            'div',
            { className: 'bgc-row', key: 'model' },
            h('span', { className: 'bgc-label' }, t('model')),
            h(
              'button',
              {
                type: 'button',
                className: 'bgc-select',
                onClick: () => setMenuOpen((open) => !open),
                'aria-expanded': menuOpen,
              },
              h('span', null, pairLabel(pair, t)),
              h('span', { className: 'bgc-select-caret' }, menuOpen ? '▲' : '▼'),
            ),
            menuOpen
              ? h(
                  'div',
                  { className: 'bgc-menu' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bgc-option',
                      'data-selected': String(pair.provider.length === 0),
                      onClick: () => {
                        setMenuOpen(false)
                        const next = { provider: '', model: '' }
                        setSettings({ ...settings, summarizationModel: next })
                        void commit({ summarizationModel: next })
                      },
                    },
                    h('span', null, t('modelFollow')),
                    pair.provider.length === 0 ? h('span', { className: 'bgc-check' }, '✓') : null,
                  ),
                  groups.length > 0
                    ? groups.map((group) =>
                        h(
                          'div',
                          { key: group.id },
                          h('div', { className: 'bgc-group-label' }, group.name),
                          group.models.map((model) =>
                            h(
                              'button',
                              {
                                type: 'button',
                                key: `${group.id}/${model.id}`,
                                className: 'bgc-option',
                                'data-selected': String(pair.provider === group.id && pair.model === model.id),
                                onClick: () => {
                                  setMenuOpen(false)
                                  const next = { provider: group.id, model: model.id }
                                  setSettings({ ...settings, summarizationModel: next })
                                  void commit({ summarizationModel: next })
                                },
                              },
                              h('span', null, model.name ?? model.id),
                              pair.provider === group.id && pair.model === model.id
                                ? h('span', { className: 'bgc-check' }, '✓')
                                : null,
                            ),
                          ),
                        ),
                      )
                    : h('div', { className: 'bgc-hint', style: { padding: '8px 10px' } }, t('modelUnavailable')),
                )
              : null,
            catalogFailed
              ? h(
                  'div',
                  { className: 'bgc-manual' },
                  h('input', {
                    placeholder: t('provider'),
                    value: manualPair?.provider ?? pair.provider,
                    onChange: (event) => {
                      const next = { provider: event.target.value, model: manualPair?.model ?? pair.model }
                      setManualPair(next)
                    },
                  }),
                  h('input', {
                    placeholder: t('modelId'),
                    value: manualPair?.model ?? pair.model,
                    onChange: (event) => {
                      const next = { provider: manualPair?.provider ?? pair.provider, model: event.target.value }
                      setManualPair(next)
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bgc-select',
                      style: { width: 'auto' },
                      onClick: () => {
                        const next = manualPair ?? pair
                        const provider = next.provider.trim()
                        const model = next.model.trim()
                        if (provider.length === 0 !== (model.length === 0)) {
                          setStatus({ tone: 'error', text: t('invalidPair') })
                          return
                        }
                        const value = { provider, model }
                        setSettings({ ...settings, summarizationModel: value })
                        void commit({ summarizationModel: value })
                      },
                    },
                    t('apply'),
                  ),
                )
              : h('p', { className: 'bgc-hint' }, t('modelHint')),
          ),
          h(
            'div',
            { className: 'bgc-row', key: 'failures' },
            h(
              'div',
              { className: 'bgc-row-head' },
              h('span', { className: 'bgc-label' }, t('failures')),
            ),
            h('input', {
              className: 'bgc-number',
              type: 'number',
              min: 0,
              max: 10,
              step: 1,
              value: failures,
              'aria-label': t('failures'),
              onChange: (event) => {
                const next = Number(event.target.value)
                setSettings({ ...settings, maxFailures: next })
                if (Number.isInteger(next) && next >= 0 && next <= 10) scheduleCommit({ maxFailures: next })
              },
            }),
            h('p', { className: 'bgc-hint' }, failuresValid ? t('failuresHint') : t('invalidFailures')),
          ),
        ]

        return h(
          'div',
          { className: 'bgc-root' },
          h(
            'div',
            { className: 'bgc-head' },
            h('h2', { className: 'bgc-title' }, t('title')),
            h('p', { className: 'bgc-desc' }, t('description')),
          ),
          h('div', { className: 'bgc-card' }, rows),
          h(
            'div',
            { className: 'bgc-foot' },
            status.text.length > 0
              ? h('div', { className: 'bgc-status', 'data-tone': status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'ok' : 'idle' }, status.text)
              : null,
            settingsFile.length > 0
              ? h('div', null, t('fileHint'), h('div', { className: 'bgc-mono' }, settingsFile))
              : null,
            h('div', { className: 'bgc-mono' }, `build ${BUILD}`),
          ),
        )
      }
    }

    /* ------------------------------------------------------------------ */
    /* plugin                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * @param {object} ctx - client plugin context.
     */
    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'background-compaction: dictionaries')
      ctx.effect(() => installStyles(), 'background-compaction: styles')
      // Mount the namespace before the page can render; a failure is surfaced in
      // the page instead of removing it.
      let mountError
      try {
        await ctx.remote.$mount(REMOTE_CONTRIBUTION)
      } catch (error) {
        mountError = error
        console.warn('[dsh-background-compaction] settings remote mount failed', error)
      }
      const SettingsPage = makeSettingsPage(ctx, mountError)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'background-compaction',
            order: 26,
            label: () => t('nav'),
          },
          SettingsPage,
        ),
      )
    }

    const inject = ['slots', 'locale', 'remote']
    const module = { exports: { apply, inject, name: NAME } }
    return module.exports
  },
})
