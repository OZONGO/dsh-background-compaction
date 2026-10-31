/**
 * Settings: defaults, validation, atomic persistence, live notification, and
 * tolerance for a hand-edited or corrupt file.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  normalizeModelPair,
  normalizeSettings,
  SETTINGS_DEFAULTS,
  SettingsStore,
  SettingsValidationError,
} from '../src/host/settings.js'
import { temporaryDirectory } from './helpers.js'

test('defaults follow the conversation model and start at 85%', () => {
  assert.deepEqual(normalizeSettings({}), {
    autoTriggerRatio: 0.85,
    summarizationModel: { provider: '', model: '' },
    maxFailures: 2,
  })
})

test('accepts an explicit model pair', () => {
  assert.deepEqual(normalizeModelPair({ provider: ' openai ', model: ' gpt-x ' }), {
    provider: 'openai',
    model: 'gpt-x',
  })
})

test('rejects a half-set model pair', () => {
  assert.throws(() => normalizeModelPair({ provider: 'openai', model: '' }), SettingsValidationError)
  assert.throws(() => normalizeModelPair({ provider: '', model: 'gpt-x' }), SettingsValidationError)
})

test('rejects a trigger ratio outside (0,1)', () => {
  assert.throws(() => normalizeSettings({ autoTriggerRatio: 0 }), /must be in \(0,1\)/)
  assert.throws(() => normalizeSettings({ autoTriggerRatio: 1 }), /must be in \(0,1\)/)
  assert.throws(() => normalizeSettings({ autoTriggerRatio: Number.NaN }), /must be in \(0,1\)/)
})

test('rejects a failure limit outside [0,10] or non-integer', () => {
  assert.throws(() => normalizeSettings({ maxFailures: -1 }), /must be an integer in \[0,10\]/)
  assert.throws(() => normalizeSettings({ maxFailures: 11 }), /must be an integer in \[0,10\]/)
  assert.throws(() => normalizeSettings({ maxFailures: 1.5 }), /must be an integer in \[0,10\]/)
})

test('missing file loads as defaults', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  const store = new SettingsStore({ directory: fixture.directory })
  assert.deepEqual(store.load(), { ok: true })
  assert.deepEqual(store.get(), { ...SETTINGS_DEFAULTS })
})

test('a corrupt file reports a diagnostic and keeps defaults', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  await writeFile(join(fixture.directory, 'config.json'), '{ not json', 'utf8')
  const store = new SettingsStore({ directory: fixture.directory })
  const loaded = store.load()
  assert.equal(loaded.ok, false)
  assert.deepEqual(store.get(), { ...SETTINGS_DEFAULTS })
})

test('a valid file overrides defaults and preserves unknown keys', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  await writeFile(
    join(fixture.directory, 'config.json'),
    JSON.stringify({ autoTriggerRatio: 0.5, maxFailures: 5, note: 'keep me' }),
    'utf8',
  )
  const store = new SettingsStore({ directory: fixture.directory })
  assert.deepEqual(store.load(), { ok: true })
  assert.equal(store.get().autoTriggerRatio, 0.5)
  assert.equal(store.get().maxFailures, 5)
  assert.equal(store.extra.note, 'keep me')
})

test('update persists atomically, leaves no temp files, and notifies', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  const store = new SettingsStore({ directory: fixture.directory })
  store.load()
  const seen = []
  const unsubscribe = store.subscribe((settings) => seen.push(settings))
  const committed = await store.update({ autoTriggerRatio: 0.42 })
  unsubscribe()
  assert.equal(committed.autoTriggerRatio, 0.42)
  assert.equal(seen.length, 1)
  const written = JSON.parse(await readFile(join(fixture.directory, 'config.json'), 'utf8'))
  assert.equal(written.autoTriggerRatio, 0.42)
  assert.equal(written.$schema, 1)
  const entries = await readdir(fixture.directory)
  assert.deepEqual(entries, ['config.json'])
})

test('a rejected update does not touch disk or memory', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  const store = new SettingsStore({ directory: fixture.directory })
  store.load()
  await assert.rejects(() => store.update({ autoTriggerRatio: 2 }), SettingsValidationError)
  assert.equal(store.get().autoTriggerRatio, SETTINGS_DEFAULTS.autoTriggerRatio)
  assert.deepEqual(await readdir(fixture.directory), [])
})

test('update preserves unknown keys carried over from the file', async (t) => {
  const fixture = await temporaryDirectory()
  t.after(fixture.cleanup)
  await writeFile(join(fixture.directory, 'config.json'), JSON.stringify({ note: 'keep me' }), 'utf8')
  const store = new SettingsStore({ directory: fixture.directory })
  store.load()
  await store.update({ maxFailures: 3 })
  const written = JSON.parse(await readFile(join(fixture.directory, 'config.json'), 'utf8'))
  assert.equal(written.note, 'keep me')
  assert.equal(written.maxFailures, 3)
})
