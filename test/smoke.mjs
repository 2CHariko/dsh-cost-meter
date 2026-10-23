/**
 * Smoke test for the cost-meter client bundle.
 *
 * It drives `lib/client.js` through the real client envelope: stub
 * `window.__ModuleLoader__` (as the shell does), evaluate the factory, run
 * `apply` against a fake cordis context that records slot registrations, then
 * render the registered components.
 *
 * React is shimmed on purpose: the deployment ships a prebuilt frontend and
 * installs no React on disk, so there is no real instance to borrow here. The
 * shim implements the surface the bundle uses — `createElement`, `Fragment`,
 * `useState`, `useRef`, `useEffect`, `useLayoutEffect`, `useSyncExternalStore`,
 * `Component` — plus a static renderer that honors function components, class
 * components, and `getDerivedStateFromError` boundaries, which is enough to
 * prove registration shape, the priced pill, the peak/off-peak resolver, the
 * detail panel, the settings page, and every fallback state.
 *
 * Run: node test/smoke.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'client.js')

// ── the React shim ──────────────────────────────────────────────────────────

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img'])
const ATTRIBUTE_ALIASES = { className: 'class', htmlFor: 'for' }
const Fragment = Symbol('Fragment')

class ShimComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }
}

const React = {
  Fragment,
  Component: ShimComponent,
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {
      throw new Error('state updates are not exercised by this shim')
    }]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
  useLayoutEffect() {},
  useSyncExternalStore(subscribe, getSnapshot) {
    if (typeof subscribe !== 'function') throw new Error('useSyncExternalStore: subscribe must be a function')
    if (typeof getSnapshot !== 'function') throw new Error('useSyncExternalStore: getSnapshot must be a function')
    return getSnapshot()
  },
}

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function renderAttribute(rawName, value) {
  const name = ATTRIBUTE_ALIASES[rawName] ?? rawName
  if (name === 'children' || name === 'key' || name === 'ref') return ''
  if (value === undefined || value === null || value === false) return ''
  if (name === 'style' && typeof value === 'object') {
    return ' style="' + Object.entries(value).map(([key, item]) => `${key}:${item}`).join(';') + '"'
  }
  if (value === true) return ` ${name}="true"`
  return ` ${name}="${escapeText(value)}"`
}

const isClassComponent = (type) => typeof type === 'function' && /^class[\s{]/u.test(Function.prototype.toString.call(type))

/** Render one element tree; class components honor React's error-boundary protocol. */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node)
  const { type, props } = node
  const resolved = props ?? {}
  if (type === Fragment) return render(resolved.children)
  if (typeof type === 'function') {
    if (isClassComponent(type)) {
      const instance = new type(resolved)
      instance.props = resolved
      instance.state = instance.state ?? {}
      if (typeof type.getDerivedStateFromError !== 'function') return render(instance.render())
      try {
        return render(instance.render())
      } catch (error) {
        instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error) ?? {})
        if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, {})
        return render(instance.render())
      }
    }
    return render(type(resolved))
  }
  const inner = render(resolved.children)
  const attributes = Object.entries(resolved).map(([name, value]) => renderAttribute(name, value)).join('')
  return VOID_TAGS.has(type) ? `<${type}${attributes}>` : `<${type}${attributes}>${inner}</${type}>`
}

// ── load the bundle through the shell's envelope ────────────────────────────

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import(`file://${bundle.replaceAll('\\', '/')}`)

if (loaded === undefined) throw new Error('bundle did not call window.__ModuleLoader__.load')
if (loaded.id !== 'dsh-cost-meter') throw new Error(`unexpected bundle id ${loaded.id}`)

/** Platform seed stub: react plus the two optional members. */
function platformRequire(options = {}) {
  return (request) => {
    if (request === 'react') return React
    if (request === 'react-dom') {
      if (options.reactDom === false) throw new Error('react-dom unavailable')
      return options.reactDom ?? { createPortal: (node) => node }
    }
    if (request === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.primitives === false) throw new Error('primitives unavailable')
      return options.primitives ?? {}
    }
    throw new Error(`unexpected platform request: ${request}`)
  }
}

const bundleExports = loaded.factory(platformRequire())

if (typeof bundleExports.apply !== 'function') throw new Error('bundle exports no apply')
if (!Array.isArray(bundleExports.inject) || bundleExports.inject[0] !== 'slots') {
  throw new Error(`unexpected inject face: ${JSON.stringify(bundleExports.inject)}`)
}
const internals = bundleExports.__internals
if (internals === undefined) throw new Error('bundle exports no __internals')

// ── fakes: settings scope, locale, cordis context ───────────────────────────

function fakeScope(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    writes: [],
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate(ops, revision) {
      this.writes.push({ ops, revision })
      return Promise.resolve()
    },
    push(next) {
      snapshot = next
      for (const listener of Array.from(listeners)) listener()
    },
  }
}

const CONFIGURED = {
  source: 'auto',
  model: 'deepseek-flash',
  sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  usdSourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  currency: 'CNY',
  decimals: 3,
  showSavings: true,
  refreshMinutes: 360,
  input: 2,
  cacheRead: 0.04,
  cacheWrite: 0,
  output: 8,
  offPeakFactor: 0.5,
  peakWindows: [],
  weekdaysOnly: true,
  holidays: [],
}
const READY = { status: 'ready', value: CONFIGURED, base: undefined, user: { model: 'deepseek-flash' }, revision: 7, writable: true, mode: 'host' }

/** Fake `chat` locale namespace: records the bind and serves the ported keys. */
function fakeLocale() {
  const bindings = []
  return {
    bindings,
    bind(namespace) {
      bindings.push(namespace)
      return (key, params) => internals.chatFallback(key, params)
    },
  }
}

/** A settled feed snapshot the components can render without any transport. */
function staticFeed(overrides = {}) {
  return Object.assign(
    {
      status: 'ready',
      catalogs: internals.BUILTIN_CATALOGS,
      meta: { CNY: {}, USD: {} },
      priceHistory: { changes: [], firstDate: null, lastDate: null },
      projectionInstalled: false,
      live: false,
      fetchedAt: 0,
      error: null,
    },
    overrides,
  )
}

/** A feed whose CNY table is live at `fetchedAt`, and whose USD table may be too. */
function liveFeed(overrides = {}) {
  return staticFeed(Object.assign(
    {
      meta: {
        CNY: { live: true, fetchedAt: PEAK_AT },
        USD: { live: true, fetchedAt: PEAK_AT },
      },
      live: true,
      fetchedAt: PEAK_AT,
    },
    overrides,
  ))
}

function fakeFeed(overrides = {}) {
  const snapshot = staticFeed(overrides)
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: () => Promise.resolve(),
  }
}

/** Run `apply` against a recording context and return registrations plus the locale. */
function mount(scope, options = {}) {
  const registrations = new Map()
  const locale = options.locale === false ? undefined : fakeLocale()
  const effects = []
  bundleExports.apply({
    get(name) {
      return name === 'locale' ? locale : undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    inject(deps, callback) {
      if (!deps.includes('configForms')) throw new Error(`unexpected inject ${deps}`)
      callback({
        configForms: {
          get(namespace) {
            if (namespace !== 'cost-meter') throw new Error(`unexpected namespace ${namespace}`)
            return scope
          },
        },
      })
    },
    slots: {
      inject(key, callback) {
        callback()
      },
      register(registerOptions, component) {
        registrations.set(`${registerOptions.name}#${registerOptions.id ?? ''}`, { options: registerOptions, component })
        return () => {}
      },
    },
  })
  return { registrations, locale, effects }
}

/** Usage shaped like the screenshot: 25.72M tok total at a 99% cache-hit share. */
const USAGE = { uncachedInputTokens: 180_072, outputTokens: 112_407, cacheReadTokens: 25_428_736, cacheWriteTokens: 0 }

/** Friday 10:00 Beijing — inside the 01:00-04:00 UTC peak window. */
const PEAK_AT = Date.parse('2026-10-23T02:00:00Z')
/** Friday 20:00 Beijing — outside both windows. */
const OFF_PEAK_AT = Date.parse('2026-10-23T12:00:00Z')
/** Saturday 10:00 Beijing — a window, but a weekend. */
const WEEKEND_AT = Date.parse('2026-10-24T02:00:00Z')

/** Stub the browser fetch the catalog store uses, before `apply` runs. */
const fetchCalls = []
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        catalogs: internals.BUILTIN_CATALOGS,
        meta: {
          CNY: { live: true, fetchedAt: PEAK_AT, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', error: null },
          USD: { live: true, fetchedAt: PEAK_AT, sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', error: null },
        },
        fetchedAt: PEAK_AT,
        live: true,
        error: null,
        priceHistory: { changes: [], firstDate: null, lastDate: null },
        projectionInstalled: true,
      }
    },
  }
}

const scope = fakeScope(READY)
const mounted = mount(scope)
const registrations = mounted.registrations

// ── registration shape ──────────────────────────────────────────────────────

const rowKey = 'conversation.composer.dock#cost'
if (!registrations.has(rowKey)) throw new Error(`missing ${rowKey} (got ${[...registrations.keys()].join(', ')})`)
const rowRegistration = registrations.get(rowKey)
if (rowRegistration.options.priority !== undefined) throw new Error('an additive entry must not declare a shadowing priority')
if (rowRegistration.options.order !== 2) throw new Error('the spend pill must sit after the shipped activity and usage pills')

const pageKey = 'settings.section#cost-meter'
if (!registrations.has(pageKey)) throw new Error(`missing ${pageKey} (got ${[...registrations.keys()].join(', ')})`)
const pageRegistration = registrations.get(pageKey)
if (pageRegistration.options.order !== 46) throw new Error('the settings page needs its sidebar position')
if (pageRegistration.options.label !== '花费金额（估算）') throw new Error('the settings page needs its label')
if (registrations.has('settings.plugins.tab#cost-meter')) throw new Error('the settings page must not be a tab inside Plugins any more')

// ── the peak/off-peak resolver ──────────────────────────────────────────────

const config = internals.resolveConfig(READY)
const feed = liveFeed()

const peak = internals.resolvePricing(config, feed, PEAK_AT)
console.log('peak  :', peak.currencyCode, peak.period.kind, peak.input, peak.cacheRead, peak.output, peak.next?.at)
if (peak.period.kind !== 'peak') throw new Error(`10:00 Beijing on a Friday is peak, got ${peak.period.kind}`)
if (peak.input !== 2 || peak.cacheRead !== 0.04 || peak.output !== 8) throw new Error('peak prices must be the CNY flash peak column')
if (peak.currency !== '¥' || peak.currencyCode !== 'CNY') throw new Error('the default prices must be quoted in CNY')
if (peak.next === null || peak.next.at !== Date.parse('2026-10-23T04:00:00Z')) throw new Error(`peak should end at 12:00 Beijing, got ${peak.next?.at}`)
if (peak.sourceKind !== 'live') throw new Error('a live feed must be labelled live')

const offPeak = internals.resolvePricing(config, feed, OFF_PEAK_AT)
console.log('off   :', offPeak.currencyCode, offPeak.period.kind, offPeak.input, offPeak.cacheRead, offPeak.output)
if (offPeak.period.kind !== 'offPeak') throw new Error(`20:00 Beijing is off-peak, got ${offPeak.period.kind}`)
if (offPeak.input !== 1 || offPeak.cacheRead !== 0.02 || offPeak.output !== 4) throw new Error('off-peak prices must be the CNY flash off-peak column')
if (offPeak.next === null || offPeak.next.at !== Date.parse('2026-10-26T01:00:00Z')) {
  throw new Error(`the weekend defers peak to Monday 09:00 Beijing, got ${offPeak.next?.at}`)
}

const usdConfig = Object.assign({}, config, { currency: 'USD' })
const usdPeak = internals.resolvePricing(usdConfig, feed, PEAK_AT)
if (usdPeak.currency !== '$' || usdPeak.currencyCode !== 'USD') throw new Error(`switching to USD must change the symbol, got ${usdPeak.currency}`)
if (usdPeak.input !== 0.3 || usdPeak.cacheRead !== 0.006 || usdPeak.output !== 1.2) throw new Error('USD peak prices must come from the USD table')
if (usdPeak.currencyCode === peak.currencyCode) throw new Error('the two catalogs must stay distinct')

const weekend = internals.resolvePricing(config, feed, WEEKEND_AT)
if (weekend.period.kind !== 'offPeak' || weekend.period.reason !== 'weekend') {
  throw new Error(`Saturday must be off-peak by weekend, got ${weekend.period.kind}/${weekend.period.reason}`)
}

const holidayConfig = Object.assign({}, config, { holidays: ['2026-10-23'] })
const holiday = internals.resolvePricing(holidayConfig, feed, PEAK_AT)
if (holiday.period.kind !== 'offPeak' || holiday.period.reason !== 'holiday') {
  throw new Error(`a listed holiday must be off-peak, got ${holiday.period.kind}/${holiday.period.reason}`)
}

const proConfig = Object.assign({}, config, { model: 'deepseek-v4-pro' })
const pro = internals.resolvePricing(proConfig, feed, PEAK_AT)
if (pro.input !== 9 || pro.output !== 27) throw new Error(`CNY pro selection must repoint every bucket, got ${JSON.stringify(pro.peak)}`)
const proUsd = internals.resolvePricing(Object.assign({}, proConfig, { currency: 'USD' }), feed, PEAK_AT)
if (proUsd.input !== 1.32 || proUsd.output !== 3.96) throw new Error(`USD pro selection must repoint every bucket, got ${JSON.stringify(proUsd.peak)}`)

const builtin = internals.resolvePricing(Object.assign({}, config, { source: 'builtin' }), liveFeed(), PEAK_AT)
if (builtin.sourceKind !== 'builtin') throw new Error('the builtin source must not claim the live catalog')
if (builtin.input !== 2 || builtin.currency !== '¥') throw new Error('the builtin source must price with the bundled CNY table')

const manual = internals.resolvePricing(Object.assign({}, config, { source: 'manual', input: 2, cacheRead: 0.04, output: 8 }), feed, PEAK_AT)
if (manual.input !== 2 || manual.output !== 8) throw new Error('manual mode must use the typed peak prices')
const manualOff = internals.resolvePricing(Object.assign({}, config, { source: 'manual', input: 2, cacheRead: 0.04, output: 8 }), feed, OFF_PEAK_AT)
if (manualOff.input !== 1 || manualOff.output !== 4) throw new Error(`manual off-peak must halve at the default factor, got ${manualOff.input}/${manualOff.output}`)
if (manual.currency !== '¥') throw new Error(`manual CNY must use the ¥ symbol, got ${manual.currency}`)
const manualUsd = internals.resolvePricing(Object.assign({}, config, { source: 'manual', currency: 'USD' }), feed, PEAK_AT)
if (manualUsd.currency !== '$') throw new Error(`manual USD must use the $ symbol, got ${manualUsd.currency}`)

const customWindow = internals.resolvePricing(Object.assign({}, config, { peakWindows: ['05:00-06:00'] }), feed, Date.parse('2026-10-23T05:30:00Z'))
if (customWindow.period.kind !== 'peak') throw new Error('a configured UTC window must override the catalog schedule')

const format = internals.formatAgo(3 * 60_000)
if (format !== '3 分钟前') throw new Error(`relative time regressed: ${format}`)
if (internals.formatRemaining(88 * 60_000) !== '1 小时 28 分') throw new Error('countdown formatting regressed')
if (internals.parseWindow('23:00-02:00') === null) throw new Error('a wrapping window must parse')
if (internals.parseWindow('9:00-10:00').text !== '09:00-10:00') throw new Error('window text must normalize')

// ── the dock entry: one priced pill beside the shipped ones ─────────────────

const useProjection = (key) => (key === 'tokenUsage' ? USAGE : undefined)
const ui = internals.createComponents(internals.createPriceStore(), fakeFeed(liveFeed()), {
  get: (name) => (name === 'locale' ? fakeLocale() : undefined),
})
const t = internals.chatFallback

const rowHtml = render(React.createElement(rowRegistration.component, { useProjection, now: PEAK_AT }))
console.log('pill  :', rowHtml)

// 180072*2 + 25428736*0.04 + 112407*8 = 0.360144 + 1.01714944 + 0.899256 = 2.27654944
if (!rowHtml.includes('¥2.277')) throw new Error(`the pill must price the session at CNY peak rates: ${rowHtml}`)
if (!rowHtml.includes('data-cost-meter-pill="cost"')) throw new Error('the pill must keep its cost marker')
if (!rowHtml.includes('data-period="peak"')) throw new Error('the pill must mark the active period')
if (!rowHtml.includes('峰')) throw new Error('the pill must show the peak badge')
if ((rowHtml.match(/<button/gu) ?? []).length !== 1) throw new Error('the entry must render exactly one dialog trigger')
if (rowHtml.includes('25.7M tok')) throw new Error('the entry must not duplicate the shipped token pill')
if (mounted.locale.bindings[0] !== 'chat') throw new Error(`the panel must bind the chat locale, got ${mounted.locale.bindings[0]}`)

const offPeakRow = render(React.createElement(rowRegistration.component, { useProjection, now: OFF_PEAK_AT }))
if (!offPeakRow.includes('¥1.138') || !offPeakRow.includes('谷')) {
  throw new Error(`the same session must reprice at CNY off-peak rates: ${offPeakRow}`)
}

// Switching the currency through the settings entry reprices the same session in USD.
const usdScope = fakeScope({ status: 'ready', value: { ...CONFIGURED, currency: 'USD' }, base: undefined, user: undefined, revision: 8, writable: true, mode: 'host' })
const usdMount = mount(usdScope)
const usdRow = render(React.createElement(usdMount.registrations.get(rowKey).component, { useProjection, now: PEAK_AT }))
console.log('usd   :', usdRow)
if (!usdRow.includes('$0.341')) throw new Error(`a USD entry must price in dollars: ${usdRow}`)
if (usdRow.includes('¥')) throw new Error(`a USD entry must never keep the ¥ prefix: ${usdRow}`)

// An empty session renders nothing at all rather than a fake zero.
const emptyRow = render(
  React.createElement(rowRegistration.component, {
    now: PEAK_AT,
    useProjection: () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  }),
)
if (emptyRow !== '') throw new Error(`an empty session should render nothing, got ${emptyRow}`)

// A projection-less owner degrades to nothing instead of throwing.
const noSeatRow = render(React.createElement(rowRegistration.component, { now: PEAK_AT }))
if (noSeatRow !== '') throw new Error(`a missing projection seat should render nothing, got ${noSeatRow}`)

// ── the cost panel ──────────────────────────────────────────────────────────

const openDialog = { open: true, setOpen: () => {} }
const costPanel = render(React.createElement(ui.CostPill, { pricing: peak, t, usage: USAGE, dialog: openDialog, now: PEAK_AT }))
console.log('cost  :', costPanel.slice(costPanel.indexOf('<div class="dsh-cost-meter-panel"'), costPanel.length))
for (const fragment of [
  'data-cost-meter-usage="true"',
  '本会话花费',
  '¥2.277',
  '× ¥2/百万',
  '× ¥0.04/百万',
  '× ¥8/百万',
  '峰价',
  '北京时间 10:00',
  '12:00 转谷价',
  'deepseek-flash',
  '合计',
  '缓存省下',
  '人民币 · DeepSeek 官方价目',
]) {
  if (!costPanel.includes(fragment)) throw new Error(`cost panel missing ${fragment}`)
}

// ── historical per-day billing ─────────────────────────────────────────────

const HISTORY = {
  changes: [
    {
      date: '2026-10-22',
      catalogs: {
        CNY: {
          code: 'CNY',
          currency: '¥',
          models: [{
            id: 'deepseek-flash',
            label: 'deepseek-flash',
            peak: { cacheRead: 0.03, input: 1.8, cacheWrite: 0, output: 7.2 },
            offPeak: { cacheRead: 0.015, input: 0.9, cacheWrite: 0, output: 3.6 },
          }],
        },
        USD: internals.BUILTIN_CATALOGS.USD,
      },
    },
    {
      date: '2026-10-23',
      catalogs: {
        CNY: internals.BUILTIN_CATALOGS.CNY,
        USD: internals.BUILTIN_CATALOGS.USD,
      },
    },
  ],
  firstDate: '2026-10-22',
  lastDate: '2026-10-23',
}
const BY_DAY = {
  '2026-10-22': {
    peak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    offPeak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  },
  '2026-10-23': {
    peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    offPeak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  },
}
const historyFeed = staticFeed({ live: true, fetchedAt: PEAK_AT, priceHistory: HISTORY, projectionInstalled: true })
const historical = internals.resolvePricing(config, historyFeed, PEAK_AT, BY_DAY)
console.log('history:', historical.mode, historical.history?.peakCost, historical.history?.offPeakCost, historical.history?.cost, historical.history?.mixed)
if (historical.mode !== 'history') throw new Error('a populated day map must switch to historical billing')
if (historical.history.peakCost !== 1.8) throw new Error(`peak usage must use the 10-22 price, got ${historical.history.peakCost}`)
if (historical.history.offPeakCost !== 1) throw new Error(`off-peak usage must use the 10-23 price, got ${historical.history.offPeakCost}`)
if (historical.history.cost !== 2.8) throw new Error(`total must be 2.8, got ${historical.history.cost}`)
if (historical.history.mixed !== true) throw new Error('a session with both periods must be labelled mixed')
if (historical.history.uncoveredDays !== 0) throw new Error('every day is covered by a snapshot')

const histUi = internals.createComponents(internals.createPriceStore(), fakeFeed({ live: true, fetchedAt: PEAK_AT, priceHistory: HISTORY, projectionInstalled: true }), {
  get: () => undefined,
})
const histRow = render(React.createElement(histUi.CostPillEntry, {
  now: PEAK_AT,
  useProjection: (key) => (key === 'tokenUsage' ? USAGE : BY_DAY),
}))
console.log('histRow:', histRow)
if (!histRow.includes('¥2.800')) throw new Error(`the pill must show the historical total: ${histRow}`)
if (!/>峰</u.test(histRow)) throw new Error(`the pill badge must be the single character 峰/谷: ${histRow}`)
if (histRow.includes('混合')) throw new Error('the pill badge must not show 混合')

const histPanel = render(React.createElement(histUi.CostPill, { pricing: historical, t, usage: USAGE, dialog: openDialog, now: PEAK_AT }))
for (const fragment of ['峰时用量', '谷时用量', '合计', '按每次请求发生时的峰/谷价累计', '当前单价', '历史价目自 2026-10-22 起']) {
  if (!histPanel.includes(fragment)) throw new Error(`historical panel missing ${fragment}`)
}

// Before the first snapshot, days fall back to the current table and are counted.
const uncovered = internals.resolvePricing(config, staticFeed({ priceHistory: { changes: [], firstDate: null, lastDate: null } }), PEAK_AT, BY_DAY)
if (uncovered.history.uncoveredDays !== 2) throw new Error(`uncovered days must be counted, got ${uncovered.history.uncoveredDays}`)
if (uncovered.history.cost !== 3) throw new Error(`current-price fallback must be 2 + 1 = 3, got ${uncovered.history.cost}`)

// Without the projection the caller falls back to the current-period estimate.
const noProjection = internals.resolvePricing(config, historyFeed, PEAK_AT, undefined)
if (noProjection.mode !== 'current' || noProjection.history !== null) throw new Error('a missing projection must keep the current-period estimate')

// ── the catalog store: host JSON, failure fallback, forced refresh ─────────

const catalogStore = internals.createCatalogStore()
catalogStore.start()
await new Promise((resolve) => setTimeout(resolve, 0))
if (!fetchCalls.length) throw new Error('the catalog store must ask the host route on start')
if (!fetchCalls[0].url.endsWith('/dsh-cost-meter/prices')) throw new Error(`unexpected catalog route ${fetchCalls[0].url}`)
const feedSnapshot = catalogStore.getSnapshot()
if (feedSnapshot.status !== 'ready' || feedSnapshot.live !== true) throw new Error(`the catalog store must accept the host catalog: ${JSON.stringify(feedSnapshot)}`)
if (feedSnapshot.fetchedAt !== PEAK_AT) throw new Error('the catalog store must keep the host timestamp')
if (feedSnapshot.catalogs.CNY.models[0].peak.input !== 2 || feedSnapshot.catalogs.USD.models[0].peak.input !== 0.3) {
  throw new Error('the catalog store must keep both currency tables')
}
if (feedSnapshot.meta.CNY.live !== true || feedSnapshot.meta.USD.live !== true) throw new Error('the catalog store must keep both source states')

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  return { ok: false, status: 503, json: async () => ({}) }
}
await catalogStore.refresh()
if (catalogStore.getSnapshot().error === null) throw new Error('a failed refresh must be reported')
if (catalogStore.getSnapshot().catalogs.CNY !== internals.BUILTIN_CATALOGS.CNY) throw new Error('a failed refresh must keep the last good catalog')
if (!fetchCalls.some((call) => call.method === 'POST' && call.url.endsWith('/dsh-cost-meter/refresh'))) {
  throw new Error('a forced refresh must POST the refresh route')
}
catalogStore.stop()
globalThis.fetch = originalFetch

// ── the seeded defaults price a session with no saved config ────────────────

const unset = internals.resolveConfig({ status: 'unavailable', value: undefined })
if (unset.source !== 'auto' || unset.model !== 'deepseek-flash' || unset.currency !== 'CNY') throw new Error(`unexpected unconfigured shape: ${JSON.stringify(unset)}`)
const unsetPrices = internals.resolvePricing(unset, staticFeed(), OFF_PEAK_AT)
if (unsetPrices.input !== 1 || unsetPrices.output !== 4 || unsetPrices.currency !== '¥') {
  throw new Error(`bundled defaults must price off-peak CNY flash, got ${JSON.stringify(unsetPrices.peak)}`)
}
if (!unsetPrices.configured) throw new Error('seeded defaults must count as configured')

// ── all four manual prices at 0 warn instead of inventing an amount ────────

const zeroed = { status: 'ready', value: { ...CONFIGURED, source: 'manual', input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, base: undefined, user: undefined, revision: 2, writable: true, mode: 'host' }
const zeroedMount = mount(fakeScope(zeroed))
const zeroedRow = render(React.createElement(zeroedMount.registrations.get(rowKey).component, { useProjection, now: PEAK_AT }))
console.log('zeroed :', zeroedRow)
if (!zeroedRow.includes('花费未配置')) throw new Error(`an all-zero price set should say so, got ${zeroedRow}`)
if (!zeroedRow.includes('data-unconfigured="true"')) throw new Error('an unconfigured pill must not claim configured prices')
if (!zeroedRow.includes('设置 → 花费金额')) throw new Error('an unconfigured pill must point at the settings page')

// ── the row survives a crash in the styled body ─────────────────────────────

const Throwing = () => {
  throw new Error('boom')
}
const guarded = render(
  React.createElement(ui.RowErrorBoundary, { fallback: React.createElement('span', null, 'fallback') }, React.createElement(Throwing, null)),
)
if (guarded !== '<span>fallback</span>') throw new Error(`the boundary did not catch the crash: ${guarded}`)

// ── optional platform members absent: the pill still renders ────────────────

const bareExports = loaded.factory(platformRequire({ primitives: false, reactDom: false }))
const bareUi = bareExports.__internals.createComponents(bareExports.__internals.createPriceStore(), fakeFeed(), {
  get: () => undefined,
})
const degradedPill = render(React.createElement(bareUi.CostPill, { pricing: peak, t, usage: USAGE, dialog: openDialog, now: PEAK_AT }))
if (!degradedPill.includes('¥2.277')) throw new Error('the pill must render without primitives or react-dom')
if (!degradedPill.includes('data-cost-meter-usage="true"')) throw new Error('the panel must render inline without a portal')

// ── the settings page (settings.section) ───────────────────────────────────

const pageComponent = pageRegistration.component
const pageHtml = render(React.createElement(pageComponent, {}))
console.log('page  :', pageHtml.slice(0, 900))
for (const fragment of [
  '花费金额（估算）',
  '价格来源',
  '自动（官方价目）',
  '内置价目',
  '手动价格',
  '计价模型',
  '计价币种',
  '人民币（¥）',
  '美元（$）',
  '人民币价目地址',
  '美元价目地址',
  '人民币价目',
  '美元价目',
  '手动峰价',
  '谷价折扣系数',
  '高峰时段（UTC）',
  '节假日（北京时间）',
  '自动刷新间隔（分钟）',
  '保存',
  '重置为默认',
  '已与设置同步',
]) {
  if (!pageHtml.includes(fragment)) throw new Error(`settings page missing ${fragment}`)
}
if (!pageHtml.includes('value="2"')) throw new Error('the settings page should seed the manual input price from the snapshot')
if (!/data-period="(?:peak|offPeak)"/u.test(pageHtml)) throw new Error('the status card must show the current period')
const saveTag = /<button[^>]*data-primary="true"[^>]*>/u.exec(pageHtml)?.[0] ?? ''
if (saveTag === '' || saveTag.includes('disabled')) throw new Error(`a writable settings page must keep Save enabled: ${saveTag}`)

// The write path is the 0.2.x form controller's `mutate(ops, revision)`.
const writeStore = internals.createPriceStore()
writeStore.attach(scope)
await writeStore.write([{ op: 'set', path: ['model'], value: 'deepseek-v4-pro' }], 7)
const write = scope.writes.at(-1)
if (write === undefined) throw new Error('the price store must write through the attached form')
if (write.revision !== 7) throw new Error('the write must carry the form revision')
if (write.ops[0]?.path?.[0] !== 'model' || write.ops[0]?.value !== 'deepseek-v4-pro') throw new Error('the write must carry the edited field')

// Release the polling lifetime `apply` installed, so the process can exit.
for (const disposer of [...mounted.effects, ...zeroedMount.effects, ...usdMount.effects]) {
  if (typeof disposer === 'function') disposer()
}

console.log('\nOK — the pill is additive in the composer dock, CNY prices are the default while USD is one switch away, usage is billed by each request\'s own peak/off-peak period, the settings page lives in the settings sidebar, and every fallback state holds.')
