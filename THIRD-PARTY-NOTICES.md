# Third-party notices

`dsh-cost-meter` itself is MIT-licensed (see [LICENSE](LICENSE)). It also **reproduces presentation code** from
another package, which is why this notice exists.

## @deepseek-ai/dsh-client-ui-chat

- Upstream project: DeepSeek Harness — <https://github.com/deepseek-ai/deepseek-harness>
- Package version this port was taken from: `0.2.1-rc.2` (the port started on `0.1.5-rc.1`)
- License: MIT, Copyright (c) 2026 DeepSeek

### What was reproduced

The spend pill is an **additive** entry in `conversation.composer.dock`, so ui-chat's own `activity` and `usage`
pills are no longer replaced and are **not** reproduced here. What the spend pill keeps from upstream is the
presentation of its detail panel and the shared formatters behind the numbers:

| Reproduced | Upstream source |
|---|---|
| `useStatDialog` behaviour (trigger-anchored placement, outside-pointer dismissal, Escape) | `src/client/chat/stat-dialog.ts` |
| The dialog CSS geometry (`1100` z-index rule, panel title/rule/details spacing, the `max-width` clamps) | `src/client/chat/StatDialog.module.css` |
| The pill/anchor/separator CSS rules this entry still renders in the shared dock line | `src/client/chat/StatsPills.module.css` |
| `formatExactTokens`, `formatCacheHitPercent`, `billedInputTokens`, `cacheHitPercent` | `src/client/chat/format.ts`, `src/client/chat/StatsPills.tsx` |

`lib/client.js` marks each ported site. The coin icon, the money formatter, the price form, and the pill's copy are
this package's own; the localized number templates come from the deployment's `chat` dictionary at runtime via
`ctx.locale.bind("chat")`.

The two pills that 0.1.5 ported from `StatsPills.tsx` (`TimePill`, `UsagePill`) and their `formatTokens` /
`formatTokensPerSecond` / `formatDuration` helpers were **removed in 0.2.0**: the shipped entries render them now.

### Upstream license text

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Referenced but not reproduced

`@deepseek-ai/dsh-token-meter`, `@deepseek-ai/dsh-session-stats`, `@deepseek-ai/dsh-settings`,
`@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-ui-settings-plugins`, `@deepseek-ai/cordis` and
`zod` are consumed through their published interfaces (projections, services, slots, schemas) and are **not** copied
into this package. Their own licenses apply to them.

`zod` (MIT, <https://github.com/colinhacks/zod>) is used only to describe the host projection's state and wire view;
the page receives ordinary JSON and does not bundle it.
