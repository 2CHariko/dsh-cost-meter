/**
 * Price-history regression test.
 *
 * Daily snapshots must collapse into a compact change list: identical prices do
 * not create entries, a currency missing from one day inherits the previous
 * table, and an intra-day update replaces that date instead of appending.
 *
 * Run: node test/history.mjs
 */
import { compactHistory, priceSignature, slimCatalog, todayKey } from '../lib/history.js'

const catalog = (input, output) => ({
  code: 'CNY',
  currency: '¥',
  models: [
    { id: 'deepseek-flash', label: 'flash', peak: { cacheRead: 0.04, input, cacheWrite: 0, output }, offPeak: { cacheRead: 0.02, input: input / 2, cacheWrite: 0, output: output / 2 } }
  ]
})

const usd = {
  code: 'USD',
  currency: '$',
  models: [
    { id: 'deepseek-flash', label: 'flash', peak: { cacheRead: 0.006, input: 0.3, cacheWrite: 0, output: 1.2 }, offPeak: { cacheRead: 0.003, input: 0.15, cacheWrite: 0, output: 0.6 } }
  ]
}

if (slimCatalog(catalog(2, 8)).models[0].peak.input !== 2) throw new Error('slimCatalog dropped prices')
if (todayKey(Date.parse('2026-10-23T16:00:00Z')) !== '2026-10-24') throw new Error('todayKey must use Beijing time')

// Day 1 introduces a price; day 2 repeats it; day 3 changes it.
const history = compactHistory([
  { date: '2026-10-23', catalogs: { CNY: catalog(2, 8), USD: usd } },
  { date: '2026-10-24', catalogs: { CNY: catalog(2, 8), USD: usd } },
  { date: '2026-10-25', catalogs: { CNY: catalog(3, 12), USD: usd } }
])
console.log('changes:', history.changes.map((change) => change.date).join(', '))
if (history.changes.length !== 2) throw new Error(`identical days must collapse, got ${history.changes.length}`)
if (history.changes[0].date !== '2026-10-23' || history.changes[1].date !== '2026-10-25') throw new Error('unexpected change dates')
if (history.changes[1].catalogs.CNY.models[0].peak.input !== 3) throw new Error('the changed price was not recorded')
if (history.firstDate !== '2026-10-23' || history.lastDate !== '2026-10-25') throw new Error('range metadata is wrong')

// A day that only refreshed CNY inherits the previous USD table.
const inherited = compactHistory([
  { date: '2026-10-23', catalogs: { CNY: catalog(2, 8), USD: usd } },
  { date: '2026-10-24', catalogs: { CNY: catalog(4, 16) } }
])
if (inherited.changes.length !== 2) throw new Error('a changed CNY price must create one entry')
if (inherited.changes[1].catalogs.USD === undefined) throw new Error('the missing USD table must be inherited')
if (inherited.changes[1].catalogs.USD.models[0].peak.input !== 0.3) throw new Error('the inherited USD price changed')

// Updating the same date replaces its entry instead of appending.
const sameDay = compactHistory([
  { date: '2026-10-23', catalogs: { CNY: catalog(2, 8) } },
  { date: '2026-10-23', catalogs: { CNY: catalog(5, 20) } }
])
if (sameDay.changes.length !== 1) throw new Error(`an intra-day update must replace, got ${sameDay.changes.length}`)
if (sameDay.changes[0].catalogs.CNY.models[0].peak.input !== 5) throw new Error('the intra-day update was not applied')
if (priceSignature({ CNY: slimCatalog(catalog(5, 20)) }) === priceSignature({ CNY: slimCatalog(catalog(2, 8)) })) {
  throw new Error('the price signature must change with the price')
}

console.log('\nOK — daily snapshots collapse to price-change points, inherit missing currencies, and update the current day in place.')
