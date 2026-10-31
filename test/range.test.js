/**
 * Range selection: the span must end before the most recent user message so the
 * previous turn survives verbatim, must never include the system node, and must
 * never split a tool-call/result pair.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RANGE_SKIP, selectRange, tailTokensAfter } from '../src/host/range.js'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { events, makeSession, measure } from './helpers.js'

const background = { tailRatio: 0.5, minShadowedRatio: 0.1 }
const spec = { thresholdTokens: 1000 }

/**
 * Token weight per event type, so a test can make one turn expensive.
 * @param {Record<number, number>} overrides - explicit per-seq weights.
 * @returns {(seq: number) => number} token lookup.
 */
function tokens(overrides = {}) {
  return (seq) => overrides[seq] ?? 100
}

test('keeps the most recent turn verbatim', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.user(3, 'turn 2'),
      events.assistant(4, 'answer 2'),
      events.user(5, 'turn 3'),
    ],
  })
  const range = selectRange(session, measure(session, tokens()), spec, background)
  assert.equal(range.start, 1)
  assert.equal(range.end, 4)
  assert.deepEqual(range.seqs, [1, 2, 3, 4])
  assert.equal(range.tailTokens, 100)
  assert.equal(range.shadowedTokens, 400)
})

test('never includes the system node', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.user(3, 'turn 2'),
    ],
  })
  const range = selectRange(session, measure(session, tokens()), spec, background)
  assert.ok(!range.seqs.includes(0), 'system node must stay out of the span')
})

test('both edges of the chosen span are balanced cuts', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'calling', 1),
      events.toolResult(3, 'call-2-0'),
      events.assistant(4, 'answer 1'),
      events.user(5, 'turn 2'),
    ],
  })
  const range = selectRange(session, measure(session, tokens()), spec, background)
  assert.equal(range.end, 4)
  assert.deepEqual(range.seqs, [1, 2, 3, 4])
  assert.equal(toolPairingBalancedAfter(session, range.end), true)
  assert.equal(toolPairingBalancedBefore(session, range.start), true)
})

test('refuses when the last turn leaves a tool call unanswered', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'calling', 1),
      events.user(3, 'turn 2'),
    ],
  })
  const range = selectRange(session, measure(session, tokens()), spec, background)
  assert.equal(range.skip, RANGE_SKIP.UNBALANCED)
})

test('refuses when no balanced cut exists', () => {
  const session = makeSession({
    events: [events.system(0, 'sys'), events.user(1, 'turn 1'), events.assistant(2, 'calling', 1), events.user(3, 'turn 2')],
  })
  const range = selectRange(session, measure(session, tokens()), spec, background)
  assert.equal(range.skip, RANGE_SKIP.UNBALANCED)
})

test('refuses an empty or single-node surface', () => {
  const empty = makeSession({ events: [] })
  assert.equal(selectRange(empty, measure(empty, tokens()), spec, background).skip, RANGE_SKIP.EMPTY)
  const onlySystem = makeSession({ events: [events.system(0, 'sys')] })
  assert.equal(selectRange(onlySystem, measure(onlySystem, tokens()), spec, background).skip, RANGE_SKIP.EMPTY)
})

test('refuses a surface without a user message', () => {
  const session = makeSession({ events: [events.system(0, 'sys'), events.assistant(1, 'hello')] })
  assert.equal(selectRange(session, measure(session, tokens()), spec, background).skip, RANGE_SKIP.NO_USER)
})

test('refuses when the verbatim tail is too expensive', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.user(3, 'turn 2'),
    ],
  })
  const range = selectRange(session, measure(session, tokens({ 3: 900 })), spec, background)
  assert.equal(range.skip, RANGE_SKIP.TAIL_TOO_LONG)
})

test('refuses when the summarized span is too small', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'turn 1'),
      events.assistant(2, 'answer 1'),
      events.user(3, 'turn 2'),
    ],
  })
  // Span [1..2] is 20 tokens, below 10% of the 1000-token threshold.
  const range = selectRange(session, measure(session, tokens({ 1: 10, 2: 10 })), spec, background)
  assert.equal(range.skip, RANGE_SKIP.TOO_SMALL)
})

test('tailTokensAfter counts every node after the span', () => {
  const session = makeSession({
    events: [events.system(0, 'sys'), events.user(1, 'a'), events.assistant(2, 'b'), events.user(3, 'c')],
  })
  assert.equal(tailTokensAfter(session, 1, measure(session, tokens())), 200)
  assert.equal(tailTokensAfter(session, 99, measure(session, tokens())), Number.POSITIVE_INFINITY)
})
