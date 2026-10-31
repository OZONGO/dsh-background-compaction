/**
 * Plugin-owned settings file.
 *
 * The user asked for a file the plugin owns, editable by hand and applied live
 * without restarting DSH. That rules out the native `settings` service, whose
 * preferences land in the profile patch and only accept `.volatile()` fields.
 *
 * Layout: `<dsh home>/background-compaction/config.json`
 *
 * Precedence: settings file > YAML `config` > built-in defaults. Only three
 * keys are written by the settings page, but the file accepts any key that the
 * engine understands, so a power user can pin `startRatio` by hand.
 *
 * Writes are atomic (`tmp` → `fsync` → `rename` → `fsync(dir)`) so a crash or a
 * concurrent read never observes a half-written file. `dsh-pet` writes its
 * config with a plain `writeFile`; this module deliberately does better.
 *
 * @module dsh-background-compaction/settings
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Schema version written into the file. */
export const SETTINGS_SCHEMA = 1

/** Field defaults applied when the file omits a key. */
export const SETTINGS_DEFAULTS = Object.freeze({
  autoTriggerRatio: 0.85,
  summarizationModel: Object.freeze({ provider: '', model: '' }),
  maxFailures: 2,
})

/** Raised when a settings update is rejected before touching disk. */
export class SettingsValidationError extends Error {
  /**
   * @param {string} field - offending field.
   * @param {string} message - actionable detail.
   */
  constructor(field, message) {
    super(`dsh-background-compaction: ${field} ${message}`)
    this.name = 'SettingsValidationError'
    this.field = field
  }
}

/**
 * Normalize one summarization-model pair.
 *
 * The engine requires the pair to be either both empty (follow the conversation
 * model) or both non-empty; a half-set pair throws at request time.
 *
 * @param {unknown} value - candidate pair.
 * @param {string} field - field name for error messages.
 * @returns {{provider: string, model: string}} normalized pair.
 */
export function normalizeModelPair(value, field = 'summarizationModel') {
  if (value === undefined || value === null) return { ...SETTINGS_DEFAULTS.summarizationModel }
  if (typeof value !== 'object') throw new SettingsValidationError(field, 'must be an object with provider and model')
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider.length === 0 !== (model.length === 0)) {
    throw new SettingsValidationError(field, 'provider and model must be set together as an empty or non-empty pair')
  }
  return { provider, model }
}

/**
 * Validate and normalize a settings patch.
 * @param {unknown} patch - raw candidate.
 * @returns {{autoTriggerRatio: number, summarizationModel: {provider: string, model: string}, maxFailures: number}} normalized settings.
 */
export function normalizeSettings(patch) {
  const source = patch ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new SettingsValidationError('settings', 'must be an object')
  }
  const ratio = source.autoTriggerRatio ?? SETTINGS_DEFAULTS.autoTriggerRatio
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new SettingsValidationError('autoTriggerRatio', `must be in (0,1), received ${ratio}`)
  }
  const failures = source.maxFailures ?? SETTINGS_DEFAULTS.maxFailures
  if (!Number.isSafeInteger(failures) || failures < 0 || failures > 10) {
    throw new SettingsValidationError('maxFailures', `must be an integer in [0,10], received ${failures}`)
  }
  return {
    autoTriggerRatio: ratio,
    summarizationModel: normalizeModelPair(source.summarizationModel),
    maxFailures: failures,
  }
}

/**
 * Merge a stored file over the defaults, ignoring unknown keys.
 * @param {unknown} raw - parsed file contents.
 * @returns {{settings: object, extra: object}} normalized settings plus unrecognized keys.
 */
function mergeFile(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const { $schema, autoTriggerRatio, summarizationModel, maxFailures, ...extra } = source
  const settings = normalizeSettings({ autoTriggerRatio, summarizationModel, maxFailures })
  return { settings, extra }
}

/**
 * Persist JSON atomically.
 * @param {string} file - destination path.
 * @param {string} contents - serialized payload.
 */
async function writeAtomic(file, contents) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  // Best-effort directory sync: makes the rename itself durable. Windows
  // refuses to open a directory handle, which is not an error worth surfacing.
  let directoryHandle
  try {
    directoryHandle = await open(directory, 'r')
    await directoryHandle.sync()
  } catch {
    // ignore
  } finally {
    if (directoryHandle !== undefined) await directoryHandle.close().catch(() => {})
  }
}

/**
 * Plugin-owned settings store.
 */
export class SettingsStore {
  /** @type {string} */
  #file
  /** @type {string} */
  #directory
  /** @type {object} */
  #settings = { ...SETTINGS_DEFAULTS, summarizationModel: { ...SETTINGS_DEFAULTS.summarizationModel } }
  /** @type {object} */
  #extra = {}
  /** @type {Array<(settings: object) => void>} */
  #listeners = new Set()

  /**
   * @param {{directory: string}} options - directory that owns `config.json`.
   */
  constructor(options) {
    this.#directory = options.directory
    this.#file = join(options.directory, 'config.json')
  }

  /** @returns {string} absolute settings file path. */
  get file() {
    return this.#file
  }

  /**
   * Read the file synchronously at construction time.
   *
   * A malformed file must never prevent the plugin from loading: the engine
   * still has YAML defaults to fall back on. The failure is reported through
   * the returned diagnostic so the caller can log it.
   *
   * @returns {{ok: true} | {ok: false, error: Error}} load outcome.
   */
  load() {
    let raw
    try {
      raw = readFileSync(this.#file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true }
      return { ok: false, error }
    }
    try {
      const parsed = JSON.parse(raw)
      const merged = mergeFile(parsed)
      this.#settings = merged.settings
      this.#extra = merged.extra
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** @returns {{autoTriggerRatio: number, summarizationModel: {provider: string, model: string}, maxFailures: number}} current settings. */
  get() {
    return { ...this.#settings, summarizationModel: { ...this.#settings.summarizationModel } }
  }

  /** @returns {object} unrecognized keys preserved from the file. */
  get extra() {
    return { ...this.#extra }
  }

  /**
   * Subscribe to committed changes.
   * @param {(settings: object) => void} listener - change listener.
   * @returns {() => void} unsubscribe.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Validate, persist, and publish a settings patch.
   *
   * The in-memory value only changes after the write succeeds, so a failed save
   * leaves the running engine on the previous, known-good settings.
   *
   * @param {object} patch - partial settings.
   * @returns {Promise<object>} committed settings.
   */
  async update(patch) {
    const candidate = normalizeSettings({
      autoTriggerRatio: patch?.autoTriggerRatio ?? this.#settings.autoTriggerRatio,
      summarizationModel: patch?.summarizationModel ?? this.#settings.summarizationModel,
      maxFailures: patch?.maxFailures ?? this.#settings.maxFailures,
    })
    const payload = JSON.stringify({ $schema: SETTINGS_SCHEMA, ...this.#extra, ...candidate }, null, 2)
    await writeAtomic(this.#file, `${payload}\n`)
    this.#settings = candidate
    for (const listener of this.#listeners) {
      try {
        listener(this.get())
      } catch {
        // a broken listener must not roll back a committed write
      }
    }
    return this.get()
  }
}
