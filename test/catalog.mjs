/**
 * Parser regression test for the host-side price catalogs.
 *
 * DeepSeek publishes the table twice: the Chinese page quotes CNY and the
 * English page quotes USD. Both use a rowspan table where a price row can carry
 * only the period and its numbers, while a later row (a concurrency limit)
 * carries numbers that are not prices at all. This test feeds both shapes — plus
 * the MODEL VERSION row whose values start with "DeepSeek-" — and proves the
 * parser keeps two models, assigns both columns, detects the currency, converts
 * the Chinese page's Beijing-time windows to UTC, and never invents a third
 * model.
 *
 * Run: node test/catalog.mjs
 */
import { BUILTIN_CATALOGS, parseCatalog } from '../lib/catalog.js'

const USD_PAGE = `<!doctype html><html><body>
<nav>Models &amp; Pricing · deepseek-flash</nav>
<table>
  <thead>
    <tr><th>MODEL</th><th>deepseek-flash<sup>(1)</sup></th><th>deepseek-v4-pro</th></tr>
  </thead>
  <tbody>
    <tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash-1017</td><td>DeepSeek-V4-Pro-0813</td></tr>
    <tr><td>THINKING MODE</td><td>Supported</td><td>Supported</td></tr>
    <tr><td>CONTEXT LENGTH</td><td>1M</td><td>1M</td></tr>
    <tr><td>MAX OUTPUT</td><td>384K</td><td>128K</td></tr>
    <tr><td>PRICING<sup>(2)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
    <tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
    <tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
    <tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
    <tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
    <tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
    <tr><td>Concurrency Limit<sup>(3)</sup></td><td>2500</td><td>500</td></tr>
  </tbody>
</table>
<p>Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through
Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public
holidays in full.</p>
</body></html>`

const CNY_PAGE = `<!doctype html><html><body>
<nav>模型 &amp; 价格 · deepseek-flash</nav>
<table>
  <thead>
    <tr><th>模型</th><th>deepseek-flash<sup>(1)</sup></th><th>deepseek-v4-pro</th></tr>
  </thead>
  <tbody>
    <tr><td>模型版本</td><td>DeepSeek-V4.1-Flash-1017</td><td>DeepSeek-V4-Pro-0813</td></tr>
    <tr><td>思考模式</td><td>支持非思考与思考模式（默认）</td><td>支持非思考与思考模式（默认）</td></tr>
    <tr><td>上下文长度</td><td>1M</td><td>1M</td></tr>
    <tr><td>输出长度</td><td>最大 384K</td><td>最大 384K</td></tr>
    <tr><td>价格<sup>(2)</sup></td><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>
    <tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>
    <tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>
    <tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>
    <tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>
    <tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>
    <tr><td>并发限制<sup>(3)</sup></td><td>2500</td><td>500</td></tr>
  </tbody>
</table>
<p>空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。</p>
</body></html>`

const usd = parseCatalog(USD_PAGE, 1_700_000_000_000)
console.log('USD:', usd.code, usd.currency, usd.models.map((model) => model.id).join(', '))
console.log('USD flash:', JSON.stringify(usd.models[0]?.peak), JSON.stringify(usd.models[0]?.offPeak))
console.log('USD sched:', JSON.stringify(usd.schedule))

if (usd.code !== 'USD' || usd.currency !== '$') throw new Error(`USD page detected as ${usd.code}/${usd.currency}`)
if (usd.models.length !== 2) throw new Error(`the parser invented ${usd.models.length} USD models`)
if (usd.models[0].id !== 'deepseek-flash' || usd.models[1].id !== 'deepseek-v4-pro') {
  throw new Error(`unexpected USD model ids: ${usd.models.map((model) => model.id).join(', ')}`)
}
const usdFlash = usd.models[0]
if (usdFlash.peak.input !== 0.3 || usdFlash.peak.cacheRead !== 0.006 || usdFlash.peak.output !== 1.2) {
  throw new Error(`USD flash peak regressed: ${JSON.stringify(usdFlash.peak)}`)
}
if (usdFlash.offPeak.input !== 0.15 || usdFlash.offPeak.cacheRead !== 0.003 || usdFlash.offPeak.output !== 0.6) {
  throw new Error(`USD flash off-peak regressed: ${JSON.stringify(usdFlash.offPeak)}`)
}
const usdPro = usd.models[1]
if (usdPro.peak.input !== 1.32 || usdPro.peak.cacheRead !== 0.044 || usdPro.peak.output !== 3.96) {
  throw new Error(`USD pro peak regressed: ${JSON.stringify(usdPro.peak)}`)
}
if (usdFlash.peak.cacheWrite !== 0) throw new Error('cache write must stay 0 (DeepSeek does not bill it)')
if (usd.schedule.peakWindows.join(',') !== '01:00-04:00,06:00-10:00') {
  throw new Error(`USD schedule regressed: ${usd.schedule.peakWindows.join(',')}`)
}
if (usd.schedule.weekdaysOnly !== true) throw new Error('the USD page says Monday through Friday')

const cny = parseCatalog(CNY_PAGE, 1_700_000_000_001)
console.log('CNY:', cny.code, cny.currency, cny.models.map((model) => model.id).join(', '))
console.log('CNY flash:', JSON.stringify(cny.models[0]?.peak), JSON.stringify(cny.models[0]?.offPeak))
console.log('CNY pro  :', JSON.stringify(cny.models[1]?.peak), JSON.stringify(cny.models[1]?.offPeak))
console.log('CNY sched:', JSON.stringify(cny.schedule))

if (cny.code !== 'CNY' || cny.currency !== '¥') throw new Error(`CNY page detected as ${cny.code}/${cny.currency}`)
if (cny.models.length !== 2) throw new Error(`the parser invented ${cny.models.length} CNY models`)
const cnyFlash = cny.models[0]
if (cnyFlash.peak.cacheRead !== 0.04 || cnyFlash.peak.input !== 2 || cnyFlash.peak.output !== 8) {
  throw new Error(`CNY flash peak regressed: ${JSON.stringify(cnyFlash.peak)}`)
}
if (cnyFlash.offPeak.cacheRead !== 0.02 || cnyFlash.offPeak.input !== 1 || cnyFlash.offPeak.output !== 4) {
  throw new Error(`CNY flash off-peak regressed: ${JSON.stringify(cnyFlash.offPeak)}`)
}
const cnyPro = cny.models[1]
if (cnyPro.peak.cacheRead !== 0.3 || cnyPro.peak.input !== 9 || cnyPro.peak.output !== 27) {
  throw new Error(`CNY pro peak regressed: ${JSON.stringify(cnyPro.peak)}`)
}
if (cnyPro.offPeak.cacheRead !== 0.15 || cnyPro.offPeak.input !== 4.5 || cnyPro.offPeak.output !== 13.5) {
  throw new Error(`CNY pro off-peak regressed: ${JSON.stringify(cnyPro.offPeak)}`)
}
if (cny.schedule.peakWindows.join(',') !== '01:00-04:00,06:00-10:00') {
  throw new Error(`Beijing windows must be converted to UTC, got ${cny.schedule.peakWindows.join(',')}`)
}
if (cny.schedule.weekdaysOnly !== true) throw new Error('the CNY page says 周一至周五')

// The hint wins over a page's own wording (a custom JSON may say nothing useful).
const hinted = parseCatalog(USD_PAGE, 1, 'CNY')
if (hinted.code !== 'CNY' || hinted.currency !== '¥') throw new Error('an explicit code hint must win')

// A JSON source with the published shape must bypass HTML parsing entirely.
const json = parseCatalog(JSON.stringify({
  currency: '¥',
  models: [{ id: 'custom', label: 'Custom', peak: { input: 2, cacheRead: 0.04, output: 8 } }],
  schedule: { peakWindows: ['09:00-12:00'], weekdaysOnly: true, offsetMinutes: 480 }
}), 1)
if (json.models[0].id !== 'custom' || json.models[0].peak.input !== 2 || json.currency !== '¥' || json.code !== 'CNY') {
  throw new Error(`the JSON shape regressed: ${JSON.stringify(json)}`)
}
if (json.models[0].offPeak.input !== 1) throw new Error('a JSON model without off-peak halves its peak prices')

// A text projection (markdown) is accepted as a fallback.
const markdown = parseCatalog(`
| 1M INPUT TOKENS (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |
| PEAK | $0.006 | $0.044 |
| 1M INPUT TOKENS (CACHE MISS) | OFF-PEAK | $0.15 | $0.66 |
| PEAK | $0.3 | $1.32 |
| deepseek-flash | deepseek-v4-pro |
`, 2)
if (markdown.models.length !== 2 || markdown.models[0].peak.output !== 0) {
  throw new Error('a text projection without output rows must still parse the two header models')
}
if (markdown.code !== 'USD') throw new Error(`a dollar-only text source must be USD, got ${markdown.code}`)

// A page that no longer carries the table must throw, so the host keeps its last good catalog.
let rejected = false
try {
  parseCatalog('<html><body>nothing here</body></html>', 3)
} catch {
  rejected = true
}
if (!rejected) throw new Error('a page without a pricing table must be rejected')

// The bundled tables mirror the same numbers the live parse produced.
if (BUILTIN_CATALOGS.CNY.models[0].peak.input !== cnyFlash.peak.input) throw new Error('the bundled CNY catalog drifted from the page')
if (BUILTIN_CATALOGS.USD.models[0].peak.input !== usdFlash.peak.input) throw new Error('the bundled USD catalog drifted from the page')

console.log('\nOK — both pages parse into their own currency, the parser keeps exactly the header models, splits peak/off-peak, converts Beijing windows to UTC, never reads unrelated numbers as prices, and accepts JSON or text sources.')
