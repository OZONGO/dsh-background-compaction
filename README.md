# dsh-background-compaction

> 在上下文到达阈值**之前**就把历史总结好，下一次对话直接使用摘要 —— 不卡顿、不等待。

DeepSeek Harness（DSH）插件。它接管压缩的**触发时机**：在阈值 85% 处用一次几乎全缓存的模型调用，把"截至上一轮"的历史在后台总结成摘要；摘要就绪后的下一个回合边界，用 **0 次模型调用**把它提交成 checkpoint。用户全程可以继续对话。

- 自动路径：到达阈值 85% 开始后台生成 → 下一回合生效
- 手动路径：`/bcompact <消息>` → 立即回答，下一回合生效
- 设置页：自动触发比例、摘要模型、失败熔断次数
- 压缩后模型看到的是：**摘要 + 上一整轮原文**

---

## 1. 它解决什么问题

DSH 原生压缩（`dsh-compaction-basic`）在 `agent/pre-step` 时测压 → 超过阈值 → **同步**调用一次模型写摘要 → 提交 checkpoint。这段时间用户看到的是"卡住"。

慢的不是输入（前缀命中 KV 缓存），而是**输出**。所以唯一有效的优化是：把生成挪到不需要等待的时间窗里。

本插件做的事：

```
回合 N-1（上下文到 85%）
  ├─ 原生压缩：没到阈值 → 什么都不做
  └─ 本插件：起一个游离任务，后台总结 [首节点 .. 上一轮结束]
               ↓（30~60s，用户继续对话）
回合 N（摘要已就绪）
  └─ 本插件：pre-step 提交 held 摘要
       ├─ compaction/start
       ├─ summarize() → 直接返回 held（0 次模型调用）
       ├─ compaction/summary + user/message(surfaceOp:replace)
       └─ compaction/end            ← 毫秒级
     本轮请求 = system + 摘要 + 上一轮原文 + 本轮消息
```

---

## 2. 安装

### 2.1 从本地目录安装（开发）

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:E:/AI/workspace/dsh-plugin/dsh-background-compaction
```

### 2.2 从 Git 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:OZONGO/dsh-background-compaction
```

### 2.3 注册 bundle

把包名加入 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-background-compaction"]
    }
  },
  "dependencies": {
    "dsh-background-compaction": "file:E:/AI/workspace/dsh-plugin/dsh-background-compaction"
  }
}
```

然后**重启 DSH**（宿主代码不支持热加载：`hmr.config.root` 默认为空，模块级 HMR 还需要 `--expose-internals`）。

### 2.4 确认加载

宿主日志（`%APPDATA%/DSH Desktop/logs/host/dsh-YYYY-MM-DD.log`）应出现：

```
[background-compaction-engine] background-compaction: engine ready (auto=true, startRatio=0.85, maxFailures=2, state=…)
```

设置面板左侧应出现 **后台压缩** 一页。

---

## 3. 使用

### 3.1 自动

什么都不用做。上下文到达 `thresholdTokens × 自动触发比例` 时后台开始生成；摘要就绪后的下一个回合自动生效。

> **注意阈值的真实位置**：DSH 的 `thresholdTokens` 不是 `contextWindow × 0.8`。
> 以 200k 窗口为例：`messageBudget = 200000 - 65536`、`pressureBudget = 134464 - 65536`，
> 所以 `thresholdTokens = min(160000, 68928) = **68928**`。
> 85% 触发点是 **~58.6k**，不是 170k。本插件所有比例都相对 `thresholdTokens`，从不使用绝对 token 常量。

### 3.2 `/bcompact [消息]`

| 输入 | 行为 |
|---|---|
| `/bcompact 继续改登录页` | 后台开始压缩；`继续改登录页` 作为普通用户消息**立即**回答；下一回合使用摘要 |
| `/bcompact` | 只触发压缩，不产生回合 |

命令跑在回合之外，所以它**不可能**同步压缩（`compactRegion` 要求 open turn）。它做的是：起后台任务 + `agent.followup(消息)`。

### 3.3 设置页

**设置 → 后台压缩**，三项，改完立即生效，无需重启：

| 字段 | 范围 | 说明 |
|---|---|---|
| 自动触发比例 | 0.1 – 0.99 | 达到 `thresholdTokens × 该值` 时启动后台生成，默认 0.85 |
| 摘要模型 | provider / model，或"跟随当前对话" | 默认跟随当前对话的模型 |
| 失败熔断次数 | 0 – 10 | 连续失败达到该值后停止后台生成，直到一次压缩成功 |

设置保存在 `~/.dsh/background-compaction/config.json`，可以直接手改：

```json
{
  "$schema": 1,
  "autoTriggerRatio": 0.85,
  "summarizationModel": { "provider": "", "model": "" },
  "maxFailures": 2
}
```

**优先级：设置文件 > YAML 配置 > 内置默认值。** `summarizationModel` 的空串对表示"跟随当前对话"。

---

## 4. 验收

不需要长对话，三步即可：

| 步 | 操作 | 期望 |
|---|---|---|
| 1 | 新会话，做 2–3 轮对话（读一个文件就够，总量几百到几千 token） | 正常 |
| 2 | 输入 `/bcompact 继续` | **立即**得到回答；日志出现 `held ready` |
| 3 | 再发一条消息 | 该轮 `pre-step` 提交摘要；日志出现 `swap hit`；生成 `last-swap.json` |

> `/bcompact` 需要一个**非空且平衡**的可压缩区间（绝对下限 512 token）；历史太短会返回"历史太短，压缩没有意义"。
> 自动路径的门槛更高：被压缩区间至少是 `thresholdTokens` 的 10%（200k 窗口约 6.9k token）。

证据文件 `~/.dsh/background-compaction/last-swap.json`：

```json
{
  "origin": "bcompact",
  "range": { "start": 4, "end": 5 },
  "shadowedTokens": 41230,
  "tailTokens": 4310,
  "messages": [
    { "role": "system", "chars": 1180, "head": "You are a coding agent…" },
    { "role": "user",   "chars": 1900, "head": "This is an automatically generated checkpoint…" },
    { "role": "user",   "chars": 220,  "head": "继续" },
    { "role": "assistant", "chars": 3400, "head": "好的，我先看一下…" }
  ]
}
```

`messages` 来自提交**之后**的 `session.deriveMessages()`。因为 surface 是纯投影，这就是下一轮真正发出去的东西。

日志关键字：

```
background-compaction: engine ready …     引擎加载
background-compaction: started …          后台生成开始
background-compaction: held ready …       摘要就绪
background-compaction: swap hit …         0 调用换入
background-compaction: discarded …        失效丢弃（reason=…）
background-compaction: summarize miss …   指纹没命中，回退真实调用
```

---

## 5. 它是怎么接进 DSH 的

**关键事实**：Web 版把压缩放在 **agent preset** 里，而不是宿主平面。

```yaml
# dsh-web-app/cordis.patch.yml
- id: compaction-basic
  disabled: true            # 宿主平面禁用

# dsh-web-app/presets/standard.patch.yml
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

所以每个 agent 的 `ctx.compaction` 来自 preset，并且被 `isolate` 隔离。本插件挂在**宿主平面**，通过 `agent/pre-step`（事件会冒泡到根）工作：

- 它**自己**用继承来的 `compactRegion` 提交摘要 —— 不依赖自己是 agent 的 `ctx.compaction`；
- preset 里的原生引擎继续存在，作为**兜底**：摘要没赶上阈值、上下文溢出、`/compact` 都由它处理；
- 两者用同一套 `tokenMeter` 与阈值数学，所以在正常路径上原生引擎永远不会先触发。

这是有意的设计：**行为上接管压缩，同时保留一个不会出错的退路**。

### 5.1 覆盖了哪些方法

| 成员 | 处理 | 原因 |
|---|---|---|
| `static Config` | 扩展 | 增加 `background` 段 |
| `constructor` | 覆盖 | 剥离 `background`、读设置、注册钩子 |
| `compactIfNeeded` | 覆盖 | pressure 分支优先用 held |
| `summarize` | 覆盖 | 指纹命中直接返回 held |
| `compactNow` | **不覆盖** | 它用 `owner: null`，而公开 `compactRegion` 要求 open turn —— 无法换入 |
| `compactRegion` | 不覆盖 | 事务逻辑必须原样 |

### 5.2 失效矩阵

摘要只在前缀仍然一致时使用；否则丢弃（宁可白花钱，不可用错摘要）。

| 条件 | 结果 |
|---|---|
| `state !== ready` | 不换入 |
| 指纹与本次 input 不符 | `summarize` 走真实调用 |
| 路由（provider/model）变了 | 丢弃 |
| surface 首节点变了 | 丢弃 |
| 尾巴超过 `tailRatio × thresholdTokens` | 丢弃 |
| 超过 `holdTtlMs` | 丢弃 |
| 有未匹配的 `compaction/start` | 不启动新任务 |
| 连续失败 ≥ 熔断次数 | 停止后台生成 |

另外：任何 `compaction/start`（包括 `/compact` 与 overflow 恢复）都会**立即中止**在飞的摘要任务。

---

## 6. 配置参考

### 6.1 YAML（bundle patch 或 profile patch）

```yaml
- id: background-compaction
  name: 'dsh-background-compaction'
  config:
    # 透传给 BasicCompactionEngine 的键同样可用：
    # thresholdRatio, headroomTokens, retainRatio, retainTokens,
    # summarizationProvider, summarizationModel, maxTokens,
    # compactionRetries, maxOverflowRetries, modelPolicies, auto
    background:
      startRatio: 0.85        # 设置页的“自动触发比例”覆盖它
      tailRatio: 0.5          # 逐字尾巴上限（相对 thresholdTokens）
      minShadowedRatio: 0.1   # 被压缩区间的下限
      cacheWarmMs: 300000     # 冷缓存闸门：最近一次请求超过该值则不启动
      holdTtlMs: 900000       # 摘要最长存活
      maxSessions: 8          # 同时保留摘要的会话数
      maxFailures: 2          # 设置页的“失败熔断次数”覆盖它
```

### 6.2 子 agent

子 agent（`delegationDepth > 0`）**不做**后台预计算，继续走原生同步压缩。子 agent 上下文短，预热的收益抵不上成本。

---

## 7. 兼容性

- 只替换压缩的**触发时机**，不改变 DSH 的 checkpoint 渲染、日志格式或计价规则。
- `/compact` 保持官方同步语义。
- 工具结果 pruner 保留。
- 上下文溢出仍走官方同步恢复。
- `auto: false` 时后台完全停止。
- 子类只覆盖 2 个方法；`@deepseek-ai/dsh-compaction-basic` 升级时先跑 `npm test`（含真实 Session 的换入测试）。

---

## 8. 开发

```bash
npm test          # 102 个用例：纯函数 + 真实 Cordis 上下文 + 真实 Session 换入
```

测试要点：

- `test/spec.test.js` —— 200k 窗口的阈值必须等于 **68928**（锁死阈值数学）
- `test/swap.test.js` —— 用**真实的 `@deepseek-ai/dsh-session` Session** 跑完整换入，断言"模型调用次数不增加"
- `test/integration.test.js` —— 真实 Cordis `Context` + 真实 `BasicCompactionEngine` 父类
- `test/remote.test.js` —— 客户端内联的 Remote 契约必须与宿主模块一致
- `test/settings.test.js` —— 原子写、损坏文件容错、未知键保留

### 8.1 把包链进 profile 时**必须用真链接**

Git Bash 的 `ln -s` 在目录上会**退化成复制**（Windows 上除非启用 `MSYS=winsymlinks:nativestrict`）。
复制会得到一个冻结的快照：之后所有代码改动都不会生效，而且症状极其误导 ——
插件能加载、日志正常、只有新代码不出现。

用 PowerShell 建目录联接（junction）：

```powershell
New-Item -ItemType Junction `
  -Path "$HOME\.dsh\profiles\desktop\node_modules\dsh-background-compaction" `
  -Target "E:\AI\workspace\dsh-plugin\dsh-background-compaction"
```

或者直接用 `pnpm add file:<path>`（pnpm 自己会建正确的链接）。

本地跑测试时同理，`node_modules/@deepseek-ai` 也必须是**链接**而不是复制 ——
否则运行时会加载第二份 DSH 包，得到不同的 `Service` 类对象：

```powershell
New-Item -ItemType Junction `
  -Path "node_modules\@deepseek-ai" `
  -Target "<DSH app>\resources\app\node_modules\@deepseek-ai"
```

---

## 9. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 设置页报 `cannot get property "remote.<ns>" without inject` | 渲染进程还在跑旧 bundle | 完全退出 DSH Desktop 再打开；页面底部的 `build bX` 告诉你跑的是哪一版 |
| 改了代码但行为没变、日志也没有新行 | profile 里是**拷贝**而不是链接 | 见 §8.1，改成 junction |
| 设置页报 `settings remote is not mounted` | `ctx.remote.$mount` 失败 | 看宿主日志里 `settings remote unavailable` 那一行 |
| `/bcompact` 回"历史太短" | 可压缩区间不足 512 token | 多聊两轮或读一个文件 |

---

## 9. 许可

MIT
