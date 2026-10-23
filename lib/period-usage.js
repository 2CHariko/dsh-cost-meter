/**
 * Time-aware token accounting for the cost meter, with no DSH imports so it can
 * be unit-tested without a profile or a network.
 *
 * The durable session log reports provider usage on `assistant/message` and
 * `assistant/attempt` events. This module folds those samples into buckets keyed
 * by **local day + peak/off-peak**, using the request's start time rather than
 * the settlement time, and mirrors `@deepseek-ai/dsh-token-meter`'s replacement
 * rules so the total never double-counts a streamed attempt.
 *
 * @module dsh-cost-meter/period-usage
 */

/** Projection key the host registers and the browser half reads. */
export const PROJECTION_KEY = 'costMeterUsageByDay'

/** All-zero billing buckets. */
export function emptyBuckets() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0
  }
}

/** A fresh, empty projection state. */
export function emptyState() {
  return { days: {}, current: null, last: null }
}

/** Parse "HH:MM" into minutes, or null. */
function parseClock(value) {
  const match = /^([0-9]{1,2}):([0-9]{2})$/u.exec(String(value).trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Parse one "HH:MM-HH:MM" window; wraps across midnight. */
export function parseWindow(value) {
  const match = /^\s*([0-9]{1,2}:[0-9]{2})\s*[-–—~至到]\s*([0-9]{1,2}:[0-9]{2})\s*$/u.exec(String(value))
  if (match === null) return null
  const start = parseClock(match[1])
  const end = parseClock(match[2])
  if (start === null || end === null || start === end) return null
  return { start, end }
}

/**
 * Resolve the billing schedule the fold uses.
 *
 * Explicit `peakWindows` win; otherwise the schedule published by the fetched
 * catalog is used. Holidays are Beijing-time `YYYY-MM-DD` dates.
 */
export function resolveSchedule(input) {
  const configured = (Array.isArray(input.peakWindows) ? input.peakWindows : [])
    .map(parseWindow)
    .filter((window) => window !== null)
  const catalog = input.catalogSchedule !== null && typeof input.catalogSchedule === 'object' ? input.catalogSchedule : {}
  const catalogWindows = (Array.isArray(catalog.peakWindows) ? catalog.peakWindows : [])
    .map(parseWindow)
    .filter((window) => window !== null)
  const windows = configured.length > 0 ? configured : catalogWindows.length > 0 ? catalogWindows : [parseWindow('01:00-04:00'), parseWindow('06:00-10:00')]
  return {
    windows: windows.filter((window) => window !== null),
    weekdaysOnly: configured.length > 0 ? input.weekdaysOnly !== false : catalog.weekdaysOnly !== false,
    offsetMinutes: Number.isFinite(catalog.offsetMinutes) ? catalog.offsetMinutes : 480,
    holidays: (Array.isArray(input.holidays) ? input.holidays : []).filter((day) => typeof day === 'string')
  }
}

/** Stable identity of a schedule, used to decide when the projection must refold. */
export function scheduleHash(schedule) {
  return JSON.stringify({
    windows: schedule.windows.map((window) => `${window.start}-${window.end}`),
    weekdaysOnly: schedule.weekdaysOnly,
    offsetMinutes: schedule.offsetMinutes,
    holidays: [...schedule.holidays].sort()
  })
}

/** Local calendar date (`YYYY-MM-DD`) of one instant. */
export function dateKeyAt(atMs, offsetMinutes = 480) {
  const local = new Date(atMs + offsetMinutes * 60_000)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`
}

/** Peak or off-peak at one instant. */
export function periodAt(atMs, schedule) {
  const offset = schedule.offsetMinutes
  const local = new Date(atMs + offset * 60_000)
  const dateKey = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`
  const weekday = local.getUTCDay()
  if (schedule.holidays.includes(dateKey)) return 'offPeak'
  if (schedule.weekdaysOnly && (weekday === 0 || weekday === 6)) return 'offPeak'
  const utc = new Date(atMs)
  const minuteOfDay = utc.getUTCHours() * 60 + utc.getUTCMinutes()
  const inside = schedule.windows.some((window) =>
    window.start <= window.end
      ? minuteOfDay >= window.start && minuteOfDay < window.end
      : minuteOfDay >= window.start || minuteOfDay < window.end
  )
  return inside ? 'peak' : 'offPeak'
}

/** The last usage sample carried by one settlement event, mirroring token-meter. */
export function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined && event.data.usage !== null) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = Array.isArray(event.data.stream) ? event.data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record !== null && typeof record === 'object' && record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage' && record.chunk.usage !== undefined && record.chunk.usage !== null) {
      return record.chunk.usage
    }
  }
  return undefined
}

/** Provider usage -> disjoint billing buckets. */
export function bucketsFrom(usage) {
  return {
    uncachedInputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage.cacheWriteTokens) || 0
  }
}

/** Whether two bucket sets are identical. */
export function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
}

function sameStep(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined &&
    left.turn === right.turn && left.step === right.step
}

function addBuckets(target, addition) {
  return {
    uncachedInputTokens: target.uncachedInputTokens + addition.uncachedInputTokens,
    outputTokens: target.outputTokens + addition.outputTokens,
    cacheReadTokens: target.cacheReadTokens + addition.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + addition.cacheWriteTokens
  }
}

function subtractBuckets(target, removal) {
  return {
    uncachedInputTokens: Math.max(0, target.uncachedInputTokens - removal.uncachedInputTokens),
    outputTokens: Math.max(0, target.outputTokens - removal.outputTokens),
    cacheReadTokens: Math.max(0, target.cacheReadTokens - removal.cacheReadTokens),
    cacheWriteTokens: Math.max(0, target.cacheWriteTokens - removal.cacheWriteTokens)
  }
}

function dayIsEmpty(day) {
  return bucketsEqual(day.peak, emptyBuckets()) && bucketsEqual(day.offPeak, emptyBuckets())
}

function mutateDay(days, date, period, change) {
  const current = days[date] ?? { peak: emptyBuckets(), offPeak: emptyBuckets() }
  const next = { peak: current.peak, offPeak: current.offPeak }
  next[period] = change(current[period])
  const copy = Object.assign({}, days)
  if (dayIsEmpty(next)) delete copy[date]
  else copy[date] = next
  return copy
}

/**
 * Fold one durable event into the day/period buckets.
 *
 * The same `(turn, step)` replaces its previous sample (a streamed attempt's
 * final message supersedes its earlier attempts), and `llm/retry-started`
 * closes that replacement slot so a retry bills separately. A replacement that
 * crosses a day or period boundary is subtracted from the old bucket first.
 */
export function foldUsage(state, event, schedule) {
  if (event.type === 'step/start') {
    const { turn, step } = event.data
    if (sameStep(state.current, { turn, step }) && state.current.time === event.time) return state
    return Object.assign({}, state, { current: { turn, step, time: event.time } })
  }
  if (event.type === 'llm/retry-started') {
    const { turn, step } = event.data
    const last = sameStep(state.last, { turn, step }) ? null : state.last
    return Object.assign({}, state, { current: { turn, step, time: event.time }, last })
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

  const usage = usageOf(event)
  if (usage === undefined) return state
  const { turn, step } = event.data
  const time = sameStep(state.current, { turn, step }) ? state.current.time : event.time
  const date = dateKeyAt(time, schedule.offsetMinutes)
  const period = periodAt(time, schedule)
  const buckets = bucketsFrom(usage)
  const previous = sameStep(state.last, { turn, step }) ? state.last : null

  if (previous !== null && previous.date === date && previous.period === period && bucketsEqual(previous.buckets, buckets)) {
    return state
  }

  let days = state.days
  if (previous !== null) {
    days = mutateDay(days, previous.date, previous.period, (bucket) => subtractBuckets(bucket, previous.buckets))
  }
  days = mutateDay(days, date, period, (bucket) => addBuckets(bucket, buckets))
  return Object.assign({}, state, {
    days,
    last: { turn, step, date, period, buckets }
  })
}

/** Total tokens in one bucket set. */
export function bucketTotal(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
}

/** Sum every day's buckets into one pair, for tests and diagnostics. */
export function sumDays(days) {
  let peak = emptyBuckets()
  let offPeak = emptyBuckets()
  for (const day of Object.values(days)) {
    peak = addBuckets(peak, day.peak)
    offPeak = addBuckets(offPeak, day.offPeak)
  }
  return { peak, offPeak }
}
