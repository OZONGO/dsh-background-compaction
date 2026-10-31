/**
 * `/bcompact [message]` — compact in the background, then send the message.
 *
 * A command handler runs **outside** any turn (`command/run` and `command/done`
 * are log-only appends), so it cannot call `compactRegion` — that requires an
 * open turn. The only honest implementation is therefore:
 *
 * 1. start the detached summarization over the current surface, and
 * 2. hand the trailing text back to the agent as a real user message with
 *    `agent.followup()`, exactly like `/plan <message>` does with `steer`.
 *
 * The turn answers immediately on the old context; the finished summary is
 * committed at the next step boundary, so the turn *after* that one sees
 * "summary + previous turn".
 *
 * @module dsh-background-compaction/command
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Command name without the slash. */
export const BCOMPACT_NAME = 'bcompact'

/** Human-readable failure text per refusal reason. */
const REFUSAL = Object.freeze({
  'no-routed-target': 'No routed model yet · 尚无可用模型路由',
  'compaction-locked': 'A compaction is already running · 已有压缩在进行',
  'already-running': 'Background compaction is already running · 后台压缩已在进行',
  'no-range': 'No compactable history yet · 没有可压缩的历史',
  'empty-surface': 'No compactable history yet · 没有可压缩的历史',
  'no-user-message': 'No compactable history yet · 没有可压缩的历史',
  'no-balanced-cut': 'No safe cut point (tool calls would be split) · 找不到安全的切分点',
  'span-too-small': 'Not enough history to compact · 历史太短，压缩没有意义',
  'tail-too-long': 'The most recent turn is too large to keep verbatim · 最近一轮太大，无法逐字保留',
  spec: 'This model reports no usable context window · 该模型没有可用的上下文窗口',
})

/**
 * Register the command.
 *
 * @param {object} ctx - context that owns `commands`.
 * @param {object} engine - background compaction engine.
 * @returns {() => void} disposer.
 */
export function registerBcompact(ctx, engine) {
  return ctx.commands.register({
    definitionId: 'dsh-background-compaction',
    name: BCOMPACT_NAME,
    description: 'Compact older history in the background and continue the conversation',
    input: { hint: '[message]' },
    handler: async (invocation) => {
      const text = (invocation.rawInput ?? '').trim()
      let outcome
      try {
        outcome = await engine.startManual(invocation.agent)
      } catch (error) {
        return { kind: 'error', text: `Background compaction failed to start: ${error?.message ?? error}` }
      }
      if (!outcome.ok) {
        return { kind: 'error', text: REFUSAL[outcome.reason] ?? `Background compaction unavailable: ${outcome.reason}` }
      }
      if (outcome.already === 'ready') {
        if (text.length > 0) {
          invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
          return {
            kind: 'success',
            text: 'A summary is already waiting; it lands next turn · 摘要已就绪，下一轮生效',
          }
        }
        return { kind: 'success', text: 'A summary is already waiting; it lands next turn · 摘要已就绪，下一轮生效' }
      }
      if (text.length > 0) {
        invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        return {
          kind: 'success',
          text: 'Compacting in the background; this turn answers on the old context · 后台压缩中，本轮照常回答',
        }
      }
      return {
        kind: 'success',
        text: 'Background compaction started (no message, no turn) · 后台压缩已启动（未附带消息）',
      }
    },
  })
}
