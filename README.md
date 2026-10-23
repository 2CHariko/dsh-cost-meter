---
description: "Shows the current session's spend beside the token-usage pill in the DSH Web composer dock, priced from DeepSeek's published price table with automatic peak/off-peak selection."
kind: "package-reference"
---

# dsh-cost-meter

English | [中文](README.zh.md)

Shows **this session's spend** beside the **token-usage pill** in the composer dock, with a breakdown on click.
Prices are **fetched from DeepSeek's two published price pages** — the Chinese page in CNY (the default) and the
English page in USD — by the host half and served to the page on a same-origin route, so a fresh install needs no
price entry at all.

Usage is **billed at the time each request happened**, not at the clock the page is rendered. A host projection folds
every durable usage sample into local-day + peak/off-peak buckets using the request's start time, and the page prices
each day with a **daily price snapshot**; a session that runs from morning into the afternoon therefore shows the
morning tokens at peak and the afternoon tokens at off-peak. Off-peak is half of peak on the official table.

It is a **pure consumer** of `@deepseek-ai/dsh-token-meter`'s event stream: it does not meter anything, never touches
a model request, and never writes the session log. It only multiplies the existing provider usage samples by the unit
prices in force when each request started.

Once installed, that line reads:

```
⬤ 4 turns 68 steps · 191 tok/s   ⬤ 25.7M tok · Cache hit 99%   ⬤ ¥2.277 谷
```

The first two pills are ui-chat's own; the third is this plugin's bill for the usage the session actually recorded.
Its badge stays a single character — `峰` in peak hours, `谷` off-peak — and it opens a detail panel with the peak
and off-peak subtotals, so a mixed session is visible without changing the badge.

## Table of Contents

- [Why the host token accounting needs no change](#why-no-host-change)
- [Install](#install)
- [How prices are resolved](#pricing)
- [Settings](#configure)
- [Uninstall](#uninstall)
- [How it works](#implementation)
- [Compatibility and versioning](#compatibility)
- [Changelog](CHANGELOG.md)
- [Known limitations](#limitations)
- [Development](#development)
- [Verification status](#verification)
- [License](#license)

-----

<a id="why-no-host-change"></a>
## Why the host token accounting needs no change

The DSH dock line is rendered by two independent entries in the **list** slot `conversation.composer.dock` from
`@deepseek-ai/dsh-client-ui-chat`, and both only read host projections:

| On screen | Source |
|---|---|
| `4 turns 68 steps`, `191 tok/s` | the `sessionStats` projection (whole-log fold, `dsh-session-stats`) |
| `25.7M tok`, `cache hit 99%` | the `tokenUsage` projection (`dsh-token-meter`) |

The `tokenUsage` wire value is exactly four **disjoint** billing buckets:

```
{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
```

where `uncachedInputTokens = usage.inputTokens` (cache-miss prompt input) and cache read/write stay separate. So
spend is one multiply-add:

```
cost = (uncached·P_in + cacheRead·P_read + cacheWrite·P_write + output·P_out) / price denominator
```

`dsh-llm`'s model metadata (`LlmModelInfo`) carries **no price field at all**, and neither `llm-pi-ai` nor a
router catalog supplies prices — which is why the host half reads DeepSeek's published table itself. The clock no
longer selects one column for the whole session: each durable usage sample is folded into a day + period bucket by
its **request start** time, and the page sums `peak usage × peak price + off-peak usage × off-peak price` per day,
using the daily snapshot that was in force then.

<a id="install"></a>
## Install

Pick **one** of the two paths, do not mix them: `dsh plugin add` goes through pnpm, and any later
`pnpm install` prunes a manually copied directory as an extraneous package.

The examples use the `desktop` profile — the one the desktop app opens by default. Pass `--profile web` (or
`-Profile web`) if you run the browser-only `dsh web` profile instead.

### A. Official path (pnpm / GitHub)

```powershell
dsh plugin --profile desktop add github:2CHariko/dsh-cost-meter
```

That forwards to pnpm inside the profile directory, so `$DSH_HOME\profiles\desktop\package.json` gains a
dependency and the package (plus its `@deepseek-ai/schemastery` dependency) lands under that profile's
`node_modules`, where the loader resolves it from.

Installing the package does not compose it — pnpm never edits the composition. Append this block to
`$DSH_HOME\profiles\desktop\cordis.patch.yml`:

```yaml
# >>> dsh-cost-meter
- insert:
    - id: cost-meter
      name: dsh-cost-meter
# <<< dsh-cost-meter
```

That is the whole row: the schema defaults (`source: auto`, `model: deepseek-flash`, USD from the official table)
are the starting point, and the settings page writes any change into this entry's config. A `config:` block is
optional — an existing 0.2.x row that still carries the old four prices keeps loading, and those numbers become the
manual-price fallback.

### B. Offline / scripted path

```powershell
pwsh -File install.ps1                 # desktop profile by default
pwsh -File install.ps1 -Profile web    # browser-only profile
```

For a machine with no npm network, or to install straight from a checkout. The script does two things, both
idempotent:

1. copies the package to `$DSH_HOME\profiles\<profile>\node_modules\dsh-cost-meter` (the profile directory is
   the anchor the loader resolves bare specifiers from, and the profile's own `node_modules` is the first stop);
2. inserts the `- insert:` block above into `$DSH_HOME\profiles\<profile>\cordis.patch.yml`, backing the file up
   to `cordis.patch.yml.bak-<timestamp>` first.

### Common to both paths

DSH 0.2.x reads the profile patch document at boot. **Restart the application** once after installing (only some
profiles opt into live config reload), then **refresh the Web page** so it fetches the new client bundle.

### Verify

```powershell
# 1. Is the row in the composed tree? (no warning, and "- id: cost-meter" present, means yes)
dsh --profile desktop --dump-config | Select-String cost-meter
# 2. Can the profile resolve both halves, import the host half, and validate the row config?
node test\verify-install.mjs --profile desktop
```

<a id="pricing"></a>
## How prices are resolved

The host half reads both official pages — <https://api-docs.deepseek.com/zh-cn/quick_start/pricing> (CNY) and
<https://api-docs.deepseek.com/quick_start/pricing> (USD) — parses each model table, and publishes both on
`/dsh-cost-meter/prices` for the page. Prices are per million tokens, 2026-10-23; **CNY is the default**:

| Model | Bucket | CNY peak | CNY off-peak | USD peak | USD off-peak |
|---|---|---|---|---|---|
| `deepseek-flash` (V4.1-Flash) | cache hit (缓存读取) | `¥0.04` | `¥0.02` | `$0.006` | `$0.003` |
| | cache miss (未命中输入) | `¥2` | `¥1` | `$0.30` | `$0.15` |
| | output (输出) | `¥8` | `¥4` | `$1.20` | `$0.60` |
| `deepseek-v4-pro` | cache hit | `¥0.30` | `¥0.15` | `$0.044` | `$0.022` |
| | cache miss | `¥9` | `¥4.5` | `$1.32` | `$0.66` |
| | output | `¥27` | `¥13.5` | `$3.96` | `$1.98` |

Cache write is not billed on DeepSeek and stays 0.

**Peak hours** are `01:00–04:00` and `06:00–10:00` UTC, Monday through Friday, excluding Chinese public holidays —
09:00–12:00 and 14:00–18:00 Beijing time (the Chinese page states them in Beijing time; the parser converts them to
UTC). Every other instant is off-peak, including weekends and holidays, and costs half. Each request is classified by
the instant it **started**, so crossing a boundary mid-generation does not reprice it. The dock badge keeps its
single-character form (`峰` / `谷`) for the current period; the panel's peak/off-peak rows carry the historical split.

**Daily price snapshots.** From 0.5.0 on, each successful refresh writes/updates one snapshot for the current Beijing
date under `~/.dsh/cost-meter-prices`. The route sends a compact change list (one entry per price change), and the page
prices each day with the snapshot in force on that date. Editing peak windows, weekdays, or holidays disposes and
re-registers the projection, so history is reclassified with the new rule; changing the currency or model does not
refold anything.

The same tables ship **bundled** in both halves, so a first paint — or a host that cannot reach a page — still
prices correctly; the last good table per currency survives a failed refresh, and the settings page shows why the
refresh failed and which currency it affected. If a page layout changes and no priced model can be parsed, the host
keeps the previous table instead of zeroing prices.

<a id="configure"></a>
## Settings

**Settings → 花费金额（估算）** — this plugin's own page in the Settings sidebar, beside General and Models.

| Field | Meaning |
|---|---|
| 价格来源 (source) | `自动` uses the fetched official tables, `内置价目` uses the bundled copies without network, `手动价格` uses your four peak numbers |
| 计价模型 (model) | which catalog model to price (`deepseek-flash` or `deepseek-v4-pro`) |
| 计价币种 (currency) | `人民币（¥）` is the default and prices from the Chinese page; `美元（$）` uses the English page. No exchange-rate conversion |
| 人民币价目地址 / 美元价目地址 | the CNY and USD pages or JSON endpoints fetched in auto mode; a JSON body with the same `{ code, currency, models }` shape is accepted |
| 自动刷新间隔 (refresh minutes) | host refresh cadence, 0–1440; 0 refreshes only when the page asks |
| 金额小数位 (decimals) | 0–6, default 3 |
| 同时显示缓存省下 | adds a counterfactual saving row (`cacheRead × (P_in − P_read)`) |
| 手动峰价 (manual peak prices) | cache-miss input, cache read, cache write, output per million tokens, denominated in the selected currency; used only in manual mode |
| 谷价折扣系数 (off-peak factor) | manual mode's off-peak multiplier, default `0.5` |
| 高峰时段 (UTC) | empty follows the published schedule; otherwise comma-separated `HH:MM-HH:MM` windows |
| 高峰仅限工作日 | whether windows apply Monday through Friday only |
| 节假日 (Beijing dates) | `YYYY-MM-DD` list billed at off-peak all day, e.g. `2026-10-01` |

The page shows the current period, the next boundary, the freshness of **both** catalogs (and any per-currency
failure), and a refresh button. Saving goes through the 0.2.x `configForms` controller into the profile's
`cost-meter` entry config; "重置为默认" unsets every overridden field. Nothing is written into
`~/.dsh/settings.yaml` — DSH 0.2.x imports that legacy document once, renames it, and keeps configuration in the
profile.

**In manual mode with all four prices at 0 the pill reads "花费未配置"** with a hover hint pointing at the settings
page, rather than inventing an amount. Auto and builtin modes always resolve real prices.

<a id="uninstall"></a>
## Uninstall

```powershell
# A. official path
dsh plugin --profile desktop remove dsh-cost-meter
# B. scripted path (also removes the marked block and the package directory)
pwsh -File install.ps1 -Uninstall
```

Either way, **delete the marked block from the patch file by hand**, then restart and refresh. Removing that block
composes the dock without this entry again, so only ui-chat's own pills remain.

<a id="implementation"></a>
## How it works

| Path | Role |
|---|---|
| `lib/index.js` | the host half: exports the `Config` schema, turns the generated settings page off (`auto: false`), fetches both official tables, registers the `costMeterUsageByDay` projection, records daily price snapshots, and serves `/dsh-cost-meter/prices` + `/dsh-cost-meter/refresh` on the Web server |
| `lib/catalog.js` | dependency-free price-table parser (HTML rows, markdown projection, or a JSON catalog), the CNY/USD symbol and schedule detection, and the bundled seed tables |
| `lib/period-usage.js` | pure fold from durable usage events to local-day + peak/off-peak buckets, with request-start classification and token-meter's replacement/retry rules |
| `lib/history.js` | daily snapshot files under `~/.dsh/cost-meter-prices` and their compression into a price-change list |
| `lib/client.js` | the hand-written lazy-CJS client bundle: one additive dock pill, the historical peak/off-peak + price-version resolver, and this plugin's settings page |
| `test/catalog.mjs` | feeds the parser both synthetic pages (rowspans, a version row, a concurrency row, Beijing-time prose) and asserts each keeps exactly the header models in its own currency |
| `test/period-usage.mjs` | folds synthetic events across the peak boundary, retries, streamed attempts, holidays, and local days |
| `test/history.mjs` | asserts daily snapshots collapse to price-change points, inherit a missing currency, and update the current day in place |
| `test/smoke.mjs` | drives the real `window.__ModuleLoader__` envelope as a smoke test (React is shimmed, because the deployment only installs a prebuilt frontend) |
| `test/verify-install.mjs` | reproduces the loader's resolution after install: both halves resolve, the host half imports, the row config passes the schema |

Why the client bundle is hand-written: `@deepseek-ai/dsh-client-modules` serves every package that declares
`dsh.client` as its `lib/client.js` verbatim and evaluates it in the page, while the build preset that normally
emits that envelope (`packages/client/tsdown.client.ts`) is not a published package — so a plugin living outside
the DSH checkout writes the envelope itself. The factory may `require` the shell's platform seed table:
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-dockkit`. All of those are baseline
requests, so `dsh.client.external` declares nothing.

The two registration points (both checked against the live slot protocol, which DSH serves to the page in its
slot catalog):

```
conversation.composer.dock   list, session  → ADDITIVE entry { id: "cost", order: 2 }, after ui-chat's
                                              "activity" (0) and "usage" (1) entries
settings.section             list, root     → this plugin's own page in the Settings sidebar, id "cost-meter",
                                              order 46, label 花费金额（估算）
```

Prices are read in two layers: the catalog from the host route (a small polling store, refreshed on load and on
demand), and the configuration from the 0.2.x client service `ctx.configForms.get("cost-meter")` — the successor of
the removed `settingsScope` service — subscribed with uSES and written with `mutate(ops, revision)`. `tokenUsage`
arrives through the session-scoped slot's standard `useProjection` prop. Both re-render immediately, so **saving
settings needs no refresh**.

Every `Config` field is marked `.volatile()`, which is load-bearing rather than cosmetic: DSH's settings projection
(`volatileForm`) describes **only** entries that have at least one volatile field, and hands the plugin live
references (`{ get() }`) instead of plain values. Without that marking the entry never appears in
`settings.describe()`, `configForms` stays empty, and every control on this page is permanently disabled. The host
therefore reads its own fields through a `currentConfig()` helper on each request and on a one-minute tick, so a
saved change applies without remounting; a successful save also asks the host to refresh the catalogs immediately.

### Why the pill is additive

0.1.5 shipped one `stats` cell holding both pills, and shadowing it with a lower `priority` was the only way to
land to the right of the token pill. 0.2.x split that cell into the `activity` and `usage` entries, and a list
slot renders **every** registration, so there is nothing to shadow: a fresh id with a higher `order` simply lands
beside them. That is why this version no longer reproduces ui-chat's two pills, their panels, or their formatters.

The price of being additive is that upstream changes to those two pills show up on their own — which is what you
want — while the spend pill keeps its own copy of the three-column detail panel geometry (still derived from
ui-chat's `stat-dialog`; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

Panel placement and dismissal reuse the platform seed's `useAnchoredPosition` / `useDismissOnOutsidePointer`
(with a local fallback when that export is missing). The panel's copy comes from this package; the numeric parts
that need localized digits come from the deployment's own `chat` dictionary through `ctx.get("locale").bind("chat")`,
with a bundled Chinese copy as the fallback when no locale service is mounted.

The entry is wrapped in a `RowErrorBoundary`: if the styled pill throws, it degrades to a plain priced chip, so
the dock can never lose the spend reading entirely.

<a id="compatibility"></a>
## Compatibility and versioning

This plugin's version is **independent** of DSH's, but it depends on DSH slot protocols, client service names,
and projection keys that are not stable APIs.

| dsh-cost-meter | DSH verified against | Notes |
|---|---|---|
| `0.5.2` | `0.2.1-rc.2` | repository moved to `2CHariko/dsh-cost-meter`; docs and package metadata updated (no behavior change) |
| `0.5.1` | `0.2.1-rc.2` | dock badge restored to one character (`峰` / `谷`) for the current period; the panel keeps the historical peak/off-peak split |
| `0.5.0` | `0.2.1-rc.2` | usage billed by request start, split into day + peak/off-peak buckets by a host projection; daily price snapshots under `~/.dsh/cost-meter-prices` |
| `0.4.1` | `0.2.1-rc.2` | settings page became writable: every `Config` field is now `.volatile()`, so `settings.describe()` serves the entry and `configForms` stops being empty; host reads the live references |
| `0.4.0` | `0.2.1-rc.2` | CNY table from the Chinese page is the default, USD from the English page is one switch away; both fetched and published together, Beijing-time windows converted to UTC |
| `0.3.0` | `0.2.1-rc.2` | dynamic official price table over same-origin routes, automatic peak/off-peak pricing (UTC windows, weekdays, holidays), own `settings.section` page in the Settings sidebar |
| `0.2.1` | `0.2.1-rc.2` | seeded DeepSeek defaults (schema-only, no row `config:`), pill metrics and the panel's blur/radius aligned with the shipped stat UI |
| `0.2.0` | `0.2.1-rc.2` | ported to the 0.2.x contract: additive dock entry, `settings.plugins.tab` form, `configForms` instead of `settingsScope`, `Config` + `auto: false` instead of `settings.installSection` |
| `0.1.0` | `0.1.5-rc.1` | first release; took over the `stats` cell and read prices through `settingsScope` |

`peerDependencies` carries that range (`@deepseek-ai/dsh-settings@^0.2.1-rc.2`, `@deepseek-ai/cordis@^4.0.2`), so a
mismatch is visible at install time.

How the version moves:

- **PATCH** — documentation, comments, internal tidying; no behaviour change.
- **MINOR** — a new configuration field or new displayed content; existing configuration keeps working.
- **MAJOR** — anything that requires a **different DSH version**: a changed slot protocol, a renamed projection
  key, a renamed client service. Those do not make the plugin error out; they make the pill silently disappear,
  which is exactly why they must be signalled as MAJOR.

`0.2.0` is not a stable release: the slot ids, the `configForms` service, and the settings-page policy are 0.2.x
contracts and can move again. After upgrading DSH, re-run both commands under [Verify](#verify). Per-release notes
are in [CHANGELOG.md](CHANGELOG.md).

<a id="limitations"></a>
## Known limitations

- **The session-level aggregate has no route dimension**: a session that switched provider/model mid-way bills every
  token at the model selected in settings. A single-route session is unaffected; exact pricing would need a per-route
  bucket in the projection.
- **Historical prices start with this version**: daily snapshots begin on the day 0.5.0 first refreshes. Usage before
  the first snapshot has no historical table and is priced with the current one; the panel reports how many days that
  affects. Snapshot granularity is one Beijing day, so an intra-day price change is reflected once observed.
- **Only provider-reported usage counts**: a step that was interrupted or reported no usage is not billed here, so
  this is a ledger estimate rather than a reconciliation against an invoice.
- **`cacheWriteTokens` means different things per provider**: always 0 on DeepSeek, while Anthropic-style cache
  writes are a separate premium tier that needs its own price.
- **No configuration surface when the page cannot reach the host settings API**: the form then says so and the
  pill keeps pricing the composition entry.
- **Upgrading DSH leaves this package alone**: it lives in the profile, not in the DSH install directory — but if
  the 0.2.x slot/service APIs move, `lib/client.js` must move with them.
- **The price tables come from two public pages**: when DeepSeek changes a layout, the parser may stop finding that
  table. The host then keeps the last good catalog for that currency (or the bundled one) and the settings page
  shows the parse error; set a JSON price URL in the matching address field to bypass HTML parsing entirely.
- **CNY and USD are separate published tables, not a converted rate**: switching the currency changes which table
  and symbol are used; the plugin never applies an exchange rate.
- **No holiday calendar is fetched**: weekends are automatic, but Chinese public holidays must be listed in the
  settings page to be billed at off-peak. The list is a plain date list, so it never goes stale silently.
- **The host reports live packages**: DSH sends `{name, version}` of every live loader package with each official
  API request for diagnostics, so `name`/`version` in `package.json` must be real and non-empty (malformed package
  metadata fails request preparation outright).

<a id="development"></a>
## Development

```powershell
npm run check        # node --check all three modules
npm test             # parser + period fold + price history + client bundle (registration, historical pricing, catalog store, settings page, every fallback)
npm run test:install -- --profile desktop   # after install: both halves resolve, host half imports, row config passes
```

`catalog.mjs` covers both pages' actual shape: two header columns, a version row whose values start with `DeepSeek-`,
a concurrency row of bare numbers, rowspan-split period rows, `元`-suffixed prices, the Chinese prose that states the
schedule in Beijing time (converted to UTC), the English `UTC` sentence, a JSON source, and a markdown projection.
It exists because a naive scan reads the concurrency limit as a third model's prices.

`smoke.mjs` covers: the bundle envelope and export surface, the additive dock registration's id/order (and that no
shadowing priority is declared), the `settings.section` page's id/order/label, the peak/hour/window/holiday resolver
against fixed instants, model selection, manual-price fallback, four-bucket cost arithmetic, the catalog store's
host round-trip and its keep-the-last-good-table failure path, the priced pill's period badge, the detail panel's
meta and rate rows, an empty session rendering nothing, a missing projection seat rendering nothing, the
error-boundary fallback, the settings page seeding from the snapshot, the `mutate(ops, revision)` write path, and
degraded rendering with `react-dom`/`primitives` absent.
`verify-install.mjs` reproduces the loader's resolution (`createRequire` anchored at the profile manifest, matching
`cordis-plugin-loader`, which uses the profile directory as `parentURL`), confirms that `dsh-cost-meter`,
`dsh-cost-meter/client`, and `@deepseek-ai/schemastery` all resolve from the profile, and asserts that a row without
overrides resolves to the auto source with the bundled flash prices.

### Three easy traps (all handled in code)

- **A new row in `cordis.patch.yml` must be wrapped in `- insert:`.** A bare `- id: x` is a *patch* targeting an
  existing row of that id; when none exists it only prints `patch: entry "x" not found` and skips — silently
  ineffective. The semantics come from `applyEntryPatches` in `dsh-app-boot`.
- **Emptying the patch file leaves `null`.** A file with only comments parses as `null`, not as an empty list, so
  `-Uninstall` restores the `[]` sentinel when it finds the document has no entries left.
- **A dock entry's `id` is its cell key.** Reusing a shipped id (`activity`, `usage`) puts you in *that* cell and
  replaces it; a fresh id (`cost`) is added beside it. Keeping the id distinct is what makes this plugin additive.

<a id="verification"></a>
## Verification status

Verified locally against DSH `0.2.1-rc.2`:

- the row reaches the composed tree (`cost-meter` under the user patch layer, no warning);
- the profile resolves both halves and imports the host half (`apply` / `Config` / the namespace constant are all
  present), and the row config passes the schema;
- the host route answers a live parse of both official pages, and each parsed catalog carries both models with their
  peak and off-peak columns (CNY `¥2 / ¥0.04 / ¥8` for flash peak, USD `$0.3 / $0.006 / $1.2`);
- a live session's `costMeterUsageByDay` projection folds real events into both periods, and its four buckets sum
  **exactly** to that session's `tokenUsage` (so the split never loses or double-counts tokens);
  `/dsh-cost-meter/refresh` writes today's snapshot under `~/.dsh/cost-meter-prices` and publishes it as one
  price-change entry;
- `/dsh-cost-meter/refresh` reports `settingsServed: true`, so DSH's settings projection describes this entry and the
  page's form is writable rather than permanently disabled;
- the live page registers this plugin's Settings section (`cost-meter`, order 46) and keeps the additive dock entry
  (`cost`, order 2) beside the shipped `activity` and `usage` pills;
- the smoke test is green (registration, historical per-day pricing, peak/off-peak resolution, catalog store, priced
  pill, settings page, every fallback state);
- the installed `lib/client.js` and `lib/index.js` are **byte-identical** to the versions in this repository that
  passed the smoke test (SHA256 comparison).

Not verified (needs a browser session): that the running page draws the pill after the shipped two, that its panel
opens, and that the Settings sidebar page saves through the host. If the dock looks wrong after a restart and
refresh, roll back by deleting the marked block as described under [Uninstall](#uninstall).

<a id="license"></a>
## License

MIT, Copyright (c) 2026 2CHariko. See [LICENSE](LICENSE).

This package reproduces presentation code from `@deepseek-ai/dsh-client-ui-chat` (also MIT); the provenance and
notice are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
