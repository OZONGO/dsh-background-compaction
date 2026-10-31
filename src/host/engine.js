/**
 * Background compaction engine.
 *
 * Shape: summarize ahead of the threshold in a detached task, then commit the
 * finished summary on the next step boundary with **zero model calls**. The
 * foreground engine (`BasicCompactionEngine`) still owns the durable
 * transaction, the compaction lock, overflow recovery, and `/compact`; this
 * subclass only decides *which range* to compact and *where the summary text
 * comes from*.
 *
 * Two overrides carry the whole feature:
 *
 * - {@link BackgroundCompactionEngine#summarize} returns a ready held summary
 *   when the replay input fingerprint matches, and otherwise defers to the
 *   base implementation.
 * - {@link BackgroundCompactionEngine#compactIfNeeded} prefers a held summary
 *   on the pressure path so a finished background result is never thrown away
 *   in favour of a synchronous call.
 *
 * `compactNow` is deliberately **not** overridden: it runs inside
 * `agent.runMaintenance`, where `owner: null` forbids the public
 * `compactRegion` (which hard-codes `owner: "current-turn"` and throws without
 * an open turn). Manual `/compact` therefore stays a real synchronous
 * compaction, which is also what the user asked for.
 *
 * @module dsh-background-compaction/engine
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { join } from 'node:path'

import { registerBcompact } from './command.js'
import { Config, resolveBackground, splitConfig } from './config.js'
import { HeldStore, heldInvalidReason } from './held.js'
import { buildSummarizationInput, fingerprint, shortFingerprint } from './input.js'
import { decideBackgroundPreconditions, decidePressureStart } from './policy.js'
import { selectRange } from './range.js'
import { describeSwap, writeSwapSnapshot } from './recorder.js'
import { mountSettingsRemote } from './remote.js'
import { SettingsStore } from './settings.js'
import { resolveCompactSpec, resolveTargetPolicy, routedTarget } from './spec.js'

/** Logger prefix for every line this plugin emits. */
export const LOG_PREFIX = 'background-compaction:'

/**
 * Absolute usefulness floor for a user-requested `/bcompact`.
 *
 * The automatic path uses a threshold-relative floor (10% of ~68928 tokens on a
 * 200k window) because compacting a tiny span there is pure waste. A manual
 * request is different: the user asked for it, so only a span too small to
 * produce a smaller summary than it replaces is refused.
 */
export const MANUAL_MIN_SHADOWED_TOKENS = 512

/**
 * Resolve the delegation depth of an agent without importing the subagent
 * package: a top-level agent is depth 0.
 * @param {object} agent - agent loop instance.
 * @returns {number} non-negative delegation depth.
 */
export function delegationDepthOf(agent) {
  const runtime = agent?.options?.subagentDepth
  const persisted = agent?.session?.header?.delegationDepth
  return Math.max(Number.isSafeInteger(persisted) ? persisted : 0, Number.isSafeInteger(runtime) ? runtime : 0)
}

/**
 * Whether a failure means "not now" rather than "this summary is wrong".
 * @param {unknown} error - thrown value.
 * @returns {boolean} `true` when the held summary should be kept.
 */
function isDeferred(error) {
  return error instanceof ManualCompactionError && error.code === 'busy'
}

/**
 * Background compaction engine.
 *
 * Registered as `ctx.compaction`; it replaces `dsh-compaction-basic` rather than
 * running beside it, because a Cordis context allows exactly one provider per
 * service name and a duplicate `provide` throws at load time.
 */
export class BackgroundCompactionEngine extends BasicCompactionEngine {
  static Config = Config
  static inject = ['llm', 'tokenMeter', 'sessions']

  /** Resolved `background` section. */
  background
  /** Plugin-owned settings. */
  settingsStore
  /** In-memory summaries. */
  held
  /** Detached background promises, kept only so shutdown can settle them. */
  pending = new Set()
  /** Consecutive background failures. */
  failures = 0
  /** Timestamp of the last background failure, for the half-open breaker. */
  lastFailureAt = 0
  /** Last routed-request timestamp per session, for the cold-cache gate. */
  lastRequestAt = new Map()
  /** Cached model capacity per `provider/model`. */
  modelInfo = new Map()
  /** Compaction-lock state per session. */
  compactionState = new Map()
  /** Targets already warned about for unusable capacity. */
  warnedTargets = new Set()
  /** Last skip reason logged per session, so steady states do not spam the log. */
  skipReasons = new Map()
  /** Ratio pair already warned about as unable to ever trigger. */
  #ratioWarning

  /**
   * @param {object} ctx - owning Cordis context.
   * @param {object} config - Loader-provided configuration.
   */
  constructor(ctx, config = {}) {
    const { basic, background } = splitConfig(config)
    super(ctx, basic)
    this.background = resolveBackground(background)
    this.baseSummarization = {
      provider: this.config.summarizationProvider,
      model: this.config.summarizationModel,
    }
    this.stateDirectory = join(resolveDshHome(), 'background-compaction')
    this.settingsStore = new SettingsStore({ directory: this.stateDirectory })
    const loaded = this.settingsStore.load()
    if (!loaded.ok) {
      ctx.logger.warn(
        `${LOG_PREFIX} ignoring unreadable settings file ${this.settingsStore.file}: ${loaded.error?.message}`,
      )
    }
    this.settingsStore.subscribe(() => this.#applySettings())
    this.held = new HeldStore({ maxSessions: this.background.maxSessions })
    this.#applySettings()
    this.#registerHooks()
    this.#registerIntegrations()
    ctx.logger.info(
      `${LOG_PREFIX} engine ready (auto=${this.config.auto}, startRatio=${this.startRatio}, maxFailures=${this.maxFailures}, state=${this.stateDirectory})`,
    )
  }

  /**
   * Effective background start ratio.
   *
   * The settings file wins only when it actually carries the key, so a YAML
   * `background.startRatio` stays in force until the settings page writes it.
   * @returns {number} ratio in (0,1).
   */
  get startRatio() {
    const store = this.settingsStore
    return store.has('autoTriggerRatio') ? store.get().autoTriggerRatio : this.background.startRatio
  }

  /**
   * Effective circuit-breaker limit, with the same precedence as
   * {@link BackgroundCompactionEngine#startRatio}.
   * @returns {number} non-negative failure count.
   */
  get maxFailures() {
    const store = this.settingsStore
    return store.has('maxFailures') ? store.get().maxFailures : this.background.maxFailures
  }

  /**
   * Fold settings into the frozen engine configuration.
   *
   * `resolveConfig` deep-freezes its result, so live settings changes replace
   * the `config` property instead of mutating it. An empty summarization pair
   * means "follow the conversation model", which is also the YAML default.
   */
  #applySettings() {
    const settings = this.settingsStore.get()
    const pair = settings.summarizationModel.provider.length > 0 ? settings.summarizationModel : this.baseSummarization
    this.config = Object.freeze({
      ...this.config,
      summarizationProvider: pair.provider,
      summarizationModel: pair.model,
    })
    this.#warnIfUnusable()
  }

  /**
   * Warn when the effective ratios can never produce a start.
   *
   * `resolveBackground` validates the YAML pair, but the settings page can move
   * the start ratio below `minShadowedRatio`; at that point every span is too
   * small by construction and the feature would die without a symptom.
   */
  #warnIfUnusable() {
    const ratio = this.startRatio
    const floor = this.background.minShadowedRatio
    if (floor < ratio) {
      this.#ratioWarning = undefined
      return
    }
    const key = `${floor}/${ratio}`
    if (this.#ratioWarning === key) return
    this.#ratioWarning = key
    this.ctx.logger.warn(
      `${LOG_PREFIX} minShadowedRatio (${floor}) is not below the effective start ratio (${ratio}); background generation cannot start`,
    )
  }

  /** Register the lifecycle hooks this engine adds. */
  #registerHooks() {
    const { ctx } = this
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          await this.#onPreStep(agent, signal)
        } catch (error) {
          ctx.logger.warn(`${LOG_PREFIX} pre-step failed: ${error?.message ?? error}; continuing the turn`)
        }
      }
      return next()
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/start') {
        this.#noteCompaction(session, true)
        const running = this.held.get(session.id)
        // A *ready* summary is intentionally left alone: our own commit appends
        // `compaction/start` before `summarize()` runs, and deleting it here
        // would turn the swap into a full synchronous summarization.
        if (running?.state === 'running') {
          running.abort.abort(new Error('another compaction started'))
          this.held.delete(session.id)
          ctx.logger.info(`${LOG_PREFIX} discarded in-flight summary session=${session.id} reason=compaction-started`)
        }
        return
      }
      if (event.type === 'compaction/end') {
        this.#noteCompaction(session, false)
        return
      }
      if (event.type === 'session/end-seed') {
        // A constructor-seed boundary proves any open marker belongs to an
        // earlier process lifecycle: the lock is stale, not active.
        this.compactionState.set(session.id, { active: false, initialized: true })
        return
      }
      if (event.type === 'request/header' || event.type === 'request/context' || event.type === 'assistant/message') {
        this.lastRequestAt.set(session.id, Date.now())
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = agent?.session?.id
      if (sessionId === undefined) return
      const held = this.held.get(sessionId)
      if (held !== undefined) {
        if (held.state === 'running') held.abort.abort(new Error('agent disposed'))
        this.held.delete(sessionId)
      }
      this.lastRequestAt.delete(sessionId)
      this.compactionState.delete(sessionId)
      this.skipReasons.delete(sessionId)
    })
    ctx.effect(
      () => () => {
        this.held.clear()
        this.pending.clear()
      },
      'background-compaction: dispose held summaries',
    )
  }

  /** Wire the `/bcompact` command and the settings remote when available. */
  #registerIntegrations() {
    const { ctx } = this
    ctx.inject(['commands'], (scope) => {
      try {
        registerBcompact(scope, this)
      } catch (error) {
        ctx.logger.warn(`${LOG_PREFIX} /bcompact unavailable: ${error?.message ?? error}`)
      }
    })
    ctx.inject(['typert'], (scope) => {
      try {
        mountSettingsRemote(scope, this)
      } catch (error) {
        ctx.logger.warn(`${LOG_PREFIX} settings remote unavailable: ${error?.message ?? error}`)
      }
    })
  }

  /**
   * Track the compaction lock incrementally.
   * @param {object} session - session that emitted the event.
   * @param {boolean} active - whether a compaction just started or ended.
   */
  #noteCompaction(session, active) {
    this.compactionState.set(session.id, { active, initialized: true })
  }

  /**
   * Whether the session has an unmatched `compaction/start`.
   *
   * Mirrors the base engine's `assertCompactionInactive`: an opening marker that
   * precedes the latest `session/end-seed` belongs to an earlier process
   * lifecycle, so a crash mid-compaction does not disable the session forever.
   *
   * @param {object} session - target session.
   * @returns {boolean} `true` while a compaction transaction is open.
   */
  #compactionLocked(session) {
    const state = this.compactionState.get(session.id)
    if (state?.initialized === true) return state.active
    // First sighting (the plugin can attach to a live session): scan once.
    let active = false
    let startSeq
    let endSeedSeq
    const end = session.seq ?? 0
    for (let seq = 0; seq < end; seq += 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'compaction/start') {
        active = true
        startSeq = event.seq ?? seq
      } else if (event.type === 'compaction/end') {
        active = false
      } else if (event.type === 'session/end-seed') {
        endSeedSeq = event.seq ?? seq
      }
    }
    const locked = active && !(endSeedSeq !== undefined && startSeq !== undefined && endSeedSeq > startSeq)
    this.compactionState.set(session.id, { active: locked, initialized: true })
    return locked
  }

  /**
   * Resolve token budgets for the routed target.
   * @param {object} session - target session.
   * @param {{provider: string, model: string}} target - routed target.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} resolved spec.
   */
  async #specFor(session, target, signal) {
    const key = `${target.provider}/${target.model}`
    let info = this.modelInfo.get(key)
    if (info === undefined) {
      const resolved = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      info = { contextWindow: resolved?.context?.contextWindow, defaultMaxTokens: resolved?.defaultMaxTokens }
      this.modelInfo.set(key, info)
    }
    const header = session.requestHeader()
    const reserved = header?.config?.maxTokens ?? info.defaultMaxTokens ?? 0
    const policy = resolveTargetPolicy(this.config, target)
    return resolveCompactSpec(policy, info.contextWindow, reserved)
  }

  /**
   * Log a skip reason once per state change.
   *
   * `agent/pre-step` runs on every step, so an unconditional line would turn a
   * long generation into thousands of identical entries.
   *
   * @param {string} sessionId - session that was skipped.
   * @param {string} reason - skip reason from the policy.
   */
  #noteSkip(sessionId, reason) {
    if (this.skipReasons.get(sessionId) === reason) return
    this.skipReasons.set(sessionId, reason)
    this.ctx.logger.info(`${LOG_PREFIX} skip session=${sessionId} reason=${reason}`)
  }

  /**
   * Age of the last background failure, for the half-open breaker.
   * @returns {number} milliseconds, or `Infinity` when nothing ever failed.
   */
  #failureAgeMs() {
    return this.lastFailureAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastFailureAt
  }

  /**
   * Step-boundary work: commit a ready summary, then maybe start a new one.
   * @param {object} agent - agent owning the session.
   * @param {AbortSignal} signal - turn cancellation.
   */
  async #onPreStep(agent, signal) {
    const session = agent.session
    const held = this.held.get(session.id)
    if (held !== undefined && held.state === 'ready') {
      const outcome = await this.#swap(agent, held, signal)
      if (outcome.ok) return
    }
    if (!this.config.auto) return
    await this.#maybeStart(agent, signal)
  }

  /**
   * Commit one ready summary through the native transaction.
   * @param {object} agent - agent owning the session.
   * @param {object} held - ready held record.
   * @param {AbortSignal} signal - turn cancellation.
   * @returns {Promise<{ok: true, result: object} | {ok: false}>} swap outcome.
   */
  async #swap(agent, held, signal) {
    const session = agent.session
    const target = routedTarget(session)
    if (target === undefined) {
      this.held.delete(session.id)
      this.ctx.logger.info(`${LOG_PREFIX} discarded summary session=${session.id} reason=routed-target-changed`)
      return { ok: false }
    }
    let spec
    try {
      spec = await this.#specFor(session, target, signal)
    } catch (error) {
      this.held.delete(session.id)
      this.ctx.logger.warn(
        `${LOG_PREFIX} discarded summary session=${session.id} reason=spec: ${error?.message ?? error}`,
      )
      return { ok: false }
    }
    // Measure *after* the capacity lookup: this snapshot is what the invalidation
    // rules and the commit itself will see.
    const measurement = this.ctx.tokenMeter.measure(session)
    const reason = heldInvalidReason(held, {
      session,
      measurement,
      spec,
      background: this.background,
      target,
      now: Date.now(),
    })
    if (reason !== null) {
      this.held.delete(session.id)
      this.ctx.logger.info(`${LOG_PREFIX} discarded summary session=${session.id} reason=${reason}`)
      return { ok: false }
    }
    try {
      const result = await this.compactRegion(held.startSeq, held.endSeq, agent, signal)
      this.held.delete(session.id)
      this.failures = 0
      this.lastFailureAt = 0
      const snapshot = describeSwap(session, result, held, {
        origin: held.origin,
        thresholdTokens: spec.thresholdTokens,
        totalTokens: measurement.totalTokens,
      })
      const written = await writeSwapSnapshot(this.stateDirectory, snapshot)
      this.ctx.logger.info(
        `${LOG_PREFIX} swap hit session=${session.id} origin=${held.origin} range=${result.shadowedRange.start}-${result.shadowedRange.end} shadowed=~${result.shadowedTokenCount}t modelCalls=0` +
          (written.ok ? ` evidence=${written.file}` : ` evidence-failed=${written.error?.message}`),
      )
      return { ok: true, result }
    } catch (error) {
      // "Busy" means another compaction owns the lock and an aborted turn means
      // the user cancelled: the summary is still correct, only the timing is
      // wrong, so keep it for the next step boundary.
      if (isDeferred(error) || signal?.aborted === true) {
        this.ctx.logger.info(
          `${LOG_PREFIX} swap deferred session=${session.id} reason=${isDeferred(error) ? 'compaction-busy' : 'aborted'}`,
        )
        return { ok: false }
      }
      this.held.delete(session.id)
      this.ctx.logger.warn(
        `${LOG_PREFIX} swap failed session=${session.id}: ${error?.message ?? error}; falling back to threshold compaction`,
      )
      return { ok: false }
    }
  }

  /**
   * Start background generation when the policy allows it.
   * @param {object} agent - agent owning the session.
   * @param {AbortSignal} signal - turn cancellation.
   */
  async #maybeStart(agent, signal) {
    const session = agent.session
    const target = routedTarget(session)
    const blocked = decideBackgroundPreconditions({
      delegationDepth: delegationDepthOf(agent),
      auto: this.config.auto,
      heldState: this.held.get(session.id)?.state,
      locked: this.#compactionLocked(session),
      failures: this.failures,
      maxFailures: this.maxFailures,
      failureAgeMs: this.#failureAgeMs(),
      failureCooldownMs: this.background.failureCooldownMs,
      hasTarget: target !== undefined,
    })
    if (blocked !== null) {
      this.#noteSkip(session.id, blocked)
      return
    }
    let spec
    try {
      spec = await this.#specFor(session, target, signal)
    } catch (error) {
      const key = `${target.provider}/${target.model}`
      if (!this.warnedTargets.has(key)) {
        this.warnedTargets.add(key)
        this.ctx.logger.warn(`${LOG_PREFIX} background disabled for ${key}: ${error?.message ?? error}`)
      }
      return
    }
    // The capacity lookup yields: a concurrent step may have started a summary
    // for this session in the meantime, so re-check before spending a call.
    if (this.held.get(session.id) !== undefined) return
    const measurement = this.ctx.tokenMeter.measure(session)
    const gate = {
      totalTokens: measurement.totalTokens,
      thresholdTokens: spec.thresholdTokens,
      startRatio: this.startRatio,
      lastRequestAgeMs: Date.now() - (this.lastRequestAt.get(session.id) ?? 0),
      cacheWarmMs: this.background.cacheWarmMs,
    }
    // Pressure and cache gates need no span: most steps sit far below the start
    // ratio, and this runs inside the pre-step waterfall.
    if (decidePressureStart({ ...gate, hasRange: true }) !== null) return
    const range = selectRange(session, measurement, spec, this.background)
    const reason = decidePressureStart({ ...gate, hasRange: !('skip' in range) })
    if (reason !== null) {
      this.#noteSkip(session.id, reason)
      return
    }
    this.startGeneration(agent, range, 'auto', spec)
  }

  /**
   * Start one detached summarization task.
   *
   * The task never appends session events and never forwards the turn signal:
   * pressing Esc cancels the turn, not a summary that is already half written.
   *
   * @param {object} agent - agent owning the session.
   * @param {object} range - selected span from {@link selectRange}.
   * @param {'auto'|'bcompact'} origin - who asked for it.
   * @param {object} spec - resolved budgets.
   * @returns {object} the running held record.
   */
  startGeneration(agent, range, origin, spec) {
    const session = agent.session
    const input = buildSummarizationInput(session, range.seqs)
    const held = {
      sessionId: session.id,
      startSeq: range.start,
      endSeq: range.end,
      seqs: range.seqs,
      fingerprint: fingerprint(input),
      target: routedTarget(session),
      headSeq: session.surface.nodes[0],
      result: undefined,
      createdAt: Date.now(),
      tailTokens: range.tailTokens,
      shadowedTokens: range.shadowedTokens,
      state: 'running',
      origin,
      abort: new AbortController(),
    }
    this.held.set(session.id, held)
    this.skipReasons.delete(session.id)
    this.ctx.logger.info(
      `${LOG_PREFIX} started session=${session.id} origin=${origin} range=${held.startSeq}-${held.endSeq} shadowed=~${range.shadowedTokens}t tail=~${range.tailTokens}t threshold=${spec.thresholdTokens} fp=${shortFingerprint(held.fingerprint)}`,
    )
    const promise = BasicCompactionEngine.prototype.summarize
      .call(this, input, agent, held.abort.signal)
      .then((result) => {
        if (this.held.get(session.id) !== held) return
        held.result = result
        held.state = 'ready'
        // A completed generation proves the route works, so the breaker closes
        // here rather than only on a successful swap.
        this.failures = 0
        this.lastFailureAt = 0
        this.ctx.logger.info(
          `${LOG_PREFIX} held ready session=${session.id} origin=${origin} ms=${Date.now() - held.createdAt} usage=${JSON.stringify(result.usage ?? null)}`,
        )
      })
      .catch((error) => {
        if (this.held.get(session.id) !== held) return
        held.state = 'failed'
        this.held.delete(session.id)
        this.failures += 1
        this.lastFailureAt = Date.now()
        this.ctx.logger.warn(
          `${LOG_PREFIX} held failed session=${session.id} origin=${origin} failures=${this.failures}/${this.maxFailures}: ${error?.message ?? error}`,
        )
      })
    this.pending.add(promise)
    promise
      .finally(() => this.pending.delete(promise))
      .catch(() => {})
    return held
  }

  /**
   * Start a user-requested (`/bcompact`) background summarization.
   *
   * Unlike the automatic path this ignores the pressure threshold, the cold
   * cache gate, the circuit breaker, and `auto`: the user asked for it. It still
   * refuses when another compaction owns the session lock, because the summary
   * would be built against a surface that is about to change.
   *
   * @param {object} agent - agent owning the session.
   * @returns {Promise<{ok: true, already?: string, range?: object} | {ok: false, reason: string}>} outcome.
   */
  async startManual(agent) {
    const session = agent.session
    const existing = this.held.get(session.id)
    if (existing?.state === 'ready') return { ok: true, already: 'ready' }
    if (existing?.state === 'running') return { ok: false, reason: 'already-running' }
    if (this.#compactionLocked(session)) return { ok: false, reason: 'compaction-locked' }
    const target = routedTarget(session)
    if (target === undefined) return { ok: false, reason: 'no-routed-target' }
    let spec
    try {
      spec = await this.#specFor(session, target)
    } catch {
      return { ok: false, reason: 'spec' }
    }
    const pending = this.held.get(session.id)
    if (pending?.state === 'ready') return { ok: true, already: 'ready' }
    if (pending?.state === 'running') return { ok: false, reason: 'already-running' }
    const measurement = this.ctx.tokenMeter.measure(session)
    const range = selectRange(session, measurement, spec, this.background, {
      minShadowedTokens: MANUAL_MIN_SHADOWED_TOKENS,
    })
    if ('skip' in range) return { ok: false, reason: range.skip }
    this.startGeneration(agent, range, 'bcompact', spec)
    return { ok: true, range }
  }

  /**
   * Prefer a held summary on the pressure path.
   *
   * The base engine calls this from its own `agent/pre-step` hook, i.e. inside
   * an open turn, which is exactly where `compactRegion` is allowed to run.
   *
   * @param {object} agent - agent owning the session.
   * @param {'pressure'|'context-overflow'} trigger - compaction trigger.
   * @param {AbortSignal} signal - turn cancellation.
   * @returns {Promise<object | null>} compaction result or `null`.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'pressure') {
      const held = this.held.get(agent.session.id)
      if (held?.state === 'ready') {
        const outcome = await this.#swap(agent, held, signal)
        if (outcome.ok) return outcome.result
      }
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  /**
   * Return a ready held summary for the replay input the engine just built.
   *
   * @param {object} input - replayed conversation prefix.
   * @param {object} agent - agent owning the session.
   * @param {AbortSignal} signal - cancellation forwarded to the adapter.
   * @returns {Promise<object>} summary blocks plus the auxiliary call envelope.
   */
  async summarize(input, agent, signal) {
    const fp = fingerprint(input)
    const held = this.held.findByFingerprint(agent.session.id, fp)
    if (held?.state === 'ready' && held.result !== undefined) {
      this.ctx.logger.info(`${LOG_PREFIX} summarize reused held session=${agent.session.id} fp=${shortFingerprint(fp)}`)
      return held.result
    }
    this.ctx.logger.info(
      `${LOG_PREFIX} summarize miss session=${agent.session.id} fp=${shortFingerprint(fp)} held=${held?.state ?? 'none'}`,
    )
    return super.summarize(input, agent, signal)
  }
}
