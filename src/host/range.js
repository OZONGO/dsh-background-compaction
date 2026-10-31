/**
 * Range selection for background summarization.
 *
 * The compacted span must end **before the most recent user message** so the
 * previous turn survives verbatim, which is the behaviour the user asked for
 * ("the compacted content plus the previous turn"). That cut point is also
 * naturally tool-pairing balanced, and it is stable regardless of whether
 * generation starts at a step boundary or in the middle of a turn.
 *
 * @module dsh-background-compaction/range
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'

/** Why a surface produced no usable range. */
export const RANGE_SKIP = Object.freeze({
  EMPTY: 'empty-surface',
  NO_USER: 'no-user-message',
  UNBALANCED: 'no-balanced-cut',
  TOO_SMALL: 'span-too-small',
  TAIL_TOO_LONG: 'tail-too-long',
})

/**
 * Index the measured token counts by surface seq.
 * @param {object} measurement - `ctx.tokenMeter.measure(session)` result.
 * @returns {Map<number, number>} seq → tokens.
 */
function tokenIndex(measurement) {
  const index = new Map()
  for (const node of measurement?.nodes ?? []) {
    if (node !== undefined && node.seq !== undefined) index.set(node.seq, node.tokens ?? node.heuristicTokens ?? 0)
  }
  return index
}

/**
 * Sum the measured tokens of a slice of surface seqs.
 * @param {readonly number[]} seqs - surface seqs.
 * @param {Map<number, number>} tokens - seq → tokens.
 * @returns {number} total tokens.
 */
function sumTokens(seqs, tokens) {
  let total = 0
  for (const seq of seqs) total += tokens.get(seq) ?? 0
  return total
}

/**
 * Select an inclusive surface span to summarize in the background.
 *
 * @param {object} session - session owning the surface.
 * @param {object} measurement - measured token counts.
 * @param {{thresholdTokens: number}} spec - resolved token budgets.
 * @param {{tailRatio: number, minShadowedRatio: number}} background - background policy.
 * @param {{minShadowedTokens?: number}} [options] - override the usefulness floor; a manual
 *   `/bcompact` uses an absolute floor instead of the threshold-relative one, because the user
 *   asked for a compaction of whatever history exists.
 * @returns {{start: number, end: number, seqs: number[], shadowedTokens: number, tailTokens: number} | {skip: string}} range or a skip reason.
 */
export function selectRange(session, measurement, spec, background, options = {}) {
  const nodes = session.surface.nodes
  if (!Array.isArray(nodes) || nodes.length < 2) return { skip: RANGE_SKIP.EMPTY }

  // Surface node 0 is the system prompt when the session has one; it is never
  // compacted. A surface without a system head starts at node 0, exactly like
  // the base engine's `selectCompactableRange`.
  const firstIndex = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  let lastUserIndex = -1
  for (let index = nodes.length - 1; index >= firstIndex; index -= 1) {
    if (session.eventAt(nodes[index])?.type === 'user/message') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return { skip: RANGE_SKIP.NO_USER }
  // Nothing precedes the latest user message: there is no completed turn to
  // summarize, which is "history is too short", not "no safe cut point".
  if (lastUserIndex <= firstIndex) return { skip: RANGE_SKIP.TOO_SMALL }

  let endIndex = lastUserIndex - 1
  while (endIndex >= firstIndex && !toolPairingBalancedAfter(session, nodes[endIndex])) endIndex -= 1
  if (endIndex < firstIndex) return { skip: RANGE_SKIP.UNBALANCED }

  let startIndex = firstIndex
  while (startIndex < endIndex && !toolPairingBalancedBefore(session, nodes[startIndex])) startIndex += 1
  if (startIndex >= endIndex) return { skip: RANGE_SKIP.UNBALANCED }

  const tokens = tokenIndex(measurement)
  const tailSeqs = nodes.slice(endIndex + 1)
  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
  const tailTokens = sumTokens(tailSeqs, tokens)
  const shadowedTokens = sumTokens(shadowedSeqs, tokens)

  if (tailTokens > spec.thresholdTokens * background.tailRatio) return { skip: RANGE_SKIP.TAIL_TOO_LONG }
  const floor =
    options.minShadowedTokens === undefined
      ? spec.thresholdTokens * background.minShadowedRatio
      : options.minShadowedTokens
  if (shadowedTokens < floor) return { skip: RANGE_SKIP.TOO_SMALL }

  return {
    start: nodes[startIndex],
    end: nodes[endIndex],
    seqs: [...shadowedSeqs],
    shadowedTokens,
    tailTokens,
  }
}

/**
 * Sum the tokens that follow an inclusive span.
 * @param {object} session - session owning the surface.
 * @param {number} endSeq - inclusive end seq.
 * @param {object} measurement - measured token counts.
 * @returns {number} tail tokens.
 */
export function tailTokensAfter(session, endSeq, measurement) {
  const nodes = session.surface.nodes
  const endIndex = nodes.indexOf(endSeq)
  if (endIndex < 0) return Number.POSITIVE_INFINITY
  const tokens = tokenIndex(measurement)
  return sumTokens(nodes.slice(endIndex + 1), tokens)
}
