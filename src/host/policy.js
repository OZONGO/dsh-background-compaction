/**
 * Pure background-trigger policy.
 *
 * Every gate is a named constant so logs, tests, and the design document share
 * one vocabulary. The policy never touches the session: it receives numbers and
 * flags and returns a decision.
 *
 * The decision is split in two so the engine can run the cheap, synchronous
 * gates before it pays for an asynchronous model-capacity lookup:
 *
 * - {@link decideBackgroundPreconditions} — everything that is known without a
 *   token budget (subagent, auto, held state, lock, circuit breaker, route).
 * - {@link decideBackgroundStart} — the same preconditions plus the pressure,
 *   range, and cache gates.
 *
 * @module dsh-background-compaction/policy
 */

/** Reasons background generation does not start. */
export const SKIP = Object.freeze({
  SUBAGENT: 'subagent-session',
  AUTO_OFF: 'auto-disabled',
  RUNNING: 'already-running',
  READY: 'already-ready',
  LOCKED: 'compaction-locked',
  DUE: 'threshold-reached',
  BELOW_START: 'below-start-ratio',
  CIRCUIT_OPEN: 'circuit-open',
  NO_RANGE: 'no-range',
  COLD_CACHE: 'cold-cache',
  NO_TARGET: 'no-routed-target',
})

/**
 * Gates that need no token budget.
 *
 * The circuit breaker is half-open: once `failures` reaches `maxFailures`, one
 * probe is allowed after `failureCooldownMs`. Without that the breaker would
 * latch forever — a ready summary is what resets `failures`, and the breaker is
 * exactly what prevents one from being generated.
 *
 * @param {object} input - decision inputs.
 * @param {number} input.delegationDepth - 0 for a top-level agent.
 * @param {boolean} input.auto - effective `auto` switch.
 * @param {'running'|'ready'|undefined} input.heldState - current held state.
 * @param {boolean} input.locked - an unmatched `compaction/start` exists.
 * @param {number} input.failures - consecutive failures.
 * @param {number} input.maxFailures - circuit-breaker limit.
 * @param {number} [input.failureAgeMs] - milliseconds since the last failure.
 * @param {number} [input.failureCooldownMs] - probe delay once the breaker is open.
 * @param {boolean} input.hasTarget - a routed provider/model is known.
 * @returns {string | null} skip reason, or `null` when the preconditions hold.
 */
export function decideBackgroundPreconditions(input) {
  if (input.delegationDepth !== 0) return SKIP.SUBAGENT
  if (!input.auto) return SKIP.AUTO_OFF
  if (input.heldState === 'running') return SKIP.RUNNING
  if (input.heldState === 'ready') return SKIP.READY
  if (input.locked) return SKIP.LOCKED
  if (!input.hasTarget) return SKIP.NO_TARGET
  // `0` means "never start in the background" and has no probe to recover with.
  if (input.maxFailures <= 0) return SKIP.CIRCUIT_OPEN
  if (input.failures >= input.maxFailures) {
    const age = input.failureAgeMs ?? 0
    const cooldown = input.failureCooldownMs ?? Number.POSITIVE_INFINITY
    if (age < cooldown) return SKIP.CIRCUIT_OPEN
  }
  return null
}

/**
 * Gates that need a token budget: pressure, span availability, cache warmth.
 *
 * @param {object} input - decision inputs.
 * @param {number} input.totalTokens - measured surface pressure.
 * @param {number} input.thresholdTokens - effective compaction threshold.
 * @param {number} input.startRatio - fraction of the threshold that starts generation.
 * @param {boolean} input.hasRange - a balanced, useful span exists.
 * @param {number} input.lastRequestAgeMs - milliseconds since the last routed request.
 * @param {number} input.cacheWarmMs - cold-cache gate.
 * @returns {string | null} skip reason, or `null` when generation may start.
 */
export function decidePressureStart(input) {
  if (input.totalTokens >= input.thresholdTokens) return SKIP.DUE
  if (input.totalTokens < input.thresholdTokens * input.startRatio) return SKIP.BELOW_START
  if (!input.hasRange) return SKIP.NO_RANGE
  if (input.cacheWarmMs > 0 && input.lastRequestAgeMs > input.cacheWarmMs) return SKIP.COLD_CACHE
  return null
}

/**
 * Decide whether to start background summarization for one session.
 *
 * @param {object} input - decision inputs.
 * @param {number} input.delegationDepth - 0 for a top-level agent.
 * @param {boolean} input.auto - effective `auto` switch.
 * @param {'running'|'ready'|undefined} input.heldState - current held state.
 * @param {boolean} input.locked - an unmatched `compaction/start` exists.
 * @param {number} input.totalTokens - measured surface pressure.
 * @param {number} input.thresholdTokens - effective compaction threshold.
 * @param {number} input.startRatio - fraction of the threshold that starts generation.
 * @param {number} input.failures - consecutive failures.
 * @param {number} input.maxFailures - circuit-breaker limit.
 * @param {number} [input.failureAgeMs] - milliseconds since the last failure.
 * @param {number} [input.failureCooldownMs] - probe delay once the breaker is open.
 * @param {boolean} input.hasRange - a balanced, useful span exists.
 * @param {number} input.lastRequestAgeMs - milliseconds since the last routed request.
 * @param {number} input.cacheWarmMs - cold-cache gate.
 * @param {boolean} input.hasTarget - a routed provider/model is known.
 * @returns {{start: true} | {start: false, reason: string}} the decision.
 */
export function decideBackgroundStart(input) {
  const blocked = decideBackgroundPreconditions(input) ?? decidePressureStart(input)
  return blocked === null ? { start: true } : { start: false, reason: blocked }
}
