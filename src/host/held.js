/**
 * In-memory store for background summaries and its invalidation rules.
 *
 * A held summary is only ever used once, and only while it still describes the
 * exact prefix the engine is about to compact. Every rule below exists because
 * using a stale summary would silently corrupt the model's view of the
 * conversation; discarding one only costs an extra summarization call.
 *
 * @module dsh-background-compaction/held
 */

import { buildSummarizationInput, fingerprint } from './input.js'
import { tailTokensAfter } from './range.js'

/** Reasons a ready summary is discarded. */
export const INVALID = Object.freeze({
  NOT_READY: 'not-ready',
  HEAD_CHANGED: 'surface-head-changed',
  TARGET_CHANGED: 'routed-target-changed',
  RANGE_MISSING: 'range-missing',
  FINGERPRINT: 'fingerprint-mismatch',
  TAIL_TOO_LONG: 'tail-too-long',
  EXPIRED: 'expired',
})

/**
 * Bounded per-session store.
 *
 * Eviction prefers the oldest entry that is not currently generating, so a
 * slow background call is not cancelled just because another session started.
 */
export class HeldStore {
  /** @type {Map<string, object>} */
  #entries = new Map()
  /** @type {number} */
  #maxSessions

  /**
   * @param {{maxSessions: number}} options - capacity.
   */
  constructor(options) {
    this.#maxSessions = Math.max(1, options.maxSessions)
  }

  /** @returns {number} number of tracked sessions. */
  get size() {
    return this.#entries.size
  }

  /**
   * Track one held summary.
   * @param {string} sessionId - session identity.
   * @param {object} held - held record.
   */
  set(sessionId, held) {
    this.#entries.set(sessionId, held)
    this.#evict()
  }

  /**
   * Read the held summary for a session.
   * @param {string} sessionId - session identity.
   * @returns {object | undefined} held record.
   */
  get(sessionId) {
    return this.#entries.get(sessionId)
  }

  /**
   * Drop one session's held summary.
   * @param {string} sessionId - session identity.
   */
  delete(sessionId) {
    this.#entries.delete(sessionId)
  }

  /**
   * Find a ready summary by replay fingerprint.
   * @param {string} sessionId - session identity.
   * @param {string} fp - fingerprint of the input the engine just built.
   * @returns {object | undefined} held record.
   */
  findByFingerprint(sessionId, fp) {
    const held = this.#entries.get(sessionId)
    if (held === undefined || held.fingerprint !== fp) return undefined
    return held
  }

  /** Drop every entry, aborting generation. */
  clear() {
    for (const held of this.#entries.values()) {
      if (held.state === 'running') held.abort?.abort(new Error('background compaction disposed'))
    }
    this.#entries.clear()
  }

  /** Evict the oldest non-running entry until the capacity fits. */
  #evict() {
    while (this.#entries.size > this.#maxSessions) {
      let victim
      for (const [sessionId, held] of this.#entries) {
        if (held.state === 'running') continue
        if (victim === undefined || held.createdAt < victim.held.createdAt) victim = { sessionId, held }
      }
      if (victim === undefined) {
        // Everything is generating: drop the oldest anyway rather than grow.
        for (const [sessionId, held] of this.#entries) {
          if (victim === undefined || held.createdAt < victim.held.createdAt) victim = { sessionId, held }
        }
      }
      if (victim === undefined) return
      victim.held.abort?.abort(new Error('background compaction evicted'))
      this.#entries.delete(victim.sessionId)
    }
  }
}

/**
 * Decide whether a ready summary may still be swapped in.
 *
 * @param {object} held - held record.
 * @param {object} context - validation context.
 * @param {object} context.session - target session.
 * @param {object} context.measurement - current measurement.
 * @param {{thresholdTokens: number}} context.spec - resolved budgets.
 * @param {{tailRatio: number, holdTtlMs: number}} context.background - background policy.
 * @param {{provider: string, model: string} | undefined} context.target - current routed target.
 * @param {number} context.now - current epoch milliseconds.
 * @returns {string | null} invalidation reason, or `null` when still usable.
 */
export function heldInvalidReason(held, context) {
  if (held.state !== 'ready') return INVALID.NOT_READY
  if (held.headSeq !== context.session.surface.nodes[0]) return INVALID.HEAD_CHANGED
  if (context.target === undefined) return INVALID.TARGET_CHANGED
  if (held.target.provider !== context.target.provider || held.target.model !== context.target.model) {
    return INVALID.TARGET_CHANGED
  }
  if (context.background.holdTtlMs > 0 && context.now - held.createdAt > context.background.holdTtlMs) {
    return INVALID.EXPIRED
  }
  const nodes = context.session.surface.nodes
  const startIndex = nodes.indexOf(held.startSeq)
  const endIndex = nodes.indexOf(held.endSeq)
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return INVALID.RANGE_MISSING
  const tail = tailTokensAfter(context.session, held.endSeq, context.measurement)
  if (tail > context.spec.thresholdTokens * context.background.tailRatio) return INVALID.TAIL_TOO_LONG
  // Re-derive the span the engine would compact *now*: an intervening
  // compaction may have replaced nodes inside the recorded span, in which case
  // the seqs survive but the derived messages no longer do.
  const currentSeqs = nodes.slice(startIndex, endIndex + 1)
  const rebuilt = fingerprint(buildSummarizationInput(context.session, currentSeqs))
  if (rebuilt !== held.fingerprint) return INVALID.FINGERPRINT
  return null
}
