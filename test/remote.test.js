/**
 * The remote contract exists twice: once as ESM for the host (`src/host/remote.js`)
 * and once inlined in the hand-written client bundle (`src/client/index.js`),
 * because the client bundle cannot import host modules. This test pins the two
 * together so a rename on one side fails loudly instead of producing a settings
 * page that silently cannot reach its host.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { REMOTE_DESCRIPTORS, REMOTE_NAMESPACE } from '../src/host/remote.js'

const CLIENT_SOURCE = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'index.js'), 'utf8')

test('host and client agree on the namespace', () => {
  assert.equal(REMOTE_NAMESPACE, 'backgroundCompaction')
  assert.match(CLIENT_SOURCE, new RegExp(`const REMOTE_NAMESPACE = '${REMOTE_NAMESPACE}'`))
})

test('host and client agree on the mounted methods', () => {
  const hostMethods = REMOTE_DESCRIPTORS.map((descriptor) => descriptor.method).sort()
  const clientMethods = [...CLIENT_SOURCE.matchAll(/remoteDescriptor\('([a-zA-Z]+)'/g)]
    .map((match) => match[1])
    .sort()
  assert.deepEqual(clientMethods, hostMethods)
  assert.deepEqual(hostMethods, ['get', 'update'])
})

test('every host descriptor is direct, strict, and namespaced', () => {
  for (const descriptor of REMOTE_DESCRIPTORS) {
    assert.equal(descriptor.service, REMOTE_NAMESPACE)
    assert.equal(descriptor.namespace, REMOTE_NAMESPACE)
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.result.mode, 'strict')
    assert.ok(descriptor.id.startsWith(`dsh-background-compaction#${REMOTE_NAMESPACE}/`))
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.source, 'json')
      assert.equal(parameter.codec.mode, 'strict')
    }
  }
})

test('the client mounts the same package identity', () => {
  assert.match(CLIENT_SOURCE, /const REMOTE_PACKAGE = 'dsh-background-compaction'/)
  assert.match(CLIENT_SOURCE, /ctx\.remote\.\$mount\(REMOTE_CONTRIBUTION\)/)
})

test('the client bundle is a ModuleLoader factory with the plugin exports', () => {
  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(CLIENT_SOURCE, /id: 'dsh-background-compaction'/)
  assert.match(CLIENT_SOURCE, /factory: \(require\) => \{/)
  assert.match(CLIENT_SOURCE, /apply,\s*inject,\s*name: NAME/)
  assert.match(CLIENT_SOURCE, /const inject = \['slots', 'locale', 'remote'\]/)
})
