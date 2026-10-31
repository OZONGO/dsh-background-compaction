/**
 * Settings remote: the only channel between the settings page and the host.
 *
 * `ctx.configForms` is client-only and only accepts `.volatile()` fields of a
 * Loader entry, which cannot express a plugin-owned JSON file. This module uses
 * the hand-written Typert descriptor form that `dsh-ops` ships: provide a plain
 * service, register descriptors under the package face, and let the generated
 * client gateway project `ctx.remote.<namespace>.<method>()`.
 *
 * @module dsh-background-compaction/remote
 */

/** Namespace shared by the host service and the client proxy. */
export const REMOTE_NAMESPACE = 'backgroundCompaction'

/**
 * Build one strict codec.
 * @param {string} name - codec identity used in error messages.
 * @param {(value: unknown) => unknown} parse - value parser.
 * @returns {object} codec descriptor.
 */
const codec = (name, parse) => ({
  mode: 'strict',
  typeSymbol: `dsh-background-compaction#${name}`,
  create: () => ({ parse }),
})

/** Result codec: the host returns a plain JSON value. */
const jsonResult = codec('SettingsResult', (value) => value)

/** Patch codec: reject anything that is not a plain object before it reaches disk. */
const patchCodec = codec('SettingsPatch', (value) => {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('settings patch must be an object')
  return value
})

/**
 * Build one remote method descriptor.
 * @param {string} method - method name.
 * @param {{wire: string, codec: object} | undefined} parameter - optional single parameter.
 * @returns {object} descriptor.
 */
function descriptor(method, parameter) {
  return {
    id: `dsh-background-compaction#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    result: jsonResult,
    parameters:
      parameter === undefined
        ? []
        : [{ name: parameter.wire, wire: parameter.wire, source: 'json', codec: parameter.codec }],
  }
}

/** Invocation descriptors registered for this package face. */
export const REMOTE_DESCRIPTORS = Object.freeze([
  descriptor('get'),
  descriptor('update', { wire: 'patch', codec: patchCodec }),
])

/**
 * Settings service exposed to the client half.
 */
export class BackgroundCompactionSettings {
  /** Typert remote identity consumed by the host gateway. */
  typertRemote = Object.freeze({
    service: this,
    serviceKey: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
  })

  /**
   * @param {object} engine - background compaction engine.
   */
  constructor(engine) {
    this.engine = engine
  }

  /**
   * Read the stored settings plus the values actually in force.
   * @returns {object} settings snapshot.
   */
  get() {
    const settings = this.engine.settingsStore.get()
    return {
      settings,
      effective: {
        autoTriggerRatio: this.engine.startRatio,
        maxFailures: this.engine.maxFailures,
        summarizationProvider: this.engine.config.summarizationProvider,
        summarizationModel: this.engine.config.summarizationModel,
      },
      paths: {
        directory: this.engine.stateDirectory,
        settings: this.engine.settingsStore.file,
      },
      held: this.engine.held.size,
    }
  }

  /**
   * Persist a settings patch and apply it live.
   * @param {object} patch - partial settings.
   * @returns {Promise<object>} committed snapshot.
   */
  async update(patch) {
    await this.engine.settingsStore.update(patch ?? {})
    return this.get()
  }
}

/**
 * Mount the remote service and its descriptors.
 * @param {object} scope - context that owns `typert`.
 * @param {object} engine - background compaction engine.
 */
export function mountSettingsRemote(scope, engine) {
  const service = new BackgroundCompactionSettings(engine)
  scope.provide(REMOTE_NAMESPACE, service)
  scope.typert.register({
    package: 'dsh-background-compaction',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: REMOTE_DESCRIPTORS,
  })
}
