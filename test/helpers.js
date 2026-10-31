/**
 * Test helpers: a fake session surface faithful to the parts of the real
 * session contract that range selection, replay-input construction, and the
 * tool-pairing balance cache actually read.
 *
 * The real cache (`@deepseek-ai/dsh-compaction/tool-pairing`) requires:
 * - `session.surface.nodes` (ordered seq list),
 * - `session.surface.replaceGeneration`,
 * - `session.eventAt(seq)` returning the event whose `.seq` equals `seq`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let nextId = 0

/** Event factories. */
export const events = {
  system: (seq, text) => ({
    seq,
    type: 'system/message',
    data: { message: { role: 'system', content: [{ type: 'text', text }] } },
  }),
  user: (seq, text) => ({
    seq,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  }),
  assistant: (seq, text, toolCalls = 0) => ({
    seq,
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          ...(text.length > 0 ? [{ type: 'text', text }] : []),
          ...Array.from({ length: toolCalls }, (_, index) => ({
            type: 'tool-call',
            id: `call-${seq}-${index}`,
            name: 'read',
            arguments: '{}',
          })),
        ],
      },
    },
  }),
  toolResult: (seq, id) => ({
    seq,
    type: 'tool/result',
    data: { message: { role: 'tool', content: [{ type: 'tool-result', id, content: 'ok' }] } },
  }),
  compactionStart: (seq) => ({ seq, type: 'compaction/start', data: {} }),
  compactionEnd: (seq) => ({ seq, type: 'compaction/end', data: {} }),
  endSeed: (seq) => ({ seq, type: 'session/end-seed', data: {} }),
}

/**
 * Project one event to a request message, mirroring `deriveEventMessage`.
 * @param {object} event - session event.
 * @returns {object | null} derived message.
 */
export function deriveEventMessage(event) {
  if (event === undefined) return null
  switch (event.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'assistant/message':
      return event.data.message
    case 'tool/result':
      return event.data.message
    default:
      return null
  }
}

/**
 * Build a fake session.
 * @param {{events: object[], maxTokens?: number, provider?: string, model?: string}} options - session shape.
 * @returns {object} fake session.
 */
export function makeSession(options) {
  const list = options.events
  const session = {
    id: options.id ?? `session-${(nextId += 1)}`,
    header: { delegationDepth: options.delegationDepth ?? 0 },
    surface: {
      nodes: list.map((event) => event.seq),
      replaceGeneration: options.replaceGeneration ?? 0,
      contentGeneration: 0,
    },
    seq: list.length,
    eventAt(seq) {
      const event = list[seq]
      return event?.seq === seq ? event : undefined
    },
    deriveEventMessage,
    requestHeader() {
      return {
        config: {
          provider: options.provider ?? 'deepseek',
          model: options.model ?? 'deepseek-v4',
          maxTokens: options.maxTokens ?? 65536,
        },
        tools: options.tools,
      }
    },
    toolHistory() {
      return []
    },
    deriveMessages() {
      return list.map(deriveEventMessage).filter((message) => message !== null)
    },
  }
  return session
}

/**
 * Build a measurement whose per-node token counts come from a lookup table.
 * @param {object} session - fake session.
 * @param {(seq: number) => number} tokensOf - token count per seq.
 * @returns {{totalTokens: number, surfaceTokens: number, nodes: object[]}} measurement.
 */
export function measure(session, tokensOf) {
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: tokensOf(seq), heuristicTokens: tokensOf(seq) }))
  const totalTokens = nodes.reduce((total, node) => total + node.tokens, 0)
  return { totalTokens, surfaceTokens: totalTokens, nodes }
}

/**
 * Create a temporary state directory for one test.
 * @returns {Promise<{directory: string, cleanup: () => Promise<void>}>} fixture.
 */
export async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bgc-'))
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

/** A 200k-window policy matching the shipped defaults. */
export const DEFAULT_POLICY = Object.freeze({
  target: { provider: 'deepseek', model: 'deepseek-v4' },
  thresholdRatio: 0.8,
  headroomTokens: 65536,
  retainRatio: 0.16,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 65536,
  compactionRetries: 1,
  maxOverflowRetries: 1,
})
