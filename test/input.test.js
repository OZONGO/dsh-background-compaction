/**
 * Replay-input construction and fingerprint stability.
 *
 * The fingerprint is the only thing that connects a background summary to the
 * input the engine rebuilds at swap time. If it is not deterministic, the swap
 * silently degrades into a second model call.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSummarizationInput, fingerprint, shortFingerprint, stableStringify } from '../src/host/input.js'
import { events, makeSession } from './helpers.js'

test('stableStringify sorts object keys at every depth', () => {
  const left = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }
  const right = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }
  assert.equal(stableStringify(left), stableStringify(right))
})

test('stableStringify keeps array order significant', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('stableStringify skips undefined object members but keeps array holes as null', () => {
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
  assert.equal(stableStringify([1, undefined]), '[1,null]')
})

test('fingerprint is stable across key order and changes with content', () => {
  const a = { tools: [{ name: 'read' }], messages: [{ role: 'user', content: 'hi' }] }
  const b = { messages: [{ content: 'hi', role: 'user' }], tools: [{ name: 'read' }] }
  assert.equal(fingerprint(a), fingerprint(b))
  assert.notEqual(fingerprint(a), fingerprint({ ...a, messages: [{ role: 'user', content: 'HI' }] }))
  assert.equal(fingerprint(a).length, 64)
})

test('shortFingerprint is a readable prefix', () => {
  assert.equal(shortFingerprint('abcdef0123456789'), 'abcdef012345')
  assert.equal(shortFingerprint(undefined), 'none')
})

test('replay input leads with the system head and keeps surface order', () => {
  const session = makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'one'),
      events.assistant(2, 'two'),
      events.user(3, 'three'),
    ],
  })
  const input = buildSummarizationInput(session, [1, 2])
  assert.equal(input.messages.length, 3)
  assert.equal(input.messages[0].role, 'system')
  assert.equal(input.messages[1].content[0].text, 'one')
  assert.equal(input.messages[2].content[0].text, 'two')
  assert.equal(input.tools, undefined)
})

test('replay input carries the request tool list when present', () => {
  const tools = [{ name: 'read', description: 'read a file' }]
  const session = makeSession({ events: [events.system(0, 'sys'), events.user(1, 'one')], tools })
  const input = buildSummarizationInput(session, [1])
  assert.deepEqual(input.tools, tools)
})

test('replay input omits the leading system message when node 0 is not a system event', () => {
  const session = makeSession({ events: [events.user(0, 'one'), events.assistant(1, 'two')] })
  const input = buildSummarizationInput(session, [0, 1])
  assert.equal(input.messages.length, 2)
  assert.equal(input.messages[0].role, 'user')
})

test('replay input drops events that project to no message', () => {
  const session = makeSession({
    events: [events.system(0, 'sys'), events.user(1, 'one'), events.compactionStart(2)],
  })
  const input = buildSummarizationInput(session, [1, 2])
  assert.equal(input.messages.length, 2)
})
