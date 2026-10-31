# dsh-background-compaction 设计文档

> 状态：**v1.0 定稿，等待开工**（2026-10-31）
> 依据：DSH 桌面版 `2.0.18`、`@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2`、`@deepseek-ai/dsh-compaction@0.2.1-rc.2` 的实机产物
> 本文档只描述设计与契约，不含实现代码。

---

## 0. TL;DR

在 DSH 的 `ctx.compaction` seam 上，用一个**继承 `BasicCompactionEngine` 的替代实现**，把"压缩"拆成两半：

1. **后台生成**：上下文到达阈值的 `startRatio`（默认 85%）时，用一次几乎全缓存的 LLM 调用把"截至上一轮结束"的历史总结好，**暂存（held）**。全程不写日志、不持锁、不阻塞用户。
2. **前台换入**：held 就绪后的**下一个 `agent/pre-step`**，用 `compactRegion` 把 held 直接提交成 checkpoint —— **0 次 LLM 调用**，毫秒级。

于是用户看到的是：**对话从不卡顿；压缩完成后的一次对话，模型收到的是"摘要 + 上一轮原文"。**

`/bcompact <文本>` 复用同一条路径：命令处理器起后台任务 + `agent.followup(文本)`，文本照常成为本轮用户消息并立即回答。

三条不可动摇的约束：

1. **后台任务只读会话、只调 `ctx.llm.stream`，绝不写日志**（不占 `compaction/start` 锁，不产生 surface 变更）。
2. **换入必须走原生 `compactRegion`**，因此后台生成用的 input 必须与引擎将要构建的 input **逐字节一致**，否则指纹不匹配（功能退化为多调一次模型）。
3. **held 有明确失效条件**，任一不满足就丢弃并回退到普通压缩 —— 宁可白花钱，不可用错摘要。

---

## 1. 决策记录

| # | 问题 | 决定 |
|---|---|---|
| Q1 | 压缩何时生效 | **B**：后台生成 → 下一回合 `pre-step` 瞬时提交（不在阈值处等待） |
| Q2 | 压缩后模型看到什么 | **A**：摘要 + **上一整轮原文**；官方 `retainTokens` 只作上限兜底 |
| Q3 | 后台未完成时用户又发消息 | **A**：绝不阻塞，本轮用旧上下文；仅 overflow 时走官方同步兜底 |
| Q4 | `/bcompact` 本轮是否等待 | **A**：立即回答（命令在回合外，处理器只能起后台任务 + `followup`） |
| Q5 | `/bcompact` 文本语义 | 普通用户消息；**空文本 = 纯触发压缩、不开回合** |
| Q6 | 实现底座 | **A**：继承 `BasicCompactionEngine`，覆盖 `compactIfNeeded` / `summarize` |
| Q7 | 官方行为 | `/compact` 保持同步；pruner 保留；overflow 同步兜底；`auto=false` 时后台全停 |
| Q8 | 设置页 | `settings.section` 独立页 `background-compaction`，**只放 3 项**（无总开关） |
| Q9 | 打包 | 包名 `dsh-background-compaction`；只装 `desktop` profile |
| Q10 | 设置存储 | **A**：`~/.dsh/background-compaction/config.json`，**原子写**，文件键覆盖 YAML |
| Q11 | 设置页字段 | 自动触发比例、摘要模型选择、失败熔断次数（**仅此三项**） |
| Q12 | 验收证据 | **A**：`~/.dsh/background-compaction/last-swap.json` 快照 + 日志 |
| Q13 | 仓库 | `git init` + 提交 + push 到 `main`；README 中文 + 英文版 |
| Q14 | 宿主↔客户端 | **A**：Typert remote（`dsh-ops` 手写描述符模式），失败则退 HTTP 路由 |
| Q15 | 模型选择器 | **A**：两级菜单（provider → model），首行"跟随当前对话" |

**已声明的默认值**（用户未反对）：

1. **子 agent 不参与后台预计算** —— 只对 `delegationDepth === 0` 的顶层会话预热；子 agent 继续走官方同步压缩。
2. **单测只覆盖纯函数**（触发策略、指纹、失效矩阵、配置解析、设置合并），不写 LLM 集成测试。
3. **代码注释英文、README 中文 + 英文版、UI 文案 zh+en 双语**（i18n API 强制两套）。
4. **held 不持久化** —— 进程重启即丢，退回普通压缩。

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 后台生成不阻塞任何回合 | 用户输入到首 token 的延迟与未压缩时无差异 |
| G2 | 换入零 LLM 调用 | 单测断言 `llm.stream` 调用次数 |
| G3 | 换入后模型看到"摘要 + 上一轮原文" | `last-swap.json` 快照逐条断言 |
| G4 | `/bcompact` 立即回答，下一轮生效 | 手工验收 + 日志 |
| G5 | 设置页三项即时生效、重启不丢 | 改设置后不重启观察行为变化 |
| G6 | held 失效时静默回退，绝不产出错误 checkpoint | 失效矩阵逐条单测 |
| G7 | `/compact`、pruner、overflow 恢复全部向后兼容 | 手工验收 + 复用 basic 行为 |

### 2.2 非目标（v1 明确不做）

- ❌ held 持久化（进程重启即丢）。
- ❌ 跨会话 / 跨 agent 共享摘要。
- ❌ 新的 checkpoint 渲染组件（复用官方 checkpoint 气泡）。
- ❌ 接管 provider 原生压缩（DSH 无此路径）。
- ❌ 多级摘要 / 摘要的摘要的特殊策略（沿用 basic 的 prior-checkpoint 合并）。
- ❌ 改变 `tokenMeter` 计价规则。
- ❌ 子 agent 的后台预计算。

---

## 3. 已验证的事实（接口地图）

> 全部来自 `E:\AI\dsh\DSH Desktop\resources\app\node_modules\@deepseek-ai\*` 的运行时 JS。这些包**不随附 `.d.ts`**，类型签名取自 `dsh-tool-cordis/lib/types/api-catalog.js` 内嵌的声明文本。

### 3.1 压缩 seam

```
ctx.compaction : CompactionEngine            // 抽象 Service，一个 context 只能挂一个实现
  ├─ compactIfNeeded(agent, trigger, signal) // 'pressure' | 'context-overflow'
  ├─ compactNow(agent, signal, commandId?)   // 手动；内部 runMaintenance 独占
  └─ compactRegion(start, end, agent, signal?) // 公开；owner 硬编码 "current-turn"
```

`dsh-compaction-basic` 的 `BasicCompactionEngine`：

- `export { BasicCompactionEngine, BasicCompactionEngine as default }`
- `static inject = ["llm", "tokenMeter", "sessions"]`
- `static Config` = schemastery `z.object({...})`，**无 `.default()`**，默认值在 `resolveConfig` 里手动补
- 构造器末尾：`this.config = resolveConfig(config); if (this.config.auto) this._registerAutomaticCompaction();`
- `summarize(input, agent, signal)` 是**唯一文档化**的子类钩子（"the sole subclass customization hook"）
- `_registerAutomaticCompaction()` 注册 `agent/pre-step`（pressure）与 `agent/request-error`（overflow）
- `compactIfNeeded` **动态派发**（"stays dynamically dispatched so subclass overrides are honored at event time"）

**关键陷阱（已核实）**：`compactRegion` 内部是
```js
compactSurfaceRegion(..., { owner: "current-turn", stability: "whole-surface" }, signal)
```
而 `compactSurfaceRegion` 在 `owner === "current-turn"` 且 `openTurn === null` 时抛
`compactRegion: no open turn — automatic compaction events must be enclosed in a turn`。

**因此：held 换入只能发生在 `agent/pre-step`（有 open turn），不能发生在 `compactNow` 的 `runMaintenance` 里。**
（v0.1 文档 §7.5 的"手动压缩也换入 held"是错的，v1.0 已删除。）

### 3.1.1 压缩实际挂在哪一层（实现期修正）

**Web 版把压缩放在 agent preset 里，不在宿主平面。** 已核实：

```yaml
# dsh-web-app/cordis.patch.yml
- id: compaction-basic
  disabled: true            # 宿主平面禁用
- id: command-compact
  disabled: true
- id: tool-result-pruner
  disabled: true

# dsh-web-app/presets/standard.patch.yml（ptc / minimal / cordis 同构）
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
    - id: tool-result-pruner
```

后果：

1. 每个 agent 的 `ctx.compaction` 来自 preset，并被 `isolate` 隔离；宿主平面的实现**不会被 agent 看到**。
2. preset 的 `plugins` 是**数据**（`AgentPreset` 只是把配置登记进注册表），不是 Loader 的嵌套 entry 列表，所以通用 patch 方言**无法**按 id 替换其中的 `compaction-basic`。唯一受支持的改法是把整份 `config.plugins` 覆盖进 profile（Web 编辑器就是这么做的），代价是永远失去上游 preset 的更新。
3. 事件会冒泡到根，所以**宿主平面的 `agent/pre-step` 监听器能收到 agent 的事件**（已用真实子 agent 验证）。

**结论（v1.0 实现采用）**：本插件挂在宿主平面，用继承来的 `compactRegion` 自己提交摘要，不依赖自己是 agent 的 `ctx.compaction`；preset 里的原生引擎保留为兜底（摘要没赶上阈值、overflow、`/compact`）。两边共用同一个 `tokenMeter` 与同一套阈值数学，正常路径上原生引擎不会先触发。

### 3.2 阈值数学（必须原样复制）

```js
messageBudgetTokens  = contextWindow - reservedCompletionTokens
pressureBudgetTokens = messageBudgetTokens - headroomTokens
thresholdTokens      = Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudgetTokens))
retainTokens         = retainTokens ?? Math.floor(messageBudgetTokens * retainRatio)
```
- `reservedCompletionTokens = session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0`
- 默认：`thresholdRatio 0.8`、`headroomTokens 65536`、`maxTokens = headroomTokens`、`retainRatio 0.16`
- 200k 窗口代入：`messageBudget 134464`、`pressureBudget 68928`、**`thresholdTokens = 68928`**

> ⚠️ **这是本项目最重要的数字**。DSH 在 200k 窗口上约 **69k** 就压缩，而不是 160k。
> 所有阈值必须用**相对 `thresholdTokens` 的比例**，禁止任何绝对 token 常量（opencode 的 `PRECOMPUTE_MIN_TOKENS = 64_000` 会让 0.85 × 68928 ≈ 58.6k 永远不成立，功能静默死亡）。

`resolveCompactSpec` **未导出**，本插件必须复制这 10 行公式，并用契约测试锁住。

### 3.3 提交事务与 surface

`compactSurfaceRegion` 的顺序（basic `lib/index.js:450-522`）：

```
validateSurfaceRegion(start,end)         // 存在性 + toolPairingBalancedBefore/After
assertCompactionInactive(...)            // 未匹配的 compaction/start = 锁
session.append('compaction/start')       // 持锁，从此不许并发压缩
input = buildSummarizationInput(session, shadowedSeqs)
        = [system head message] + header.tools + 逐 seq deriveEventMessage(...)
summary = await summarize(input, agent, signal)      ← ★ 我们的切入点
assertStable(...)                        // whole-surface 未变
assert framedSummaryTokens < shadowedRouteTokens      // 摘要必须更小
session.append('compaction/summary', { usage, shadowedRange, shadowedSeqs, ... })
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
})
session.append('compaction/end')
```

- `surface` = 可派生消息的事件 seq 有序列表；`deriveMessages()` 是**纯投影**，`replace` 把被遮蔽的节点从派生中删掉。
- `compaction/*` 事件是 **log-only**，不进入 surface，模型永远看不到。
- checkpoint 是一条普通 `user/message`：`CHECKPOINT_PREAMBLE + <compacted-summary>…</compacted-summary>`。
- 每条被遮蔽的节点**必须**出现在 `sourceEventSeqs` 里（session 侧强校验）。

### 3.4 回合与消息派生

- 回合由 `turn/start` … `turn/end` 括起，每步一个 `step/start`/`step/end`。
- 请求消息 = `session.deriveMessages()`（`dsh-agent-loop` 的 `buildRequest`），**深冻结、只读**。
- `agent/request` 明确禁止改写 messages；**没有**任何"改写出站数组"的钩子。
- 唯一能改模型所见内容的干净手段：**surface replace**（压缩用的就是它）。
- `agent/pre-step` 是 waterfall，可返回 `{kind:'enter', messages}` 替换本轮用户消息批；返回的消息会作为真实 `user/message` 落盘。

### 3.5 命令

- 注册：`ctx.commands.register({ definitionId?, name, description, input?: {hint, attachments?}, handler })`
- 名字文法：`/^[a-z][a-z0-9_-]*$/`
- `invocation = { commandId, agent, rawInput, attachments, signal }`；`rawInput` 是命令名之后的**原样文本**（含前导空格，未规范化）
- 命令**跑在任何回合之外**：只 append `command/run` / `command/done`（log-only），不产生 turn、不产生 user 消息
- 命令处理器可以拿 `agent` 主动发消息：`agent.followup(msg)`（新回合）/ `agent.steer(msg)`（本回合下一步）
  - 先例：`/plan <message>` → `agent.steer(createUserMessage({...}))`
- 未匹配的斜杠行会**原样发给模型**（fallthrough）
- 斜杠命令只在 Web GUI 生效；CLI/ACP 会把 `/xxx` 当普通文本

### 3.6 设置与宿主通信

- `ctx.configForms` 是**客户端服务**；写路径 `ctx.remote.settings.mutate(ns, ops, revision)`，宿主侧**只有 `.volatile()` 字段可写**，否则抛 `Config field "…" is not volatile`。
- 插件没有通用 KV；`ctx.storageDomain` 存在（`~/.dsh/storages`，崩溃安全），本插件**不使用**（用户要求自持可手改文件）。
- 宿主→客户端三条路：生成的 Typert Remote / **手写 Typert 描述符**（`dsh-ops` 是唯一第三方先例）/ 自定义 HTTP 路由 + `fetch`（`dsh-pet` 等主流做法）。
- 模型目录：`ctx.remote.session.modelCatalog()` → `{ default, groups: [{ id, name, models: [...] }], failures }`（`groups[].id` 是路由键，不是展示名）。
- "跟随当前对话的模型" = `summarizationProvider` / `summarizationModel` **一对空串**；引擎按 `configured ?? latest ?? agentTarget` 解析，且**两者必须同时为空或同时非空**，否则抛错。
- 子 agent 判定：`Math.max(agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0) === 0` 即顶层。

### 3.7 打包与安装

- `package.json`：`"type":"module"`、`exports["."]` + `exports["./client"]`、`dsh.bundle.patch`、`dsh.client: { inject: [...], platform: "web" }`
- 客户端 bundle **不是普通 ESM**，必须包成 `window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports; } })`
- 安装：包加入 profile 的 `dsh.profile.bundles` + `dependencies`（或 `plugin_manager install_bundle`），再叠加 bundle 的 `cordis.patch.yml`
- 替换官方：在 patch 里禁用 `id: compaction-basic`，插入本插件。`ctx.compaction` 的 `provide` **重名即抛错**，不存在共存
- `dsh-command-compact` 只 `inject: ["commands","compaction"]`，会自动跟随本实现 → `/compact` 无需改动
- 版本闸门用 `peerDependencies`（`@deepseek-ai/dsh-compaction-basic@^0.2.1-rc.2`），不要用 `engines.dsh`（文档与代码冲突）
- UI 组件库：`@deepseek-ai/dsh-client-ui-primitives`（React）。有 `SettingsForm/SettingsValueField/Switch/SegmentedControl/Menu/MenuGroup/MenuSurface/DisclosureRow/Toast` 等，**没有 Slider、没有 Select**
- i18n：`ctx.locale.register(ns, { zh, en })`，**两套必填**

---

## 4. 架构

### 4.1 组件

```
                    ┌──────────────────────────────────────────────┐
  agent/pre-step ──▶│ BackgroundCompactionEngine                    │
                    │  · compactIfNeeded 覆盖（pressure 分支用 held）│
                    │  · summarize 覆盖（指纹命中直接返回 held）      │
                    │  · 自己的 pre-step 钩子（启动 / 提交）          │
                    └───────┬──────────────────────────┬────────────┘
                            │ start()                  │ compactRegion()
                            ▼                          ▼
                    ┌───────────────┐          ┌───────────────────┐
                    │ Precomputer   │          │ basic 原生事务      │
                    │  · 选 range    │          │  锁/稳定性/摘要校验  │
                    │  · buildInput │          └───────────────────┘
                    │  · llm.stream │
                    └───────┬───────┘
                            │ Held
                            ▼
                    ┌───────────────┐
                    │ HeldStore     │  Map<sessionId, Held>
                    │  · 指纹/路由   │  一次性消费
                    │  · TTL/失效   │
                    └───────────────┘

  独立组件：SettingsStore（~/.dsh/background-compaction/config.json，原子写）
            SettingsRemote（Typert，get/update）
            BcompactCommand（/bcompact）
            SettingsPage（客户端，settings.section）
```

| 组件 | 职责 | 不做什么 |
|---|---|---|
| `BackgroundCompactionEngine` | 决定"用 held 还是走老路" | 不直接调 LLM |
| `TriggerPolicy` | 纯函数：测量 + held + 设置 → `start \| skip` | 无副作用 |
| `RangeSelector` | 纯函数：surface + 测量 → 平衡的 `{start,end}` | 不写日志 |
| `Precomputer` | 构建 input、调 LLM、管 AbortController | 不提交、不写事件 |
| `HeldStore` | 内存表 + 失效判定 + 容量上限 | 不持久化 |
| `Fingerprint` | 规范化 input → sha256 | 不做语义比较 |
| `SettingsStore` | 读写 JSON、合并优先级、原子落盘 | 不管 UI |
| `SwapRecorder` | 提交后写 `last-swap.json` | 不改任何状态 |

### 4.2 时序：自动路径

```
turn N-1（measure = 0.86 × T）
  ├─ base pre-step 钩子 → compactIfNeeded('pressure') → 未到阈值 → null
  └─ 本插件 pre-step 钩子
       └─ 0.86T ≥ 0.85T 且 < T → start()  ──┐
                                             │ 游离 Promise（30–60s，不持锁）
                                             ├─ super.summarize(input) → held.ready
                                             └─ 用户全程可继续对话
turn N（held 已就绪）
  ├─ base pre-step 钩子 → compactIfNeeded('pressure')
  │    └─ 若已到阈值 → 本插件覆盖：held 有效 → compactRegion(held.range)
  └─ 本插件 pre-step 钩子 → held 就绪 → compactRegion(held.range)
       ├─ compaction/start
       ├─ summarize() → 指纹命中 → 返回 held（0 次 LLM）
       ├─ compaction/summary（含 held 的真实 usage）
       ├─ user/message + surfaceOp:replace
       └─ compaction/end          → 毫秒级
  └─ 本轮请求 = system + 摘要 + 上一整轮原文 + 本轮用户消息
```

### 4.3 时序：`/bcompact`

```
用户输入 "/bcompact 继续改登录页"
  ├─ GUI 拦截 → commands.execute → 本插件 handler（回合之外，无 open turn）
  ├─ handler: 对当前 surface 起后台任务（range 右端 = 最后一条 user 消息之前）
  ├─ handler: agent.followup(createUserMessage("继续改登录页"))
  ├─ handler: 返回 { kind:'ok', text:'后台压缩已启动…' }
  ├─ 本轮用旧上下文立即回答（不等待）
  └─ held 就绪 → 下一次 pre-step 提交
       → 再下一轮请求 = 摘要 + "/bcompact 那一轮" 原文 + 新消息
```

---

## 5. 数据模型

### 5.1 `Held`

```ts
type Held = {
  sessionId: string
  /** 摘要覆盖的 surface 区间（inclusive，seq） */
  startSeq: number
  endSeq: number
  /** summarize() 入参的规范化指纹，换入时用它匹配 */
  fingerprint: string
  /** 生成时的路由；换模型即失效 */
  target: { provider: string; model: string }
  /** surface 首节点，用于检测会话切换/回滚 */
  headSeq: number
  /** 原样交给 compactRegion 的 summarize 返回值 */
  result: {
    summary: ContentBlock[]
    rawOutput?: ContentBlock[]
    llmStreamCall: true
    provider: string
    model: string
    maxTokens?: number
    usage?: Usage
  }
  createdAt: number
  /** 逐字保留的尾巴 token 数（生成时测得） */
  tailTokens: number
  state: 'running' | 'ready' | 'failed'
  abort: AbortController
  /** 'auto' | 'bcompact'，只用于日志与快照 */
  origin: 'auto' | 'bcompact'
}
```

### 5.2 设置文件

路径：`resolveDshHome()` + `background-compaction/config.json`

```json
{
  "$schema": 1,
  "autoTriggerRatio": 0.85,
  "summarizationModel": { "provider": "", "model": "" },
  "maxFailures": 2
}
```

- `summarizationModel` 的空串对 = **跟随当前对话的模型**（引擎原生语义）。
- 文件里**允许**出现任意合法配置键（高级用户手改）；设置页只写上面 3 个。
- **优先级**：设置文件 > YAML `config` > 内置默认值。
- **原子写**：`write tmp → fsync(tmp) → rename(tmp, target) → fsync(dir)`；写失败保留旧文件并抛给调用方。
- **读失败**（不存在 / 非法 JSON）：记日志、用默认值，**不阻止插件启动**；非法文件在下一次成功写入时被覆盖。

### 5.3 `last-swap.json`（验收证据）

路径：`resolveDshHome()` + `background-compaction/last-swap.json`

```json
{
  "at": 1730000000000,
  "sessionId": "…",
  "origin": "auto",
  "range": { "start": 12, "end": 88 },
  "shadowedTokens": 41230,
  "summaryChars": 1830,
  "tailTokens": 4310,
  "messages": [
    { "role": "system", "chars": 1180, "head": "You are …" },
    { "role": "user",   "chars": 1900, "head": "This is an automatically generated checkpoint …" },
    { "role": "user",   "chars": 220,  "head": "继续改登录页" },
    { "role": "assistant", "chars": 3400, "head": "好的，我先看一下 …" }
  ]
}
```

`messages` 来自提交**之后**的 `session.deriveMessages()` —— 因为 surface 是纯投影，这就是下一轮真正发出去的东西。

---

## 6. 核心流程

### 6.1 触发判定（`TriggerPolicy`，纯函数）

```
输入：measurement, spec, held, settings, agent, now
1  若 delegationDepth(agent) !== 0                  → skip   // 子 agent 不预热
2  若 settings.auto === false 或 config.auto === false → skip
3  若 held?.state === 'running'                     → skip   // 已有在飞
4  若 held?.state === 'ready'                       → skip   // 等提交
5  若 存在未匹配的 compaction/start                  → skip   // 别和真实压缩抢
6  若 measurement.totalTokens >= spec.thresholdTokens → skip  // 已 due，交给前台
7  若 measurement.totalTokens <  spec.thresholdTokens × settings.autoTriggerRatio → skip
8  若 failures >= settings.maxFailures              → skip   // 熔断
9  range = selectRange(session, measurement, spec)
10 若 range === null                                → skip
11 若 最近一次成功请求距今 > cacheWarmMs             → skip   // 冷缓存会重写整段 prompt
12 否则 → start()
```

`selectRange`（纯函数）：

```
nodes = session.surface.nodes                       // nodes[0] = system
1  lastUserIdx = 最后一个 type==='user/message' 的节点下标（且 > 0）
2  endIdx = lastUserIdx - 1                          // ★ 保留上一整轮原文
3  while endIdx > 0 且 !toolPairingBalancedAfter(session, nodes[endIdx]) → endIdx--
4  startIdx = 1
   while startIdx < endIdx 且 !toolPairingBalancedBefore(session, nodes[startIdx]) → startIdx++
5  if startIdx >= endIdx → null
6  tailTokens = Σ nodes[endIdx+1 ..].tokens
   if tailTokens > spec.thresholdTokens × config.background.tailRatio → null   // 尾巴太长
7  shadowedTokens = Σ nodes[startIdx .. endIdx].tokens
   if shadowedTokens < spec.thresholdTokens × config.background.minShadowedRatio → null  // 压太小没意义
8  return { start: nodes[startIdx], end: nodes[endIdx] }
```

> **为什么右端钉在"最后一条 user 消息之前"**：这个位置天然满足 `toolPairingBalancedAfter`，天然保留完整一轮，且不受"生成时正好在一轮中间"影响 —— 生成发生在哪一步，尾巴都从上一轮开始。

### 6.2 后台生成（`Precomputer`）

```
range = selectRange(...)
input = buildSummarizationInput(session, seqs(range))   // 与引擎逐字节一致
        = { tools?, messages: [system?, ...deriveEventMessage(seq)] }
fp    = sha256(canonical(input))                        // 键序规范化后哈希
held  = { range, fp, target, headSeq, state:'running', abort:new AbortController(), origin }
store.set(sessionId, held)

// 游离 Promise：不 await、不转发回合 signal、不写任何事件
super.summarize(input, agent, held.abort.signal)
  .then(result => { held.result = result; held.state = 'ready'; log('held ready') })
  .catch(err => { held.state = 'failed'; failures++; log('held failed') })
```

**必须注意的三件事：**

1. **不要用 `agent.runMaintenance`** —— 它会把"下一次用户输入"挡在门外。后台任务用独立 `AbortController` + 插件作用域内的游离 Promise。
2. **不要转发回合的 `signal`** —— 用户按 Esc 取消当前回合，不应连带杀掉已写了一半的后台总结。
3. **绝不 append 任何事件** —— v1 只写 `ctx.logger` 与 `last-swap.json`。向持久日志追加非 surface 事件有扰动 `tokenMeter` 实测锚点的风险。

### 6.3 提交（换入）

本插件自己的 `agent/pre-step` 钩子（**始终注册**，与 `auto` 无关，因为 `/bcompact` 在 `auto=false` 时也要能提交）：

```
onPreStep({agent, signal}, next):
  if signal.aborted → next()
  held = store.get(session)
  if held?.state !== 'ready' → next()
  if !valid(held, session) → store.delete(); next()
  try:
     result = await this.compactRegion(held.startSeq, held.endSeq, agent, signal)
     store.delete(held)
     recorder.write(session, result, held)          // last-swap.json
     log('swap hit', savedMs)
  catch:
     store.delete(held); log('swap failed', reason)  // 回退：下一轮走普通阈值路径
  return next()
```

`compactIfNeeded` 覆盖（base 的 pressure 钩子会调用它）：

```
compactIfNeeded(agent, trigger, signal):
  if trigger === 'pressure':
     held = store.get(session)
     if held?.state === 'ready' && valid(held, session):
        try: return await this.compactRegion(held.startSeq, held.endSeq, agent, signal)
        catch: store.delete(held)
  return super.compactIfNeeded(agent, trigger, signal)
```

`summarize` 覆盖（换入时命中）：

```
summarize(input, agent, signal):
  fp = fingerprint(input)
  held = store.findByFingerprint(agent.session, fp)
  if held?.state === 'ready':
     return held.result            // 0 次 LLM 调用；不在这里删除（由提交方删除）
  return super.summarize(input, agent, signal)
```

> **为什么用指纹而不是 range**：`summarize()` 的签名只给 `input`。因为 `buildSummarizationInput` 是确定性的，同 range ⇒ 同 input ⇒ 同指纹。
> **风险对冲**：指纹没匹配上时行为退化为"多调一次模型"，**不会产出错误结果**。

### 6.4 `/bcompact`

注册：`ctx.commands.register({ name: 'bcompact', description: '…', input: { hint: '[message]' }, handler })`

```
handler({ agent, rawInput, signal }):
  text = rawInput.trim()
  if 存在未匹配的 compaction/start → return { kind:'error', text:'已有压缩在进行' }
  range = selectRange(agent.session, measure, spec)      // 允许低于阈值
  if range === null → return { kind:'error', text:'没有可压缩的历史' }
  startBackground(agent, range, origin:'bcompact')       // 同上，不 await
  if text.length > 0:
     agent.followup(createUserMessage({ content:[{type:'text', text}], source:{kind:'user'} }))
     return { kind:'ok', text:'后台压缩已启动，本轮继续对话；下一轮将使用压缩后的上下文。' }
  return { kind:'ok', text:'后台压缩已启动（未附带消息，不产生回合）。' }
```

**行为契约**：

- 文本是**普通用户消息**，本轮正常回答，压缩在后台并行。
- 空文本 = 纯触发，**不产生回合**（等价于一个不阻塞的 `/compact`）。
- 即使 `config.auto === false` 也能用（本插件 pre-step 钩子始终注册）。
- 本轮请求仍用旧上下文；若旧上下文超窗，官方 `agent/request-error` → `compactIfNeeded('context-overflow')` → `super` 同步兜底（held 不参与 overflow）。

### 6.5 失败、失效与熔断

| # | 条件 | 判定 | 结果 |
|---|---|---|---|
| V1 | `state !== 'ready'` | 仍在跑 / 失败 | 不换入 |
| V2 | `fingerprint !== hash(本次 input)` | 前缀变了 | `summarize` 走真实调用 |
| V3 | `target` 与当前路由不一致 | 换模型 / 换 maxTokens | 丢弃 |
| V4 | `session.surface.nodes[0] !== held.headSeq` | 新会话 / 回滚 / revert | 丢弃 |
| V5 | 尾巴 token > `tailRatio × threshold` | 尾巴太长 | 丢弃 |
| V6 | 后台调用失败 | `state === 'failed'` | 丢弃，`failures++` |
| V7 | 距今 > `holdTtlMs` | 过期 | 丢弃 |
| V8 | 存在未匹配的 `compaction/start` | 有压缩在跑 | 不启动新任务 |
| V9 | `failures >= settings.maxFailures` | 连续失败 | 停止启动，直到一次成功压缩后清零 |

**并发保护**：监听 `session/event`，收到 `compaction/start` 时立刻 `abort` 该会话的 held —— 覆盖 `/compact`、overflow、以及任何其他压缩路径抢先的情况。

**失败策略**：后台失败**不重试**（等下一次阈值触发），只记日志与计数；换入失败**静默回退**，下一轮走普通阈值路径。

---

## 7. 覆盖清单

| 成员 | 是否覆盖 | 原因 |
|---|---|---|
| `static Config` | ✅ 扩展 | 增加 `background` 段（复制 basic 全部键 + 新段） |
| `constructor` | ✅ | 剥离 `background` 后 `super(ctx, rest)`；解析设置；注册钩子 |
| `compactIfNeeded` | ✅ | pressure 分支优先用 held |
| `summarize` | ✅ | 指纹命中直接返回 held |
| `compactNow` | ❌ 继承 | **无法换入**：它用 `owner: null`，而公开 `compactRegion` 要求 open turn |
| `compactRegion` | ❌ 继承 | 事务逻辑必须原样 |
| `regionDependencies` | ❌ 继承 | 绑定的是 `this.summarize`（动态派发，正确） |
| `_registerAutomaticCompaction` | ❌ 继承 | 自动钩子仍由基类注册；我们另注册自己的 pre-step |

**构造器顺序（关键）：**

```
constructor(ctx, config):
   { background, ...basic } = config          // 剥离自定义键，否则 basic 的严格校验会抛错
   super(ctx, basic)                          // 必须先过 basic 校验
   this.background = resolveBackground(background)
   this.settings   = settingsStore.load()      // 文件 > YAML
   this.applySettingsToConfig()                // 覆盖 summarizationProvider/Model
   this.held = new HeldStore(this.background)
   this._registerBackgroundHooks()             // pre-step / session/event / agent/disposed
```

> ⚠️ `BasicCompactionConfig` 对未知键**直接抛错**，不剥离会导致插件加载失败。
> ⚠️ `this.config` 是构造期解析一次的对象；**热改设置时必须同步更新 `this.config.summarizationProvider/Model`**，否则模型选择不生效。

---

## 8. 设置页

### 8.1 注册

```js
ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bgc: dictionaries')
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'background-compaction', order: 30,
  label: () => t('nav'), locale: NS
}, SettingsPage))
```

### 8.2 内容（**仅三项**）

| 字段 | 控件 | 约束 | 说明 |
|---|---|---|---|
| 自动触发比例 | 数字输入 + 步进 | `0.1 – 0.99`，step `0.05` | 到达 `thresholdTokens × 该值` 时启动后台生成 |
| 摘要模型 | 两级菜单（provider → model） | 首行"跟随当前对话"（存空串对） | 目录来自 `ctx.remote.session.modelCatalog()` |
| 失败熔断次数 | 数字输入 | `0 – 10`，整数 | 连续失败达到该值后停止后台生成 |

- **没有总开关** —— 插件的启用/禁用就是开关。
- **没有只读状态块** —— 验收证据走 `last-swap.json`（Q11 明确"只放三项"）。
- 没有 `Slider` / `Select` 组件：比例用数字输入 + 步进按钮；模型用 `MenuSurface` + `MenuGroup` 两级菜单。
- 文案 zh + en 双语，`locale.register` 两套必填。

### 8.3 读写链路

```
客户端 SettingsPage
  ├─ ctx.remote.backgroundCompaction.get()            → { settings, effective }
  └─ ctx.remote.backgroundCompaction.update(patch)    → { settings }
        │
宿主 SettingsRemote（Typert，手写描述符，参考 dsh-ops/lib/settings/runtime-contract.js）
  ├─ 校验 patch（比例范围 / 整数 / 空串对）
  ├─ SettingsStore.save()  ← 原子写
  ├─ 更新 engine.config.summarizationProvider/Model + engine.background.startRatio/maxFailures
  └─ 下一次 pre-step 立即按新值判定（无需重启）
```

**即时生效的前提**：引擎**不得**在构造器里缓存"解析后的阈值/比例"；每次判定都从 `this.settings` / `this.config` 现取。

---

## 9. 打包与安装

### 9.1 `package.json`（要点）

```json
{
  "name": "dsh-background-compaction",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/host/index.js",
  "exports": {
    ".": "./src/host/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-compaction-basic": "^0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-primitives": "*",
    "react": "*",
    "react-dom": "*"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --test test/",
    "watch": "node scripts/build.mjs --watch"
  }
}
```

> 宿主半边是**纯 ESM 源码，不打包**（`src/host/index.js` 直接作为 `main`）；只有客户端半边需要 esbuild 打包成 `window.__ModuleLoader__` 形态。

### 9.2 `cordis.patch.yml`

```yaml
# 宿主平面的 compaction-basic 由 dsh-web-app 自己禁用；这里再禁一次是为了
# 非 Web 组合（例如 TUI profile）也能安全替换。ctx.compaction 重名即抛错。
- id: compaction-basic
  disabled: true
# 挂载本插件
- insert:
    - id: background-compaction
      name: 'dsh-background-compaction'
      config:
        background:
          startRatio: 0.85
          tailRatio: 0.5
          minShadowedRatio: 0.1
          cacheWarmMs: 300000
          holdTtlMs: 900000
          maxSessions: 8
```

> **不要**尝试在 patch 里替换 preset 内的 `compaction-basic`：preset 的 `plugins` 是数据而不是嵌套 entry 列表，
> 通用方言无法按 id 命中它。见 §3.1.1。本插件不需要替换它。

### 9.3 构建

`scripts/build.mjs`：esbuild，`format: 'cjs'`、`platform: 'browser'`、`target: 'es2022'`、`jsx: 'automatic'`，
`external: ['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-locale']`，
`banner: 'window.__ModuleLoader__.load({ id: "dsh-background-compaction", factory: (require) => {'`、
`intro: 'var module = { exports: {} }; var exports = module.exports;'`、
`footer: 'return module.exports; } });'`，输出 `lib/client.js`。

### 9.4 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:E:/AI/workspace/dsh-plugin/dsh-background-compaction
# 或 pnpm add github:OZONGO/dsh-background-compaction
```
再把包名加入 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH（或依赖 HMR）。

---

## 10. 验收

> 用户要求：**不需要长对话**，只验收三件事 —— 后台压缩、前台继续对话、压缩后的下一次对话。

### 10.1 准备

1. 安装到 `desktop` profile，重启 DSH，确认日志出现 `background-compaction: engine ready`。
2. 打开设置 → **后台压缩**页，确认三项都在、值可改、改完不重启即生效。

### 10.2 用例 A —— `/bcompact` 手动路径

| 步 | 操作 | 期望 |
|---|---|---|
| A1 | 新会话，做 3 轮短对话 | 正常 |
| A2 | 输入 `/bcompact 继续` | **立即**得到回答（不等待压缩）；日志出现 `held ready` |
| A3 | 再发一条消息 | 该轮 `pre-step` 提交 held；日志出现 `swap hit`；`last-swap.json` 生成 |
| A4 | 检查 `last-swap.json` | `messages[0]` 是 system；`messages[1]` 是 checkpoint（含 `<compacted-summary>`）；其后的消息是**上一轮原文** |
| A5 | 输入 `/bcompact`（不带文本） | 返回"已启动（不产生回合）"，**没有**新的助手回答 |

### 10.3 用例 B —— 自动路径

| 步 | 操作 | 期望 |
|---|---|---|
| B1 | 设置页把"自动触发比例"改成 `0.05`（保存，不重启） | 立即生效 |
| B2 | 继续对话若干轮 | 某轮日志出现 `held ready`（后台已生成） |
| B3 | 下一轮 | `swap hit`；`last-swap.json` 更新；本轮请求显著变小 |

### 10.4 用例 C —— 兼容性

| 步 | 操作 | 期望 |
|---|---|---|
| C1 | `/compact` | 走官方同步压缩（`compaction/*` 事件齐全），不报错 |
| C2 | 设置页把"失败熔断次数"改成 `0` | 后台不再启动（日志 `skip: circuit open`） |
| C3 | 压缩过程中按 Esc 取消当前回合 | 后台任务**不**被取消（日志仍出现 `held ready`） |

### 10.5 证据

- `~/.dsh/background-compaction/last-swap.json`（Q12=A）
- DSH 日志中的 `background-compaction:` 前缀行
- 会话日志中的 `compaction/start` / `compaction/summary` / `compaction/end` 与带 `surfaceOp: replace` 的 `user/message`

---

## 11. 风险

| ID | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 上游改 `buildSummarizationInput` | 指纹永不匹配 → 功能静默失效 | 契约测试：同 range 下"我们构建的 input"与"引擎传给 summarize 的 input"深相等 |
| R2 | 阈值公式（未导出）被上游改动 | 触发点漂移 | 复制公式 + 契约测试；日志打印实际 `thresholdTokens` |
| R3 | 冷缓存导致后台重写整段 prompt | 成本暴涨（opencode 实测 25×） | `cacheWarmMs` 闸门 + 日志告警 |
| R4 | 后台任务与真实压缩并发 | 摘要作废 / 白花钱 | 监听 `compaction/start` 立即 abort；启动前检查未匹配锁 |
| R5 | 手写 Typert 描述符与实际协议不符 | 设置页读不到数据 | 先做最小 `get()` 打通，再补 `update()`；失败退 HTTP 路由 |
| R6 | 子类覆盖与上游实现耦合 | 升级即坏 | 覆盖面压到最小（2 个方法）；加载时校验 basic 版本 |
| R7 | 换入时 surface 已变（稳定性校验失败） | 本轮退回普通压缩 | 已有失效矩阵 V2/V4 覆盖 |
| R8 | 设置文件被手改坏 | 插件加载失败 | 解析失败 → 日志 + 默认值，不阻断启动 |
| R9 | 压缩被移出宿主平面（preset 结构变化） | 本插件的 `ctx.compaction` 不是 agent 用的那个 | 本插件不依赖这一点：它用自己的 `compactRegion` 提交。已用真实子 agent 验证 `agent/pre-step` 冒泡到根 |
| R10 | preset 的原生引擎先于本插件触发 | 摘要作废（多花一次调用） | 监听 `compaction/start` 立即 abort；本插件监听器注册更早，正常顺序下先提交 |
| R11 | 宿主代码不支持热加载（`hmr.config.root` 为空） | 改代码必须重启 DSH | 已记录在 README；测试覆盖 95 个用例，其中换入用真实 Session 验证 |

---

## 12. 文件清单与里程碑

```
package.json
cordis.patch.yml
README.md                 # 中文
README.en.md              # 英文
LICENSE                   # MIT
src/host/index.js         # 入口：导出 name/inject/Config/apply
src/host/engine.js        # BackgroundCompactionEngine
src/host/held.js          # HeldStore + fingerprint
src/host/range.js         # selectRange（纯函数）
src/host/policy.js        # TriggerPolicy（纯函数）
src/host/spec.js          # resolveCompactSpec 复刻
src/host/settings.js      # SettingsStore（原子写、合并、校验）
src/host/remote.js        # Typert 描述符 + SettingsRemote
src/host/command.js       # /bcompact
src/host/recorder.js      # last-swap.json
src/client/page.jsx       # 设置页
src/client/model-picker.jsx
src/client/locale.js      # zh + en
scripts/build.mjs         # esbuild → lib/client.js
test/policy.test.js
test/range.test.js
test/fingerprint.test.js
test/settings.test.js
docs/design.zh.md         # 本文档
```

| 阶段 | 交付物 | 退出条件 |
|---|---|---|
| **M0** 骨架 | 入口 + 配置剥离 + 挂载成功 | 能替代 basic 启动，`/compact` 仍可用 |
| **M1** 纯函数 | `spec` / `range` / `policy` / `fingerprint` + 单测 | 单测全绿 |
| **M2** 后台生成 | `Precomputer` + `HeldStore` | 日志可见 `held ready`，无任何事件写入 |
| **M3** 换入 | `compactIfNeeded` / `summarize` 覆盖 + `last-swap.json` | 验收用例 A 通过 |
| **M4** 命令与设置 | `/bcompact` + `SettingsStore` + Typert remote + 设置页 | 验收用例 B、C 通过 |
| **M5** 交付 | README（中/英）+ 构建脚本 + `git init` + push | 仓库可安装、可构建 |

---

## 13. 明确不做的事

- 不做 held 持久化（重启即丢）。
- 不做"摘要的摘要"特殊策略。
- 不做压缩过程的 UI 动画/进度条。
- 不做 CLI/TUI 支持（斜杠命令只在 Web GUI 生效）。
- 不接管 `dsh-compaction-tool-result-pruner`（保留其独立挂载）。
- 不改 `dsh-command-compact`（它自动跟随 `ctx.compaction`）。
- 不改 profile 的 `cordis.patch.yml` 以外的任何官方文件。
