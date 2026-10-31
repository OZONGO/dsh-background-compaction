/**
 * Swap evidence recorder.
 *
 * The request message array is derived from the session surface, so the
 * messages present immediately after a committed swap **are** what the next
 * turn sends to the model. Recording them gives an unambiguous acceptance
 * artifact without touching the durable session log.
 *
 * @module dsh-background-compaction/recorder
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Characters of each message captured in the snapshot head. */
const HEAD_CHARS = 120

/**
 * Describe one derived request message without copying its payload.
 * @param {object} message - derived request message.
 * @returns {{role: string, chars: number, head: string}} compact description.
 */
function describeMessage(message) {
  const role = typeof message?.role === 'string' ? message.role : 'unknown'
  let text = ''
  const content = message?.content
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((part) => part.length > 0)
      .join('\n')
  }
  return { role, chars: text.length, head: text.slice(0, HEAD_CHARS) }
}

/**
 * Serialize the post-swap request surface.
 *
 * @param {object} session - session that just committed a compaction.
 * @param {object} result - `CompactionResult` returned by `compactRegion`.
 * @param {object} held - held record that produced the summary.
 * @param {object} extras - additional evidence fields.
 * @param {string} extras.origin - `auto` or `bcompact`.
 * @param {number} extras.thresholdTokens - threshold in force at swap time.
 * @param {number} extras.totalTokens - measured pressure at swap time.
 * @returns {object} snapshot payload.
 */
export function describeSwap(session, result, held, extras) {
  const messages = session.deriveMessages()
  return {
    at: Date.now(),
    sessionId: session.id,
    origin: extras.origin,
    range: { start: result.startSeq, end: result.endSeq },
    shadowedTokens: result.shadowedTokenCount,
    summaryChars: Array.isArray(result.summary)
      ? result.summary.reduce((total, block) => total + (typeof block?.text === 'string' ? block.text.length : 0), 0)
      : 0,
    tailTokens: held.tailTokens,
    thresholdTokens: extras.thresholdTokens,
    totalTokensBefore: extras.totalTokens,
    messageCount: messages.length,
    messages: messages.map(describeMessage),
  }
}

/**
 * Write the snapshot atomically; failures are reported, never thrown.
 *
 * @param {string} directory - plugin state directory.
 * @param {object} snapshot - payload from {@link describeSwap}.
 * @returns {Promise<{ok: true, file: string} | {ok: false, error: Error}>} outcome.
 */
export async function writeSwapSnapshot(directory, snapshot) {
  const file = join(directory, 'last-swap.json')
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  let handle
  try {
    await mkdir(dirname(file), { recursive: true })
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
    return { ok: true, file }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    return { ok: false, error }
  }
}
