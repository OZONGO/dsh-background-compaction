/**
 * Held store and the invalidation matrix.
 *
 * Every rule here protects against using a summary that no longer describes the
 * span the engine is about to compact. A missed rule corrupts the model's view
 * of the conversation; a false positive only costs one extra summarization.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSummarizationInput, fingerprint } from '../src/host/input.js'
import { HeldStore, heldInvalidReason, INVALID } from '../src/host/held.js'
import { selectRange } from '../src/host/range.js'
import { events, makeSession, measure } from './helpers.js'

const background = { tailRatio: 0.5, minShadowedRatio: 0.1, holdTtlMs: 900_000 }
const spec = { thresholdTokens: 1000 }
const target = { provider: 'deepseek', model: 'deepseek-v4' }

/**
 * Build a session with one complete previous turn and a current user message.
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

/**
 * Build a ready held record for the session's natural range.
 * @param {object} sessionValue - fake session.
 * @param {object} overrides - field overrides.
 * @returns {object} held record.
 */
function makeHeld(sessionValue, overrides = {}) {
  const range = selectRange(sessionValue, measure(sessionValue, () => 100), spec, background)
  const input = buildSummarizationInput(sessionValue, range.seqs)
  return {
    sessionId: sessionValue.id,
    startSeq: range.start,
    endSeq: range.end,
    seqs: range.seqs,
    fingerprint: fingerprint(input),
    target,
    headSeq: sessionValue.surface.nodes[0],
    result: { summary: [], llmStreamCall: true, provider: target.provider, model: target.model },
    createdAt: Date.now(),
    tailTokens: range.tailTokens,
    shadowedTokens: range.shadowedTokens,
    state: 'ready',
    origin: 'auto',
    abort: new AbortController(),
    ...overrides,
  }
}

/**
 * Validate a held record against a session.
 * @param {object} held - held record.
 * @param {object} sessionValue - fake session.
 * @param {object} overrides - validation overrides.
 * @returns {string | null} invalidation reason.
 */
function check(held, sessionValue, overrides = {}) {
  return heldInvalidReason(held, {
    session: sessionValue,
    measurement: overrides.measurement ?? measure(sessionValue, () => 100),
    spec: overrides.spec ?? spec,
    background: overrides.background ?? background,
    target: 'target' in overrides ? overrides.target : target,
    now: overrides.now ?? Date.now(),
  })
}

test('a freshly built summary is valid', () => {
  const s = session()
  assert.equal(check(makeHeld(s), s), null)
})

test('an unfinished summary is never valid', () => {
  const s = session()
  assert.equal(check(makeHeld(s, { state: 'running' }), s), INVALID.NOT_READY)
  assert.equal(check(makeHeld(s, { state: 'failed' }), s), INVALID.NOT_READY)
})

test('a changed system head invalidates the summary', () => {
  const s = session()
  assert.equal(check(makeHeld(s, { headSeq: 999 }), s), INVALID.HEAD_CHANGED)
})

test('a routed model change invalidates the summary', () => {
  const s = session()
  assert.equal(check(makeHeld(s), s, { target: { provider: 'openai', model: 'x' } }), INVALID.TARGET_CHANGED)
  assert.equal(check(makeHeld(s), s, { target: undefined }), INVALID.TARGET_CHANGED)
})

test('a span that left the surface is invalid', () => {
  const s = session()
  assert.equal(check(makeHeld(s, { startSeq: 999 }), s), INVALID.RANGE_MISSING)
  assert.equal(check(makeHeld(s, { endSeq: 999 }), s), INVALID.RANGE_MISSING)
})

test('a tail that grew past the cap invalidates the summary', () => {
  const s = session()
  const measurement = measure(s, (seq) => (seq === 3 ? 900 : 100))
  assert.equal(check(makeHeld(s), s, { measurement }), INVALID.TAIL_TOO_LONG)
})

test('an expired summary is invalid', () => {
  const s = session()
  assert.equal(check(makeHeld(s), s, { now: Date.now() + 900_001 }), INVALID.EXPIRED)
})

test('a zero TTL disables expiry', () => {
  const s = session()
  assert.equal(check(makeHeld(s), s, { background: { ...background, holdTtlMs: 0 }, now: Date.now() + 10 ** 9 }), null)
})

test('a rewritten span invalidates the summary even when the seqs survive', () => {
  const s = session()
  const held = makeHeld(s)
  // Same seqs, different content: exactly what a compaction that replaced a
  // node inside the span looks like from the outside.
  const rewritten = makeSession({
    events: [events.system(0, 'sys'), events.user(1, 'turn 1'), events.assistant(2, 'rewritten'), events.user(3, 'turn 2')],
  })
  assert.equal(check(held, rewritten), INVALID.FINGERPRINT)
})

test('store tracks, finds, and drops entries', () => {
  const store = new HeldStore({ maxSessions: 2 })
  const held = { fingerprint: 'abc', state: 'ready', createdAt: 1, abort: new AbortController() }
  store.set('s1', held)
  assert.equal(store.get('s1'), held)
  assert.equal(store.findByFingerprint('s1', 'abc'), held)
  assert.equal(store.findByFingerprint('s1', 'zzz'), undefined)
  store.delete('s1')
  assert.equal(store.get('s1'), undefined)
})

test('store evicts the oldest non-running entry', () => {
  const store = new HeldStore({ maxSessions: 2 })
  const old = { fingerprint: 'a', state: 'ready', createdAt: 1, abort: new AbortController() }
  const running = { fingerprint: 'b', state: 'running', createdAt: 2, abort: new AbortController() }
  store.set('s1', old)
  store.set('s2', running)
  store.set('s3', { fingerprint: 'c', state: 'ready', createdAt: 3, abort: new AbortController() })
  assert.equal(store.get('s1'), undefined, 'oldest ready entry is evicted first')
  assert.equal(store.get('s2'), running, 'a running entry is preserved')
  assert.equal(store.size, 2)
})

test('store aborts running work on clear', () => {
  const store = new HeldStore({ maxSessions: 2 })
  const controller = new AbortController()
  store.set('s1', { fingerprint: 'a', state: 'running', createdAt: 1, abort: controller })
  store.clear()
  assert.equal(controller.signal.aborted, true)
  assert.equal(store.size, 0)
})
