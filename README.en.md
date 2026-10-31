# dsh-background-compaction

> Summarize history **before** the context hits the threshold, so the next turn can use the summary — no stall, no waiting.

A DeepSeek Harness (DSH) plugin. It takes over *when* compaction happens: at 85% of the threshold it spends one nearly-fully-cached model call summarizing everything up to the previous turn in the background; at the next step boundary it commits that summary as a checkpoint with **zero model calls**. The conversation stays usable the whole time.

- Automatic: background generation starts at 85% of the threshold → applied on the next turn
- Manual: `/bcompact <message>` → answers immediately, applied on the next turn
- Settings page: auto trigger ratio, summarization model, failure circuit breaker
- After compaction the model sees: **summary + the previous turn verbatim**

---

## 1. The problem

DSH's built-in compaction (`dsh-compaction-basic`) measures pressure at `agent/pre-step`, and once the threshold is crossed it writes the summary **synchronously** before the turn continues. The user sees a stall.

The slow part is not the input (the prefix hits the provider KV cache) — it is the **output**. So the only effective optimization is to move generation into a window where nobody is waiting.

```
Turn N-1 (context reaches 85%)
  ├─ built-in compaction: below threshold → does nothing
  └─ this plugin: detached task summarizes [first node .. end of previous turn]
                    ↓ (30–60s, the user keeps chatting)
Turn N (summary ready)
  └─ this plugin: pre-step commits the held summary
       ├─ compaction/start
       ├─ summarize() → returns the held summary (0 model calls)
       ├─ compaction/summary + user/message(surfaceOp:replace)
       └─ compaction/end            ← milliseconds
     this turn sends: system + summary + previous turn + new message
```

---

## 2. Install

### 2.1 From a local directory (development)

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:E:/AI/workspace/dsh-plugin/dsh-background-compaction
```

### 2.2 From Git

```bash
cd ~/.dsh/profiles/desktop
pnpm add github:OZONGO/dsh-background-compaction
```

### 2.3 Register the bundle

Add the package to the profile's `package.json`:

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

Then **restart DSH**. Host code is not hot-reloaded: `hmr.config.root` defaults to `[]`, and module-level HMR additionally requires `--expose-internals`.

### 2.4 Confirm it loaded

The host log (`%APPDATA%/DSH Desktop/logs/host/dsh-YYYY-MM-DD.log`) should contain:

```
[background-compaction-engine] background-compaction: engine ready (auto=true, startRatio=0.85, maxFailures=2, state=…)
```

The settings panel should gain a **Background compaction** page.

---

## 3. Usage

### 3.1 Automatic

Nothing to do. When the context reaches `thresholdTokens × autoTriggerRatio`, background generation starts; the next step boundary after the summary is ready applies it.

> **Where the threshold really is**: DSH's `thresholdTokens` is not `contextWindow × 0.8`.
> For a 200k window: `messageBudget = 200000 - 65536`, `pressureBudget = 134464 - 65536`,
> so `thresholdTokens = min(160000, 68928) = **68928**`.
> The 85% trigger is **~58.6k**, not 170k. Every ratio in this plugin is relative to `thresholdTokens`; it never uses an absolute token constant.

### 3.2 `/bcompact [message]`

| Input | Behaviour |
|---|---|
| `/bcompact keep going` | Background compaction starts; `keep going` is answered **immediately** as a normal user message; the next turn uses the summary |
| `/bcompact` | Triggers compaction only, no turn |

Command handlers run outside any turn, so they cannot compact synchronously (`compactRegion` requires an open turn). This command starts the detached task and calls `agent.followup(message)`.

### 3.3 Settings page

**Settings → Background compaction**, three fields, applied live without a restart:

| Field | Range | Meaning |
|---|---|---|
| Auto trigger ratio | 0.1 – 0.99 | Starts background generation at `thresholdTokens × ratio`; default 0.85 |
| Summarization model | provider / model, or "follow the conversation" | Defaults to the model the conversation is using |
| Failure circuit breaker | 0 – 10 | Stops background generation after this many consecutive failures, until one compaction succeeds |

Settings live in `~/.dsh/background-compaction/config.json` and can be edited by hand:

```json
{
  "$schema": 1,
  "autoTriggerRatio": 0.85,
  "summarizationModel": { "provider": "", "model": "" },
  "maxFailures": 2
}
```

**Precedence: settings file > YAML config > built-in defaults.** An empty `summarizationModel` pair means "follow the conversation".

---

## 4. Verifying it works

No long conversation required — three steps:

| Step | Action | Expected |
|---|---|---|
| 1 | New session, 2–3 short turns | Normal |
| 2 | Type `/bcompact keep going` | Answer arrives **immediately**; log shows `held ready` |
| 3 | Send another message | That turn commits the summary at `pre-step`; log shows `swap hit`; `last-swap.json` appears |

Evidence file `~/.dsh/background-compaction/last-swap.json`:

```json
{
  "origin": "bcompact",
  "range": { "start": 4, "end": 5 },
  "shadowedTokens": 41230,
  "tailTokens": 4310,
  "messages": [
    { "role": "system", "chars": 1180, "head": "You are a coding agent…" },
    { "role": "user",   "chars": 1900, "head": "This is an automatically generated checkpoint…" },
    { "role": "user",   "chars": 220,  "head": "keep going" },
    { "role": "assistant", "chars": 3400, "head": "Sure — let me look at…" }
  ]
}
```

`messages` is `session.deriveMessages()` taken **after** the commit. The surface is a pure projection, so this is exactly what the next turn sends.

Log markers:

```
background-compaction: engine ready …     plugin loaded
background-compaction: started …          background generation started
background-compaction: held ready …       summary ready
background-compaction: swap hit …         committed with 0 model calls
background-compaction: discarded …        discarded (reason=…)
background-compaction: summarize miss …   fingerprint missed; real call
```

---

## 5. How it attaches to DSH

**Key fact**: the Web app puts compaction inside **agent presets**, not the host plane.

```yaml
# dsh-web-app/cordis.patch.yml
- id: compaction-basic
  disabled: true            # disabled in the host plane

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

So each agent's `ctx.compaction` comes from its preset and is isolated. This plugin mounts in the **host plane** and works through `agent/pre-step` (events bubble to the root):

- it commits the summary through the inherited `compactRegion` itself — it does not need to be the agent's `ctx.compaction`;
- the preset's built-in engine stays mounted as a **fallback** for the cases where the summary did not arrive in time, context overflow, and `/compact`;
- both use the same `tokenMeter` and threshold arithmetic, so on the normal path the built-in engine never fires first.

This is deliberate: **take over compaction behaviourally, while keeping a fallback that cannot corrupt anything.**

### 5.1 What is overridden

| Member | Override | Why |
|---|---|---|
| `static Config` | yes | adds the `background` section |
| `constructor` | yes | strips `background`, loads settings, registers hooks |
| `compactIfNeeded` | yes | prefers a held summary on the pressure path |
| `summarize` | yes | returns the held summary on a fingerprint hit |
| `compactNow` | **no** | it runs with `owner: null`, while the public `compactRegion` requires an open turn — it cannot swap |
| `compactRegion` | no | the durable transaction must stay untouched |

### 5.2 Invalidation matrix

A summary is only used while the prefix still matches; otherwise it is discarded. Discarding costs one extra call — using a stale one would corrupt the model's view.

| Condition | Result |
|---|---|
| `state !== ready` | not swapped |
| fingerprint differs from this input | `summarize` performs a real call |
| routed provider/model changed | discard |
| surface head node changed | discard |
| tail exceeds `tailRatio × thresholdTokens` | discard |
| older than `holdTtlMs` | discard |
| unmatched `compaction/start` exists | do not start |
| consecutive failures ≥ limit | stop background generation |

In addition, any `compaction/start` (including `/compact` and overflow recovery) **aborts** an in-flight summary immediately.

---

## 6. Configuration reference

### 6.1 YAML (bundle patch or profile patch)

```yaml
- id: background-compaction
  name: 'dsh-background-compaction'
  config:
    # every BasicCompactionEngine key also works here:
    # thresholdRatio, headroomTokens, retainRatio, retainTokens,
    # summarizationProvider, summarizationModel, maxTokens,
    # compactionRetries, maxOverflowRetries, modelPolicies, auto
    background:
      startRatio: 0.85        # overridden by the settings page
      tailRatio: 0.5          # verbatim tail cap, relative to thresholdTokens
      minShadowedRatio: 0.1   # lower bound for the summarized span
      cacheWarmMs: 300000     # cold-cache gate
      holdTtlMs: 900000       # maximum age of a ready summary
      maxSessions: 8          # sessions that may hold a summary
      maxFailures: 2          # overridden by the settings page
```

### 6.2 Subagents

Subagents (`delegationDepth > 0`) do **not** precompute in the background; they keep the built-in synchronous compaction. Their contexts are short, so precomputation would cost more than it saves.

---

## 7. Compatibility

- Changes only *when* compaction happens; checkpoint rendering, log format, and pricing rules are untouched.
- `/compact` keeps the official synchronous semantics.
- The tool-result pruner is untouched.
- Context overflow still recovers synchronously through the official path.
- `auto: false` disables background work entirely.
- Only two methods are overridden; when `@deepseek-ai/dsh-compaction-basic` upgrades, run `npm test` first (it includes a real-Session swap test).

---

## 8. Development

```bash
npm test          # 95 cases: pure functions + real Cordis context + real-Session swap
```

Highlights:

- `test/spec.test.js` — pins the 200k-window threshold to **68928**
- `test/swap.test.js` — runs the full swap against a **real `@deepseek-ai/dsh-session` Session** and asserts the model call count does not grow
- `test/integration.test.js` — real Cordis `Context` with the real `BasicCompactionEngine` superclass
- `test/settings.test.js` — atomic writes, corrupt-file tolerance, unknown-key preservation

For local development the bare `@deepseek-ai/*` specifiers need a link to the DSH installation:

```bash
mkdir -p node_modules
ln -s "<DSH app>/resources/app/node_modules/@deepseek-ai" node_modules/@deepseek-ai
```

(At runtime DSH's overlay resolver handles this; the link is only for local tests.)

---

## 9. License

MIT
