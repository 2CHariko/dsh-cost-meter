---
description: "在 DSH Web 客户端输入区底栏的 token 用量右边显示本会话花费，价格自动取自 DeepSeek 官方价目，并按峰/谷时段自动切换。"
kind: "package-reference"
---

# dsh-cost-meter

[English](README.md) | 中文

在输入区底栏的 **token 用量旁边**显示**本会话花费**，点开有明细。价格由 Host 半从 **DeepSeek 两个官方价目页自动获取**——
中文页人民币（默认）、英文页美元——再通过同源路由发给页面，所以装完不需要手填价格。

用量按**每次请求实际发生的时刻**计价，而不是按页面渲染时的时钟：Host 投影把每条 provider 用量折进“本地日期 + 峰/谷”
桶，时间取请求**开始**时刻；页面再用**每日价目快照**逐日计价。所以上午跑的任务按峰价、下午跑的任务按谷价，跨过
12:00 不会把整段历史重新打折。官方价目里谷价正好是峰价的一半。

它是 `@deepseek-ai/dsh-token-meter` 事件流的**纯消费者**——不计量、不碰模型请求、不写会话日志，只是把已有的
provider 用量样本乘上“请求开始时”生效的那组单价。

装上之后那一行是：

```
⬤ 4 轮 68 步 · 191 tok/s   ⬤ 25.7M tok · 缓存命中 99%   ⬤ ¥2.277 谷
```

前两个 pill 是 ui-chat 自带的；第三个是本插件按会话实际记录用量算出的账单。徽标保持单字——峰时 `峰`、谷时 `谷`；
点开的面板分别列出峰时与谷时的 token 和金额，混合会话在面板里可见，但不会改变徽标。

前两个 pill 是 ui-chat 自己的，第三个是本插件的分桶账单（带当前时段徽标），点开是它自己的详情面板。

## 目录

- [为什么不需要改 Host 的计量本体](#why-no-host-change)
- [安装](#install)
- [价格怎么来](#pricing)
- [设置](#configure)
- [卸载](#uninstall)
- [实现要点](#implementation)
- [兼容性与版本策略](#compatibility)
- [变更记录](CHANGELOG.md)
- [已知限制](#limitations)
- [开发](#development)
- [验证状态](#verification)
- [许可](#license)

-----

<a id="why-no-host-change"></a>
## 为什么不需要改 Host 的计量本体

那一行由 `@deepseek-ai/dsh-client-ui-chat` 的两个独立条目渲染，都注册在**列表**槽
`conversation.composer.dock` 里，而且只读两个 Host 投影：

| 屏幕上的内容 | 来源 |
|---|---|
| `4 轮 68 步`、`191 tok/s` | `sessionStats` 投影（整本日志折叠，`dsh-session-stats`） |
| `25.7M tok`、`缓存命中 99%` | `tokenUsage` 投影（`dsh-token-meter`） |

`tokenUsage` 的线上值恰好是四个**互不重叠**的计费桶：

```
{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
```

其中 `uncachedInputTokens = usage.inputTokens`（未命中缓存的输入），缓存读/写单独计。于是花费就是一次乘加：

```
cost = (uncached·P_in + cacheRead·P_read + cacheWrite·P_write + output·P_out) / 计价分母
```

`dsh-llm` 的模型元数据（`LlmModelInfo`）**完全没有价格字段**，`llm-pi-ai` 和任何路由目录也都不提供价格——
所以 Host 半自己去读 DeepSeek 公布的价目表。时钟不再为整段会话只选一列：每条用量样本按**请求开始**时刻折进
“日期 + 峰/谷”桶，页面逐日计算 `峰时用量 × 峰价 + 谷时用量 × 谷价`，并使用当日生效的价目快照。

<a id="install"></a>
## 安装

两条路**只选一条**，不要混用：`dsh plugin add` 走 pnpm，之后任何一次 `pnpm install` 都会把手工拷进去的目录
当成多余依赖删掉。

下面的例子用 `desktop` profile（桌面版默认打开的 profile）。如果你跑的是纯浏览器的 `dsh web` profile，
把 `--profile desktop` 换成 `--profile web`（脚本用 `-Profile web`）。

### A. 官方路径（pnpm / GitHub）

```powershell
dsh plugin --profile desktop add github:2CHariko/dsh-cost-meter
```

它会在 profile 目录里转发给 pnpm，于是 `$DSH_HOME\profiles\desktop\package.json` 多一条依赖，包（以及它的
`@deepseek-ai/schemastery` 依赖）落到该 profile 的 `node_modules` 里——loader 正是从那里解析裸标识符。

装包不等于装配——pnpm 从不改组合。把下面这段追加到 `$DSH_HOME\profiles\desktop\cordis.patch.yml`：

```yaml
# >>> dsh-cost-meter
- insert:
    - id: cost-meter
      name: dsh-cost-meter
# <<< dsh-cost-meter
```

整行就这样：schema 默认值（`source: auto`、`model: deepseek-flash`、官方价目的 USD）就是起点，设置页会把改动写回
这个条目的配置。`config:` 块是可选的——旧 0.2.x 行里如果还留着四个价格，也能继续加载，那组数字会变成"手动价格"
的回退值。

### B. 离线 / 脚本路径

```powershell
pwsh -File install.ps1                 # 默认 desktop profile
pwsh -File install.ps1 -Profile web    # 纯浏览器 profile
```

给没有 npm 网络的机器，或者直接从 checkout 安装。脚本做两件事，都可重复执行：

1. 把包拷到 `$DSH_HOME\profiles\<profile>\node_modules\dsh-cost-meter`（profile 目录是 loader 解析裸标识符的
   锚点，profile 自己的 `node_modules` 是第一站）；
2. 把上面的 `- insert:` 块插进 `$DSH_HOME\profiles\<profile>\cordis.patch.yml`，改之前先备份成
   `cordis.patch.yml.bak-<时间戳>`。

### 两条路径共同点

DSH 0.2.x 在启动时读取 profile 的 patch 文档。装完**重启一次应用**（只有部分 profile 开了配置热加载），
再**刷新一次 Web 页面**，让它取到新的客户端 bundle。

### 自检

```powershell
# 1. 行是否进入组合树（无警告且出现 - id: cost-meter 即正确）
dsh --profile desktop --dump-config | Select-String cost-meter
# 2. profile 能否解析两个半侧、Host 半能否 import、行 config 能否过 schema
node test\verify-install.mjs --profile desktop
```

<a id="pricing"></a>
## 价格怎么来

Host 半读取两个官方页面——<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（人民币）与
<https://api-docs.deepseek.com/quick_start/pricing>（美元）——解析各自的模型价格表，再通过
`/dsh-cost-meter/prices` 一起发布给页面。价格均为每百万 token，2026-10-23 读取，**默认人民币**：

| 模型 | 桶 | 人民币峰价 | 人民币谷价 | 美元峰价 | 美元谷价 |
|---|---|---|---|---|---|
| `deepseek-flash`（V4.1-Flash） | 缓存读取 | `¥0.04` | `¥0.02` | `$0.006` | `$0.003` |
| | 未命中输入 | `¥2` | `¥1` | `$0.30` | `$0.15` |
| | 输出 | `¥8` | `¥4` | `$1.20` | `$0.60` |
| `deepseek-v4-pro` | 缓存读取 | `¥0.30` | `¥0.15` | `$0.044` | `$0.022` |
| | 未命中输入 | `¥9` | `¥4.5` | `$1.32` | `$0.66` |
| | 输出 | `¥27` | `¥13.5` | `$3.96` | `$1.98` |

缓存写入 DeepSeek 不计费，保持 0。

**高峰时段**为 UTC `01:00–04:00`、`06:00–10:00`，周一至周五，中国法定节假日除外——也就是北京时间
09:00–12:00、14:00–18:00（中文页按北京时间书写，解析器会换算成 UTC）。其余时刻（含周末与节假日）都是谷价，
价格减半。每条请求按**开始时刻**归档：生成过程中跨过边界不会重新计价。底栏徽标保持单字（`峰` / `谷`），
表示当前时段；历史峰谷拆分放在面板的两行里。

**每日价目快照**：从 0.5.0 起，每次成功刷新都会在 `~/.dsh/cost-meter-prices` 下写入/更新当天（北京时间）的快照。
路由只发送压缩后的“价格变更点”列表，页面按用量发生日期选择当日生效的价目。修改高峰时段、工作日或节假日会注销并
重新注册投影，用新规则重算历史；切换币种或模型不会触发重折叠。

两张表都**内置**在两个半侧里：首屏渲染、或 Host 取不到某个页面时仍然能算钱；某个币种刷新失败会保留它上一份好
数据，并在设置页显示是哪个币种失败、原因是什么；如果官方页面改版导致解析不出任何模型，Host 会保留旧表而不是把
价格清零。

<a id="configure"></a>
## 设置

**设置 → 花费金额（估算）**——本插件在设置侧边栏里的独立页面，和「通用」「模型」并列。

| 字段 | 含义 |
|---|---|
| 价格来源 | `自动` 用抓取到的官方价目，`内置价目` 不联网用内置表，`手动价格` 用你填的四个峰价 |
| 计价模型 | 用价目里的哪个模型计价（`deepseek-flash` / `deepseek-v4-pro`） |
| 计价币种 | `人民币（¥）` 默认取中文页价目；`美元（$）` 取英文页价目。不做汇率换算 |
| 人民币价目地址 / 美元价目地址 | 自动模式下分别抓取的页面或 JSON 地址；接受同结构 `{ code, currency, models }` 的 JSON |
| 自动刷新间隔（分钟） | Host 的抓取周期，0–1440；0 表示只在页面请求时刷新 |
| 金额小数位 | 0–6，默认 3 |
| 同时显示缓存省下的金额 | 账单里多加一行对照省额（`cacheRead × (P_in − P_read)`） |
| 手动峰价 | 未命中输入、缓存读取、缓存写入、输出（每百万 token，按所选币种），只在手动模式生效 |
| 谷价折扣系数 | 手动模式下的谷价倍率，默认 `0.5` |
| 高峰时段（UTC） | 留空跟随官方价目；填则用逗号分隔的 `HH:MM-HH:MM` 覆盖 |
| 高峰仅限工作日 | 时段是否只在周一至周五生效 |
| 节假日（北京时间） | `YYYY-MM-DD` 列表，这些日期全天按谷价，例如 `2026-10-01` |

页面会显示当前时段、下次切换时刻、**两个币种**价目的新鲜度（以及各自的失败原因）和刷新按钮。保存走 0.2.x 的
`configForms` 控制器写入 profile 的 `cost-meter` 条目配置；「重置为默认」会 unset 所有被覆盖的字段。**不再写
`~/.dsh/settings.yaml`**：DSH 0.2.x 只把那份旧文档导入一次，然后改名，配置改放在 profile 里。

**手动模式下四个价格都为 0 时，pill 显示「花费未配置」**，悬停提示指向设置页，而不是编一个金额出来；自动与内置
模式总会解析出真实价格。

<a id="uninstall"></a>
## 卸载

```powershell
# A. 官方路径
dsh plugin --profile desktop remove dsh-cost-meter
# B. 脚本路径（同时移除 patch 里的整段标记块与安装目录）
pwsh -File install.ps1 -Uninstall
```

两条路都要**手工删掉 patch 文件里的标记块**，然后重启并刷新。删掉那块之后，输入区底栏就只剩 ui-chat 自己的
两个 pill。

<a id="implementation"></a>
## 实现要点

| 路径 | 作用 |
|---|---|
| `lib/index.js` | Host 半：导出 `Config` schema、关掉自动生成的设置页（`auto: false`）、抓取两个官方价目、注册 `costMeterUsageByDay` 投影、记录每日价目快照，在 Web 服务器上提供 `/dsh-cost-meter/prices` 与 `/dsh-cost-meter/refresh` |
| `lib/catalog.js` | 无依赖的价格表解析器（HTML 行、markdown 投影或 JSON 价目）、人民币/美元与时段识别，加内置种子表 |
| `lib/period-usage.js` | 把持久化用量事件折成“本地日期 + 峰/谷”桶的纯函数，按请求开始时刻归档，并沿用 token-meter 的替换/重试规则 |
| `lib/history.js` | `~/.dsh/cost-meter-prices` 下的每日快照文件，以及压缩成价格变更点列表 |
| `lib/client.js` | 手写的 lazy-CJS 客户端 bundle：一个**追加式**底栏 pill、按历史时段与价目版本计价的解析器，以及本插件的设置页 |
| `test/catalog.mjs` | 用两份和真实页面同形状的合成页（rowspan、版本行、并发行、北京时间说明）验证解析器按币种只保留表头模型 |
| `test/period-usage.mjs` | 用合成事件验证跨边界、重试、流式 attempt、节假日与本地日期分桶 |
| `test/history.mjs` | 验证每日快照压缩成价格变更点、缺失币种继承、当天更新原地替换 |
| `test/smoke.mjs` | 走真实的 `window.__ModuleLoader__` 信封做冒烟测试（React 是 shim，因为部署里只有预构建前端） |
| `test/verify-install.mjs` | 安装后复现 loader 的解析：两个半侧都能解析、Host 半能 import、行 config 过 schema |

客户端 bundle 为什么手写：`@deepseek-ai/dsh-client-modules` 会把每个声明了 `dsh.client` 的包的
`lib/client.js` 原样发给页面执行，而生成这种信封的构建预设（`packages/client/tsdown.client.ts`）并不是已发布
包——所以 DSH checkout 之外的插件自己写信封。factory 可以 `require` 平台种子表：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。这些都是基线请求，所以
`dsh.client.external` 不声明任何东西。

两个注册点（都对照页面可查的槽目录核对过）：

```
conversation.composer.dock   list, session  → 追加条目 { id: "cost", order: 2 }，
                                              排在 ui-chat 的 "activity"(0) 和 "usage"(1) 之后
settings.section             list, root     → 设置侧边栏里的独立页面，id "cost-meter"，order 46，
                                              label 花费金额（估算）
```

价格分两层读取：价目表来自 Host 路由（一个小的轮询 store，进入页面和手动点刷新时更新），配置来自 0.2.x 的客户端
服务 `ctx.configForms.get("cost-meter")`（它是被移除的 `settingsScope` 的后继），用 uSES 订阅、用
`mutate(ops, revision)` 写入。`tokenUsage` 通过会话作用域槽的标准 `useProjection` 属性拿到。两者都会立刻重渲染，
所以**保存设置不需要刷新**。

`Config` 里每个字段都标了 `.volatile()`，这不是装饰而是硬条件：DSH 的设置投影（`volatileForm`）**只**描述含有
volatile 字段的条目，并且交给插件的是实时引用（`{ get() }`）而不是普通值。没有这个标记，条目根本不会出现在
`settings.describe()` 里，`configForms` 永远为空，设置页的所有控件就会一直处于禁用状态。因此 Host 在每次请求和
每分钟的 tick 里都通过 `currentConfig()` 读取一次实时值，保存后无需重挂载即可生效；保存成功还会立刻让 Host 重新
抓取价目。

### 为什么这次是"追加"而不是"接管"

0.1.5 把两个 pill 放在同一个 `stats` 格子里，只有用更低的 `priority` 遮蔽它，才能把花费 pill 放到 token pill
右边。0.2.x 把那格拆成了 `activity` 和 `usage` 两个条目，而列表槽会渲染**每一个**注册，于是没有东西需要遮蔽：
用一个新 id 配一个更大的 `order`，自然就排在它们旁边。所以这一版不再复刻 ui-chat 的两个 pill、两个面板和那套
格式化函数。

追加的代价是那两个 pill 归上游管——上游改了什么这里自动跟着变（这正是想要的）；花费 pill 只保留自己那份三列
账单面板的几何布局（仍源自 ui-chat 的 `stat-dialog`，见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）。

面板定位与点外关闭复用平台种子的 `useAnchoredPosition` / `useDismissOnOutsidePointer`（缺这两个导出时回落到
本地实现）。面板文案来自本包；需要本地化数字的部分走部署自己的 `chat` 词典
（`ctx.get("locale").bind("chat")`），没有 locale 服务时用内置中文兜底。

条目外面包了 `RowErrorBoundary`：带样式的 pill 抛错时降级成纯文本金额，底栏永远不会整段消失。

<a id="compatibility"></a>
## 兼容性与版本策略

本插件的版本与 DSH **相互独立**，但它依赖 DSH 的槽协议、客户端服务名和投影键——这些都不是稳定 API。

| dsh-cost-meter | 验证过的 DSH | 说明 |
|---|---|---|
| `0.5.2` | `0.2.1-rc.2` | 仓库迁移到 `2CHariko/dsh-cost-meter`；文档与包元数据更新（无行为变化） |
| `0.5.1` | `0.2.1-rc.2` | 底栏徽标恢复单字（`峰` / `谷`）表示当前时段；面板保留按历史时段的峰谷拆分 |
| `0.5.0` | `0.2.1-rc.2` | 按请求开始时刻计价，Host 投影折成“日期 + 峰/谷”桶；`~/.dsh/cost-meter-prices` 每日价目快照 |
| `0.4.1` | `0.2.1-rc.2` | 设置页恢复可操作：`Config` 字段全部标了 `.volatile()`，`settings.describe()` 才会暴露该条目、`configForms` 不再为空；Host 改为读取实时引用 |
| `0.4.0` | `0.2.1-rc.2` | 默认用中文页人民币价目，一键切到英文页美元价目；两张表一起抓取发布，北京时段换算成 UTC |
| `0.3.0` | `0.2.1-rc.2` | 同源路由动态获取官方价目、按 UTC 时段/工作日/节假日自动区分峰谷价、设置侧边栏里的独立页面 |
| `0.2.1` | `0.2.1-rc.2` | 预置 DeepSeek 官方默认价（只写在 schema，patch 行不带 `config:`）；pill 字号与面板的模糊/圆角对齐官方静态 UI |
| `0.2.0` | `0.2.1-rc.2` | 迁移到 0.2.x 契约：追加式底栏条目、`settings.plugins.tab` 表单、`configForms` 取代 `settingsScope`、`Config` + `auto: false` 取代 `settings.installSection` |
| `0.1.0` | `0.1.5-rc.1` | 首个版本；接管 `stats` 格，单价通过 `settingsScope` 读写 |

`peerDependencies` 带着这个范围（`@deepseek-ai/dsh-settings@^0.2.1-rc.2`、`@deepseek-ai/cordis@^4.0.2`），
所以版本不匹配在安装时就能看见。

版本怎么走：

- **PATCH** —— 文档、注释、内部整理，不改行为。
- **MINOR** —— 新增配置字段或新增展示内容；旧配置继续有效。
- **MAJOR** —— 任何**需要不同 DSH 版本**的改动：槽协议变了、投影键改名、客户端服务改名。这类改动不会让插件
  报错，只会让 pill 悄悄消失，所以必须按 MAJOR 发。

`0.2.0` 不是稳定版：槽 id、`configForms` 服务和设置页策略都是 0.2.x 的契约，还可能再动。升级 DSH 之后，
重新跑一遍[自检](#install)里的两条命令。逐版本说明在 [CHANGELOG.md](CHANGELOG.md)。

<a id="limitations"></a>
## 已知限制

- **会话级聚合没有路由维度**：中途换过 provider/模型的会话，所有 token 会按设置页选中的模型计价。单路由会话不受
  影响；要精确得在投影里增加 route 桶。
- **历史价目从本版本开始**：每日快照从 0.5.0 第一次成功刷新那天起才有。更早的用量没有历史表，按当前价估算，面板会
  标明受影响的日期数。快照精度是一天（北京时间），当天中途改价要等下一次刷新观察到。
- **只统计 provider 上报的用量**：被打断、或没上报用量的步骤不计费，所以这是账本估算，不是对账单。
- **`cacheWriteTokens` 各家含义不同**：DeepSeek 恒为 0，而 Anthropic 式缓存写入是单独的溢价档，需要自己的单价。
- **页面够不到 Host 设置 API 时没有配置界面**：表单会明说，pill 继续按组合配置计价。
- **升级 DSH 不会动这个包**：它住在 profile 里，不在 DSH 安装目录——但 0.2.x 的槽/服务 API 一动，
  `lib/client.js` 就得跟着动。
- **价格来自两个公开页面**：DeepSeek 改版后解析器可能找不到某张价格表。此时 Host 会保留该币种上一份好数据（或
  内置表），设置页会显示解析错误；把对应的「人民币/美元价目地址」换成一个同结构 JSON 地址即可完全绕开 HTML 解析。
- **人民币与美元是两张独立价目，不是汇率换算**：切换币种只是换用对应的表和符号，插件从不套用汇率。
- **不抓取节假日日历**：周末自动识别，但中国法定节假日需要在设置页里列出来才按谷价计。列表就是普通日期串，
  不会悄悄过期。
- **Host 会汇报活跃包**：DSH 每个官方 API 请求都会带上所有活跃 loader 包的 `{name, version}` 用于诊断，
  所以 `package.json` 里的 `name`/`version` 必须真实非空（元数据不合法会直接让请求准备失败）。

<a id="development"></a>
## 开发

```powershell
npm run check        # node --check 三个模块
npm test             # 解析器 + 时段折叠 + 价目历史 + 客户端 bundle（注册、按历史计价、价目 store、设置页、全部回落状态）
npm run test:install -- --profile desktop   # 装完以后：两个半侧可解析、Host 半可 import、行 config 过 schema
```

`catalog.mjs` 覆盖两份页面真实的形状：两个表头列、以 `DeepSeek-` 开头的版本行、只有裸数字的并发行、rowspan
拆开的时段行、带「元」后缀的价格、中文页用北京时间书写的时段（换算成 UTC）、英文页的 `UTC` 说明、JSON 价目和
markdown 投影。它存在的意义是：朴素的扫描会把并发上限读成第三个模型的价格。

`smoke.mjs` 覆盖：bundle 信封与导出面、追加式底栏注册的 id/order（且不声明遮蔽 priority）、
`settings.section` 设置页的 id/order/label、固定时刻下的峰/谷/工作日/节假日解析、人民币默认与美元切换、模型选择、
手动价回退、四桶计费算术、价目 store 的 Host 往返与"刷新失败保留上一份好数据"、pill 的时段徽标、账单面板的时段与
单价行、空会话什么都不渲染、没有投影座位时什么都不渲染、错误边界回落、设置页从快照播种、`mutate(ops, revision)`
写入路径，以及缺 `react-dom`/`primitives` 时的降级渲染。`verify-install.mjs` 复现
loader 的解析（`createRequire` 以 profile manifest 为锚点，与 `cordis-plugin-loader` 把 profile 目录当
`parentURL` 的行为一致），确认 `dsh-cost-meter`、`dsh-cost-meter/client`、`@deepseek-ai/schemastery` 都能从该
profile 解析，并断言不带覆盖的 patch 行会解析成 `auto` 来源加内置 flash 价。

### 三个容易踩的坑（都已在代码里规避）

- **`cordis.patch.yml` 里新增行必须包在 `- insert:` 里。** 裸的 `- id: x` 是**补丁**，只作用于已存在的同名条目；
  没有时只会打印 `patch: entry "x" not found` 然后跳过——静默失效。语义来自 `dsh-app-boot` 的
  `applyEntryPatches`。
- **清空 patch 文件会留下 `null`。** 只有注释的文件解析成 `null` 而不是空列表，所以 `-Uninstall` 在发现文档
  没有条目时会补回 `[]`。
- **底栏条目的 `id` 就是它的格键。** 复用上游 id（`activity`、`usage`）会占**那一格**并替换它；新 id（`cost`）
  才是追加在旁边。保持 id 独立，正是这个插件"追加式"的关键。

<a id="verification"></a>
## 验证状态

已在本机对照 DSH `0.2.1-rc.2` 验证：

- 行进入了组合树（用户 patch 层里出现 `cost-meter`，无警告）；
- profile 能解析两个半侧并 import Host 半（`apply` / `Config` / 命名空间常量都在），行 config 过 schema；
- Host 路由能用两个官方页面完成一次真实抓取与解析，人民币与美元价目都包含两个模型的峰价与谷价两列；
- 真实会话的 `costMeterUsageByDay` 投影把事件折进了峰/谷两个桶，四个桶之和与同一会话的 `tokenUsage` **完全相等**
  （拆分既不漏计也不重复）；`/dsh-cost-meter/refresh` 会把当天快照写进 `~/.dsh/cost-meter-prices`，并以一条价格变更点发布；
- `/dsh-cost-meter/refresh` 返回 `settingsServed: true`，说明 DSH 的设置投影已经暴露该条目，设置页表单可写，
  而不是永远禁用；
- 运行中的页面已经注册了本插件的设置页（`cost-meter`，order 46），底栏仍是上游 `activity`、`usage` 之后的追加
  条目（`cost`，order 2）；
- 冒烟测试全绿（注册、按历史日期计价、峰谷解析、价目 store、计价 pill、设置页、全部回落状态）；
- 安装后的 `lib/client.js` 与 `lib/index.js` 与本仓库里跑过冒烟测试的版本**逐字节一致**（SHA256 比对）。

未验证（需要浏览器会话）：运行中的页面是否真的把 pill 排在上游两个之后、面板能否打开、设置侧边栏页能否写回 Host。
如果重启刷新后底栏不对，按[卸载](#uninstall)删掉标记块即可回退。

<a id="license"></a>
## 许可

MIT，Copyright (c) 2026 2CHariko。见 [LICENSE](LICENSE)。

本包复刻了 `@deepseek-ai/dsh-client-ui-chat`（同为 MIT）的展示代码；出处与声明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
