/**
 * Host half of the cost meter.
 *
 * It owns three things the browser half cannot do by itself:
 *
 *   1. the `Config` schema the browser half prices with,
 *   2. the live price catalogs — DeepSeek publishes the same table twice, in CNY
 *      on the Chinese page and in USD on the English one — and this process
 *      fetches and parses both through `ctx.web.fetch` (the deployment's egress
 *      path) instead of asking the user to retype numbers,
 *   3. two same-origin HTTP routes that publish those catalogs as JSON, because
 *      a browser page cannot read the pricing pages directly (no CORS) and
 *      cannot call `ctx.web`.
 *
 * No token accounting happens here — `@deepseek-ai/dsh-token-meter` already
 * folds provider-reported usage into four disjoint buckets and publishes them to
 * every client, so this package never touches the session log or the model
 * route. Off-peak/peak selection is a pure function of the clock and the
 * published schedule, evaluated in the browser at render time.
 *
 * DSH 0.2.x derives a plugin entry's settings page from this module's `Config`
 * (`settings.schema(entry)` reads `entry.fiber.runtime.Config`). The browser half
 * renders its own page in the settings sidebar, so `apply` only turns the
 * generated page off; the values still live in the active profile's `cost-meter`
 * entry config, edited through the client's `configForms` form for that entry id.
 *
 * @module dsh-cost-meter
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { homedir } from 'node:os'
import { BUILTIN_CATALOGS, DEFAULT_SOURCE_URL, DEFAULT_USD_SOURCE_URL, parseCatalog } from './catalog.js'
import { PROJECTION_KEY, emptyState, foldUsage, resolveSchedule, scheduleHash } from './period-usage.js'
import { historyDirectory, loadHistory, pruneSnapshots, recordSnapshot, todayKey } from './history.js'

export { BUILTIN_CATALOGS, DEFAULT_SOURCE_URL, DEFAULT_USD_SOURCE_URL, PROJECTION_KEY, parseCatalog }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cost-meter'

/** Settings namespace this package owns; the browser form is keyed by it. */
export const COST_METER_SETTINGS_NAMESPACE = 'cost-meter'

/** Same-origin JSON route that publishes the current catalogs. */
export const PRICES_ROUTE = '/dsh-cost-meter/prices'

/** Same-origin route that forces a refresh, then returns the catalogs. */
export const REFRESH_ROUTE = '/dsh-cost-meter/refresh'

/**
 * The composition entry schema.
 *
 * `source: 'auto'` prices from the fetched official catalogs, `'builtin'` uses
 * the bundled tables without network access, and `'manual'` uses the four
 * `input`/`cacheRead`/`cacheWrite`/`output` numbers as **peak** prices with
 * `offPeakFactor` scaling them outside peak hours. `currency` selects which
 * published table to price with — `'CNY'` from the Chinese page (the default)
 * or `'USD'` from the English one — and `peakWindows` empty means "follow the
 * catalog schedule" instead of overriding it with UTC windows.
 *
 * Every editable field is marked `.volatile()`: DSH's settings projection
 * (`volatileForm`) keeps only fields whose nearest volatile ancestor is marked,
 * and an entry whose schema has none is not described at all — which leaves the
 * browser form permanently unavailable. Marking these fields is what makes the
 * settings page writable, and it also lets a save apply live without remounting.
 *
 * `unit` is accepted for backward compatibility with 0.2.x configurations and
 * is no longer read: prices are always per million tokens now.
 */
export const Config = z.object({
  /** Price source: auto (official pages), builtin (bundled tables) or manual. */
  source: z.string().default('auto').volatile(),
  /** Pricing page or JSON endpoint for the CNY table, read in `auto` mode. */
  sourceUrl: z.string().default(DEFAULT_SOURCE_URL).volatile(),
  /** Pricing page or JSON endpoint for the USD table, read in `auto` mode. */
  usdSourceUrl: z.string().default(DEFAULT_USD_SOURCE_URL).volatile(),
  /** Display currency and price table: `CNY` (default) or `USD`. */
  currency: z.string().default('CNY').volatile(),
  /** Model id inside the catalog. */
  model: z.string().default('deepseek-flash').volatile(),
  /** Fraction digits in the rendered amount. */
  decimals: z.number().step(1).min(0).max(6).default(3).volatile(),
  /** Whether the panel also reports what cache reads saved against the miss price. */
  showSavings: z.boolean().default(true).volatile(),
  /** Minutes between background refreshes; 0 disables them. */
  refreshMinutes: z.number().step(1).min(0).max(1440).default(360).volatile(),
  /** Manual peak price of one million cache-miss prompt input tokens, in `currency`. */
  input: z.number().min(0).default(2).volatile(),
  /** Manual peak price of one million cache-read prompt input tokens, in `currency`. */
  cacheRead: z.number().min(0).default(0.04).volatile(),
  /** Manual peak price of cache-write tokens; 0 on providers that do not bill it. */
  cacheWrite: z.number().min(0).default(0).volatile(),
  /** Manual peak price of one million completion tokens, in `currency`. */
  output: z.number().min(0).default(8).volatile(),
  /** Multiplier applied to manual peak prices outside peak hours. */
  offPeakFactor: z.number().min(0).max(1).default(0.5).volatile(),
  /** UTC windows like "01:00-04:00"; empty follows the catalog schedule. */
  peakWindows: z.array(z.string()).default([]).volatile(),
  /** Whether peak windows only apply Monday through Friday. */
  weekdaysOnly: z.boolean().default(true).volatile(),
  /** Extra holiday dates (YYYY-MM-DD, Beijing time) billed at off-peak prices. */
  holidays: z.array(z.string()).default([]).volatile(),
  /** Deprecated 0.2.x field; accepted and ignored. */
  unit: z.string().default('per-million')
})

// ───────────────────────────────────────────────────────────────────────────
// Live catalog state (module scope so a settings save does not drop it)
// ───────────────────────────────────────────────────────────────────────────

/** One metadata record per currency; the catalogs themselves live beside it. */
function emptyMeta() {
  return { fetchedAt: 0, sourceUrl: '', live: false, error: null }
}

const state = {
  catalogs: {
    CNY: BUILTIN_CATALOGS.CNY,
    USD: BUILTIN_CATALOGS.USD
  },
  meta: { CNY: emptyMeta(), USD: emptyMeta() },
  priceHistory: { changes: [], firstDate: null, lastDate: null },
  historyReady: null,
  projectionInstalled: false,
  afterRefresh: null,
  refreshing: null,
  lastAttempt: 0
}

/** Publishable snapshot for the browser half. */
function snapshot() {
  const meta = state.meta
  const fetchedAt = Math.max(meta.CNY.fetchedAt, meta.USD.fetchedAt)
  const errors = [meta.CNY.error, meta.USD.error].filter((error) => typeof error === 'string' && error.length > 0)
  return {
    ok: true,
    catalogs: state.catalogs,
    meta,
    fetchedAt,
    live: meta.CNY.live || meta.USD.live,
    error: errors.length > 0 ? errors.join('；') : null,
    priceHistory: state.priceHistory,
    projectionInstalled: state.projectionInstalled
  }
}

/** One fetch error, carrying the currency it belongs to. */
class SourceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Fetch and parse one configured price source.
 *
 * A failed source keeps its previous catalog and records the reason; it never
 * replaces prices with zeros.
 */
async function refreshSource(ctx, code, url) {
  const web = ctx.get('web')
  if (web === undefined || web === null) throw new SourceError(code, 'the web fetch service is not mounted')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    const response = await web.fetch({ url }, controller.signal)
    if (response.statusCode !== 200) throw new SourceError(code, `HTTP ${response.statusCode}`)
    const catalog = parseCatalog(response.body.content, Date.now(), code)
    if (response.truncated === true && catalog.models.length === 0) {
      throw new SourceError(code, 'the response was truncated before its pricing table')
    }
    state.catalogs[code] = catalog
    state.meta[code] = { fetchedAt: catalog.fetchedAt, sourceUrl: response.url, live: true, error: null }
  } finally {
    clearTimeout(timer)
  }
}

/** Billing buckets as they cross the projection wire. */
const projectionBucketSchema = zod.object({
  uncachedInputTokens: zod.number().int().nonnegative(),
  cacheReadTokens: zod.number().int().nonnegative(),
  cacheWriteTokens: zod.number().int().nonnegative(),
  outputTokens: zod.number().int().nonnegative()
})

/** One local day's peak and off-peak buckets. */
const projectionDaySchema = zod.object({
  peak: projectionBucketSchema,
  offPeak: projectionBucketSchema
})

const projectionStateSchema = zod.object({
  days: zod.record(zod.string(), projectionDaySchema),
  current: zod.object({ turn: zod.number().int(), step: zod.number().int(), time: zod.number() }).nullable(),
  last: zod.object({
    turn: zod.number().int(),
    step: zod.number().int(),
    date: zod.string(),
    period: zod.enum(['peak', 'offPeak']),
    buckets: projectionBucketSchema
  }).nullable()
})

const projectionViewSchema = zod.record(zod.string(), projectionDaySchema)

/**
 * One projection installation.
 *
 * The schedule is captured here, so the fold is deterministic for this
 * registration; when the schedule changes the host disposes and re-registers,
 * which drops the cached cells and reclassifies history from the log.
 */
function makeProjection(schedule) {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: projectionStateSchema,
    init: () => emptyState(),
    apply: (state, event) => foldUsage(state, event, schedule),
    wire: {
      viewSchema: projectionViewSchema,
      view: (state) => state.days
    }
  }
}

/** Record today's prices and rebuild the compact history the browser reads. */
async function capturePriceSnapshot() {
  const directory = state.historyDir
  if (directory === undefined || directory === null) return
  const liveCatalogs = {}
  for (const code of ['CNY', 'USD']) {
    if (state.meta[code].live === true) liveCatalogs[code] = state.catalogs[code]
  }
  if (Object.keys(liveCatalogs).length === 0) return
  const date = todayKey()
  await recordSnapshot(directory, date, liveCatalogs)
  await pruneSnapshots(directory, date)
  state.priceHistory = await loadHistory(directory)
}

/**
 * Refresh both published tables once.
 *
 * The two sources are independent: one layout change must not take the other
 * currency's prices down with it.
 */
async function refreshCatalogs(ctx, config) {
  if (state.refreshing !== null) return state.refreshing
  // A LAN-reachable deployment exposes the refresh route to other pages; one
  // fetch per few seconds is enough for a button and keeps it from being a
  // request amplifier.
  const attemptedAt = Date.now()
  if (attemptedAt - state.lastAttempt < 5_000) return snapshot()
  state.lastAttempt = attemptedAt
  const sources = [
    ['CNY', config.sourceUrl],
    ['USD', config.usdSourceUrl]
  ]
  const task = (async () => {
    const results = await Promise.allSettled(sources.map(([code, url]) => refreshSource(ctx, code, url)))
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      const code = sources[index][0]
      const reason = result.reason
      state.meta[code] = Object.assign({}, state.meta[code], {
        live: false,
        error: reason instanceof Error ? reason.message : String(reason)
      })
    })
    try {
      await capturePriceSnapshot()
    } catch (error) {
      ctx.logger?.warn?.('cost-meter: could not record the daily price snapshot', error)
    }
    // A new catalog may publish a different schedule; reinstall so history is
    // classified with the rule actually in force.
    try {
      state.afterRefresh?.()
    } catch (error) {
      ctx.logger?.warn?.('cost-meter: could not reinstall the projection after refresh', error)
    }
    return snapshot()
  })()
  state.refreshing = task
  try {
    return await task
  } finally {
    state.refreshing = null
  }
}

/** Whether DSH's settings projection currently describes this entry. */
function isSettingsServed(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || settings === null) return false
  try {
    return settings.describe().some((entry) => entry.ns === COST_METER_SETTINGS_NAMESPACE)
  } catch {
    return false
  }
}

/** Write one JSON response. */
function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Read one Config field: volatile fields are live references, plain ones values. */
function fieldValue(value, fallback) {
  const current = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  return current === undefined || current === null ? fallback : current
}

/** Snapshot the fields the host itself uses, at the moment of the call. */
function currentConfig(config) {
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
  return {
    source: fieldValue(config.source, 'auto'),
    sourceUrl: fieldValue(config.sourceUrl, DEFAULT_SOURCE_URL),
    usdSourceUrl: fieldValue(config.usdSourceUrl, DEFAULT_USD_SOURCE_URL),
    refreshMinutes: Number(fieldValue(config.refreshMinutes, 360)),
    peakWindows: list(fieldValue(config.peakWindows, [])),
    weekdaysOnly: fieldValue(config.weekdaysOnly, true) !== false,
    holidays: list(fieldValue(config.holidays, []))
  }
}

/** Billing schedule currently implied by the config and the fetched catalog. */
function currentSchedule(config) {
  const current = currentConfig(config)
  const catalog = state.catalogs.CNY ?? BUILTIN_CATALOGS.CNY
  return resolveSchedule({
    peakWindows: current.peakWindows,
    weekdaysOnly: current.weekdaysOnly,
    holidays: current.holidays,
    catalogSchedule: catalog.schedule
  })
}

/**
 * Turn off DSH's generated settings page for this entry, publish the catalog
 * routes, and keep the catalogs warm.
 *
 * No hard dependency is declared: while a deployment mounts no settings provider
 * the pill still prices the composition defaults; while it mounts no web server
 * the browser half falls back to its bundled tables.
 *
 * The Config fields are volatile references, so every read goes through
 * `currentConfig()`: a settings save updates the references in place without
 * remounting this plugin, and the next request or tick sees the new values.
 *
 * @param ctx - plugin context.
 * @param config - resolved entry configuration (live references).
 */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // Daily price snapshots live beside the profile so they survive reloads and
  // app upgrades. The first run starts the archive; earlier dates fall back to
  // the current table on the page.
  const directory = historyDirectory(homedir())
  state.historyDir = directory
  state.historyReady = loadHistory(directory)
    .then((history) => {
      state.priceHistory = history
    })
    .catch((error) => {
      ctx.logger?.warn?.('cost-meter: could not load the price history', error)
    })

  // One projection, re-registered whenever the billing schedule changes. The
  // cached cells disappear with the old registration, so the next read refolds
  // the whole log under the new rule.
  let projections = null
  let projectionDispose = null
  let installedHash = null
  const installProjection = () => {
    if (projections === null) return
    const schedule = currentSchedule(config)
    const hash = scheduleHash(schedule)
    if (projectionDispose !== null && hash === installedHash) return
    projectionDispose?.()
    projectionDispose = null
    try {
      projectionDispose = projections.sessionProjections.register(makeProjection(schedule))
      installedHash = hash
      state.projectionInstalled = true
    } catch (error) {
      installedHash = null
      state.projectionInstalled = false
      ctx.logger?.warn?.('cost-meter: could not register the period-usage projection', error)
    }
  }

  ctx.inject(['sessionProjections'], (child) => {
    projections = child
    child.effect(() => () => {
      projectionDispose?.()
      projectionDispose = null
      projections = null
      installedHash = null
      state.afterRefresh = null
      state.projectionInstalled = false
    })
    installProjection()
  })
  state.afterRefresh = installProjection

  /** Refresh when the current source is auto and the catalogs are older than configured. */
  const refreshIfStale = () => {
    // A settings save can change the schedule without a refresh; reinstalling
    // here keeps history classified by the rule that is actually in force.
    installProjection()
    const current = currentConfig(config)
    if (current.source !== 'auto' || current.refreshMinutes <= 0) return
    const maxAge = current.refreshMinutes * 60_000
    const oldest = Math.min(state.meta.CNY.fetchedAt || 0, state.meta.USD.fetchedAt || 0)
    if (oldest !== 0 && Date.now() - oldest < maxAge) return
    void refreshCatalogs(ctx, current).catch(() => {})
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() =>
      child.webServer.register({
        kind: 'exact',
        path: PRICES_ROUTE,
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          await state.historyReady?.catch(() => {})
          // A page opening is the best signal that someone wants prices; recover
          // from a failed warm-up or a long sleep without waiting for the timer.
          refreshIfStale()
          sendJson(res, 200, snapshot())
        }
      })
    )
    child.effect(() =>
      child.webServer.register({
        kind: 'exact',
        path: REFRESH_ROUTE,
        handler: async (req, res) => {
          if ((req.method ?? 'GET') !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            await refreshCatalogs(ctx, currentConfig(config))
          } catch {
            // The snapshot below carries the failure; the route itself succeeded.
          }
          await state.historyReady?.catch(() => {})
          // A manual refresh is also the cheapest place to answer "does the
          // settings projection serve this entry?" while diagnosing a form.
          sendJson(res, 200, Object.assign(snapshot(), { settingsServed: isSettingsServed(ctx) }))
        }
      })
    )
  })

  // One minute-long tick checks the live refresh interval and freshness, so a
  // settings change takes effect without remounting the entry.
  ctx.effect(() => {
    const warm = setTimeout(refreshIfStale, 1_500)
    const timer = setInterval(refreshIfStale, 60_000)
    return () => {
      clearTimeout(warm)
      clearInterval(timer)
      if (state.afterRefresh === installProjection) state.afterRefresh = null
    }
  })
}
