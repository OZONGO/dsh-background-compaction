/**
 * Pure background-trigger policy.
 *
 * Every gate is a named constant so logs, tests, and the design document share
 * one vocabulary. The policy never touches the session: it receives numbers and
 * flags and returns a decision.
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
 * @param {boolean} input.hasRange - a balanced, useful span exists.
 * @param {number} input.lastRequestAgeMs - milliseconds since the last routed request.
 * @param {number} input.cacheWarmMs - cold-cache gate.
 * @param {boolean} input.hasTarget - a routed provider/model is known.
 * @returns {{start: true} | {start: false, reason: string}} the decision.
 */
export function decideBackgroundStart(input) {
  const skip = (reason) => ({ start: false, reason })
  if (input.delegationDepth !== 0) return skip(SKIP.SUBAGENT)
  if (!input.auto) return skip(SKIP.AUTO_OFF)
  if (input.heldState === 'running') return skip(SKIP.RUNNING)
  if (input.heldState === 'ready') return skip(SKIP.READY)
  if (input.locked) return skip(SKIP.LOCKED)
  if (!input.hasTarget) return skip(SKIP.NO_TARGET)
  if (input.failures >= input.maxFailures) return skip(SKIP.CIRCUIT_OPEN)
  if (input.totalTokens >= input.thresholdTokens) return skip(SKIP.DUE)
  if (input.totalTokens < input.thresholdTokens * input.startRatio) return skip(SKIP.BELOW_START)
  if (!input.hasRange) return skip(SKIP.NO_RANGE)
  if (input.cacheWarmMs > 0 && input.lastRequestAgeMs > input.cacheWarmMs) return skip(SKIP.COLD_CACHE)
  return { start: true }
}
