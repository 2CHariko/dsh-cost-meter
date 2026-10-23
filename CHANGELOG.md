# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versioning policy —
including which changes must be a MAJOR — lives in
[README.md § Compatibility and versioning](README.md#compatibility).

## [0.5.2] - 2026-10-23

Documentation and package metadata follow the GitHub account rename.

### Changed

- Repository URLs, clone/install commands, `author`, `homepage`, `bugs`, and the
  license copyright now use `2CHariko/dsh-cost-meter` instead of the old
  `Nanako660` account. GitHub redirects the old paths, but the canonical
  location is the new one.

## [0.5.1] - 2026-10-23

The dock badge keeps its original single-character form.

### Changed

- The pill badge shows the **current** period as one character — `峰` or `谷` — instead of `峰价` / `谷价` / `混合`.
  The total remains historical; the panel still breaks the session into peak and off-peak subtotals, so a mixed
  session is visible there without overloading the badge.

## [0.5.0] - 2026-10-23

Usage is now billed at the time each request happened, not at the clock the page
is rendered.

### Added

- **Historical period projection.** `costMeterUsageByDay` folds every durable
  `assistant/message` / `assistant/attempt` usage sample into local-day +
  peak/off-peak buckets. A request is classified by its **start** time
  (`step/start`, updated on retries), so a request that crosses 12:00 stays in
  the period it started in. Replacement, retry, and streamed-attempt semantics
  mirror `@deepseek-ai/dsh-token-meter`.
- **Daily price snapshots.** From this version on, every successful refresh
  writes/updates one snapshot per Beijing calendar day under
  `~/.dsh/cost-meter-prices`. The route publishes a compact change list (one
  entry per price change, not per day), and the page prices each day with the
  table that was in effect then. A currency that fails to refresh inherits the
  previous day's table.
- **Reclassification on rule changes.** Changing peak windows, weekdays, or
  holidays disposes and re-registers the projection, so history is folded again
  with the new rule instead of keeping stale period labels.
- **Peak/off-peak breakdown in the panel.** The panel breaks out peak and off-peak tokens and money separately,
  with the current period/rate kept as context only. (0.5.1 restored the dock badge to a single current-period
  character.)
- Settings shows the price-snapshot range and whether the historical projection
  is registered.

### Changed

- The pill total no longer changes when the clock crosses a boundary. It is the
  sum of `peak usage × peak price + off-peak usage × off-peak price`, per day.
- `resolvePricing` accepts the projection day map and returns a `history` block;
  without it the page keeps the old estimate, explicitly labelled
  `按当前时段估算`.

### Limitations

- Snapshots start today. Usage before the first snapshot has no historical
  table and is priced with the current one (the panel reports how many days
  that affects).
- A session that switches models is still priced entirely with the model
  selected in settings (unchanged from 0.4.x).
- Snapshot granularity is one day; an intra-day price change is reflected once
  the refresh that observes it runs.

## [0.4.1] - 2026-10-23

The settings page is writable again.

### Fixed

- **Every control was disabled because the entry was never served.** DSH's settings projection (`volatileForm`)
  describes only plugin entries whose schema has at least one field marked `.volatile()`; this entry had none, so
  `settings.describe()` omitted it, `ctx.configForms.get("cost-meter")` never left its `unavailable` snapshot, and the
  page rendered every input and button with `disabled`. All editable `Config` fields are now `.volatile()`.
- The host half reads those live references through `currentConfig()` on every request and on a one-minute tick
  instead of capturing plain values once, because volatile fields arrive as `{ get() }` references. A saved source
  URL or refresh interval now takes effect without remounting the plugin.
- Saving from the page asks the host for a refresh, so a changed price URL is fetched immediately rather than at the
  next tick.

### Added

- `/dsh-cost-meter/refresh` reports `settingsServed`, the same check `settings.describe()` makes for this entry, to
  make a future "form is disabled" diagnosis a single request.

## [0.4.0] - 2026-10-23

CNY is now the default price table, with the USD table one switch away.

### Added

- **Both official price pages.** The host half fetches the Chinese page (CNY) and the English page (USD) as two
  independent sources, parses each with a currency hint, and publishes `catalogs: { CNY, USD }` plus per-currency
  freshness/errors on `/dsh-cost-meter/prices`. One page changing layout no longer takes the other currency down.
- **Currency switch in the settings page.** 计价币种 offers 人民币（¥） (default) and 美元（$）; the pill, panel, rates
  and preview all follow it. Manual prices are denominated in the selected currency.
- **CNY seed table.** `¥0.04 / ¥2 / ¥8` peak per million for `deepseek-flash` (`¥0.02 / ¥1 / ¥4` off-peak), and
  `¥0.30 / ¥9 / ¥27` for `deepseek-v4-pro` (`¥0.15 / ¥4.5 / ¥13.5` off-peak), read from the Chinese page. The USD
  table stays bundled beside it.
- Per-currency URL fields (`人民币价目地址`, `美元价目地址`) and per-currency status rows on the settings page.

### Changed

- `Config.currency` now takes `CNY` or `USD` instead of a free-form symbol; the schema default is `CNY`. A saved
  `$` or `USD` selects the USD table, and any other legacy value resolves to CNY.
- The four manual price defaults are now the CNY peak numbers, not the USD ones.
- The parser accepts `元`-suffixed and `¥`-prefixed prices, the Chinese metric labels (`百万tokens输入（缓存命中）` …),
  and converts the Chinese page's Beijing-time peak windows to UTC; the English page's `UTC` sentence is used as is.
- `parseCatalog(content, at, codeHint)` returns `{ code, currency, models, schedule }`; a JSON source may declare
  `code` and keeps its own `currency` symbol if given.

### Fixed

- A row's period is now row-local, so the concurrency-limit row can no longer inherit `PEAK`/`OFF-PEAK` and be read
  as a third model's prices (a defect found against the live page).
- Model headers are matched only as lowercase `deepseek-…` codes, so the `MODEL VERSION` row (`DeepSeek-V4.1-Flash-1017`)
  no longer becomes a spurious model.

## [0.3.0] - 2026-10-23

Prices are now fetched, not typed, and the clock decides which column applies.

### Added

- **Live price catalog.** The host half reads <https://api-docs.deepseek.com/quick_start/pricing> through
  `ctx.web.fetch`, parses the model table (cache-miss input, cache read, output; both models), and publishes it on the
  same-origin routes `/dsh-cost-meter/prices` and `/dsh-cost-meter/refresh`. Nothing in the page asks the user to
  retype DeepSeek's numbers any more.
- **Automatic peak/off-peak pricing.** The page resolves the active window from the clock every 30 seconds: peak is
  UTC `01:00–04:00` and `06:00–10:00` on Monday-through-Friday local dates, excluding configured holidays; everything
  else is off-peak at half the peak rate. The pill carries a 峰价/谷价 badge, the panel shows the current period,
  the next boundary and the catalog's age, and both the badge and the unit prices switch without a reload.
- **A settings page in the Settings sidebar.** The form moved from a tab inside the Plugins section to this plugin's
  own `settings.section` entry (`id: cost-meter`, order 46). It now edits the source (`auto` / `builtin` / `manual`),
  the model, the source URL, the refresh cadence, currency and precision, the manual peak prices and off-peak factor,
  and the peak windows / weekday rule / holiday list.
- **Bundled fallback catalog.** Both halves ship the 2026-10-23 table, so a first paint, an offline host, or a
  layout change on the official page still prices correctly; a failed refresh keeps the last good table and reports
  the reason on the settings page instead of zeroing prices.
- `lib/index.js` exports the routes and re-exports the catalog helpers; the parser itself lives in the
  dependency-free `lib/catalog.js`, with `test/catalog.mjs` covering the real table's rowspans, its version row and
  its concurrency row. `test/verify-install.mjs` checks the new defaults and routes.

### Changed

- The `Config` schema now defaults to `source: auto`, `model: deepseek-flash`, `currency: ""` (follow the catalog's
  `$`), and USD peak numbers `0.3 / 0.006 / 0 / 1.2` per million tokens. The four numbers are the **manual peak**
  prices used by `source: manual` and the offline fallback.
- `peakWindows` defaults to empty, meaning "follow the schedule published in the catalog"; a non-empty list
  overrides it with UTC windows. `holidays` takes `YYYY-MM-DD` dates in Beijing time.
- `unit` is accepted for 0.2.x configurations and ignored: prices are per million tokens only.
- The pill now appends the period badge and reads `$` amounts; the panel's title value, bucket rows, and summary
  price the active column, and its meta grid adds period, next boundary, model and rates.
- `README.md` / `README.zh.md` describe the fetched catalog, the peak/off-peak rule, and the new settings location.

### Fixed

- The unconfigured hint points at the real page again: 设置 → 花费金额（估算）.
- The settings page no longer offers a per-thousand unit or a duplicated "save prices" flow, and it validates the
  window strings and the 0–1 off-peak factor before writing.

## [0.2.1] - 2026-10-23

### Added

- **Seeded unit prices.** The schema now defaults to DeepSeek's published `deepseek-flash`
  (DeepSeek-V4.1-Flash) list price, peak hours, CNY per million tokens — cache-miss input `2`, cache hit `0.04`,
  cache write `0`, output `8` — read from <https://api-docs.deepseek.com/quick_start/pricing> on 2026-10-23. A fresh
  install prices the session immediately; off-peak hours are half of that, and zeroing all four still means "not
  configured" and the pill says so.
- The installer's patch row carries no `config:` block any more, so the schema is the single source of those
  defaults (a row that already overrides fields keeps its overrides).

### Fixed

- The pill text uses ui-chat's own metrics again
  (`font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)`, `border-radius: var(--dsw-radius-sm)`),
  instead of inheriting the larger dock text and hardcoding a 24px radius.
- The detail panel renders on the shell's menu surface: it regained
  `backdrop-filter: var(--dsw-menu-backdrop-filter)` and `border-radius: var(--dsw-radius-lg)`, matching the
  shipped stat panels' blur and corner radius.

## [0.2.0] - 2026-10-23

Ported to DeepSeek Harness `0.2.1-rc.2`. `0.1.0` cannot run there: three of the seams it used are gone.

### Changed

- The dock entry is **additive** again: `conversation.composer.dock` is a list slot that renders every
  registration, and 0.2.x split the old `stats` cell into the shipped `activity` (order 0) and `usage` (order 1)
  entries. The spend pill now registers as `{ id: "cost", order: 2 }` and no longer shadows, reproduces, or
  re-renders ui-chat's two pills, their panels, or their formatters (`TimePill`, `UsagePill`, `formatDuration`,
  `formatTokensPerSecond`, `exactCount`, the gauge/database glyphs).
- Prices are read from `ctx.configForms.get("cost-meter")` — the 0.2.x successor of the removed `settingsScope`
  service. The snapshot shape (`status`/`value`/`base`/`user`/`revision`/`writable`) and the `mutate(ops,
  revision)` write path are unchanged, so the price store only had to swap its source.
- The price form moved from `settings.plugin.item` (removed) to one page of the Plugins section,
  `settings.plugins.tab`, registered with `id: "cost-meter"` and the label 花费金额（估算）.
- The host half no longer calls `settings.installSection` (removed). It exports `Config` — which 0.2.x projects
  into its configuration inventory — and turns the generated settings page off with
  `settings.configure({ auto: false })`, because the browser half renders those fields itself.

### Fixed

- The unconfigured-price hint now points at the real page: 设置 → 插件 → 花费金额（估算）.
- Documentation no longer claims prices live in `~/.dsh/settings.yaml`; 0.2.x imports that document once, renames
  it to `settings.yaml.imported`, and keeps configuration in the profile's entry config.
- `install.ps1` installs into the `desktop` profile by default (what the desktop app opens) and no longer promises
  live patch reload, which 0.2.x does not provide for this profile.

## [0.1.0] - 2026-09-10

First release. Verified against DeepSeek Harness `0.1.5-rc.1`.

### Added

- A spend pill in the composer stats line, to the right of the token-usage pill, priced from four per-bucket unit
  prices (cache-miss input, cache read, cache write, output) plus currency symbol, price unit, and decimal places.
- A click-through spend panel showing `tokens × unit price = amount` per bucket, the session total, and — when
  enabled — what cache reads saved against the cache-miss price.
- The `cost-meter` settings namespace and its card under **Settings → Plugins → Plugin configuration**, persisted in
  the `cost-meter:` section of `~/.dsh/settings.yaml`, with reset-to-defaults.
- A host half that registers the namespace through `settings.installSection`, so the plugin still runs on
  composition defaults when no settings provider is mounted.
- `install.ps1`, an idempotent manual installer/uninstaller for machines that cannot install from a registry.

### Notes

- The pill took over ui-chat's `stats` cell (list-slot shadow registration, `priority: -1`), because
  `conversation.composer.dock`'s parent stacks its entries vertically and an additive entry could never sit to the
  right of the token pill. The two shipped pills, their dialogs, and their formatters were reproduced so nothing
  regressed; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Nothing here meters tokens or touches a model request: the numbers are the durable `tokenUsage` projection
  multiplied by prices the user configures.
