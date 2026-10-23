/**
 * Daily price snapshots for the cost meter.
 *
 * From the day this feature is installed, every successful catalog refresh
 * writes/updates one snapshot file for the Beijing calendar date. Snapshots are
 * frozen once the date passes, so a future session can price each day's usage
 * with the table that was in effect then. Publishing a compact change list (one
 * entry per price change, not per day) keeps the payload the browser receives
 * small.
 *
 * @module dsh-cost-meter/history
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dateKeyAt } from './period-usage.js'

/**
 * Where snapshots live.
 *
 * The archive is deliberately shared by every profile: prices are a property of
 * the provider, not of one workspace, and the host process does not reliably
 * receive `DSH_PROFILE_DIR`.
 */
export function historyDirectory(homeDir) {
  return join(homeDir, '.dsh', 'cost-meter-prices')
}

/** Only the price-bearing part of a catalog is stored. */
export function slimCatalog(catalog) {
  if (catalog === null || typeof catalog !== 'object' || !Array.isArray(catalog.models)) return null
  return {
    code: typeof catalog.code === 'string' ? catalog.code : '',
    currency: typeof catalog.currency === 'string' ? catalog.currency : '',
    models: catalog.models.map((model) => ({
      id: String(model.id ?? ''),
      label: String(model.label ?? model.id ?? ''),
      peak: priceBucket(model.peak),
      offPeak: priceBucket(model.offPeak)
    }))
  }
}

function priceBucket(bucket) {
  return {
    cacheRead: Number(bucket?.cacheRead) || 0,
    input: Number(bucket?.input) || 0,
    cacheWrite: Number(bucket?.cacheWrite) || 0,
    output: Number(bucket?.output) || 0
  }
}

/** Stable signature of the prices in a catalog set; equal means "no new entry". */
export function priceSignature(catalogs) {
  const currencies = Object.keys(catalogs).sort()
  return JSON.stringify(currencies.map((code) => {
    const catalog = catalogs[code]
    const models = (catalog.models ?? []).map((model) => [
      model.id,
      model.peak.cacheRead,
      model.peak.input,
      model.peak.cacheWrite,
      model.peak.output,
      model.offPeak.cacheRead,
      model.offPeak.input,
      model.offPeak.cacheWrite,
      model.offPeak.output
    ])
    return [code, catalog.currency ?? '', models]
  }))
}

/**
 * Turn dated snapshots into a change list.
 *
 * A day missing a currency inherits the previous day's table for that currency,
 * and consecutive days with identical prices collapse into one entry. Updating
 * the same date replaces that date's entry instead of appending a second one.
 */
export function compactHistory(snapshots) {
  const sorted = [...snapshots].sort((left, right) => left.date.localeCompare(right.date))
  const changes = []
  let carried = {}
  let lastSignature = null
  for (const snapshot of sorted) {
    const next = Object.assign({}, carried)
    for (const [code, catalog] of Object.entries(snapshot.catalogs ?? {})) {
      const slim = slimCatalog(catalog)
      if (slim !== null) next[code] = slim
    }
    if (Object.keys(next).length === 0) continue
    carried = next
    const signature = priceSignature(next)
    const last = changes[changes.length - 1]
    if (last !== undefined && last.date === snapshot.date) {
      if (signature !== lastSignature) {
        last.catalogs = next
        lastSignature = signature
      }
      continue
    }
    if (signature === lastSignature) continue
    changes.push({ date: snapshot.date, catalogs: next })
    lastSignature = signature
  }
  return {
    changes,
    firstDate: changes.length > 0 ? changes[0].date : null,
    lastDate: changes.length > 0 ? changes[changes.length - 1].date : null
  }
}

/** Read every dated snapshot file in the directory. */
export async function loadSnapshots(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  const snapshots = []
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/u.test(name)) continue
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && parsed.catalogs !== null && typeof parsed.catalogs === 'object') {
        snapshots.push({ date: name.slice(0, 10), catalogs: parsed.catalogs })
      }
    } catch {
      // A partially written or hand-edited snapshot is skipped; the rest still load.
    }
  }
  return snapshots
}

/** Load and compact the history for the browser. */
export async function loadHistory(directory) {
  return compactHistory(await loadSnapshots(directory))
}

/**
 * Write or update today's snapshot.
 *
 * Only currencies present in `catalogs` are replaced; a currency that failed to
 * refresh keeps the value already stored for today.
 */
export async function recordSnapshot(directory, date, catalogs) {
  const provided = {}
  for (const [code, catalog] of Object.entries(catalogs ?? {})) {
    const slim = slimCatalog(catalog)
    if (slim !== null) provided[code] = slim
  }
  if (Object.keys(provided).length === 0) return null
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${date}.json`)
  let existing = null
  try {
    existing = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    existing = null
  }
  const merged = {
    date,
    savedAt: Date.now(),
    catalogs: Object.assign({}, existing !== null && existing.catalogs !== null && typeof existing.catalogs === 'object' ? existing.catalogs : {}, provided)
  }
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(temporary, JSON.stringify(merged), 'utf8')
  await rename(temporary, path)
  return merged
}

/** Best-effort retention: snapshots older than `keepDays` are deleted. */
export async function pruneSnapshots(directory, today, keepDays = 800) {
  let names
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - keepDays * 86_400_000
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/u.test(name)) continue
    const at = new Date(`${name.slice(0, 10)}T00:00:00Z`).getTime()
    if (Number.isFinite(at) && at < cutoff) {
      await unlink(join(directory, name)).catch(() => {})
    }
  }
}

/** Today's snapshot date key (Beijing calendar). */
export function todayKey(now = Date.now()) {
  return dateKeyAt(now, 480)
}
