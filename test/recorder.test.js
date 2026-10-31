/**
 * Swap evidence: the snapshot must describe exactly the request surface the
 * next turn will send.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { describeSwap, writeSwapSnapshot } from '../src/host/recorder.js'
import { events, makeSession, temporaryDirectory } from './helpers.js'

/**
 * Build a session whose surface already contains a compaction checkpoint.
 * @returns {object} fake session.
 */
function swappedSession() {
  return makeSession({
    events: [
      events.system(0, 'sys'),
      events.user(1, 'This is an automatically generated checkpoint condensing an earlier span'),
      events.user(2, 'continue'),
      events.assistant(3, 'working on it'),
    ],
  })
}

test('describeSwap captures roles, sizes, and heads of the derived request', () => {
  const session = swappedSession()
  const snapshot = describeSwap(
    session,
    {
      startSeq: 10,
      summarySeq: 11,
      endSeq: 20,
      shadowedRange: { start: 4, end: 8 },
      shadowedTokenCount: 4321,
      summary: [{ type: 'text', text: 'x'.repeat(120) }],
    },
    { tailTokens: 55, shadowedTokens: 4000 },
    { origin: 'auto', thresholdTokens: 68928, totalTokens: 70000 },
  )
  assert.equal(snapshot.origin, 'auto')
  // `startSeq`/`endSeq` name the compaction marker events; the replaced span is
  // `shadowedRange`, which is what an acceptance check has to look at.
  assert.deepEqual(snapshot.range, { start: 4, end: 8 })
  assert.equal(snapshot.shadowedTokens, 4000, 'route-priced span, the same unit as tailTokens')
  assert.equal(snapshot.shadowedTokenCount, 4321, "the engine's durable heuristic accounting")
  assert.equal(snapshot.summaryChars, 120)
  assert.equal(snapshot.tailTokens, 55)
  assert.equal(snapshot.messageCount, 4)
  assert.equal(snapshot.messages[0].role, 'system')
  assert.equal(snapshot.messages[1].role, 'user')
  assert.match(snapshot.messages[1].head, /automatically generated checkpoint/)
  assert.equal(snapshot.messages[2].head, 'continue')
})

test('describeSwap falls back to the engine count without a held measurement', () => {
  const session = swappedSession()
  const snapshot = describeSwap(
    session,
    { startSeq: 1, summarySeq: 2, endSeq: 3, shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 77, summary: [] },
    {},
    { origin: 'auto', thresholdTokens: 1000, totalTokens: 900 },
  )
  assert.equal(snapshot.shadowedTokens, 77)
})

test('writeSwapSnapshot lands one file and no temporary residue', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  const session = swappedSession()
  const snapshot = describeSwap(
    session,
    { startSeq: 1, summarySeq: 2, endSeq: 3, shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 10, summary: [] },
    { tailTokens: 0, shadowedTokens: 10 },
    { origin: 'bcompact', thresholdTokens: 1000, totalTokens: 900 },
  )
  const written = await writeSwapSnapshot(fixture.directory, snapshot)
  assert.equal(written.ok, true)
  const parsed = JSON.parse(await readFile(join(fixture.directory, 'last-swap.json'), 'utf8'))
  assert.equal(parsed.origin, 'bcompact')
  assert.deepEqual(await readdir(fixture.directory), ['last-swap.json'])
})

test('writeSwapSnapshot reports failure without throwing', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  // A regular file cannot be used as the state directory.
  const blocker = join(fixture.directory, 'not-a-directory')
  await writeFile(blocker, 'x', 'utf8')
  const written = await writeSwapSnapshot(blocker, { at: 1 })
  assert.equal(written.ok, false)
  assert.ok(written.error instanceof Error)
})
