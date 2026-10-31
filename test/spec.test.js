/**
 * Token-budget arithmetic must match the foreground engine exactly.
 *
 * The 200k example is the single most important number in this project: the
 * effective threshold is ~68928 tokens, not 160000, because the output
 * reservation and the compaction headroom are deducted first.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_POLICY } from './helpers.js'
import { resolveCompactSpec, resolveTargetPolicy, routedTarget, SpecConfigError } from '../src/host/spec.js'

test('200k window: threshold is 68928, not 160000', () => {
  const spec = resolveCompactSpec(DEFAULT_POLICY, 200_000, 65_536)
  assert.equal(spec.messageBudgetTokens, 134_464)
  assert.equal(spec.pressureBudgetTokens, 68_928)
  assert.equal(spec.thresholdTokens, 68_928)
  assert.equal(spec.retainTokens, 21_514)
})

test('a wide window is capped by the window fraction', () => {
  const spec = resolveCompactSpec(DEFAULT_POLICY, 1_000_000, 65_536)
  // min(1e6 * 0.8, 1e6 - 65536 - 65536) = 800000
  assert.equal(spec.thresholdTokens, 800_000)
})

test('retainTokens wins over retainRatio when configured', () => {
  const spec = resolveCompactSpec({ ...DEFAULT_POLICY, retainTokens: 5_000 }, 200_000, 65_536)
  assert.equal(spec.retainTokens, 5_000)
})

test('rejects a window that cannot cover the output reservation', () => {
  assert.throws(() => resolveCompactSpec(DEFAULT_POLICY, 40_000, 65_536), SpecConfigError)
})

test('rejects a window with no pressure budget left', () => {
  assert.throws(() => resolveCompactSpec(DEFAULT_POLICY, 120_000, 65_536), SpecConfigError)
})

test('rejects non-integer capacity', () => {
  assert.throws(() => resolveCompactSpec(DEFAULT_POLICY, 200_000.5, 65_536), SpecConfigError)
})

test('rejects retention that would swallow the whole budget', () => {
  assert.throws(
    () => resolveCompactSpec({ ...DEFAULT_POLICY, retainRatio: 0.95 }, 200_000, 65_536),
    /must be less than threshold tokens/,
  )
})

test('target policy merges an exact provider/model override', () => {
  const config = {
    ...DEFAULT_POLICY,
    modelPolicies: [
      {
        provider: 'deepseek',
        model: 'deepseek-v4',
        thresholdRatio: 0.5,
        summarizationProvider: 'openai',
        summarizationModel: 'gpt-x',
      },
    ],
  }
  const policy = resolveTargetPolicy(config, { provider: 'deepseek', model: 'deepseek-v4' })
  assert.equal(policy.thresholdRatio, 0.5)
  assert.equal(policy.headroomTokens, 65536)
  assert.equal(policy.summarizationProvider, 'openai')
  assert.equal(policy.summarizationModel, 'gpt-x')
})

test('target policy falls back to the base configuration', () => {
  const policy = resolveTargetPolicy({ ...DEFAULT_POLICY, modelPolicies: [] }, { provider: 'x', model: 'y' })
  assert.equal(policy.thresholdRatio, DEFAULT_POLICY.thresholdRatio)
  assert.deepEqual(policy.target, { provider: 'x', model: 'y' })
})

test('routedTarget reads the last durable request header', () => {
  const session = { requestHeader: () => ({ config: { provider: 'deepseek', model: 'm' } }) }
  assert.deepEqual(routedTarget(session), { provider: 'deepseek', model: 'm' })
})

test('routedTarget refuses an empty or missing route', () => {
  assert.equal(routedTarget({ requestHeader: () => ({ config: { provider: '', model: '' } }) }), undefined)
  assert.equal(routedTarget({ requestHeader: () => undefined }), undefined)
})
