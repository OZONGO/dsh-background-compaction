/**
 * `dsh-background-compaction` — background context compaction for DeepSeek Harness.
 *
 * The package default export is the engine class, so the Loader mounts it as
 * `ctx.compaction`. It **replaces** `@deepseek-ai/dsh-compaction-basic`; a
 * Cordis context allows exactly one provider per service name, and mounting
 * both throws at load time.
 *
 * @module dsh-background-compaction
 */

import { Config } from './config.js'
import { BackgroundCompactionEngine } from './engine.js'

export const name = 'dsh-background-compaction'

export { BackgroundCompactionEngine, Config }
export default BackgroundCompactionEngine
