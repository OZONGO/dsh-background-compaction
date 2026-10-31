/**
 * Configuration surface for the background compaction engine.
 *
 * The base `BasicCompactionEngine` validates its own configuration strictly and
 * rejects unknown keys, so this module owns three things:
 *
 * 1. the extended `Config` schema (every base key plus a `background` section);
 * 2. the split between base keys and our own section, performed before `super()`;
 * 3. load-time validation of the `background` section with actionable messages.
 *
 * @module dsh-background-compaction/config
 */

import z from '@deepseek-ai/schemastery'

/** Keys forwarded verbatim to {@link BasicCompactionEngine}. */
export const BASE_CONFIG_KEYS = Object.freeze([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

/** Per-target override keys accepted inside `modelPolicies[]`. */
const MODEL_POLICY_KEYS = Object.freeze([
  'provider',
  'model',
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
])

/**
 * Defaults for the `background` section.
 *
 * Every ratio is expressed **relative to `thresholdTokens`**, never as an
 * absolute token count. The effective threshold on a 200k window is ~68928
 * tokens, so absolute constants such as opencode's `PRECOMPUTE_MIN_TOKENS`
 * would silently disable the feature.
 */
export const BACKGROUND_DEFAULTS = Object.freeze({
  /** Fraction of `thresholdTokens` at which background generation starts. */
  startRatio: 0.85,
  /** Upper bound for the verbatim tail, as a fraction of `thresholdTokens`. */
  tailRatio: 0.5,
  /** Lower bound for the summarized span, as a fraction of `thresholdTokens`. */
  minShadowedRatio: 0.1,
  /** Skip generation when the last routed request is older than this. */
  cacheWarmMs: 300_000,
  /** Maximum age of a ready summary before it is discarded. */
  holdTtlMs: 900_000,
  /** Maximum number of sessions holding a summary at once. */
  maxSessions: 8,
  /** Consecutive failures before background generation stops. */
  maxFailures: 2,
  /**
   * Probe delay once the circuit breaker is open.
   *
   * The breaker is half-open: after this long, one generation attempt is allowed
   * through. A successful generation resets the failure count, so the feature
   * recovers on its own instead of staying off until the process restarts.
   */
  failureCooldownMs: 300_000,
})

const number = () => z.number()
const integer = () => z.number().step(1)

const modelPolicySchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: number(),
  headroomTokens: integer().min(0),
  retainRatio: number(),
  retainTokens: integer().min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: integer().min(1),
  compactionRetries: integer().min(0),
  maxOverflowRetries: integer().min(0),
})

const backgroundSchema = z.object({
  startRatio: number(),
  tailRatio: number(),
  minShadowedRatio: number(),
  cacheWarmMs: integer().min(0),
  holdTtlMs: integer().min(0),
  maxSessions: integer().min(1),
  maxFailures: integer().min(0),
  failureCooldownMs: integer().min(0),
})

/**
 * Plugin configuration schema.
 *
 * Mirrors `BasicCompactionEngine.Config` key for key (the Loader projects this
 * schema into the settings form and rejects values that do not match) and adds
 * the `background` section.
 */
export const Config = z.object({
  thresholdRatio: number(),
  headroomTokens: integer().min(0),
  retainRatio: number(),
  retainTokens: integer().min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: integer().min(1),
  compactionRetries: integer().min(0),
  maxOverflowRetries: integer().min(0),
  modelPolicies: z.array(modelPolicySchema),
  auto: z.boolean(),
  background: backgroundSchema,
})

/**
 * Split the Loader-provided configuration into the base section and ours.
 * @param config - raw plugin configuration.
 * @returns the configuration for `super()` and our own section.
 */
export function splitConfig(config) {
  const { background, ...basic } = config ?? {}
  return { basic, background }
}

/**
 * Validate and fill the `background` section.
 *
 * Fails at load time rather than at the first trigger: a silently invalid ratio
 * would disable background compaction without any visible symptom.
 *
 * @param background - raw `background` configuration.
 * @returns a frozen, fully populated section.
 */
export function resolveBackground(background) {
  const merged = { ...BACKGROUND_DEFAULTS, ...(background ?? {}) }
  const fail = (field, message) => {
    throw new Error(`dsh-background-compaction: background.${field} ${message}`)
  }

  if (!Number.isFinite(merged.startRatio) || merged.startRatio <= 0 || merged.startRatio >= 1) {
    fail('startRatio', `must be in (0,1), received ${merged.startRatio}`)
  }
  if (!Number.isFinite(merged.tailRatio) || merged.tailRatio <= 0) {
    fail('tailRatio', `must be > 0, received ${merged.tailRatio}`)
  }
  if (!Number.isFinite(merged.minShadowedRatio) || merged.minShadowedRatio < 0 || merged.minShadowedRatio >= 1) {
    fail('minShadowedRatio', `must be in [0,1), received ${merged.minShadowedRatio}`)
  }
  if (!Number.isSafeInteger(merged.cacheWarmMs) || merged.cacheWarmMs < 0) {
    fail('cacheWarmMs', `must be a non-negative integer, received ${merged.cacheWarmMs}`)
  }
  if (!Number.isSafeInteger(merged.holdTtlMs) || merged.holdTtlMs < 0) {
    fail('holdTtlMs', `must be a non-negative integer, received ${merged.holdTtlMs}`)
  }
  if (!Number.isSafeInteger(merged.maxSessions) || merged.maxSessions < 1) {
    fail('maxSessions', `must be a positive integer, received ${merged.maxSessions}`)
  }
  if (!Number.isSafeInteger(merged.maxFailures) || merged.maxFailures < 0) {
    fail('maxFailures', `must be a non-negative integer, received ${merged.maxFailures}`)
  }
  if (!Number.isSafeInteger(merged.failureCooldownMs) || merged.failureCooldownMs < 0) {
    fail('failureCooldownMs', `must be a non-negative integer, received ${merged.failureCooldownMs}`)
  }
  if (merged.minShadowedRatio >= merged.startRatio) {
    fail('minShadowedRatio', `(${merged.minShadowedRatio}) must be below startRatio (${merged.startRatio})`)
  }

  return Object.freeze({
    startRatio: merged.startRatio,
    tailRatio: merged.tailRatio,
    minShadowedRatio: merged.minShadowedRatio,
    cacheWarmMs: merged.cacheWarmMs,
    holdTtlMs: merged.holdTtlMs,
    maxSessions: merged.maxSessions,
    maxFailures: merged.maxFailures,
    failureCooldownMs: merged.failureCooldownMs,
  })
}

export { BASE_CONFIG_KEYS as FORWARDED_KEYS, MODEL_POLICY_KEYS }
