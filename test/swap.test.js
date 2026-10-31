/**
 * Real-session swap.
 *
 * This is the acceptance criterion in miniature: build a genuine
 * `@deepseek-ai/dsh-session` Session, let the engine summarize a span in the
 * background, then commit it through the inherited `compactRegion` transaction
 * and assert that
 *
 * - the durable log gained the four compaction events,
 * - the surface now derives `system + checkpoint + retained tail`,
 * - the retained tail is the most recent turn verbatim, and
 * - the swap cost **zero** additional model calls.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { BackgroundCompactionEngine } from '../src/host/engine.js'
import { selectRange } from '../src/host/range.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-bgc-swap-'))
process.env.DSH_HOME = HOME
after(() => rmSync(HOME, { recursive: true, force: true }))

/**
 * Build a real session: system prompt, one complete turn, and a pending prompt.
 * @returns {object} real Session.
 */
function buildSession() {
  const now = Date.now()
  const system = createSystemMessage('You are a coding agent.')
  const first = createUserMessage({ content: [{ type: 'text', text: 'turn one' }], source: { kind: 'user' } })
  const answer = createAssistantMessage({
    content: [{ type: 'text', text: 'answer one' }],
    source: { provider: 'deepseek', model: 'm' },
  })
  const second = createUserMessage({ content: [{ type: 'text', text: 'turn two' }], source: { kind: 'user' } })

  let seq = 0
  const event = (type, data, surface = false) => ({
    seq: seq++,
    time: now,
    type,
    data,
    ...(surface ? { surfaceOp: 'append' } : {}),
  })
  const events = [
    event('system/message', { message: system }, true),
    event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }),
    event('request/header', {
      header: { config: { provider: 'deepseek', model: 'm', maxTokens: 65_536 } },
      reason: 'initial',
    }),
    event('user/message', first, true),
    event('assistant/message', { message: answer, turn: 1, step: 1, stream: [] }, true),
    event('step/end', { turn: 1, step: 1 }),
    event('step/start', { turn: 1, step: 2 }),
    event('user/message', second, true),
  ]
  return Session.create(SessionId('swap-session'), events, {
    version: 4,
    id: 'swap-session',
    createdAt: now,
    isSeeded: false,
    cwd: process.cwd(),
    delegationDepth: 0,
  })
}

/**
 * Build a Cordis app with stubbed model dependencies.
 * @param {object[]} calls - receives every stream request.
 * @returns {object} application context.
 */
function application(calls) {
  const app = new Context()
  app.provide('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow: 200_000 }, defaultMaxTokens: 65_536 }
    },
    async *stream(request) {
      calls.push(request)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'condensed history' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'condensed history' } }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 12 } }
    },
  })
  app.provide('tokenMeter', {
    measure: (session) => ({
      totalTokens: session.surface.nodes.length * 1000,
      surfaceTokens: session.surface.nodes.length * 1000,
      nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 1000, heuristicTokens: 1000 })),
    }),
    estimateMessage: () => 100,
  })
  app.provide('sessions', { async flush() {} })
  return app
}

test('a background summary is committed with zero model calls', async () => {
  const session = buildSession()
  const calls = []
  const engine = new BackgroundCompactionEngine(application(calls), {})
  const agent = { session, options: { provider: 'deepseek', model: 'm' } }
  const spec = { thresholdTokens: 3000 }
  const background = { tailRatio: 0.9, minShadowedRatio: 0.1 }

  const range = selectRange(session, engine.ctx.tokenMeter.measure(session), spec, background)
  assert.equal('skip' in range, false, 'range selection must find a span')
  assert.deepEqual(range.seqs, [4, 5], 'span covers the completed turn only')
  assert.equal(range.tailTokens, 1000, 'the pending prompt stays verbatim')

  const held = engine.startGeneration(agent, range, 'auto', spec)
  await Promise.all([...engine.pending])
  assert.equal(held.state, 'ready')
  assert.equal(calls.length, 1, 'one background call')

  const result = await engine.compactRegion(range.start, range.end, agent)
  assert.equal(calls.length, 1, 'the swap must not call the model again')
  assert.equal(result.shadowedRange.start, 4)
  assert.equal(result.shadowedRange.end, 5)

  const types = session.snapshotEvents().map((event) => event.type)
  assert.ok(types.includes('compaction/start'))
  assert.ok(types.includes('compaction/summary'))
  assert.ok(types.includes('compaction/end'))

  const derived = session.deriveMessages()
  assert.deepEqual(
    derived.map((message) => message.role),
    ['system', 'user', 'user'],
  )
  assert.match(derived[1].content[0].text, /automatically generated checkpoint/)
  assert.equal(derived[2].content[0].text, 'turn two', 'the most recent turn survives verbatim')
  assert.equal(session.surface.nodes.length, 3, 'system + checkpoint + tail')
})

test('the swap refuses a span whose summary no longer matches', async () => {
  const session = buildSession()
  const calls = []
  const engine = new BackgroundCompactionEngine(application(calls), {})
  const agent = { session, options: { provider: 'deepseek', model: 'm' } }
  const spec = { thresholdTokens: 3000 }
  const background = { tailRatio: 0.9, minShadowedRatio: 0.1 }
  const range = selectRange(session, engine.ctx.tokenMeter.measure(session), spec, background)
  engine.startGeneration(agent, range, 'auto', spec)
  await Promise.all([...engine.pending])

  // Rewrite the held fingerprint: the engine must then summarize for real.
  const held = engine.held.get(session.id)
  held.fingerprint = 'stale'
  await engine.compactRegion(range.start, range.end, agent)
  assert.equal(calls.length, 2, 'a stale held falls back to a real summarization call')
})
