/** Host half: the `cost-meter` entry schema and its settings presentation policy. */
import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'cost-meter';

/** Settings namespace this package owns; the browser form is keyed by it. */
export declare const COST_METER_SETTINGS_NAMESPACE: 'cost-meter';

/** Unit prices, currency, and display preferences for the spend pill. */
export interface CostMeterConfig {
    /** Symbol prefixed to every rendered amount. */
    currency: string;
    /** Price denominator: `per-million` (anything else is read as it too). */
    unit: string;
    /** Cache-miss prompt input price. */
    input: number;
    /** Cache-read prompt input price. */
    cacheRead: number;
    /** Cache-write prompt input price. */
    cacheWrite: number;
    /** Completion token price. */
    output: number;
    /** Fraction digits in the rendered amount. */
    decimals: number;
    /** Whether the pill also reports what cache reads saved. */
    showSavings: boolean;
}

/** The entry schema DSH projects into its configuration inventory. */
export declare const Config: z<CostMeterConfig>;

/**
 * Disable the generated settings page for this entry.
 *
 * The browser half owns the form (`settings.plugins.tab`), so DSH's generated
 * page would duplicate it. Mounting no settings provider leaves the plugin on
 * its composition defaults instead of failing.
 *
 * @param ctx - plugin context.
 */
export declare function apply(ctx: Context): void;
