/**
 * Price-catalog parsing for the cost meter, with no DSH imports so it can be
 * unit-tested without a profile or a network.
 *
 * DeepSeek publishes the same table twice: the Chinese page quotes CNY and the
 * English page quotes USD. Each page has a model header, then the cache-hit /
 * cache-miss / output rows split into OFF-PEAK and PEAK prices. Rowspans mean a
 * price row may carry only the period and its numbers, so the parser tracks the
 * metric across rows while keeping the period row-local — otherwise a later row
 * (a concurrency limit, say) inherits the last period and its numbers become
 * "prices".
 *
 * A JSON source with the same `{ code, currency, models, schedule }` shape is
 * accepted too, which lets a deployment bypass HTML parsing entirely.
 *
 * @module dsh-cost-meter/catalog
 */

/** Chinese (CNY) pricing page; the schema default points here. */
export const DEFAULT_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** English (USD) pricing page. */
export const DEFAULT_USD_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

/**
 * Offline seed catalogs, one per published currency.
 *
 * Both were read from DeepSeek's documentation on 2026-10-23 — the Chinese page
 * for CNY and the English page for USD — and are quoted per million tokens at
 * peak hours, with off-peak at half. The host overwrites each with a live parse
 * whenever its page is reachable; the browser half ships the same tables so a
 * first paint (or a deployment without a host route) still prices correctly.
 */
export const BUILTIN_CATALOGS = deepFreeze({
  CNY: {
    code: 'CNY',
    currency: '¥',
    models: [
      {
        id: 'deepseek-flash',
        label: 'deepseek-flash · V4.1-Flash',
        peak: { cacheRead: 0.04, input: 2, cacheWrite: 0, output: 8 },
        offPeak: { cacheRead: 0.02, input: 1, cacheWrite: 0, output: 4 }
      },
      {
        id: 'deepseek-v4-pro',
        label: 'deepseek-v4-pro · V4-Pro',
        peak: { cacheRead: 0.3, input: 9, cacheWrite: 0, output: 27 },
        offPeak: { cacheRead: 0.15, input: 4.5, cacheWrite: 0, output: 13.5 }
      }
    ],
    schedule: {
      // UTC windows; both pages describe the same Beijing-time rule,
      // "周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00".
      peakWindows: ['01:00-04:00', '06:00-10:00'],
      weekdaysOnly: true,
      offsetMinutes: 480
    }
  },
  USD: {
    code: 'USD',
    currency: '$',
    models: [
      {
        id: 'deepseek-flash',
        label: 'deepseek-flash · V4.1-Flash',
        peak: { cacheRead: 0.006, input: 0.3, cacheWrite: 0, output: 1.2 },
        offPeak: { cacheRead: 0.003, input: 0.15, cacheWrite: 0, output: 0.6 }
      },
      {
        id: 'deepseek-v4-pro',
        label: 'deepseek-v4-pro · V4-Pro',
        peak: { cacheRead: 0.044, input: 1.32, cacheWrite: 0, output: 3.96 },
        offPeak: { cacheRead: 0.022, input: 0.66, cacheWrite: 0, output: 1.98 }
      }
    ],
    schedule: {
      // "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through
      // Friday, excluding Chinese public holidays."
      peakWindows: ['01:00-04:00', '06:00-10:00'],
      weekdaysOnly: true,
      offsetMinutes: 480
    }
  }
})

/** Convenience alias for the default (CNY) table. */
export const BUILTIN_CATALOG = BUILTIN_CATALOGS.CNY

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}

/** Decode the handful of entities the pricing table can carry. */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body) => {
    const key = String(body).toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole
  })
}

/** Strip markup and collapse whitespace, so a cell reads as its visible text. */
function cellText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<br\s*\/?>/giu, ' ')
      .replace(/<[^>]*>/gu, ' ')
  )
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Tokens of one table's cells, grouped by row, in document order. */
function tableRows(tableHtml) {
  const rows = []
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu
  const cellPattern = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu
  let rowMatch
  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const cells = []
    let cellMatch
    cellPattern.lastIndex = 0
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const text = cellText(cellMatch[1])
      if (text.length > 0) cells.push(text)
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** Rows from a markdown/text projection: one pipe-delimited line per row. */
function textRows(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.includes('|')) continue
    const cells = []
    for (const cell of line.split('|')) {
      const value = cellText(cell)
      if (value.length > 0) cells.push(value)
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** Header model id: the lowercase code in a model column, never the version line. */
function modelIdOf(text) {
  const match = /^(deepseek-[a-z0-9.\-]+?)(?:\s*\(\d+\))?$/u.exec(text)
  if (match === null) return null
  return match[1].replace(/[.\-]+$/u, '')
}

/** Metric label -> pricing bucket. */
function classifyMetric(text) {
  if (/cache\s*hit/iu.test(text) && /input/iu.test(text)) return 'cacheRead'
  if (/cache\s*miss/iu.test(text) && /input/iu.test(text)) return 'input'
  if (/output\s*tokens?/iu.test(text)) return 'output'
  if (/output/iu.test(text) && /tokens?/iu.test(text)) return 'output'
  if (/缓存命中/iu.test(text)) return 'cacheRead'
  if (/缓存未命中/iu.test(text) || /未命中输入/iu.test(text)) return 'input'
  if (/输出/iu.test(text) && /tokens?/iu.test(text)) return 'output'
  return null
}

/** Period label -> peak or off-peak. */
function classifyPeriod(text) {
  if (/^off[\s-]*peak/iu.test(text) || /空闲/iu.test(text)) return 'offPeak'
  if (/^peak/iu.test(text) || /高峰/iu.test(text)) return 'peak'
  return null
}

/** One numeric price out of a cell, or null. */
/** One numeric price out of a cell, or null. Accepts `$0.006`, `0.02元`, `1 元`. */
function priceOf(text) {
  const match = /^(?:(?:US\$|CNY|RMB|人民币|[¥￥$])\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:元|CNY|RMB|人民币|美元|USD|[¥￥$])?$/iu.exec(text)
  if (match === null) return null
  const value = Number(match[1].replaceAll(',', ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Parse one pricing table's rows into `{ models }`.
 *
 * A period cell is row-local, a metric cell persists across the continuation
 * rows it owns, and numbers fill the model columns in header order.
 */
function parseTableRows(rows) {
  const models = []
  for (const row of rows) {
    for (const cell of row) {
      const id = modelIdOf(cell)
      if (id !== null && !models.some((model) => model.id === id)) models.push({ id, label: cell })
    }
    if (models.length > 0) break
  }
  if (models.length === 0) return null

  const values = new Map(models.map((model) => [model.id, { peak: {}, offPeak: {} }]))
  let metric
  for (const row of rows) {
    let period
    for (const cell of row) {
      const nextMetric = classifyMetric(cell)
      if (nextMetric !== null) metric = nextMetric
      const nextPeriod = classifyPeriod(cell)
      if (nextPeriod !== null) period = nextPeriod
    }
    if (metric === undefined || period === undefined) continue
    let column = 0
    for (const cell of row) {
      const value = priceOf(cell)
      if (value === null) continue
      const model = models[column]
      if (model === undefined) break
      values.get(model.id)[period][metric] = value
      column += 1
    }
  }

  const parsed = models
    .map((model) => {
      const priced = values.get(model.id)
      const peak = normalizeBucket(priced.peak)
      const offPeak = normalizeBucket(priced.offPeak)
      if (peak === null && offPeak === null) return null
      const resolvedPeak = peak ?? offPeak
      return {
        id: model.id,
        label: model.label.replace(/\s*\(\d+\)\s*$/u, ''),
        peak: resolvedPeak,
        offPeak: offPeak ?? scaleBucket(resolvedPeak, 0.5)
      }
    })
    .filter((model) => model !== null)
  return parsed.length === 0 ? null : parsed
}

function normalizeBucket(bucket) {
  if (bucket.input === undefined && bucket.cacheRead === undefined && bucket.output === undefined) return null
  return {
    cacheRead: bucket.cacheRead ?? 0,
    input: bucket.input ?? 0,
    cacheWrite: 0,
    output: bucket.output ?? 0
  }
}

export function scaleBucket(bucket, factor) {
  return {
    cacheRead: round(bucket.cacheRead * factor),
    input: round(bucket.input * factor),
    cacheWrite: 0,
    output: round(bucket.output * factor)
  }
}

function round(value) {
  return Math.round(value * 1e6) / 1e6
}

/** Pull every "HH:MM-HH:MM" out of a sentence, normalized to five-character clocks. */
function extractWindows(text) {
  const windows = []
  const pattern = /([0-2]?\d:[0-5]\d)\s*[-–—~至到]\s*([0-2]?\d:[0-5]\d)/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    windows.push(`${match[1].padStart(5, '0')}-${match[2].padStart(5, '0')}`)
  }
  return windows
}

/** Shift one "HH:MM-HH:MM" window by a number of minutes, wrapping at midnight. */
function shiftWindow(window, deltaMinutes) {
  const [start, end] = window.split('-').map((clock) => {
    const [hours, minutes] = clock.split(':').map(Number)
    return ((hours * 60 + minutes + deltaMinutes) % 1440 + 1440) % 1440
  })
  const format = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return `${format(start)}-${format(end)}`
}

/**
 * Extract the advertised peak windows from the page prose, if present.
 *
 * The English page states the windows in UTC; the Chinese page states the same
 * rule in Beijing time, so those windows are shifted back to UTC before they
 * reach the clock resolver. A page that names neither is left to the bundled
 * schedule.
 */
function parseSchedule(text) {
  const english = /peak hours are([\s\S]{0,200}?)UTC([\s\S]{0,160})/iu.exec(text)
  if (english !== null) {
    const windows = extractWindows(english[1])
    if (windows.length > 0) {
      return {
        peakWindows: windows,
        weekdaysOnly: /monday through friday|weekdays/iu.test(english[1] + english[2]),
        offsetMinutes: 480
      }
    }
  }
  const chinese = /([^。；]{0,180}?为高峰时段)/u.exec(text)
  if (chinese !== null) {
    const sentence = chinese[1]
    const local = /北京时间|北京時間/u.test(sentence)
    const windows = extractWindows(sentence).map((window) => (local ? shiftWindow(window, -480) : window))
    if (windows.length > 0) {
      return {
        peakWindows: windows,
        weekdaysOnly: /周一至周五|工作日/u.test(sentence),
        offsetMinutes: 480
      }
    }
  }
  return null
}

/** Normalize a currency code hint. */
function normalizeCode(value) {
  if (typeof value !== 'string') return undefined
  const upper = value.trim().toUpperCase()
  return upper === 'CNY' || upper === 'USD' ? upper : undefined
}

/** Detect the currency from a page's own words, preferring an explicit hint. */
function detectCode(text, hint) {
  const explicit = normalizeCode(hint)
  if (explicit !== undefined) return explicit
  if (/人民币|元|CNY|RMB/iu.test(text)) return 'CNY'
  if (/美元|\$|USD/iu.test(text)) return 'USD'
  return 'CNY'
}

/**
 * Turn a fetched document into a catalog.
 *
 * Accepts the documentation page (HTML or its text projection), the JSON shape
 * this module publishes, or a bare `{ models }` document, and returns
 * `{ code, currency, models, schedule }`. Throws when no priced model is found,
 * so a layout change degrades to "keep the last good catalog" instead of zero
 * prices.
 *
 * @param content - fetched body.
 * @param at - observation time recorded on the catalog.
 * @param codeHint - the currency the URL is known to publish; detection is the
 *   fallback when a custom source says nothing.
 */
export function parseCatalog(content, at = Date.now(), codeHint) {
  const text = String(content ?? '')
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    let document
    try {
      document = JSON.parse(trimmed)
    } catch {
      document = undefined
    }
    if (document !== undefined && Array.isArray(document.models)) {
      const models = document.models
        .map((model) => {
          const peak = normalizeBucket(model.peak ?? {})
          if (peak === null) return null
          return {
            id: String(model.id ?? ''),
            label: String(model.label ?? model.id ?? ''),
            peak,
            offPeak: normalizeBucket(model.offPeak ?? {}) ?? scaleBucket(peak, 0.5)
          }
        })
        .filter((model) => model !== null && model.id.length > 0)
      if (models.length === 0) throw new Error('JSON price source carries no usable model')
      const declaredSymbol = typeof document.currency === 'string' ? document.currency.trim() : ''
      const code = normalizeCode(document.code) ?? detectCode(`${String(document.code ?? '')} ${declaredSymbol}`, codeHint)
      return {
        code,
        currency: declaredSymbol.length > 0 ? declaredSymbol : symbolOf(code),
        models,
        schedule: scheduleFromDocument(document.schedule, code),
        fetchedAt: at
      }
    }
  }

  const tables = text.match(/<table\b[\s\S]*?<\/table>/giu) ?? []
  const candidates = tables.map(tableRows)
  if (candidates.length === 0) {
    // A text projection (markdown) still carries pipe-delimited rows.
    const rows = textRows(trimmed)
    if (rows.length > 0) candidates.push(rows)
  }

  let models
  for (const rows of candidates) {
    if (!rows.some((row) => row.some((cell) => /off[\s-]*peak/iu.test(cell) || /空闲/iu.test(cell)))) continue
    models = parseTableRows(rows)
    if (models !== undefined && models !== null) break
  }
  if (models === undefined || models === null) throw new Error('no pricing table found in the fetched document')

  const cleaned = cellText(text)
  const code = detectCode(cleaned, codeHint)
  return {
    code,
    currency: symbolOf(code),
    models,
    schedule: parseSchedule(cleaned) ?? BUILTIN_CATALOGS[code].schedule,
    fetchedAt: at
  }
}

/** Currency symbol for one code. */
function symbolOf(code) {
  return code === 'USD' ? '$' : '¥'
}

function scheduleFromDocument(schedule, code) {
  const fallback = BUILTIN_CATALOGS[code]?.schedule ?? BUILTIN_CATALOGS.CNY.schedule
  if (schedule === null || typeof schedule !== 'object') return fallback
  const windows = Array.isArray(schedule.peakWindows) ? schedule.peakWindows.filter((window) => typeof window === 'string') : []
  return {
    peakWindows: windows.length > 0 ? windows : fallback.peakWindows,
    weekdaysOnly: schedule.weekdaysOnly !== false,
    offsetMinutes: Number.isFinite(schedule.offsetMinutes) ? schedule.offsetMinutes : 480
  }
}
