/**
 * Trigger policy: every gate is independent and must be able to veto alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideBackgroundPreconditions, decideBackgroundStart, decidePressureStart, SKIP } from '../src/host/policy.js'

/** A decision input that starts. */
const base = Object.freeze({
  delegationDepth: 0,
  auto: true,
  heldState: undefined,
  locked: false,
  totalTokens: 60_000,
  thresholdTokens: 68_928,
  startRatio: 0.85,
  failures: 0,
  maxFailures: 2,
  hasRange: true,
  lastRequestAgeMs: 1_000,
  cacheWarmMs: 300_000,
  hasTarget: true,
})

test('starts between the start ratio and the threshold', () => {
  assert.deepEqual(decideBackgroundStart(base), { start: true })
})

test('starts exactly at the start ratio', () => {
  assert.deepEqual(decideBackgroundStart({ ...base, totalTokens: 68_928 * 0.85 }), { start: true })
})

test('refuses subagent sessions', () => {
  assert.equal(decideBackgroundStart({ ...base, delegationDepth: 1 }).reason, SKIP.SUBAGENT)
})

test('refuses when auto is off', () => {
  assert.equal(decideBackgroundStart({ ...base, auto: false }).reason, SKIP.AUTO_OFF)
})

test('refuses while a summary is already generating', () => {
  assert.equal(decideBackgroundStart({ ...base, heldState: 'running' }).reason, SKIP.RUNNING)
})

test('refuses while a summary is waiting for its swap', () => {
  assert.equal(decideBackgroundStart({ ...base, heldState: 'ready' }).reason, SKIP.READY)
})

test('refuses while another compaction owns the session lock', () => {
  assert.equal(decideBackgroundStart({ ...base, locked: true }).reason, SKIP.LOCKED)
})

test('refuses without a routed target', () => {
  assert.equal(decideBackgroundStart({ ...base, hasTarget: false }).reason, SKIP.NO_TARGET)
})

test('refuses once the circuit breaker is open', () => {
  assert.equal(decideBackgroundStart({ ...base, failures: 2 }).reason, SKIP.CIRCUIT_OPEN)
})

test('refuses at or above the threshold: the foreground owns that case', () => {
  assert.equal(decideBackgroundStart({ ...base, totalTokens: 68_928 }).reason, SKIP.DUE)
})

test('refuses below the start ratio', () => {
  assert.equal(decideBackgroundStart({ ...base, totalTokens: 10_000 }).reason, SKIP.BELOW_START)
})

test('refuses without a usable range', () => {
  assert.equal(decideBackgroundStart({ ...base, hasRange: false }).reason, SKIP.NO_RANGE)
})

test('refuses on a cold cache', () => {
  assert.equal(decideBackgroundStart({ ...base, lastRequestAgeMs: 900_000 }).reason, SKIP.COLD_CACHE)
})

test('a disabled cache gate never vetoes', () => {
  assert.deepEqual(decideBackgroundStart({ ...base, cacheWarmMs: 0, lastRequestAgeMs: 10 ** 9 }), { start: true })
})

test('the threshold wins over the start ratio when both apply', () => {
  assert.equal(decideBackgroundStart({ ...base, totalTokens: 90_000 }).reason, SKIP.DUE)
})

test('a zero failure limit disables background generation outright', () => {
  assert.equal(decideBackgroundStart({ ...base, maxFailures: 0 }).reason, SKIP.CIRCUIT_OPEN)
})

test('the breaker is half-open: a probe is allowed after the cooldown', () => {
  const open = { ...base, failures: 2, failureCooldownMs: 300_000 }
  assert.equal(decideBackgroundStart({ ...open, failureAgeMs: 1_000 }).reason, SKIP.CIRCUIT_OPEN)
  assert.deepEqual(decideBackgroundStart({ ...open, failureAgeMs: 300_000 }), { start: true })
})

test('the sync preconditions stand alone', () => {
  assert.equal(decideBackgroundPreconditions(base), null)
  assert.equal(decideBackgroundPreconditions({ ...base, delegationDepth: 2 }), SKIP.SUBAGENT)
  assert.equal(decideBackgroundPreconditions({ ...base, locked: true }), SKIP.LOCKED)
})

test('the pressure gates stand alone', () => {
  const pressure = {
    totalTokens: 60_000,
    thresholdTokens: 68_928,
    startRatio: 0.85,
    hasRange: true,
    lastRequestAgeMs: 1_000,
    cacheWarmMs: 300_000,
  }
  assert.equal(decidePressureStart(pressure), null)
  assert.equal(decidePressureStart({ ...pressure, totalTokens: 10_000 }), SKIP.BELOW_START)
  assert.equal(decidePressureStart({ ...pressure, hasRange: false }), SKIP.NO_RANGE)
  assert.equal(decidePressureStart({ ...pressure, lastRequestAgeMs: 900_000 }), SKIP.COLD_CACHE)
})
