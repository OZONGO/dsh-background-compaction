/**
 * Configuration split and load-time validation of the `background` section.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BACKGROUND_DEFAULTS, Config, resolveBackground, splitConfig } from '../src/host/config.js'

test('splitConfig separates our section from the base keys', () => {
  const { basic, background } = splitConfig({ auto: false, thresholdRatio: 0.5, background: { startRatio: 0.9 } })
  assert.deepEqual(basic, { auto: false, thresholdRatio: 0.5 })
  assert.deepEqual(background, { startRatio: 0.9 })
})

test('splitConfig tolerates a missing configuration', () => {
  assert.deepEqual(splitConfig(undefined), { basic: {}, background: undefined })
})

test('resolveBackground fills defaults', () => {
  assert.deepEqual(resolveBackground(undefined), { ...BACKGROUND_DEFAULTS })
})

test('resolveBackground merges partial overrides', () => {
  assert.equal(resolveBackground({ startRatio: 0.7 }).startRatio, 0.7)
  assert.equal(resolveBackground({ startRatio: 0.7 }).tailRatio, BACKGROUND_DEFAULTS.tailRatio)
})

test('resolveBackground rejects a start ratio outside (0,1)', () => {
  assert.throws(() => resolveBackground({ startRatio: 0 }), /startRatio must be in \(0,1\)/)
  assert.throws(() => resolveBackground({ startRatio: 1 }), /startRatio must be in \(0,1\)/)
})

test('resolveBackground rejects a non-positive tail ratio', () => {
  assert.throws(() => resolveBackground({ tailRatio: 0 }), /tailRatio must be > 0/)
})

test('resolveBackground rejects a min span ratio at or above the start ratio', () => {
  assert.throws(
    () => resolveBackground({ startRatio: 0.5, minShadowedRatio: 0.5 }),
    /minShadowedRatio .* must be below startRatio/,
  )
})

test('resolveBackground rejects negative or fractional counters', () => {
  assert.throws(() => resolveBackground({ cacheWarmMs: -1 }), /cacheWarmMs/)
  assert.throws(() => resolveBackground({ holdTtlMs: 1.5 }), /holdTtlMs/)
  assert.throws(() => resolveBackground({ maxSessions: 0 }), /maxSessions/)
  assert.throws(() => resolveBackground({ maxFailures: -1 }), /maxFailures/)
  assert.throws(() => resolveBackground({ failureCooldownMs: -1 }), /failureCooldownMs/)
  assert.throws(() => resolveBackground({ failureCooldownMs: 1.5 }), /failureCooldownMs/)
})

test('the schema declares every base key plus background', () => {
  const keys = Object.keys(Config.dict ?? {})
  for (const key of [
    'thresholdRatio',
    'headroomTokens',
    'retainRatio',
    'retainTokens',
    'summarizationProvider',
    'summarizationModel',
    'maxTokens',
    'compactionRetries',
    'maxOverflowRetries',
    'modelPolicies',
    'auto',
    'background',
  ]) {
    assert.ok(keys.includes(key), `Config must declare ${key}`)
  }
})
