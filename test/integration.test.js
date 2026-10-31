/**
 * Integration: the engine must mount on a real Cordis context, register as
 * `ctx.compaction`, and route `summarize()` to either the held summary or the
 * model exactly as designed.
 *
 * This is the closest thing to a live DSH load that can run without booting the
 * desktop app: real `Context`, real `Service` registration, real
 * `BasicCompactionEngine` superclass, stubbed `llm`/`tokenMeter`/`sessions`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { BackgroundCompactionEngine } from '../src/host/engine.js'
import { fingerprint } from '../src/host/input.js'
import { events, makeSession } from './helpers.js'

// The engine resolves its state directory from `DSH_HOME` at construction time.
// Point it at a throwaway home so tests never touch the real `~/.dsh`.
const HOME = mkdtempSync(join(tmpdir(), 'dsh-bgc-home-'))
process.env.DSH_HOME = HOME
after(() => rmSync(HOME, { recursive: true, force: true }))

/**
 * Build a stubbed Cordis application.
 * @param {{contextWindow?: number, streamError?: Error}} options - stub behaviour.
 * @returns {{app: object, calls: object[]}} application and recorded calls.
 */
function application(options = {}) {
  const app = new Context()
  const calls = []
  app.provide('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow: options.contextWindow ?? 200_000 }, defaultMaxTokens: 65_536 }
    },
    async *stream(request) {
      calls.push(request)
      if (options.streamError !== undefined) throw options.streamError
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'condensed history' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'condensed history' } }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 12 } }
    },
  })
  app.provide('tokenMeter', {
    measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }),
  })
  app.provide('sessions', { async flush() {} })
  return { app, calls }
}

/**
 * Build a fake agent around a fake session.
 * @param {object} session - fake session.
 * @returns {object} fake agent.
 */
/** Wait for deferred Cordis injection callbacks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

function agentFor(session) {
  return { session, options: { provider: 'deepseek', model: 'deepseek-v4' } }
}

/**
 * A surface with one complete previous turn.
 * @returns {object} fake session.
 */
function session() {
  return makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.user(3, 'turn 2'),
    ],
  })
}

test('mounts on a real Cordis context and provides ctx.compaction', () => {
  const { app } = application()
  const engine = new BackgroundCompactionEngine(app, { auto: true })
  const registered = app.get('compaction')
  // Cordis exposes services through a tracking proxy, so identity differs.
  assert.equal(registered?.constructor?.name, 'BackgroundCompactionEngine')
  assert.equal(typeof registered.summarize, 'function')
  assert.equal(typeof registered.compactIfNeeded, 'function')
  assert.equal(engine.constructor.name, 'BackgroundCompactionEngine')
})

test('summarize falls through to the model when nothing is held', async () => {
  const { app, calls } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const result = await engine.summarize(input, agentFor(session()), undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].purpose, 'compaction')
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.summary[0].text, 'condensed history')
})

test('summarize returns a held summary without calling the model', async () => {
  const { app, calls } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const heldResult = { summary: [{ type: 'text', text: 'held' }], llmStreamCall: true, provider: 'p', model: 'm' }
  engine.held.set('session-x', {
    fingerprint: fingerprint(input),
    state: 'ready',
    result: heldResult,
    createdAt: Date.now(),
    abort: new AbortController(),
  })
  const sessionValue = session()
  sessionValue.id = 'session-x'
  const result = await engine.summarize(input, agentFor(sessionValue), undefined)
  assert.equal(result, heldResult)
  assert.equal(calls.length, 0)
})

test('startGeneration produces a ready held record with usage', async () => {
  const { app, calls } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  const agent = agentFor(sessionValue)
  const range = { start: 1, end: 2, seqs: [1, 2], shadowedTokens: 500, tailTokens: 100 }
  const held = engine.startGeneration(agent, range, 'auto', { thresholdTokens: 1000 })
  assert.equal(held.state, 'running')
  await Promise.all([...engine.pending])
  assert.equal(held.state, 'ready')
  assert.equal(calls.length, 1)
  assert.equal(held.result.summary[0].text, 'condensed history')
  assert.equal(engine.held.get(sessionValue.id), held)
})

test('a failed background call is counted and dropped', async () => {
  const { app } = application({ streamError: new Error('provider down') })
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  const held = engine.startGeneration(agentFor(sessionValue), { start: 1, end: 2, seqs: [1, 2], shadowedTokens: 500, tailTokens: 100 }, 'auto', { thresholdTokens: 1000 })
  await Promise.all([...engine.pending])
  assert.equal(held.state, 'failed')
  assert.equal(engine.failures, 1)
  assert.equal(engine.held.get(sessionValue.id), undefined)
})

test('startManual refuses without a routed target', async () => {
  const { app } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  sessionValue.requestHeader = () => undefined
  const outcome = await engine.startManual(agentFor(sessionValue))
  assert.deepEqual(outcome, { ok: false, reason: 'no-routed-target' })
})

test('startManual refuses while an unmatched compaction marker is open', async () => {
  const { app } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.compactionStart(3),
      events.user(4, 'turn 2'),
    ],
  })
  const outcome = await engine.startManual(agentFor(sessionValue))
  assert.deepEqual(outcome, { ok: false, reason: 'compaction-locked' })
})

test('startManual refuses when the span is too small', async () => {
  const { app } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  app.get('tokenMeter').measure = () => ({
    totalTokens: 3,
    surfaceTokens: 3,
    nodes: sessionValue.surface.nodes.map((seq) => ({ seq, tokens: 1 })),
  })
  const outcome = await engine.startManual(agentFor(sessionValue))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'span-too-small')
})

test('startManual starts generation and reports the chosen span', async () => {
  const { app, calls } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  app.get('tokenMeter').measure = () => ({
    totalTokens: 100_100,
    surfaceTokens: 100_100,
    nodes: sessionValue.surface.nodes.map((seq) => ({ seq, tokens: seq === 3 ? 100 : 50_000 })),
  })
  const outcome = await engine.startManual(agentFor(sessionValue))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.range.seqs, [1, 2])
  await Promise.all([...engine.pending])
  assert.equal(calls.length, 1)
})

test('startManual accepts a span the automatic floor would refuse', async () => {
  const { app } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  const sessionValue = session()
  // 700 tokens of compactable history: below 10% of the 68928-token threshold,
  // but above the absolute manual floor, so `/bcompact` must accept it.
  app.get('tokenMeter').measure = () => ({
    totalTokens: 800,
    surfaceTokens: 800,
    nodes: sessionValue.surface.nodes.map((seq) => ({ seq, tokens: seq === 3 ? 100 : 350 })),
  })
  const outcome = await engine.startManual(agentFor(sessionValue))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.range.seqs, [1, 2])
  await Promise.all([...engine.pending])
})

test('settings changes are applied live to the summarization route', async () => {
  const { app, calls } = application()
  const engine = new BackgroundCompactionEngine(app, {})
  await engine.settingsStore.update({ summarizationModel: { provider: 'openai', model: 'gpt-x' } })
  assert.equal(engine.config.summarizationProvider, 'openai')
  assert.equal(engine.config.summarizationModel, 'gpt-x')
  await engine.summarize({ messages: [] }, agentFor(session()), undefined)
  assert.equal(calls[0].provider, 'openai')
  assert.equal(calls[0].model, 'gpt-x')
})

test('mounts the settings remote through the Typert face', async () => {
  const { app } = application()
  const contributions = []
  app.provide('typert', {
    register(contribution) {
      contributions.push(contribution)
      return () => {}
    },
  })
  const engine = new BackgroundCompactionEngine(app, {})
  await settle()
  assert.equal(contributions.length, 1, 'exactly one Typert contribution')
  const contribution = contributions[0]
  assert.equal(contribution.package, 'dsh-background-compaction')
  assert.equal(contribution.face, 'host')
  assert.deepEqual(
    contribution.invocations.map((invocation) => invocation.method),
    ['get', 'update'],
  )
  for (const invocation of contribution.invocations) {
    assert.equal(invocation.service, 'backgroundCompaction')
    assert.equal(invocation.namespace, 'backgroundCompaction')
    assert.equal(invocation.invocation.kind, 'direct')
  }
  assert.deepEqual(contribution.invocations[0].parameters, [])
  assert.deepEqual(
    contribution.invocations[1].parameters.map((parameter) => parameter.wire),
    ['patch'],
  )
  const service = app.get('backgroundCompaction')
  assert.equal(service.constructor.name, 'BackgroundCompactionSettings')
  assert.equal(service.get().settings.autoTriggerRatio, 0.85)
  assert.equal(engine.held.size, 0)
})

test('the remote persists updates and reports the effective values', async () => {
  const { app } = application()
  app.provide('typert', { register: () => () => {} })
  const engine = new BackgroundCompactionEngine(app, {})
  await settle()
  const service = app.get('backgroundCompaction')
  const updated = await service.update({ autoTriggerRatio: 0.6, maxFailures: 4 })
  assert.equal(updated.settings.autoTriggerRatio, 0.6)
  assert.equal(updated.effective.autoTriggerRatio, 0.6)
  assert.equal(engine.startRatio, 0.6)
  assert.equal(engine.maxFailures, 4)
  assert.match(updated.paths.settings, /config\.json$/)
})

test('registers /bcompact when the command service is present', async () => {
  const { app } = application()
  const registered = []
  app.provide('commands', {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  })
  const engine = new BackgroundCompactionEngine(app, {})
  await settle()
  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.name, 'bcompact')
  assert.equal(definition.definitionId, 'dsh-background-compaction')
  assert.equal(typeof definition.handler, 'function')
  assert.equal(engine.constructor.name, 'BackgroundCompactionEngine')
})
