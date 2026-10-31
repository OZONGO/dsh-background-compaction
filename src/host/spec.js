/**
 * Token-budget math for the background trigger.
 *
 * `resolveCompactSpec` and `resolveTargetPolicy` live in
 * `@deepseek-ai/dsh-compaction-basic` but are **not exported**. Background
 * compaction must measure pressure with exactly the same arithmetic as the
 * foreground engine, otherwise the two disagree about where the threshold is
 * and the feature either fires far too early or never fires at all.
 *
 * These are deliberate, minimal re-implementations. `test/spec.test.js` pins
 * them to the documented formula and `docs/design.zh.md` records the risk.
 *
 * @module dsh-background-compaction/spec
 */

/** Raised when the routed target cannot produce a usable token budget. */
export class SpecConfigError extends Error {
  /**
   * @param {string} targetKey - `provider/model` identity for the failure.
   * @param {string} message - actionable detail.
   */
  constructor(targetKey, message) {
    super(message)
    this.name = 'SpecConfigError'
    this.targetKey = targetKey
  }
}

/**
 * Pick the retention shape for one policy layer.
 * @param {object} layer - layer that may carry `retainTokens` or `retainRatio`.
 * @param {object} fallback - inherited retention.
 * @returns {{retainTokens?: number, retainRatio?: number}} the retention shape.
 */
function resolveRetention(layer, fallback) {
  if (layer.retainTokens !== undefined) return { retainTokens: layer.retainTokens }
  if (layer.retainRatio !== undefined) return { retainRatio: layer.retainRatio }
  return fallback
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * Mirrors `resolveTargetPolicy` from `dsh-compaction-basic`.
 *
 * @param {object} config - resolved top-level engine configuration.
 * @param {{provider: string, model: string}} target - routed target.
 * @returns {object} the merged policy for that exact target.
 */
export function resolveTargetPolicy(config, target) {
  const override = (config.modelPolicies ?? []).find(
    (policy) => policy.provider === target.provider && policy.model === target.model,
  )
  const inheritedRetention =
    config.retainTokens === undefined ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens }
  return {
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  }
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 * Mirrors `resolveCompactSpec` from `dsh-compaction-basic`.
 *
 * @param {object} policy - merged policy for the exact routed target.
 * @param {number} contextWindow - positive adapter-owned capacity.
 * @param {number} reservedCompletionTokens - output tokens one request reserves.
 * @returns {{contextWindow: number, messageBudgetTokens: number, pressureBudgetTokens: number, thresholdTokens: number, retainTokens: number}} budgets.
 */
export function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens) {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new SpecConfigError(targetKey, `contextWindow (${contextWindow}) must be a positive integer`)
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new SpecConfigError(
      targetKey,
      `reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer`,
    )
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new SpecConfigError(
      targetKey,
      `${targetKey} reserves ${reservedCompletionTokens} completion tokens of its ${contextWindow}-token window, leaving no message budget`,
    )
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new SpecConfigError(
      targetKey,
      `${targetKey} reserves ${reservedCompletionTokens} completion and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token window, leaving no pressure budget`,
    )
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
  const retainTokens =
    policy.retainTokens === undefined ? Math.floor(messageBudgetTokens * policy.retainRatio) : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new SpecConfigError(targetKey, `${targetKey} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`)
  }
  return { contextWindow, messageBudgetTokens, pressureBudgetTokens, thresholdTokens, retainTokens }
}

/**
 * Read the routed provider/model pair a session last requested.
 * @param {object} session - target session.
 * @returns {{provider: string, model: string} | undefined} the routed target.
 */
export function routedTarget(session) {
  const config = session?.requestHeader?.()?.config
  if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  if (config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}
