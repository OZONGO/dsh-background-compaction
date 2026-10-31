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
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { join } from 'node:path'

import { registerBcompact } from './command.js'
import { Config, resolveBackground, splitConfig } from './config.js'
import { HeldStore, heldInvalidReason } from './held.js'
import { buildSummarizationInput, fingerprint, shortFingerprint } from './input.js'
import { decideBackgroundStart, SKIP } from './policy.js'
import { selectRange } from './range.js'
import { describeSwap, writeSwapSnapshot } from './recorder.js'
import { mountSettingsRemote } from './remote.js'
import { SettingsStore } from './settings.js'
import { resolveCompactSpec, resolveTargetPolicy, routedTarget } from './spec.js'

/** Logger prefix for every line this plugin emits. */
export const LOG_PREFIX = 'background-compaction:'

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
  /** Last routed-request timestamp per session, for the cold-cache gate. */
  lastRequestAt = new Map()
  /** Cached model capacity per `provider/model`. */
  modelInfo = new Map()
  /** Compaction-lock state per session. */
  compactionState = new Map()
  /** Targets already warned about for unusable capacity. */
  warnedTargets = new Set()

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

  /** Effective background start ratio (settings override YAML). */
  get startRatio() {
    return this.settingsStore.get().autoTriggerRatio
  }

  /** Effective circuit-breaker limit (settings override YAML). */
  get maxFailures() {
    return this.settingsStore.get().maxFailures
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
   * @param {object} session - target session.
   * @returns {boolean} `true` while a compaction transaction is open.
   */
  #compactionLocked(session) {
    const state = this.compactionState.get(session.id)
    if (state?.initialized === true) return state.active
    // First sighting (the plugin can attach to a live session): scan once.
    let active = false
    const end = session.seq ?? 0
    for (let seq = 0; seq < end; seq += 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'compaction/start') active = true
      else if (event.type === 'compaction/end') active = false
    }
    this.compactionState.set(session.id, { active, initialized: true })
    return active
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
    const measurement = this.ctx.tokenMeter.measure(session)
    const target = routedTarget(session)
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
    if (this.held.get(session.id) !== undefined) return
    const target = routedTarget(session)
    if (target === undefined) return
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
    const measurement = this.ctx.tokenMeter.measure(session)
    const range = selectRange(session, measurement, spec, this.background)
    const decision = decideBackgroundStart({
      delegationDepth: delegationDepthOf(agent),
      auto: this.config.auto,
      heldState: undefined,
      locked: this.#compactionLocked(session),
      totalTokens: measurement.totalTokens,
      thresholdTokens: spec.thresholdTokens,
      startRatio: this.startRatio,
      failures: this.failures,
      maxFailures: this.maxFailures,
      hasRange: !('skip' in range),
      lastRequestAgeMs: Date.now() - (this.lastRequestAt.get(session.id) ?? 0),
      cacheWarmMs: this.background.cacheWarmMs,
      hasTarget: true,
    })
    if (!decision.start) {
      if (decision.reason !== SKIP.BELOW_START && decision.reason !== SKIP.DUE) {
        this.ctx.logger.info(`${LOG_PREFIX} skip session=${session.id} reason=${decision.reason}`)
      }
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
    this.ctx.logger.info(
      `${LOG_PREFIX} started session=${session.id} origin=${origin} range=${held.startSeq}-${held.endSeq} shadowed=~${range.shadowedTokens}t tail=~${range.tailTokens}t threshold=${spec.thresholdTokens} fp=${shortFingerprint(held.fingerprint)}`,
    )
    const promise = BasicCompactionEngine.prototype.summarize
      .call(this, input, agent, held.abort.signal)
      .then((result) => {
        if (this.held.get(session.id) !== held) return
        held.result = result
        held.state = 'ready'
        this.ctx.logger.info(
          `${LOG_PREFIX} held ready session=${session.id} origin=${origin} ms=${Date.now() - held.createdAt} usage=${JSON.stringify(result.usage ?? null)}`,
        )
      })
      .catch((error) => {
        if (this.held.get(session.id) !== held) return
        held.state = 'failed'
        this.held.delete(session.id)
        this.failures += 1
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
    const measurement = this.ctx.tokenMeter.measure(session)
    const range = selectRange(session, measurement, spec, this.background)
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
