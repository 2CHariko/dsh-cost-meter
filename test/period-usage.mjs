/**
 * Fold regression test for the period-usage projection.
 *
 * The fold must bill usage at the request's start time, split it across the
 * peak/off-peak boundary, and mirror token-meter's replacement rules so streamed
 * attempts and retries never double-count.
 *
 * Run: node test/period-usage.mjs
 */
import {
  PROJECTION_KEY,
  bucketsFrom,
  dateKeyAt,
  emptyBuckets,
  emptyState,
  foldUsage,
  resolveSchedule,
  scheduleHash,
  sumDays,
  usageOf
} from '../lib/period-usage.js'

const schedule = resolveSchedule({
  peakWindows: [],
  weekdaysOnly: true,
  holidays: [],
  catalogSchedule: { peakWindows: ['01:00-04:00', '06:00-10:00'], weekdaysOnly: true, offsetMinutes: 480 }
})

if (PROJECTION_KEY !== 'costMeterUsageByDay') throw new Error('projection key changed')
if (schedule.windows.length !== 2) throw new Error('the catalog windows were not adopted')
if (scheduleHash(schedule).length === 0) throw new Error('schedule hash is empty')

const usage = (input, output, read = 0, write = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write })
const event = (type, time, data) => ({ type, time, data })
const attempt = (time, data, sample) => event('assistant/attempt', time, Object.assign({}, data, {
  stream: [{ type: 'chunk', chunk: { type: 'usage', usage: sample } }]
}))
const day = (state, date) => state.days[date] ?? { peak: emptyBuckets(), offPeak: emptyBuckets() }

// 09:59:30 Beijing (peak window) starts, settles at 10:00:10.
let state = emptyState()
state = foldUsage(state, event('step/start', Date.parse('2026-10-23T01:59:30Z'), { turn: 1, step: 1 }), schedule)
state = foldUsage(state, event('assistant/message', Date.parse('2026-10-23T02:00:10Z'), { turn: 1, step: 1, usage: usage(100, 10) }), schedule)
if (day(state, '2026-10-23').peak.uncachedInputTokens !== 100) throw new Error('request-start time must decide the peak bucket')

// The same step's final message replaces the streamed attempt instead of adding.
state = foldUsage(state, event('assistant/message', Date.parse('2026-10-23T02:00:12Z'), { turn: 1, step: 1, usage: usage(120, 12) }), schedule)
if (day(state, '2026-10-23').peak.uncachedInputTokens !== 120) throw new Error(`replacement double-counted: ${JSON.stringify(day(state, '2026-10-23'))}`)

// 12:01 Beijing is off-peak.
state = foldUsage(state, event('step/start', Date.parse('2026-10-23T04:01:00Z'), { turn: 1, step: 2 }), schedule)
state = foldUsage(state, event('assistant/message', Date.parse('2026-10-23T04:01:05Z'), { turn: 1, step: 2, usage: usage(200, 20) }), schedule)
if (day(state, '2026-10-23').offPeak.uncachedInputTokens !== 200) throw new Error('off-peak bucket missing')
if (day(state, '2026-10-23').peak.uncachedInputTokens !== 120) throw new Error('off-peak usage leaked into peak')

// A streamed attempt carries usage in a `chunk` record, not on the event itself.
const streamed = event('assistant/attempt', Date.parse('2026-10-23T04:02:00Z'), {
  turn: 1,
  step: 3,
  stream: [
    { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
    { type: 'chunk', chunk: { type: 'usage', usage: usage(30, 3, 5, 0) } }
  ]
})
if (usageOf(streamed).cacheReadTokens !== 5) throw new Error('stream usage chunk was not read')
state = foldUsage(state, event('step/start', Date.parse('2026-10-23T04:01:59Z'), { turn: 1, step: 3 }), schedule)
state = foldUsage(state, streamed, schedule)
if (day(state, '2026-10-23').offPeak.cacheReadTokens !== 5) throw new Error('stream usage did not land in the off-peak bucket')

// Retry: the failed attempt stays billed, the retried attempt bills separately.
let retry = emptyState()
retry = foldUsage(retry, event('step/start', Date.parse('2026-10-23T03:59:00Z'), { turn: 2, step: 1 }), schedule)
retry = foldUsage(retry, attempt(Date.parse('2026-10-23T03:59:30Z'), { turn: 2, step: 1 }, usage(50, 5)), schedule)
retry = foldUsage(retry, event('llm/retry-started', Date.parse('2026-10-23T04:00:30Z'), { turn: 2, step: 1 }), schedule)
retry = foldUsage(retry, event('assistant/message', Date.parse('2026-10-23T04:00:40Z'), { turn: 2, step: 1, usage: usage(60, 6) }), schedule)
const retryDay = day(retry, '2026-10-23')
if (retryDay.peak.uncachedInputTokens !== 50) throw new Error(`the failed attempt must stay in peak: ${JSON.stringify(retryDay.peak)}`)
if (retryDay.offPeak.uncachedInputTokens !== 60) throw new Error(`the retried attempt must bill in off-peak: ${JSON.stringify(retryDay.offPeak)}`)

// A replacement that itself crosses the boundary moves the tokens.
let moved = emptyState()
moved = foldUsage(moved, event('step/start', Date.parse('2026-10-23T03:58:00Z'), { turn: 3, step: 1 }), schedule)
moved = foldUsage(moved, attempt(Date.parse('2026-10-23T03:59:00Z'), { turn: 3, step: 1 }, usage(70, 7)), schedule)
moved = foldUsage(moved, event('assistant/message', Date.parse('2026-10-23T04:02:00Z'), { turn: 3, step: 1, usage: usage(70, 7) }), schedule)
// Without retry-started, the later sample replaces the earlier one; the time is
// still the step's start (03:58), so it remains peak.
if (day(moved, '2026-10-23').peak.uncachedInputTokens !== 70) throw new Error('same-step replacement must not double bill')
if (day(moved, '2026-10-23').offPeak.uncachedInputTokens !== 0) throw new Error('a replacement keeps the request-start period')

// Holiday: the same Friday is billed off-peak all day.
const holidaySchedule = resolveSchedule({
  peakWindows: [],
  weekdaysOnly: true,
  holidays: ['2026-10-23'],
  catalogSchedule: { peakWindows: ['01:00-04:00', '06:00-10:00'], weekdaysOnly: true, offsetMinutes: 480 }
})
let holiday = emptyState()
holiday = foldUsage(holiday, event('step/start', Date.parse('2026-10-23T02:00:00Z'), { turn: 1, step: 1 }), holidaySchedule)
holiday = foldUsage(holiday, event('assistant/message', Date.parse('2026-10-23T02:01:00Z'), { turn: 1, step: 1, usage: usage(90, 9) }), holidaySchedule)
if (day(holiday, '2026-10-23').peak.uncachedInputTokens !== 0) throw new Error('a holiday must not bill peak')

// Two local days split by the Beijing date, not the UTC date.
let days = emptyState()
days = foldUsage(days, event('step/start', Date.parse('2026-10-23T15:59:00Z'), { turn: 1, step: 1 }), schedule) // 23:59 Beijing
days = foldUsage(days, event('assistant/message', Date.parse('2026-10-23T15:59:30Z'), { turn: 1, step: 1, usage: usage(10, 1) }), schedule)
days = foldUsage(days, event('step/start', Date.parse('2026-10-23T16:01:00Z'), { turn: 1, step: 2 }), schedule) // 00:01 next day
days = foldUsage(days, event('assistant/message', Date.parse('2026-10-23T16:01:30Z'), { turn: 1, step: 2, usage: usage(20, 2) }), schedule)
if (days.days['2026-10-23'] === undefined || days.days['2026-10-24'] === undefined) throw new Error(`local-day split failed: ${JSON.stringify(Object.keys(days.days))}`)

// Sum of every bucket pair is what the browser computes cost from.
const totals = sumDays(state.days)
if (totals.peak.uncachedInputTokens !== 120 || totals.offPeak.uncachedInputTokens !== 230) {
  throw new Error(`unexpected totals: ${JSON.stringify(totals)}`)
}
if (dateKeyAt(Date.parse('2026-10-23T16:01:00Z')) !== '2026-10-24') throw new Error('dateKeyAt must use Beijing time')
if (bucketsFrom({ inputTokens: 1, outputTokens: 2 }).cacheReadTokens !== 0) throw new Error('missing cache buckets must default to 0')

console.log('\nOK — usage is billed by request start, split at the peak boundary, replaced per attempt, and retries or holidays never double-count.')
