/**
 * Replay-input construction and the summary fingerprint.
 *
 * Background generation must build **byte-identical** input to the one the
 * engine builds inside `compactRegion`; otherwise the fingerprint recorded at
 * generation time never matches at swap time and the whole feature degrades
 * into an extra model call. `buildSummarizationInput` in
 * `dsh-compaction-basic` is private, so this is a faithful re-implementation
 * of its four lines.
 *
 * @module dsh-background-compaction/input
 */

import { createHash } from 'node:crypto'

/**
 * Stable JSON serialization with sorted object keys.
 *
 * `JSON.stringify` alone is not safe here: the input is assembled from objects
 * owned by the session log, and key insertion order is not part of any
 * contract. Sorting makes the fingerprint depend only on the value.
 *
 * @param {unknown} value - value to serialize.
 * @returns {string} canonical JSON.
 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value !== 'object') return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item === undefined ? null : item)).join(',')}]`
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * Build the replayed conversation prefix for a set of surface nodes.
 *
 * Mirrors `buildSummarizationInput` from `dsh-compaction-basic`:
 * the `system/message` at surface node 0 leads, then every shadowed node in
 * surface order, and the request header's tool list travels alongside.
 *
 * @param {object} session - session supplying the surface, header, and projection.
 * @param {readonly number[]} shadowedSeqs - surface-node seqs, in order.
 * @returns {{tools?: readonly unknown[], messages: readonly unknown[]}} replay input.
 */
export function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader()
  const headSeq = session.surface.nodes[0]
  const head = headSeq === undefined ? undefined : session.eventAt(headSeq)
  const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null)
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

/**
 * Fingerprint one replay input.
 * @param {{tools?: readonly unknown[], messages: readonly unknown[]}} input - replay input.
 * @returns {string} lowercase hex sha256.
 */
export function fingerprint(input) {
  return createHash('sha256').update(stableStringify(input)).digest('hex')
}

/**
 * Short fingerprint form for logs and snapshots.
 * @param {string} fp - full fingerprint.
 * @returns {string} first 12 hex characters.
 */
export function shortFingerprint(fp) {
  return typeof fp === 'string' ? fp.slice(0, 12) : 'none'
}
