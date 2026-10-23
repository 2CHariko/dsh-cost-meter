/**
 * Verify the installed copy resolves and imports exactly the way the loader will.
 *
 * The loader imports each entry specifier through Node's internal ESM loader
 * with the profile directory as `parentURL` (cordis-plugin-loader
 * `config/tree.ts`), so bare-specifier resolution walks up from
 * `~/.dsh/profiles/<profile>/`. This script reproduces that walk with
 * `createRequire` anchored at the profile manifest, then imports both halves and
 * exercises the host schema.
 *
 * Run: node test/verify-install.mjs [--profile <name>]
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const profileIndex = argv.indexOf('--profile')
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : 'desktop'
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh')
const profileDir = join(dshHome, 'profiles', profile)

const require = createRequire(join(profileDir, 'package.json'))

function resolve(specifier) {
  try {
    return require.resolve(specifier)
  } catch (error) {
    throw new Error(`cannot resolve ${specifier} from ${profileDir}: ${error.message}`)
  }
}

const hostEntry = resolve('dsh-cost-meter')
const clientEntry = resolve('dsh-cost-meter/client')
console.log('host half  :', hostEntry)
console.log('client half:', clientEntry)
console.log('schemastery:', resolve('@deepseek-ai/schemastery'))

const host = await import(pathToFileURL(hostEntry).href)
console.log('host exports:', Object.keys(host).sort().join(', '))

if (typeof host.apply !== 'function') throw new Error('host half exports no apply')
if (host.name !== 'cost-meter') throw new Error(`unexpected plugin name ${host.name}`)
if (host.COST_METER_SETTINGS_NAMESPACE !== 'cost-meter') throw new Error('unexpected settings namespace')
if (host.PRICES_ROUTE !== '/dsh-cost-meter/prices' || host.REFRESH_ROUTE !== '/dsh-cost-meter/refresh') {
  throw new Error('the catalog routes are not the ones the browser half calls')
}
if (host.PROJECTION_KEY !== 'costMeterUsageByDay') throw new Error('the period-usage projection key changed')
if (!host.BUILTIN_CATALOGS?.CNY?.models?.length || !host.BUILTIN_CATALOGS?.USD?.models?.length) {
  throw new Error('the host half carries no bundled price catalogs')
}

// The schema the loader validates the row config against; the defaults must
// resolve to the auto source with DeepSeek's CNY deepseek-flash peak numbers.
// Volatile fields resolve to live references, exactly as the runtime hands them
// to `apply`, so unwrap them the same way the settings projection does.
const plain = (value) => {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  return value
}
const resolved = plain(host.Config({}))
console.log('row config resolves to:', JSON.stringify(resolved))
for (const [field, expected] of Object.entries({
  source: 'auto',
  sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  usdSourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  model: 'deepseek-flash',
  currency: 'CNY',
  decimals: 3,
  showSavings: true,
  refreshMinutes: 360,
  input: 2,
  cacheRead: 0.04,
  cacheWrite: 0,
  output: 8,
  offPeakFactor: 0.5,
  weekdaysOnly: true,
})) {
  if (resolved[field] !== expected) throw new Error(`default for ${field} is ${JSON.stringify(resolved[field])}, expected ${JSON.stringify(expected)}`)
}
if (!Array.isArray(resolved.peakWindows) || resolved.peakWindows.length !== 0) throw new Error('peakWindows must default to "follow the catalog"')
if (!Array.isArray(resolved.holidays) || resolved.holidays.length !== 0) throw new Error('holidays must default to an empty list')

// DSH's settings projection only exposes fields marked volatile; an entry with
// none is not described at all, and its browser form can never write.
for (const field of ['source', 'currency', 'model', 'sourceUrl', 'usdSourceUrl', 'input', 'cacheRead', 'output', 'offPeakFactor', 'peakWindows', 'holidays']) {
  if (host.Config.dict[field].meta?.volatile !== true) {
    throw new Error(`config field "${field}" is not volatile, so settings.describe omits the entry`)
  }
}
if (host.Config.dict.unit.meta?.volatile === true) throw new Error('the deprecated unit field must not be exposed in the settings form')

// A price must survive validation, and a negative one must be refused.
if (plain(host.Config({ input: 2.5 })).input !== 2.5) throw new Error('a positive price did not survive the schema')
let rejected = false
try {
  host.Config({ input: -1 })
} catch {
  rejected = true
}
if (!rejected) throw new Error('the schema accepted a negative price')

// The installed row carries no config block on purpose: the schema above is the
// single source of the defaults, so a row without overrides must parse.
const parsedRow = plain(host.Config({}))
if (parsedRow.source !== 'auto' || parsedRow.currency !== 'CNY' || parsedRow.input !== 2) {
  throw new Error('a row without overrides does not resolve to the seeded defaults')
}

console.log('\nOK — the profile resolves both halves, the host half imports, and the row config validates.')
