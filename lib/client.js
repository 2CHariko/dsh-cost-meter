/**
 * Browser half of the cost meter, written directly in the client-modules
 * lazy-CJS envelope (`window.__ModuleLoader__.load({ id, factory })`).
 *
 * DSH 0.2.x surfaces this half targets:
 *   - `conversation.composer.dock` (list, session scope): one ADDITIVE entry,
 *     `{ id: "cost", order: 2 }`, rendered after the shipped `activity` (order 0)
 *     and `usage` (order 1) pills.
 *   - `settings.section` (list, root scope): this plugin's own page in the
 *     Settings sidebar, `{ id: "cost-meter", order: 46 }`.
 *
 * Prices are no longer typed by hand unless the user asks for that. The host
 * half fetches DeepSeek's published price table and serves it on
 * `/dsh-cost-meter/prices`; this half keeps that catalog in a small store,
 * refreshes it on load and on demand, and derives the *effective* unit prices
 * from the clock: peak hours (UTC 01:00-04:00 and 06:00-10:00, Monday through
 * Friday, Chinese public holidays excluded) use the peak column, everything
 * else uses the off-peak column, which the page publishes at half the peak rate.
 *
 * The resolved period, its next boundary, the catalog age, and the per-bucket
 * prices all render from one pure function (`resolvePricing`), so the pill, the
 * detail panel, and the settings page cannot disagree.
 *
 * Token buckets come from the `tokenUsage` projection (whole durable log,
 * provider-reported, four disjoint buckets) through the slot's standard
 * `useProjection` seat.
 */
window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** The shell's platform seed answers `react`; tolerate either interop shape. */
		const reactSeed = require("react");
		const React = reactSeed.createElement === undefined ? reactSeed.default : reactSeed;

		/** Optional seed members: a missing export must never break the stats row. */
		const optional = (request) => {
			try {
				return require(request);
			} catch (error) {
				console.warn(`[dsh-cost-meter] optional platform module ${request} unavailable`, error);
				return undefined;
			}
		};
		const reactDomSeed = optional("react-dom");
		const createPortal = reactDomSeed !== undefined && typeof reactDomSeed.createPortal === "function" ? reactDomSeed.createPortal : undefined;
		const primitives = optional("@deepseek-ai/dsh-client-ui-primitives");
		const anchoredPosition = primitives !== undefined && typeof primitives.useAnchoredPosition === "function" ? primitives.useAnchoredPosition : undefined;
		const outsidePointer = primitives !== undefined && typeof primitives.useDismissOnOutsidePointer === "function" ? primitives.useDismissOnOutsidePointer : undefined;

		/** Settings namespace owned by this package's host half. */
		const NS = "cost-meter";

		/** Same-origin catalog routes published by the host half. */
		const PRICES_ROUTE = "/dsh-cost-meter/prices";
		const REFRESH_ROUTE = "/dsh-cost-meter/refresh";
		/** Host projection that folds usage into local day + peak/off-peak buckets. */
		const PROJECTION_KEY = "costMeterUsageByDay";

		/** How often the page re-reads the host catalog. */
		const FEED_POLL_MS = 5 * 60 * 1000;
		/** How often the clock-derived period is recomputed while the page is open. */
		const CLOCK_TICK_MS = 30 * 1000;

		/**
		 * Composition-free defaults, mirroring the host schema exactly.
		 *
		 * The four manual numbers are DeepSeek's `deepseek-flash` **peak** list
		 * price in CNY per million tokens (the Chinese page, 2026-10-23);
		 * `source: "auto"` prefers the fetched catalogs instead, so these are both
		 * the offline fallback and the starting point of manual mode. Manual
		 * numbers are denominated in the selected `currency`.
		 */
		const DEFAULTS = Object.freeze({
			source: "auto",
			model: "deepseek-flash",
			sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
			usdSourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
			currency: "CNY",
			decimals: 3,
			showSavings: true,
			refreshMinutes: 360,
			input: 2,
			cacheRead: 0.04,
			cacheWrite: 0,
			output: 8,
			offPeakFactor: 0.5,
			peakWindows: [],
			weekdaysOnly: true,
			holidays: []
		});

		/** Bundled mirror of the host seed catalogs; keeps the first paint honest. */
		const BUILTIN_CATALOGS = Object.freeze({
			CNY: {
				code: "CNY",
				currency: "¥",
				models: [
					{
						id: "deepseek-flash",
						label: "deepseek-flash · V4.1-Flash",
						peak: { cacheRead: 0.04, input: 2, cacheWrite: 0, output: 8 },
						offPeak: { cacheRead: 0.02, input: 1, cacheWrite: 0, output: 4 }
					},
					{
						id: "deepseek-v4-pro",
						label: "deepseek-v4-pro · V4-Pro",
						peak: { cacheRead: 0.3, input: 9, cacheWrite: 0, output: 27 },
						offPeak: { cacheRead: 0.15, input: 4.5, cacheWrite: 0, output: 13.5 }
					}
				],
				schedule: { peakWindows: ["01:00-04:00", "06:00-10:00"], weekdaysOnly: true, offsetMinutes: 480 }
			},
			USD: {
				code: "USD",
				currency: "$",
				models: [
					{
						id: "deepseek-flash",
						label: "deepseek-flash · V4.1-Flash",
						peak: { cacheRead: 0.006, input: 0.3, cacheWrite: 0, output: 1.2 },
						offPeak: { cacheRead: 0.003, input: 0.15, cacheWrite: 0, output: 0.6 }
					},
					{
						id: "deepseek-v4-pro",
						label: "deepseek-v4-pro · V4-Pro",
						peak: { cacheRead: 0.044, input: 1.32, cacheWrite: 0, output: 3.96 },
						offPeak: { cacheRead: 0.022, input: 0.66, cacheWrite: 0, output: 1.98 }
					}
				],
				schedule: { peakWindows: ["01:00-04:00", "06:00-10:00"], weekdaysOnly: true, offsetMinutes: 480 }
			}
		});

		/** Snapshot published while no settings transport has answered yet. */
		const UNAVAILABLE = Object.freeze({
			status: "unavailable",
			value: undefined,
			base: undefined,
			user: undefined,
			revision: undefined,
			writable: false,
			mode: "memory"
		});

		/** Numeric manual price fields, in the order the form shows them. */
		const PRICE_FIELDS = ["input", "cacheRead", "cacheWrite", "output"];

		/** Field labels for the price form. */
		const LABELS = Object.freeze({
			input: "未命中输入",
			cacheRead: "缓存读取",
			cacheWrite: "缓存写入",
			output: "输出",
			currency: "计价币种",
			decimals: "金额小数位",
			showSavings: "同时显示缓存省下的金额",
			source: "价格来源",
			model: "计价模型",
			sourceUrl: "人民币价目地址",
			usdSourceUrl: "美元价目地址",
			refreshMinutes: "自动刷新间隔（分钟）",
			offPeakFactor: "谷价折扣系数",
			peakWindows: "高峰时段（UTC）",
			weekdaysOnly: "高峰仅限工作日",
			holidays: "节假日（北京时间）"
		});

		/**
		 * This package's own copy. The two ported pills use the deployment's
		 * `chat` locale namespace instead (see `chatCopy`), so their wording
		 * follows the active language exactly as the shipped row did; these keys
		 * cover only the spend pill, its panel, and the settings page.
		 */
		const COPY = Object.freeze({
			"cost.title": "本会话花费",
			"cost.total": "合计",
			"cost.saved": "缓存省下",
			"cost.unconfigured": "花费未配置",
			"cost.none": "—",
			"cost.peak": "峰价",
			"cost.offPeak": "谷价",
			"cost.peakShort": "峰",
			"cost.offPeakShort": "谷",
			"cost.mixed": "混合",
			"cost.peakUsage": "峰时用量",
			"cost.offPeakUsage": "谷时用量",
			"cost.historyNote": "按每次请求发生时的峰/谷价累计",
			"cost.estimateNote": "历史时段投影不可用，按当前时段估算",
			"cost.historyFrom": "历史价目自 {date} 起",
			"cost.uncoveredDays": "其中 {days} 天的用量早于首个价目快照，暂按当前价估算",
			"cost.currentRate": "当前单价",
			"cost.snapshots": "已保存 {count} 个价目版本",
			"cost.projectionMissing": "历史时段投影未注册",
			"cost.priceHistory": "价目快照",
			"cost.priceHistoryValue": "{count} 个价目版本 · 自 {from} 起",
			"cost.historyEnabled": "已注册（按请求时段累计）",
			"cost.historyDisabled": "未注册（按当前价估算）",
			"cost.historyUsage": "历史计价",
			"cost.peakShort": "峰",
			"cost.offPeakShort": "谷",
			"cost.period": "时段",
			"cost.nextSwitch": "下次切换",
			"cost.model": "计价模型",
			"cost.rates": "单价（每百万 token）",
			"cost.ratesValue": "未命中 {input} · 缓存 {read} · 输出 {output}",
			"cost.source": "价格来源",
			"cost.sourceLive": "DeepSeek 官方价目",
			"cost.sourceBuiltin": "内置价目",
			"cost.sourceManual": "手动价格",
			"cost.currencyCNY": "人民币（¥）",
			"cost.currencyUSD": "美元（$）",
			"cost.cnyShort": "人民币",
			"cost.usdShort": "美元",
			"cost.catalogCNY": "人民币价目",
			"cost.catalogUSD": "美元价目",
			"cost.fetchedAgo": "{when}更新",
			"cost.refresh": "刷新",
			"cost.refreshing": "刷新中…",
			"cost.localTime": "北京时间 {clock}",
			"cost.switchAt": "{clock} 转{next}（{remaining}后）",
			"cost.switchUnknown": "8 天内不切换",
			"cost.remainingMinutes": "{minutes} 分钟",
			"cost.remainingHours": "{hours} 小时 {minutes} 分",
			"cost.justNow": "刚刚",
			"cost.minutesAgo": "{minutes} 分钟前",
			"cost.hoursAgo": "{hours} 小时前",
			"cost.daysAgo": "{days} 天前",
			"cost.hint": "尚未取到价目：设置 → 花费金额",
			"cost.pageTitle": "花费金额（估算）",
			"cost.pageDescription": "按每次请求发生时的峰/谷价、以及当日价目快照分别计价，乘的是本会话整本日志里 provider 上报的用量（不受分页与压缩影响）。价目从 DeepSeek 官方页面自动获取（中文页人民币、英文页美元，默认人民币），自本版本起每天保存一份快照。",
			"cost.statusPeriod": "当前时段",
			"cost.statusNext": "下次切换",
			"cost.statusCatalog": "价目状态",
			"cost.statusModel": "计价模型",
			"cost.catalogLive": "官方价目 · {when}更新",
			"cost.catalogBuiltin": "内置价目（未联网，点刷新重试）",
			"cost.catalogError": "刷新失败：{message}",
			"cost.catalogLoading": "正在获取价目…",
			"cost.catalogStale": "官方价目（尚未记录更新时间）",
			"cost.cardUnavailable": "Host 没有把本条目投影成可写的设置表单（或当前页面不是通过 loopback 打开），单价只能随组合配置生效；请重启 Harness 后再打开本页。",
			"cost.cardPreview": "示例：1M 未命中输入 + 5M 缓存读取 + 100k 输出 = {amount}（{period}）",
			"cost.cardPreviewBare": "四个手动峰价都还是 0；切到「自动」或填入价格后底部才会显示花费。",
			"cost.synced": "已与设置同步",
			"cost.dirty": "有未保存的修改",
			"cost.save": "保存",
			"cost.saving": "保存中…",
			"cost.discard": "放弃修改",
			"cost.reset": "重置为默认",
			"cost.scopeUnavailable": "设置作用域不可用，无法保存单价",
			"cost.invalidPrice": "「{field}」需要一个不小于 0 的数字",
			"cost.invalidDecimals": "「{field}」需要 0 到 6 之间的整数",
			"cost.invalidFactor": "「{field}」需要 0 到 1 之间的数字",
			"cost.invalidWindow": "「{field}」需要形如 01:00-04:00 的时段，多个用逗号分隔",
			"cost.invalidHoliday": "「{field}」需要形如 2026-10-01 的日期，多个用逗号分隔",
			"cost.sectionManual": "手动峰价",
			"cost.sectionSchedule": "峰谷时段",
			"cost.sectionCatalog": "价目",
			"cost.autoFollow": "留空跟随官方价目",
			"cost.manualHint": "仅在「手动价格」来源下生效，金额按所选币种；谷价 = 峰价 × 折扣系数。",
			"cost.scheduleHint": "UTC 时段，例如 01:00-04:00；留空则跟随价目里公布的时段。",
			"cost.holidayHint": "例如 2026-10-01，多个用逗号分隔；这些日期全天按谷价。",
			"cost.unitMillion": "百万"
		});

		/** Fill `{name}` placeholders; unknown placeholders stay literal. */
		function interpolate(text, params) {
			if (params === undefined) return text;
			return text.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, key) => (params[key] === undefined ? whole : String(params[key])));
		}

		/** This package's own translate seat. */
		function tr(key, params) {
			const text = COPY[key];
			return text === undefined ? key : interpolate(text, params);
		}

		/**
		 * Simplified-Chinese fallback for the ported copy, used only when the
		 * deployment mounts no locale service. Keys and text mirror ui-chat's own
		 * `chat` dictionary plus the shared `common` number templates its lookup
		 * chain would otherwise supply.
		 */
		const CHAT_FALLBACK = Object.freeze({
			"number.groupSeparator": ",",
			"number.thousand": "{value}K",
			"number.million": "{value}M",
			"duration.compactSeconds": "{seconds}秒",
			"duration.compactMinutes": "{minutes}分{seconds}秒",
			"stats.counts": "{turns} 轮 {steps} 步",
			"stats.cacheHit": "缓存命中 {percent}%",
			"stats.dialog.title": "会话统计",
			"stats.dialog.usageTitle": "Token 用量",
			"stats.dialog.llmTime": "模型用时",
			"stats.dialog.toolTime": "工具调用用时",
			"stats.dialog.ttft": "首 token 平均（TTFT）",
			"stats.dialog.speed": "输出速度（TPS）",
			"message.tokensPerSecond": "{tps} tok/s",
			"message.turnUsage.cacheHit": "缓存命中",
			"message.turnUsage.input": "未缓存输入",
			"message.turnUsage.cacheRead": "缓存读取",
			"message.turnUsage.cacheWrite": "缓存写入",
			"message.turnUsage.output": "输出",
			"message.turnUsage.count": "{count} tok"
		});

		function chatFallback(key, params) {
			const text = CHAT_FALLBACK[key];
			return text === undefined ? key : interpolate(text, params);
		}

		/**
		 * Bind the ported pills to the deployment's `chat` namespace so the
		 * reproduced row speaks the active language the shipped one did. Falls
		 * back to the bundled Chinese copy when the locale feature is absent or
		 * refuses the bind.
		 */
		function chatCopy(ctx) {
			const locale = ctx.get("locale");
			if (locale !== undefined && locale !== null && typeof locale.bind === "function") {
				try {
					return locale.bind("chat");
				} catch (error) {
					console.warn("[dsh-cost-meter] chat locale namespace unavailable; using bundled copy", error);
				}
			}
			return chatFallback;
		}

		const CSS = [
			// ── the dock pill (geometry copied verbatim from ui-chat StatsPills) ──
			".dsh-cost-meter-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}",
			".dsh-cost-meter-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}",
			".dsh-cost-meter-pill svg{flex:none;width:14px;height:14px}",
			"button.dsh-cost-meter-pill{cursor:pointer}",
			"button.dsh-cost-meter-pill:hover,button.dsh-cost-meter-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			"button.dsh-cost-meter-pill[data-unconfigured=true]{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-cost-meter-pillLabel{text-overflow:ellipsis;min-width:0;overflow:hidden}",
			".dsh-cost-meter-badge{flex:none;border-radius:4px;padding:0 4px;font-size:10px;line-height:14px;letter-spacing:.02em;border:.5px solid currentColor;opacity:.9}",
			".dsh-cost-meter-badge[data-period=peak]{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-cost-meter-badge[data-period=offPeak]{color:var(--dsw-alias-state-success-primary)}",
			".dsh-cost-meter-badge[data-period=mixed]{color:var(--dsw-alias-label-tertiary)}",
			".dsh-cost-meter-panelBadge[data-period=mixed]{color:var(--dsw-alias-label-tertiary)}",
			".dsh-cost-meter-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			// ── the anchored detail panel (geometry copied verbatim from ui-chat stat-dialog) ──
			".dsh-cost-meter-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(460px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}",
			".dsh-cost-meter-panelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".dsh-cost-meter-panelTitleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".dsh-cost-meter-panelTitleValue{font-variant-numeric:tabular-nums}",
			".dsh-cost-meter-panelTitleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
			".dsh-cost-meter-panelTitleLabel svg{flex:none;width:14px;height:14px}",
			".dsh-cost-meter-panelDetails{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
			".dsh-cost-meter-panelDetails dt,.dsh-cost-meter-panelDetails dd{min-width:0;margin:0}",
			".dsh-cost-meter-panelDetails dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
			".dsh-cost-meter-panelDetails3{grid-template-columns:minmax(76px,auto) minmax(0,1fr) minmax(0,auto)}",
			".dsh-cost-meter-panelDetails3 dd.dsh-cost-meter-panelMid{color:var(--dsw-alias-label-tertiary);text-align:left;overflow-wrap:anywhere}",
			".dsh-cost-meter-panelGap{margin-top:10px}",
			".dsh-cost-meter-panelNote{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-cost-meter-panelBadge{display:inline-flex;align-items:center;gap:4px;border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;border:.5px solid currentColor}",
			".dsh-cost-meter-panelBadge[data-period=peak]{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-cost-meter-panelBadge[data-period=offPeak]{color:var(--dsw-alias-state-success-primary)}",
			".dsh-cost-meter-panelFoot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
			".dsh-cost-meter-panelFoot button{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:1px 8px;cursor:pointer}",
			".dsh-cost-meter-panelFoot button:disabled{opacity:.5;cursor:default}",
			// ── the settings page (own sidebar section) ──
			".dsh-cost-meter-page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px}",
			".dsh-cost-meter-head{display:flex;flex-direction:column;gap:4px}",
			".dsh-cost-meter-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}",
			".dsh-cost-meter-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-cost-meter-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}",
			".dsh-cost-meter-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}",
			".dsh-cost-meter-cardTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".dsh-cost-meter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 16px}",
			".dsh-cost-meter-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dsh-cost-meter-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-cost-meter-field input[type=text],.dsh-cost-meter-field input[type=number],.dsh-cost-meter-field select,.dsh-cost-meter-field textarea{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px;font-variant-numeric:tabular-nums}",
			".dsh-cost-meter-field textarea{min-height:32px;resize:vertical;font-size:12px}",
			".dsh-cost-meter-field input:focus,.dsh-cost-meter-field select:focus,.dsh-cost-meter-field textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}",
			".dsh-cost-meter-fieldHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-cost-meter-status{display:grid;grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:8px 16px;margin:0;font-size:12px;line-height:18px}",
			".dsh-cost-meter-status dt{color:var(--dsw-alias-label-tertiary);margin:0}",
			".dsh-cost-meter-status dd{color:var(--dsw-alias-label-secondary);margin:0;font-variant-numeric:tabular-nums}",
			".dsh-cost-meter-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsh-cost-meter-check{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-cost-meter-warn{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-cost-meter-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
			".dsh-cost-meter-foot{display:flex;align-items:center;gap:8px}",
			".dsh-cost-meter-foot button,.dsh-cost-meter-cardHead button{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}",
			".dsh-cost-meter-foot button[data-primary=true]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".dsh-cost-meter-foot button:disabled,.dsh-cost-meter-cardHead button:disabled{opacity:.5;cursor:default}",
			".dsh-cost-meter-note{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsh-cost-meter-preview{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:pre-wrap}"
		].join("");

		const CSS_TAG_ID = "dsh-cost-meter/cost-meter.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cost-meter";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ─────────────────────────────────────────────────────────────────────
		// Price accounting and clock-derived pricing
		// ─────────────────────────────────────────────────────────────────────

		/** Accept one non-negative finite number out of an unknown wire value. */
		function amount(value, fallback) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
		}

		function text(value, fallback) {
			return typeof value === "string" ? value : fallback;
		}

		function stringList(value) {
			if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
			if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
			return [];
		}

		/**
		 * Project one settings snapshot into the normalized configuration this
		 * half prices with. Absent, loading, and unavailable snapshots all resolve
		 * to composition defaults, so the row never blocks on the transport.
		 */
		function resolveConfig(snapshot) {
			const ready = snapshot !== undefined && snapshot !== null && snapshot.status === "ready" && typeof snapshot.value === "object" && snapshot.value !== null;
			const raw = ready ? snapshot.value : {};
			const source = raw.source === "manual" || raw.source === "builtin" ? raw.source : "auto";
			const currency = raw.currency === "USD" || raw.currency === "$" ? "USD" : "CNY";
			return {
				source,
				model: text(raw.model, DEFAULTS.model) || DEFAULTS.model,
				sourceUrl: text(raw.sourceUrl, DEFAULTS.sourceUrl) || DEFAULTS.sourceUrl,
				usdSourceUrl: text(raw.usdSourceUrl, DEFAULTS.usdSourceUrl) || DEFAULTS.usdSourceUrl,
				currency,
				decimals: Math.min(6, Math.round(amount(raw.decimals, DEFAULTS.decimals))),
				showSavings: raw.showSavings !== false,
				refreshMinutes: Math.min(1440, Math.round(amount(raw.refreshMinutes, DEFAULTS.refreshMinutes))),
				input: amount(raw.input, DEFAULTS.input),
				cacheRead: amount(raw.cacheRead, DEFAULTS.cacheRead),
				cacheWrite: amount(raw.cacheWrite, DEFAULTS.cacheWrite),
				output: amount(raw.output, DEFAULTS.output),
				offPeakFactor: Math.min(1, amount(raw.offPeakFactor, DEFAULTS.offPeakFactor)),
				peakWindows: stringList(raw.peakWindows),
				weekdaysOnly: raw.weekdaysOnly !== false,
				holidays: stringList(raw.holidays),
				revision: ready ? snapshot.revision : undefined,
				writable: ready && snapshot.writable === true,
				status: ready ? "ready" : snapshot === undefined || snapshot === null ? "unavailable" : snapshot.status
			};
		}

		/** Parse "HH:MM" into minutes, or null. */
		function parseClock(value) {
			const match = /^([0-9]{1,2}):([0-9]{2})$/u.exec(String(value).trim());
			if (match === null) return null;
			const hours = Number(match[1]);
			const minutes = Number(match[2]);
			if (hours > 23 || minutes > 59) return null;
			return hours * 60 + minutes;
		}

		/** Format minutes-of-day as "HH:MM". */
		function formatClockMinutes(minutes) {
			const normalized = ((minutes % 1440) + 1440) % 1440;
			return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
		}

		/** Parse one "HH:MM-HH:MM" window; wraps across midnight. */
		function parseWindow(value) {
			const match = /^\s*([0-9]{1,2}:[0-9]{2})\s*[-–—~至到]\s*([0-9]{1,2}:[0-9]{2})\s*$/u.exec(String(value));
			if (match === null) return null;
			const start = parseClock(match[1]);
			const end = parseClock(match[2]);
			if (start === null || end === null || start === end) return null;
			return { start, end, text: `${formatClockMinutes(start)}-${formatClockMinutes(end)}` };
		}

		/** Whether one minute-of-day (UTC) falls inside a window. */
		function inWindow(minuteOfDay, window) {
			if (window.start <= window.end) return minuteOfDay >= window.start && minuteOfDay < window.end;
			return minuteOfDay >= window.start || minuteOfDay < window.end;
		}

		/** Effective schedule: explicit config windows win, else the catalog's. */
		function resolveSchedule(config, catalog) {
			const fromCatalog = catalog !== undefined && catalog !== null && catalog.schedule !== undefined && catalog.schedule !== null ? catalog.schedule : BUILTIN_CATALOGS.CNY.schedule;
			const configured = (config.peakWindows ?? []).map(parseWindow).filter((window) => window !== null);
			const catalogWindows = stringList(fromCatalog.peakWindows).map(parseWindow).filter((window) => window !== null);
			const windows = configured.length > 0 ? configured : catalogWindows.length > 0 ? catalogWindows : BUILTIN_CATALOGS.CNY.schedule.peakWindows.map(parseWindow).filter((window) => window !== null);
			return {
				windows,
				weekdaysOnly: configured.length > 0 ? config.weekdaysOnly !== false : fromCatalog.weekdaysOnly !== false,
				offsetMinutes: Number.isFinite(fromCatalog.offsetMinutes) ? fromCatalog.offsetMinutes : 480
			};
		}

		/** Date key ("YYYY-MM-DD") of one instant in the schedule's local offset. */
		function localDateKey(atMs, offsetMinutes) {
			const local = new Date(atMs + offsetMinutes * 60_000);
			return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
		}

		/** Local weekday (0 = Sunday) of one instant. */
		function localWeekday(atMs, offsetMinutes) {
			return new Date(atMs + offsetMinutes * 60_000).getUTCDay();
		}

		/**
		 * Peak or off-peak at one instant.
		 *
		 * Peak applies only inside a published UTC window, on a Monday-through-
		 * Friday local date, and outside the configured holiday list.
		 */
		function periodAt(atMs, schedule, holidays) {
			const offset = schedule.offsetMinutes;
			const dateKey = localDateKey(atMs, offset);
			const weekday = localWeekday(atMs, offset);
			const holiday = Array.isArray(holidays) && holidays.includes(dateKey);
			const weekend = weekday === 0 || weekday === 6;
			const utc = new Date(atMs);
			const minuteOfDay = utc.getUTCHours() * 60 + utc.getUTCMinutes();
			const insideWindow = schedule.windows.some((window) => inWindow(minuteOfDay, window));
			const peak = insideWindow && (schedule.weekdaysOnly !== true || !weekend) && !holiday;
			return {
				kind: peak ? "peak" : "offPeak",
				dateKey,
				weekday,
				holiday,
				reason: peak ? "window" : holiday ? "holiday" : weekend && schedule.weekdaysOnly === true ? "weekend" : "outside"
			};
		}

		/** First instant after `atMs` whose period differs; null within eight days. */
		function nextChangeAt(atMs, schedule, holidays) {
			const current = periodAt(atMs, schedule, holidays).kind;
			const firstMinute = Math.floor(atMs / 60_000) * 60_000 + 60_000;
			for (let step = 0; step < 8 * 1440; step += 1) {
				const at = firstMinute + step * 60_000;
				const kind = periodAt(at, schedule, holidays).kind;
				if (kind !== current) return { at, kind };
			}
			return null;
		}

		/** Scale one bucket by a factor, rounding to wire precision. */
		function scaleBucket(bucket, factor) {
			const round = (value) => Math.round(value * 1e6) / 1e6;
			return {
				cacheRead: round(bucket.cacheRead * factor),
				input: round(bucket.input * factor),
				cacheWrite: round((bucket.cacheWrite ?? 0) * factor),
				output: round(bucket.output * factor)
			};
		}

		/** Pick the configured model out of a catalog, falling back to its first. */
		function pickModel(catalog, id) {
			const models = catalog !== undefined && catalog !== null && Array.isArray(catalog.models) ? catalog.models : [];
			const normalized = models.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string");
			if (normalized.length === 0) return undefined;
			return normalized.find((model) => model.id === id) ?? normalized[0];
		}

		function normalizeBucket(bucket) {
			if (bucket === undefined || bucket === null || typeof bucket !== "object") return null;
			const normalized = {
				cacheRead: amount(bucket.cacheRead, 0),
				input: amount(bucket.input, 0),
				cacheWrite: amount(bucket.cacheWrite, 0),
				output: amount(bucket.output, 0)
			};
			if (normalized.cacheRead === 0 && normalized.input === 0 && normalized.output === 0) return null;
			return normalized;
		}

		/** All-zero usage buckets. */
		function emptyUsage() {
			return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
		}

		function addUsage(left, right) {
			return {
				uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
				cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
				cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
				outputTokens: left.outputTokens + right.outputTokens
			};
		}

		function usageTotal(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
		}

		function normalizeUsage(value) {
			if (value === null || typeof value !== "object") return emptyUsage();
			return {
				uncachedInputTokens: amount(value.uncachedInputTokens, 0),
				cacheReadTokens: amount(value.cacheReadTokens, 0),
				cacheWriteTokens: amount(value.cacheWriteTokens, 0),
				outputTokens: amount(value.outputTokens, 0)
			};
		}

		/** Latest price version whose effective date is at or before `date`. */
		function priceVersionAt(changes, date) {
			let picked;
			for (const change of changes) {
				if (typeof change?.date !== "string" || change.date > date) break;
				picked = change;
			}
			return picked;
		}

		/** Peak/off-peak units from one catalog, falling back to the current one. */
		function unitsFrom(catalog, modelId, factor) {
			if (catalog === undefined || catalog === null) return null;
			const model = pickModel(catalog, modelId);
			const peak = model !== undefined ? normalizeBucket(model.peak) : null;
			if (peak === null) return null;
			const offPeak = model !== undefined ? normalizeBucket(model.offPeak) : null;
			return { peak, offPeak: offPeak ?? scaleBucket(peak, factor) };
		}

		/**
		 * Resolve everything the UI needs at one instant.
		 *
		 * `byDay` is the host projection's day map (`{ "YYYY-MM-DD": {peak,
		 * offPeak} }`). When it carries usage, the cost is computed per day with
		 * the price version effective that day; otherwise the caller falls back
		 * to pricing the aggregate at the current period.
		 *
		 * @param config - normalized configuration (`resolveConfig`).
		 * @param feed - catalog store snapshot (catalogs, meta, price history).
		 * @param atMs - instant used for the "current period" context.
		 * @param byDay - day/period usage projection, or undefined.
		 */
		function resolvePricing(config, feed, atMs, byDay) {
			const code = config.currency === "USD" ? "USD" : "CNY";
			const builtin = BUILTIN_CATALOGS[code];
			const deliveredCatalogs = feed !== undefined && feed !== null && feed.catalogs !== undefined && feed.catalogs !== null ? feed.catalogs : undefined;
			const delivered = deliveredCatalogs !== undefined ? deliveredCatalogs[code] : undefined;
			const catalog = config.source === "builtin" ? builtin : delivered !== undefined && delivered !== null ? delivered : builtin;
			const meta = config.source !== "builtin" && feed !== undefined && feed !== null && feed.meta !== undefined && feed.meta !== null ? feed.meta[code] : undefined;
			const live = config.source !== "builtin" && meta !== undefined && meta !== null && meta.live === true;
			const schedule = resolveSchedule(config, catalog);
			const period = periodAt(atMs, schedule, config.holidays);
			const next = nextChangeAt(atMs, schedule, config.holidays);
			const manualPeak = { cacheRead: config.cacheRead, input: config.input, cacheWrite: config.cacheWrite, output: config.output };
			const manualOffPeak = scaleBucket(manualPeak, config.offPeakFactor);
			const catalogUnits = unitsFrom(catalog, config.model, config.offPeakFactor);
			const useManual = config.source === "manual" || catalogUnits === null;
			const resolvedUnits = useManual ? { peak: manualPeak, offPeak: manualOffPeak } : catalogUnits;
			const peakPrices = resolvedUnits.peak;
			const offPeakPrices = resolvedUnits.offPeak;
			const unit = period.kind === "peak" ? peakPrices : offPeakPrices;
			const fallbackSymbol = code === "USD" ? "$" : "¥";
			const symbol = useManual ? fallbackSymbol : text(catalog.currency, fallbackSymbol) || fallbackSymbol;
			const model = config.source === "manual" ? undefined : pickModel(catalog, config.model);
			const configured = unit.input > 0 || unit.cacheRead > 0 || unit.cacheWrite > 0 || unit.output > 0;

			const base = {
				mode: "current",
				currencyCode: code,
				currency: symbol,
				decimals: config.decimals,
				showSavings: config.showSavings,
				input: unit.input,
				cacheRead: unit.cacheRead,
				cacheWrite: unit.cacheWrite,
				output: unit.output,
				period,
				next,
				schedule,
				peakPrices,
				offPeakPrices,
				currentUnits: unit,
				model: model !== undefined ? model.id : undefined,
				modelLabel: model !== undefined ? text(model.label, model.id) : undefined,
				sourceKind: useManual ? "manual" : live ? "live" : "builtin",
				fetchedAt: live ? amount(meta.fetchedAt, 0) : 0,
				error: config.source === "builtin" || meta === undefined || meta === null || typeof meta.error !== "string" ? null : meta.error,
				configured,
				history: null
			};

			if (byDay === undefined || byDay === null || typeof byDay !== "object") return base;
			const changes = feed !== undefined && feed !== null && feed.priceHistory !== undefined && feed.priceHistory !== null && Array.isArray(feed.priceHistory.changes)
				? feed.priceHistory.changes
				: [];
			const priceShape = (units) => ({ input: units.input, cacheRead: units.cacheRead, cacheWrite: units.cacheWrite, output: units.output, currency: symbol, decimals: config.decimals, showSavings: config.showSavings });

			let peakUsage = emptyUsage();
			let offPeakUsage = emptyUsage();
			let peakCost = 0;
			let offPeakCost = 0;
			let saved = 0;
			let days = 0;
			let uncoveredDays = 0;
			for (const [date, rawDay] of Object.entries(byDay)) {
				if (rawDay === null || typeof rawDay !== "object") continue;
				const dayPeak = normalizeUsage(rawDay.peak);
				const dayOffPeak = normalizeUsage(rawDay.offPeak);
				if (usageTotal(dayPeak) + usageTotal(dayOffPeak) === 0) continue;
				days += 1;

				let units;
				if (config.source === "manual") {
					units = { peak: manualPeak, offPeak: manualOffPeak };
				} else if (config.source === "builtin") {
					units = { peak: peakPrices, offPeak: offPeakPrices };
				} else {
					const version = priceVersionAt(changes, date);
					const historical = version?.catalogs?.[code];
					if (historical === undefined || historical === null) {
						uncoveredDays += 1;
						units = { peak: peakPrices, offPeak: offPeakPrices };
					} else {
						units = unitsFrom(historical, config.model, config.offPeakFactor) ?? { peak: peakPrices, offPeak: offPeakPrices };
					}
				}
				const peakAccount = account(dayPeak, priceShape(units.peak));
				const offPeakAccount = account(dayOffPeak, priceShape(units.offPeak));
				peakUsage = addUsage(peakUsage, dayPeak);
				offPeakUsage = addUsage(offPeakUsage, dayOffPeak);
				peakCost += peakAccount.cost;
				offPeakCost += offPeakAccount.cost;
				saved += peakAccount.saved + offPeakAccount.saved;
			}
			if (days === 0) return base;
			return Object.assign({}, base, {
				mode: "history",
				history: {
					peakUsage,
					offPeakUsage,
					peakCost,
					offPeakCost,
					cost: peakCost + offPeakCost,
					saved,
					mixed: usageTotal(peakUsage) > 0 && usageTotal(offPeakUsage) > 0,
					days,
					uncoveredDays,
					from: changes.length > 0 ? changes[0].date : null
				}
			});
		}

		/** Tokens per price unit; prices are always quoted per million now. */
		function divisorOf() {
			return 1e6;
		}

		/** Money text: the configured precision, widened for sub-cent amounts. */
		function formatMoney(value, prices) {
			const magnitude = Math.abs(value);
			const digits = magnitude > 0 && magnitude < 0.01 ? Math.min(6, prices.decimals + 3) : prices.decimals;
			return prices.currency + value.toFixed(digits);
		}

		/**
		 * Price one usage reading. The four buckets are disjoint by construction
		 * (`tokenUsage` folds `uncachedInputTokens = usage.inputTokens` and keeps
		 * cache read/write apart), so each bucket is charged exactly once.
		 */
		function account(usage, prices) {
			const miss = amount(usage.uncachedInputTokens, 0);
			const read = amount(usage.cacheReadTokens, 0);
			const write = amount(usage.cacheWriteTokens, 0);
			const output = amount(usage.outputTokens, 0);
			const divisor = divisorOf();
			const perBucket = {
				miss: miss * prices.input / divisor,
				read: read * prices.cacheRead / divisor,
				write: write * prices.cacheWrite / divisor,
				output: output * prices.output / divisor
			};
			return {
				miss,
				read,
				write,
				output,
				billed: miss + read + write,
				cost: perBucket.miss + perBucket.read + perBucket.write + perBucket.output,
				saved: read * Math.max(0, prices.input - prices.cacheRead) / divisor,
				perBucket
			};
		}

		/** "3 分钟前" style relative time for the catalog age. */
		function formatAgo(ms) {
			const minutes = Math.floor(Math.max(0, ms) / 60_000);
			if (minutes < 1) return tr("cost.justNow");
			if (minutes < 60) return tr("cost.minutesAgo", { minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return tr("cost.hoursAgo", { hours });
			return tr("cost.daysAgo", { days: Math.floor(hours / 24) });
		}

		/** "1 小时 28 分" style countdown. */
		function formatRemaining(ms) {
			const minutes = Math.max(0, Math.ceil(ms / 60_000));
			if (minutes < 60) return tr("cost.remainingMinutes", { minutes });
			return tr("cost.remainingHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
		}

		/** Clock in the schedule's local offset. */
		function formatLocalClock(atMs, offsetMinutes) {
			const local = new Date(atMs + offsetMinutes * 60_000);
			return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
		}

		/** Period label. */
		function periodLabel(kind) {
			return kind === "peak" ? tr("cost.peak") : tr("cost.offPeak");
		}

		// ─────────────────────────────────────────────────────────────────────
		// Formatters and panel geometry ported from
		// @deepseek-ai/dsh-client-ui-chat (StatsPills / stat-dialog / formatTokens)
		// ─────────────────────────────────────────────────────────────────────

		/** Viewport margin the placement clamp keeps. */
		const PANEL_MARGIN = 12;
		/** Distance between the trigger's top edge and the panel's bottom. */
		const PANEL_GAP = 8;
		/** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
		const MEASURE_STYLE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};

		/** Compact decode-rate text: integers at or above 10, one decimal below. */
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}

		/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
		function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
			const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
			const doubledScale = scale * 2;
			const denominatorQuotient = Math.floor(denominator / doubledScale);
			const denominatorRemainder = denominator % doubledScale;
			let lower = 0;
			let upper = scale;
			while (lower < upper) {
				const candidate = Math.floor((lower + upper + 1) / 2);
				const factor = candidate * 2 - 1;
				if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
				else upper = candidate - 1;
			}
			return lower;
		}

		function displayPercentUnits(units, decimalPlaces) {
			if (decimalPlaces === 0) return String(units);
			const whole = Math.floor(units / 10);
			const tenths = units % 10;
			return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
		}

		/** Display-ready cache-hit share without rounding a partial hit to 100%. */
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (promptTokens === 0) return null;
			const missedInputTokens = promptTokens - cacheReadTokens;
			if (missedInputTokens === 0) return "100";
			const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
			if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
			let distinguishingPlaces = 1;
			let scaledDoubleGap = missedInputTokens * 200;
			const denominatorTens = Math.floor(promptTokens / 10);
			while (scaledDoubleGap <= denominatorTens) {
				scaledDoubleGap *= 10;
				distinguishingPlaces += 1;
			}
			const denominatorOnes = promptTokens % 10;
			let roundedLoss = 5;
			for (let loss = 1; loss < 5; loss += 1) {
				const factor = loss * 2 + 1;
				const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
				if (scaledDoubleGap <= threshold) {
					roundedLoss = loss;
					break;
				}
			}
			return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
		}

		/** Sum the three disjoint prompt-side billing buckets. */
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}

		/** Display-ready cache-hit share of prompt-side input over the whole durable log. */
		function cacheHitPercent(usage) {
			return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage));
		}

		/** Compact token count through the shared number templates. */
		function formatTokens(value, t) {
			const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t("number.thousand", { value: scaled(value / 1e3) });
			return t("number.million", { value: scaled(value / 1e6) });
		}

		/** Exact integer token count with locale-owned digit grouping. */
		function formatExactTokens(value, t) {
			const digits = String(value);
			const groups = [];
			for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
			return groups.join(t("number.groupSeparator"));
		}

		/**
		 * Place a panel above its trigger, clamped into the viewport — the local
		 * stand-in for the primitives' hook, used only if that export is missing.
		 */
		function useLocalAnchoredPosition(open, anchorRef, panelRef) {
			const [pos, setPos] = React.useState(undefined);
			React.useLayoutEffect(() => {
				if (!open) {
					setPos(undefined);
					return undefined;
				}
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || anchor === undefined || panel === null || panel === undefined) return;
					const a = anchor.getBoundingClientRect();
					const p = panel.getBoundingClientRect();
					let left = a.left + a.width / 2 - p.width / 2;
					left = Math.max(PANEL_MARGIN, Math.min(left, window.innerWidth - PANEL_MARGIN - p.width));
					let top = a.top - PANEL_GAP - p.height;
					if (top < PANEL_MARGIN) top = a.bottom + PANEL_GAP;
					setPos({ left, top });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open, anchorRef, panelRef]);
			return pos;
		}

		/** Close the panel on a pointer outside both the trigger and the panel. */
		function useLocalOutsidePointer(rootRef, open, setOpen, panelRef) {
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current !== null && rootRef.current !== undefined && rootRef.current.contains(target)) return;
					if (panelRef.current !== null && panelRef.current !== undefined && panelRef.current.contains(target)) return;
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => document.removeEventListener("pointerdown", onPointerDown, true);
			}, [open, rootRef, panelRef, setOpen]);
		}

		/**
		 * One trigger-anchored dialog seat: open state, clamped placement,
		 * outside-close, and Escape. Sibling seats share one exclusive slot by
		 * passing `controlled`.
		 */
		function useStatDialog(controlled) {
			const [ownOpen, setOwnOpen] = React.useState(false);
			const open = controlled !== undefined && controlled !== null && controlled.open !== undefined ? controlled.open : ownOpen;
			const setOpen = controlled !== undefined && controlled !== null && controlled.setOpen !== undefined ? controlled.setOpen : setOwnOpen;
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const pos = anchoredPosition !== undefined
				? anchoredPosition({ open, anchorRef: rootRef, panelRef, side: "top", gap: PANEL_GAP, margin: PANEL_MARGIN })
				: useLocalAnchoredPosition(open, rootRef, panelRef);
			if (outsidePointer !== undefined) outsidePointer(rootRef, open, setOpen, panelRef);
			else useLocalOutsidePointer(rootRef, open, setOpen, panelRef);
			React.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open, setOpen]);
			return { open, setOpen, rootRef, panelRef, pos };
		}

		/** Portal when react-dom is available; otherwise render in place (already fixed-position). */
		function portal(node) {
			if (createPortal === undefined || typeof document === "undefined") return node;
			return createPortal(node, document.body);
		}

		/**
		 * One detail panel: title row with the owning pill's icon, rule, and the
		 * label/value grid the shipped stat dialogs use.
		 */
		function StatPanel(props) {
			const rows = props.rows.filter((row) => row !== null && row !== undefined);
			const cells = [];
			for (const row of rows) for (const cell of row) cells.push(cell);
			const attributes = { className: props.detailsClass, ref: undefined };
			attributes[props.detailsAttribute] = true;
			return React.createElement(
				"div",
				{
					ref: props.panelRef,
					className: "dsh-cost-meter-panel",
					role: "dialog",
					"aria-label": props.ariaLabel,
					style: props.pos === undefined ? MEASURE_STYLE : props.pos
				},
				React.createElement(
					"div",
					{ className: "dsh-cost-meter-panelTitle" },
					React.createElement("span", { className: "dsh-cost-meter-panelTitleLabel" }, props.icon, props.title),
					props.titleValue === undefined ? null : React.createElement("span", { className: "dsh-cost-meter-panelTitleValue" }, props.titleValue)
				),
				React.createElement("div", { className: "dsh-cost-meter-panelTitleRule", "aria-hidden": true }),
				React.createElement("dl", attributes, cells),
				props.extra === undefined ? null : props.extra
			);
		}

		/** One dt/dd/dd triple for the three-column cost grid. */
		function detailRow3(label, middle, value, key) {
			const id = key === undefined ? label : key;
			return [
				React.createElement("dt", { key: `${id}-dt` }, label),
				React.createElement("dd", { key: `${id}-mid`, className: "dsh-cost-meter-panelMid" }, middle),
				React.createElement("dd", { key: `${id}-dd` }, value)
			];
		}

		/** One dt/dd pair for the panel's meta grid. */
		function detailRow2(label, value, key) {
			const id = key === undefined ? label : key;
			return [
				React.createElement("dt", { key: `${id}-dt` }, label),
				React.createElement("dd", { key: `${id}-dd` }, value)
			];
		}

		/** The coin glyph (¥ in a circle) for the spend pill. */
		function CoinGlyph() {
			return React.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("circle", { cx: 8, cy: 8, r: 6.1, stroke: "currentColor", strokeWidth: 1.2 }),
				React.createElement("path", {
					d: "M5.7 5.1 8 8.1l2.3-3M8 8.1v3.1M5.9 9.2h4.2M5.9 10.5h4.2",
					stroke: "currentColor",
					strokeWidth: 1.1,
					strokeLinecap: "round"
				})
			);
		}

		// ─────────────────────────────────────────────────────────────────────
		// Stores: settings snapshot (uSES) and the host-served price catalog
		// ─────────────────────────────────────────────────────────────────────

		/**
		 * The settings scope may attach long after the first render (its provider
		 * resolves asynchronously), and `useSyncExternalStore` needs one subscribe
		 * identity for a component's whole life — so components subscribe here and
		 * this store forwards to whatever scope is current.
		 */
		function createPriceStore() {
			let scope;
			let unsubscribe;
			let snapshot = UNAVAILABLE;
			const listeners = new Set();
			const publish = () => {
				snapshot = scope === undefined ? UNAVAILABLE : scope.getSnapshot();
				for (const listener of Array.from(listeners)) listener();
			};
			return {
				attach(next) {
					if (scope === next) return;
					if (unsubscribe !== undefined) {
						unsubscribe();
						unsubscribe = undefined;
					}
					scope = next;
					if (scope !== undefined) unsubscribe = scope.subscribe(publish);
					publish();
				},
				getSnapshot() {
					return snapshot;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				async write(ops, expectedRevision) {
					if (scope === undefined) throw new Error(tr("cost.scopeUnavailable"));
					await scope.mutate(ops, expectedRevision);
				}
			};
		}

		/**
		 * The host-published catalog. Keeps the bundled table until the first
		 * answer, keeps the last good table across failures, and reports both the
		 * freshness and the reason a refresh failed.
		 */
		function createCatalogStore() {
			const emptyMeta = () => ({ CNY: {}, USD: {} });
			let snapshot = {
				status: "idle",
				catalogs: BUILTIN_CATALOGS,
				meta: emptyMeta(),
				priceHistory: { changes: [], firstDate: null, lastDate: null },
				projectionInstalled: false,
				live: false,
				fetchedAt: 0,
				error: null
			};
			let timer;
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of Array.from(listeners)) listener();
			};
			const fail = (error) => {
				const message = error instanceof Error ? error.message : String(error);
				publish(Object.assign({}, snapshot, { status: snapshot.live ? "ready" : "error", error: message }));
			};
			const request = async (url, method) => {
				const impl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
				if (impl === undefined) throw new Error("fetch is unavailable");
				if (typeof location !== "undefined" && location.protocol === "file:") throw new Error("file:// pages have no host price route");
				const response = await impl(url, { method, headers: { accept: "application/json" }, cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return await response.json();
			};
			const accept = (body) => {
				if (body === null || typeof body !== "object" || body.catalogs === null || typeof body.catalogs !== "object") {
					throw new Error("price route returned no catalogs");
				}
				publish({
					status: "ready",
					catalogs: body.catalogs,
					meta: body.meta !== null && typeof body.meta === "object" ? body.meta : emptyMeta(),
					priceHistory: body.priceHistory !== null && typeof body.priceHistory === "object" && Array.isArray(body.priceHistory.changes)
						? body.priceHistory
						: { changes: [], firstDate: null, lastDate: null },
					projectionInstalled: body.projectionInstalled === true,
					live: body.live === true,
					fetchedAt: Number.isFinite(body.fetchedAt) ? body.fetchedAt : 0,
					error: typeof body.error === "string" ? body.error : null
				});
			};
			const load = async (force) => {
				if (typeof location !== "undefined" && location.protocol === "file:") {
					publish(Object.assign({}, snapshot, { status: "unavailable", error: null }));
					return;
				}
				if (snapshot.status === "idle" || (force === true && snapshot.status !== "loading")) {
					publish(Object.assign({}, snapshot, { status: "loading" }));
				}
				try {
					accept(await request(force === true ? REFRESH_ROUTE : PRICES_ROUTE, force === true ? "POST" : "GET"));
				} catch (error) {
					fail(error);
				}
			};
			return {
				getSnapshot() {
					return snapshot;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				refresh() {
					return load(true);
				},
				start() {
					void load(false);
					if (timer === undefined) timer = setInterval(() => void load(false), FEED_POLL_MS);
				},
				stop() {
					if (timer !== undefined) clearInterval(timer);
					timer = undefined;
				}
			};
		}

		/** Read the price snapshot through uSES so both halves re-render on a committed save. */
		function usePrices(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		/** Read the catalog snapshot the same way. */
		function useCatalog(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		/** A clock tick, so the peak/off-peak boundary moves while the page stays open. */
		function useNow() {
			const [now, setNow] = React.useState(() => Date.now());
			React.useEffect(() => {
				const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
				return () => clearInterval(id);
			}, []);
			return now;
		}

		/** Single hook call for callers whose owner supplies no projection seat. */
		const NO_PROJECTION = () => undefined;

		/** Parse a user-typed price; null means "not a usable number". */
		function parsePrice(text) {
			const trimmed = String(text).trim();
			if (trimmed.length === 0) return 0;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
		}

		/** Parse a comma/space separated list into trimmed entries. */
		function parseList(text) {
			return String(text)
				.split(/[,，\s]+/u)
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		}

		// ─────────────────────────────────────────────────────────────────────
		// Components
		// ─────────────────────────────────────────────────────────────────────

		/**
		 * Build the components against one price store. Components are created per
		 * `apply` call (so they close over their stores) and keep stable React
		 * identity for the life of the plugin.
		 */
		function createComponents(store, catalogStore, ctx) {
			/** One "count × unit price" expression for the cost panel's middle column. */
			function costExpression(count, unitPrice, prices, t) {
				return `${formatExactTokens(count, t)} × ${prices.currency}${unitPrice}/${tr("cost.unitMillion")}`;
			}

			/** The cost panel's bucket rows plus its total/savings summary. */
			function costRows(totals, prices, t) {
				if (totals === undefined) return { buckets: [], summary: [] };
				const buckets = [
					detailRow3(t("message.turnUsage.input"), costExpression(totals.miss, prices.input, prices, t), formatMoney(totals.perBucket.miss, prices)),
					detailRow3(t("message.turnUsage.cacheRead"), costExpression(totals.read, prices.cacheRead, prices, t), formatMoney(totals.perBucket.read, prices)),
					totals.write > 0
						? detailRow3(t("message.turnUsage.cacheWrite"), costExpression(totals.write, prices.cacheWrite, prices, t), formatMoney(totals.perBucket.write, prices))
						: null,
					detailRow3(t("message.turnUsage.output"), costExpression(totals.output, prices.output, prices, t), formatMoney(totals.perBucket.output, prices))
				].filter((row) => row !== null);
				const summary = [
					React.createElement("dt", { key: "total-dt" }, tr("cost.total")),
					React.createElement("dd", { key: "total-dd" }, formatMoney(totals.cost, prices))
				];
				if (prices.showSavings && totals.saved > 0) {
					summary.push(React.createElement("dt", { key: "saved-dt" }, tr("cost.saved")));
					summary.push(React.createElement("dd", { key: "saved-dd" }, formatMoney(totals.saved, prices)));
				}
				return { buckets, summary };
			}

			/** Period chip shared by the pill, the panel and the settings page. */
			function PeriodBadge(props) {
				const kind = props.kind;
				const label = kind === "mixed"
					? tr("cost.mixed")
					: props.short === true
						? kind === "peak" ? tr("cost.peakShort") : tr("cost.offPeakShort")
						: periodLabel(kind);
				return React.createElement(
					"span",
					{
						className: props.className,
						"data-period": kind,
						"data-cost-meter-period": kind
					},
					label
				);
			}

			/** Rows for one historical period: total tokens and the money it cost. */
			function historyRow(label, usage, cost, prices, t, key) {
				return detailRow3(label, `${formatTokens(usageTotal(usage), t)} tok`, formatMoney(cost, prices), key);
			}

			/** This package's pill: spend for the session, priced per historical period. */
			function CostPill(props) {
				const t = props.t;
				const prices = props.pricing;
				const usage = props.usage;
				const { open, setOpen, rootRef, panelRef, pos } = useStatDialog(props.dialog);
				const historical = prices.mode === "history";
				const totals = historical ? undefined : usage === undefined || usage === null ? undefined : account(usage, prices);
				const cost = historical ? prices.history.cost : totals === undefined ? undefined : totals.cost;
				const saved = historical ? prices.history.saved : totals === undefined ? 0 : totals.saved;
				const unconfigured = !prices.configured;
				const label = unconfigured ? tr("cost.unconfigured") : cost === undefined ? tr("cost.none") : formatMoney(cost, prices);
				const badgeKind = prices.period.kind;
				const badgeLabel = periodLabel(badgeKind);
				const aria = unconfigured
					? tr("cost.hint")
					: `${tr("cost.title")} ${label}（${historical ? badgeLabel : `${badgeLabel} · ${tr("cost.estimateNote")}`}）`;
				const rows = historical ? { buckets: [], summary: [] } : costRows(totals, prices, t);
				const fixedNow = props.now ?? Date.now();
				const schedule = prices.schedule;
				const clock = formatLocalClock(fixedNow, schedule.offsetMinutes);
				const next = prices.next;
				const summary = historical
					? [
						React.createElement("dt", { key: "total-dt" }, tr("cost.total")),
						React.createElement("dd", { key: "total-dd" }, formatMoney(prices.history.cost, prices)),
						...(prices.showSavings && saved > 0
							? [
								React.createElement("dt", { key: "saved-dt" }, tr("cost.saved")),
								React.createElement("dd", { key: "saved-dd" }, formatMoney(saved, prices))
							]
							: [])
					]
					: rows.summary;
				const usageRows = historical
					? [
						historyRow(tr("cost.peakUsage"), prices.history.peakUsage, prices.history.peakCost, prices, t, "peak-usage"),
						historyRow(tr("cost.offPeakUsage"), prices.history.offPeakUsage, prices.history.offPeakCost, prices, t, "offpeak-usage")
					]
					: rows.buckets;
				const metaRows = [
					detailRow2(tr("cost.period"), `${periodLabel(prices.period.kind)} · ${tr("cost.localTime", { clock })}`, "period"),
					detailRow2(
						tr("cost.nextSwitch"),
						next === null
							? tr("cost.switchUnknown")
							: tr("cost.switchAt", {
								clock: formatLocalClock(next.at, schedule.offsetMinutes),
								next: periodLabel(next.kind),
								remaining: formatRemaining(next.at - fixedNow)
							}),
						"next"
					),
					prices.modelLabel === undefined
						? null
						: detailRow2(tr("cost.model"), prices.modelLabel, "model"),
					detailRow2(
						historical ? tr("cost.currentRate") : tr("cost.rates"),
						tr("cost.ratesValue", {
							input: `${prices.currency}${prices.input}`,
							read: `${prices.currency}${prices.cacheRead}`,
							output: `${prices.currency}${prices.output}`
						}),
						"rates"
					)
				].filter((row) => row !== null);
				const sourceText = prices.sourceKind === "manual"
					? tr("cost.sourceManual")
					: prices.sourceKind === "live"
						? tr("cost.sourceLive")
						: tr("cost.sourceBuiltin");
				const currencyText = prices.currencyCode === "USD" ? tr("cost.usdShort") : tr("cost.cnyShort");
				const fetchedText = prices.sourceKind !== "manual" && prices.fetchedAt > 0 ? ` · ${formatAgo(fixedNow - prices.fetchedAt)}` : "";
				const foot = React.createElement(
					"div",
					{ className: "dsh-cost-meter-panelFoot" },
					React.createElement("span", null, `${currencyText} · ${sourceText}${fetchedText}`),
					props.onRefresh === undefined || prices.sourceKind === "manual"
						? null
						: React.createElement(
							"button",
							{
								type: "button",
								onClick: () => props.onRefresh(),
								disabled: props.refreshing === true
							},
							props.refreshing === true ? tr("cost.refreshing") : tr("cost.refresh")
						)
				);
				return React.createElement(
					"span",
					{ ref: rootRef, className: "dsh-cost-meter-anchor" },
					React.createElement(
						"button",
						{
							type: "button",
							className: "dsh-cost-meter-pill",
							"data-unconfigured": unconfigured ? "true" : undefined,
							"data-cost-meter-pill": "cost",
							"data-period": badgeKind,
							"data-cost-mode": prices.mode,
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							"aria-label": aria,
							title: unconfigured ? tr("cost.hint") : undefined,
							onClick: () => {
								setOpen(!open);
							}
						},
						React.createElement(CoinGlyph, null),
						React.createElement("span", { className: "dsh-cost-meter-pillLabel" }, label),
						React.createElement(PeriodBadge, { className: "dsh-cost-meter-badge", kind: badgeKind, short: true })
					),
					open
						? portal(
							React.createElement(StatPanel, {
								panelRef,
								pos,
								ariaLabel: tr("cost.title"),
								icon: React.createElement(CoinGlyph, null),
								title: tr("cost.title"),
								titleValue: cost === undefined ? undefined : formatMoney(cost, prices),
								detailsClass: "dsh-cost-meter-panelDetails dsh-cost-meter-panelDetails3",
								detailsAttribute: "data-cost-meter-usage",
								rows: usageRows,
								extra: React.createElement(
									"div",
									null,
									historical
										? React.createElement("div", { className: "dsh-cost-meter-panelNote" }, tr("cost.historyNote"))
										: null,
									React.createElement("dl", { className: "dsh-cost-meter-panelDetails dsh-cost-meter-panelDetails" }, summary),
									React.createElement("dl", { className: "dsh-cost-meter-panelDetails dsh-cost-meter-panelGap" }, metaRows.flat()),
									historical && prices.history.uncoveredDays > 0
										? React.createElement("div", { className: "dsh-cost-meter-panelNote" }, tr("cost.uncoveredDays", { days: prices.history.uncoveredDays }))
										: null,
									historical && prices.history.from !== null
										? React.createElement("div", { className: "dsh-cost-meter-panelNote" }, tr("cost.historyFrom", { date: prices.history.from }))
										: null,
									historical ? null : React.createElement("div", { className: "dsh-cost-meter-panelNote" }, tr("cost.estimateNote")),
									foot
								)
							})
						)
						: null
				);
			}

		/**
         * The dock entry: one additive pill beside the shipped `activity` and
         * `usage` pills. It prices the same durable `tokenUsage` projection they
         * read, through the slot's standard `useProjection` seat.
         */
		function CostPillEntry(props) {
			const t = chatCopy(ctx);
			const useProjection = typeof props.useProjection === "function" ? props.useProjection : NO_PROJECTION;
			const usage = useProjection("tokenUsage");
			const byDay = useProjection(PROJECTION_KEY);
			const config = resolveConfig(usePrices(store));
			const feed = useCatalog(catalogStore);
			const ticking = useNow();
			const now = typeof props.now === "number" ? props.now : ticking;
			const pricing = resolvePricing(config, feed, now, byDay);
			const [open, setOpen] = React.useState(false);
			const hasTokens = (usage !== undefined && usage !== null && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) ||
				(pricing.mode === "history" && pricing.history !== null);
			if (!hasTokens) return null;
			const dialog = {
				open,
				setOpen: (next) => {
					setOpen(next);
				}
			};
			return React.createElement(
				RowErrorBoundary,
				{ fallback: React.createElement(PlainCostPill, { pricing, t, usage }) },
				React.createElement(CostPill, {
					pricing,
					t,
					usage,
					dialog,
					now,
					refreshing: feed.status === "loading",
					onRefresh: () => {
						void catalogStore.refresh();
					}
				})
			);
		}

		/** Panel-free fallback so a crash in the pill can never blank the dock. */
		function PlainCostPill(props) {
			const pricing = props.pricing;
			const unconfigured = !pricing.configured;
			const historical = pricing.mode === "history";
			const totals = historical || props.usage === undefined || props.usage === null ? undefined : account(props.usage, pricing);
			const cost = historical ? pricing.history.cost : totals === undefined ? undefined : totals.cost;
			const kind = pricing.period.kind;
			const label = unconfigured ? tr("cost.unconfigured") : cost === undefined ? tr("cost.none") : formatMoney(cost, pricing);
			return React.createElement(
				"span",
				{ className: "dsh-cost-meter-anchor" },
				React.createElement(
					"span",
					{ className: "dsh-cost-meter-pill", "data-unconfigured": unconfigured ? "true" : undefined },
					React.createElement(CoinGlyph, null),
					React.createElement("span", { className: "dsh-cost-meter-pillLabel" }, label),
					React.createElement(PeriodBadge, { className: "dsh-cost-meter-badge", kind, short: true })
				)
			);
		}

		/**
         * Keep a crash inside the priced pill from taking the dock line with it:
         * the entry reads live projections, so it must always render something.
         */
		class RowErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error("[dsh-cost-meter] spend pill failed; falling back to plain text", error);
			}
			render() {
				return this.state.failed ? this.props.fallback : this.props.children;
			}
		}

			/** One labeled control inside the settings page. */
			function Field(props) {
				return React.createElement(
					"label",
					{ className: "dsh-cost-meter-field" },
					React.createElement("span", null, props.label),
					props.children,
					props.hint === undefined ? null : React.createElement("span", { className: "dsh-cost-meter-fieldHint" }, props.hint)
				);
			}

			/** One label/value row of the status card. */
			function StatusRow(props) {
				return [
					React.createElement("dt", { key: `${props.id}-dt` }, props.label),
					React.createElement("dd", { key: `${props.id}-dd` }, props.children)
				];
			}

			/** The settings page, registered into the Settings sidebar. */
			function CostSettingsPage() {
				const snapshot = usePrices(store);
				const config = resolveConfig(snapshot);
				const feed = useCatalog(catalogStore);
				const ticking = useNow();
				const pricing = resolvePricing(config, feed, ticking);
				const [draft, setDraft] = React.useState(null);
				const [busy, setBusy] = React.useState(false);
				const [failure, setFailure] = React.useState(null);
				const refreshing = feed.status === "loading";

				const seed = () => ({
					source: config.source,
					model: config.model,
					sourceUrl: config.sourceUrl,
					usdSourceUrl: config.usdSourceUrl,
					currency: config.currency,
					decimals: String(config.decimals),
					showSavings: config.showSavings,
					refreshMinutes: String(config.refreshMinutes),
					input: String(config.input),
					cacheRead: String(config.cacheRead),
					cacheWrite: String(config.cacheWrite),
					output: String(config.output),
					offPeakFactor: String(config.offPeakFactor),
					peakWindows: config.peakWindows.join(", "),
					weekdaysOnly: config.weekdaysOnly,
					holidays: config.holidays.join(", ")
				});
				const staged = draft === null ? seed() : draft;
				const edit = (field, value) => {
					setDraft(Object.assign(seed(), draft === null ? {} : draft, { [field]: value }));
				};
				const unavailable = snapshot.status === "unavailable";
				const writable = snapshot.writable === true && !unavailable;

				const save = async () => {
					const ops = [];
					const numbers = ["input", "cacheRead", "cacheWrite", "output", "decimals", "refreshMinutes"];
					for (const field of numbers) {
						const parsed = parsePrice(staged[field]);
						if (parsed === null) {
							setFailure(tr("cost.invalidPrice", { field: LABELS[field] }));
							return;
						}
						if (field === "decimals" && (parsed > 6 || Math.round(parsed) !== parsed)) {
							setFailure(tr("cost.invalidDecimals", { field: LABELS.decimals }));
							return;
						}
						if (field === "refreshMinutes" && Math.round(parsed) !== parsed) {
							setFailure(tr("cost.invalidPrice", { field: LABELS.refreshMinutes }));
							return;
						}
						const current = field === "decimals" || field === "refreshMinutes" ? config[field] : config[field];
						if (parsed !== current) ops.push({ op: "set", path: [field], value: parsed });
					}
					const factor = parsePrice(staged.offPeakFactor);
					if (factor === null || factor > 1) {
						setFailure(tr("cost.invalidFactor", { field: LABELS.offPeakFactor }));
						return;
					}
					if (factor !== config.offPeakFactor) ops.push({ op: "set", path: ["offPeakFactor"], value: factor });
					const windows = parseList(staged.peakWindows);
					for (const window of windows) {
						if (parseWindow(window) === null) {
							setFailure(tr("cost.invalidWindow", { field: LABELS.peakWindows }));
							return;
						}
					}
					if (windows.join(",") !== config.peakWindows.join(",")) ops.push({ op: "set", path: ["peakWindows"], value: windows });
					const holidays = parseList(staged.holidays);
					for (const day of holidays) {
						if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(day)) {
							setFailure(tr("cost.invalidHoliday", { field: LABELS.holidays }));
							return;
						}
					}
					if (holidays.join(",") !== config.holidays.join(",")) ops.push({ op: "set", path: ["holidays"], value: holidays });
					const texts = ["source", "model", "sourceUrl", "usdSourceUrl", "currency"];
					for (const field of texts) {
						if (staged[field] !== config[field]) ops.push({ op: "set", path: [field], value: staged[field] });
					}
					if (staged.showSavings !== config.showSavings) ops.push({ op: "set", path: ["showSavings"], value: staged.showSavings });
					if (staged.weekdaysOnly !== config.weekdaysOnly) ops.push({ op: "set", path: ["weekdaysOnly"], value: staged.weekdaysOnly });
					if (ops.length === 0) {
						setDraft(null);
						setFailure(null);
						return;
					}
					setBusy(true);
					setFailure(null);
					try {
						await store.write(ops, snapshot.revision);
						setDraft(null);
						// A new source URL should take effect now, not on the next host tick.
						if (staged.source === "auto") void catalogStore.refresh();
					} catch (error) {
						setFailure(error instanceof Error ? error.message : String(error));
					} finally {
						setBusy(false);
					}
				};

				const reset = async () => {
					const user = snapshot.user !== null && typeof snapshot.user === "object" ? snapshot.user : {};
					const ops = Object.keys(user).map((field) => ({ op: "unset", path: [field] }));
					setDraft(null);
					setFailure(null);
					if (ops.length === 0) return;
					setBusy(true);
					try {
						await store.write(ops, snapshot.revision);
						void catalogStore.refresh();
					} catch (error) {
						setFailure(error instanceof Error ? error.message : String(error));
					} finally {
						setBusy(false);
					}
				};

				const catalogOf = (code) => {
					const delivered = feed.catalogs !== undefined && feed.catalogs !== null ? feed.catalogs[code] : undefined;
					return delivered !== undefined && delivered !== null ? delivered : BUILTIN_CATALOGS[code] ?? BUILTIN_CATALOGS.CNY;
				};
				const models = catalogOf(staged.currency).models;
				const next = pricing.next;
				const preview = pricing.configured
					? tr("cost.cardPreview", {
						amount: formatMoney((1e6 * pricing.input + 5e6 * pricing.cacheRead + 1e5 * pricing.output) / divisorOf(), pricing),
						period: periodLabel(pricing.period.kind)
					})
					: tr("cost.cardPreviewBare");
				const catalogStatus = (code) => {
					const meta = feed.meta !== undefined && feed.meta !== null ? feed.meta[code] : undefined;
					const label = code === "CNY" ? tr("cost.catalogCNY") : tr("cost.catalogUSD");
					if (feed.status === "unavailable") return { label, text: tr("cost.catalogBuiltin"), error: null };
					if (feed.status === "loading" && (meta === undefined || !meta.fetchedAt)) return { label, text: tr("cost.catalogLoading"), error: null };
					if (meta !== undefined && meta !== null && meta.live === true) {
						return {
							label,
							text: tr("cost.catalogLive", { when: meta.fetchedAt ? formatAgo(Date.now() - meta.fetchedAt) : tr("cost.catalogStale") }),
							error: null
						};
					}
					return {
						label,
						text: tr("cost.catalogBuiltin"),
						error: meta !== undefined && meta !== null && typeof meta.error === "string" ? meta.error : null
					};
				};
				const currencyText = pricing.currencyCode === "USD" ? tr("cost.usdShort") : tr("cost.cnyShort");

				const statusRows = [
					...StatusRow({
						id: "period",
						label: tr("cost.statusPeriod"),
						children: React.createElement(
							"span",
							{ className: "dsh-cost-meter-inline" },
							React.createElement(PeriodBadge, { className: "dsh-cost-meter-panelBadge", kind: pricing.period.kind }),
							React.createElement("span", null, tr("cost.localTime", { clock: formatLocalClock(Date.now(), pricing.schedule.offsetMinutes) }))
						)
					}),
					...StatusRow({
						id: "next",
						label: tr("cost.statusNext"),
						children: next === null
							? tr("cost.switchUnknown")
							: tr("cost.switchAt", {
								clock: formatLocalClock(next.at, pricing.schedule.offsetMinutes),
								next: periodLabel(next.kind),
								remaining: formatRemaining(next.at - Date.now())
							})
					}),
					...["CNY", "USD"].flatMap((code) => {
						const entry = catalogStatus(code);
						return StatusRow({
							id: `catalog-${code}`,
							label: entry.label,
							children: React.createElement(
								"span",
								{ className: "dsh-cost-meter-inline" },
								React.createElement("span", null, entry.text),
								entry.error === null ? null : React.createElement("span", { className: "dsh-cost-meter-error" }, tr("cost.catalogError", { message: entry.error }))
							)
						});
					}),
					...StatusRow({
						id: "history",
						label: tr("cost.priceHistory"),
						children: feed.priceHistory !== undefined && feed.priceHistory !== null && feed.priceHistory.firstDate !== null
							? tr("cost.priceHistoryValue", { count: feed.priceHistory.changes.length, from: feed.priceHistory.firstDate })
							: tr("cost.snapshots", { count: 0 })
					}),
					...StatusRow({
						id: "history-usage",
						label: tr("cost.historyUsage"),
						children: feed.projectionInstalled === true ? tr("cost.historyEnabled") : tr("cost.historyDisabled")
					}),
					...StatusRow({
						id: "model",
						label: tr("cost.statusModel"),
						children: `${currencyText} · ${pricing.modelLabel ?? tr("cost.sourceManual")} · ${pricing.currency}${pricing.input}/${tr("cost.unitMillion")}`
					})
				];

				return React.createElement(
					"div",
					{ className: "dsh-cost-meter-page", "data-cost-meter-card": NS },
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-head" },
						React.createElement("div", { className: "dsh-cost-meter-title" }, tr("cost.pageTitle")),
						React.createElement("div", { className: "dsh-cost-meter-desc" }, tr("cost.pageDescription"))
					),
					unavailable ? React.createElement("div", { className: "dsh-cost-meter-warn" }, tr("cost.cardUnavailable")) : null,
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-card" },
						React.createElement(
							"div",
							{ className: "dsh-cost-meter-cardHead" },
							React.createElement("div", { className: "dsh-cost-meter-cardTitle" }, tr("cost.sectionCatalog")),
							feed.status === "unavailable"
								? null
								: React.createElement(
									"button",
									{
										type: "button",
										disabled: refreshing,
										onClick: () => {
											void catalogStore.refresh();
										}
									},
									refreshing ? tr("cost.refreshing") : tr("cost.refresh")
								)
						),
						React.createElement("dl", { className: "dsh-cost-meter-status" }, statusRows)
					),
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-card" },
						React.createElement(
							"div",
							{ className: "dsh-cost-meter-grid" },
							React.createElement(
								Field,
								{ key: "source", label: LABELS.source },
								React.createElement(
									"select",
									{
										value: staged.source,
										disabled: !writable || busy,
										onChange: (event) => edit("source", event.target.value)
									},
									React.createElement("option", { value: "auto" }, "自动（官方价目）"),
									React.createElement("option", { value: "builtin" }, "内置价目"),
									React.createElement("option", { value: "manual" }, "手动价格")
								)
							),
							React.createElement(
								Field,
								{ key: "model", label: LABELS.model },
								React.createElement(
									"select",
									{
										value: staged.model,
										disabled: !writable || busy,
										onChange: (event) => edit("model", event.target.value)
									},
									models.map((model) => React.createElement("option", { key: model.id, value: model.id }, model.label ?? model.id))
								)
							),
							React.createElement(
								Field,
								{ key: "sourceUrl", label: LABELS.sourceUrl, hint: "中文页按人民币计价；也可填返回同结构 JSON 的地址。" },
								React.createElement("input", {
									type: "text",
									value: staged.sourceUrl,
									disabled: !writable || busy,
									onChange: (event) => edit("sourceUrl", event.target.value)
								})
							),
							React.createElement(
								Field,
								{ key: "usdSourceUrl", label: LABELS.usdSourceUrl, hint: "英文页按美元计价；只有切到美元时才参与显示。" },
								React.createElement("input", {
									type: "text",
									value: staged.usdSourceUrl,
									disabled: !writable || busy,
									onChange: (event) => edit("usdSourceUrl", event.target.value)
								})
							),
							React.createElement(
								Field,
								{ key: "refresh", label: LABELS.refreshMinutes, hint: "0 表示只在打开页面时刷新。" },
								React.createElement("input", {
									type: "number",
									min: 0,
									max: 1440,
									value: staged.refreshMinutes,
									disabled: !writable || busy,
									onChange: (event) => edit("refreshMinutes", event.target.value)
								})
							),
							React.createElement(
								Field,
								{ key: "currency", label: LABELS.currency, hint: "人民币取中文页价目，美元取英文页价目；不做汇率换算。" },
								React.createElement(
									"select",
									{
										value: staged.currency,
										disabled: !writable || busy,
										onChange: (event) => edit("currency", event.target.value)
									},
									React.createElement("option", { value: "CNY" }, tr("cost.currencyCNY")),
									React.createElement("option", { value: "USD" }, tr("cost.currencyUSD"))
								)
							),
							React.createElement(
								Field,
								{ key: "decimals", label: LABELS.decimals },
								React.createElement("input", {
									type: "number",
									min: 0,
									max: 6,
									value: staged.decimals,
									disabled: !writable || busy,
									onChange: (event) => edit("decimals", event.target.value)
								})
							)
						),
						React.createElement(
							"label",
							{ className: "dsh-cost-meter-check" },
							React.createElement("input", {
								type: "checkbox",
								checked: staged.showSavings,
								disabled: !writable || busy,
								onChange: (event) => edit("showSavings", event.target.checked)
							}),
							LABELS.showSavings
						)
					),
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-card" },
						React.createElement(
							"div",
							{ className: "dsh-cost-meter-cardHead" },
							React.createElement("div", { className: "dsh-cost-meter-cardTitle" }, tr("cost.sectionManual")),
							React.createElement("div", { className: "dsh-cost-meter-fieldHint" }, tr("cost.manualHint"))
						),
						React.createElement(
							"div",
							{ className: "dsh-cost-meter-grid" },
							PRICE_FIELDS.map((field) =>
								React.createElement(
									Field,
									{ key: field, label: `${LABELS[field]}（${pricing.currency}/${tr("cost.unitMillion")}）` },
									React.createElement("input", {
										type: "text",
										inputMode: "decimal",
										value: staged[field],
										disabled: !writable || busy,
										onChange: (event) => edit(field, event.target.value)
									})
								)
							),
							React.createElement(
								Field,
								{ key: "offPeakFactor", label: LABELS.offPeakFactor },
								React.createElement("input", {
									type: "text",
									inputMode: "decimal",
									value: staged.offPeakFactor,
									disabled: !writable || busy,
									onChange: (event) => edit("offPeakFactor", event.target.value)
								})
							)
						)
					),
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-card" },
						React.createElement("div", { className: "dsh-cost-meter-cardTitle" }, tr("cost.sectionSchedule")),
						React.createElement(
							"div",
							{ className: "dsh-cost-meter-grid" },
							React.createElement(
								Field,
								{ key: "windows", label: LABELS.peakWindows, hint: tr("cost.scheduleHint") },
								React.createElement("input", {
									type: "text",
									value: staged.peakWindows,
									placeholder: BUILTIN_CATALOGS.CNY.schedule.peakWindows.join(", "),
									disabled: !writable || busy,
									onChange: (event) => edit("peakWindows", event.target.value)
								})
							),
							React.createElement(
								Field,
								{ key: "holidays", label: LABELS.holidays, hint: tr("cost.holidayHint") },
								React.createElement("input", {
									type: "text",
									value: staged.holidays,
									placeholder: "2026-10-01",
									disabled: !writable || busy,
									onChange: (event) => edit("holidays", event.target.value)
								})
							)
						),
						React.createElement(
							"label",
							{ className: "dsh-cost-meter-check" },
							React.createElement("input", {
								type: "checkbox",
								checked: staged.weekdaysOnly,
								disabled: !writable || busy,
								onChange: (event) => edit("weekdaysOnly", event.target.checked)
							}),
							LABELS.weekdaysOnly
						)
					),
					React.createElement("div", { className: "dsh-cost-meter-preview" }, preview),
					failure === null ? null : React.createElement("div", { className: "dsh-cost-meter-error", role: "alert" }, failure),
					React.createElement(
						"div",
						{ className: "dsh-cost-meter-foot" },
						React.createElement(
							"button",
							{ type: "button", "data-primary": "true", disabled: !writable || busy, onClick: () => void save() },
							busy ? tr("cost.saving") : tr("cost.save")
						),
						React.createElement("button", { type: "button", disabled: !writable || busy || draft === null, onClick: () => setDraft(null) }, tr("cost.discard")),
						React.createElement("button", { type: "button", disabled: !writable || busy, onClick: () => void reset() }, tr("cost.reset")),
						React.createElement("span", { className: "dsh-cost-meter-note" }, draft === null ? tr("cost.synced") : tr("cost.dirty"))
					)
				);
			}

			return { CostPillEntry, PlainCostPill, RowErrorBoundary, CostPill, CostSettingsPage, costRows, PeriodBadge };
		}

		/**
		 * Client plugin body.
		 * @param ctx - client cordis context.
		 */
		function apply(ctx) {
			const store = createPriceStore();
			const catalogStore = createCatalogStore();

			// Optional attach: the pill keeps pricing composition defaults while no
			// configuration provider is mounted, so this must not be a hard `inject`.
			ctx.inject(["configForms"], (formsCtx) => {
				store.attach(formsCtx.configForms.get(NS));
			});

			// One polling lifetime for the host-published catalog.
			ctx.effect(() => {
				catalogStore.start();
				return () => catalogStore.stop();
			}, "dsh-cost-meter: catalog feed");

			const ui = createComponents(store, catalogStore, ctx);

			// Additive: a fresh id lands beside the shipped `activity` (order 0) and
			// `usage` (order 1) pills. Reusing a shipped id would replace that cell.
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "cost",
						order: 2
					},
					ui.CostPillEntry
				)
			);

			// This plugin's own page in the Settings sidebar, beside the shipped
			// sections — not a tab buried inside the Plugins section.
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: NS,
						order: 46,
						label: tr("cost.pageTitle")
					},
					ui.CostSettingsPage
				)
			);
		}

		/** The slot registry is the one hard dependency. */
		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * Test-only surface: the pure helpers and the component factory, so the
		 * smoke test can drive the ported pills and panels directly. The loader
		 * reads only `apply`/`inject`.
		 */
		exports.__internals = {
			createComponents,
			createPriceStore,
			createCatalogStore,
			account,
			resolveConfig,
			resolvePricing,
			resolveSchedule,
			periodAt,
			nextChangeAt,
			pickModel,
			parseWindow,
			formatMoney,
			formatAgo,
			formatRemaining,
			formatLocalClock,
			formatTokens,
			formatExactTokens,
			formatCacheHitPercent,
			formatTokensPerSecond,
			billedInputTokens,
			cacheHitPercent,
			interpolate,
			chatFallback,
			BUILTIN_CATALOGS,
			BUILTIN_CATALOG: BUILTIN_CATALOGS.CNY,
			DEFAULTS
		};
		return module.exports;
	}
});
