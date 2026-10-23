/**
 * Browser half of the cost meter.
 *
 * `lib/client.js` is the built artifact — a hand-written lazy-CJS bundle in the
 * `window.__ModuleLoader__.load({ id, factory })` envelope consumed by
 * `@deepseek-ai/dsh-client-modules`. It is served verbatim to the page, so this
 * declaration file exists only to document the shape for readers and tooling.
 */

/** Slots this bundle registers into (DSH 0.2.x). */
export interface CostMeterClientRegistrations {
    /** Spend pill, additive beside ui-chat's `activity` and `usage` pills. */
    readonly pill: 'conversation.composer.dock';
    /** Price form, one page of the Plugins settings section. */
    readonly form: 'settings.plugins.tab';
}

/** Required services: the UI slot registry (the price form uses `configForms` optionally). */
export declare const inject: readonly string[];

/**
 * Register the pill and the price form.
 * @param ctx - client cordis context.
 */
export declare function apply(ctx: unknown): void;
