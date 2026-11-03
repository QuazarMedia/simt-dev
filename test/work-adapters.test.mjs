// Plan 0004 W48: adapter SDK and conformance corpus.
//
// What the suite pins: a generic document adapter and a mock remote adapter pass the same contract
// suite; an executor must declare side effects, permissions and retry semantics; a descriptor that
// carries code is refused before it enters the registry; an absent adapter leaves the default
// operation intact; and an adapter is used only at a pinned version and digest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ADAPTER_SCHEMA,
  CAPABILITIES,
  INTERFACES,
  conformance,
  parseDescriptor,
  pinned,
  resolveAdapter,
  validateDescriptor,
} from '../src/adapters/conformance.mjs';

const document = () => ({
  schema: ADAPTER_SCHEMA,
  name: 'document',
  version: '1.0.0',
  digest: 'sha256-doc',
  interfaces: ['observer', 'validator'],
  capabilities: ['observe-only'],
  sideEffects: [],
  bounds: { maxInputBytes: 1_000_000, maxOutputBytes: 100_000 },
  permissions: [],
  provenance: { source: 'templates/work/document.json' },
});

const remote = () => ({
  schema: ADAPTER_SCHEMA,
  name: 'mock-remote',
  version: '2.1.0',
  digest: 'sha256-remote',
  interfaces: ['observer', 'executor'],
  capabilities: ['execute'],
  sideEffects: ['write-object'],
  bounds: { maxInputBytes: 100_000, maxOutputBytes: 100_000 },
  permissions: ['write-object'],
  provenance: { source: 'test/fixtures/mock-remote.json' },
  retry: { attempts: 3, backoff: 'capped' },
});

test('the schema, the interfaces and the capabilities are named', () => {
  assert.equal(ADAPTER_SCHEMA, 'simt.adapter/1');
  assert.deepEqual(INTERFACES, ['observer', 'validator', 'executor', 'recipe-mapper']);
  assert.deepEqual(CAPABILITIES, ['observe-only', 'execute']);
});

test('a document adapter and a remote adapter pass the same suite', () => {
  const result = conformance([document(), remote()]);
  assert.equal(result.passes, true);
  assert.deepEqual(result.observeOnly, ['document']);
  assert.deepEqual(result.executing, ['mock-remote']);
  assert.deepEqual(result.checks.map((check) => check.ok), [true, true]);
});

test('an executor with no side effects, permissions or retry semantics fails', () => {
  const thin = { ...remote(), sideEffects: [], permissions: [], retry: undefined };
  const errors = validateDescriptor(thin).errors;
  assert.match(errors.join(' '), /side effects/);
  assert.match(errors.join(' '), /permissions/);
  assert.match(errors.join(' '), /retry semantics/);
  assert.equal(conformance([thin]).passes, false);
});

test('a capability without the interface that performs it is refused', () => {
  const lying = { ...document(), capabilities: ['execute'] };
  assert.match(validateDescriptor(lying).errors.join(' '), /cannot declare the execute capability/);

  const noCapability = { ...document(), capabilities: [] };
  assert.match(validateDescriptor(noCapability).errors.join(' '), /declares no capability/);
});

test('a descriptor names what it is and what it tested', () => {
  const errors = validateDescriptor({}).errors;
  assert.match(errors.join(' '), /needs a name/);
  assert.match(errors.join(' '), /needs a version/);
  assert.match(errors.join(' '), /content digest/);
  assert.match(errors.join(' '), /input bound/);
  assert.match(errors.join(' '), /provenance/);
  assert.match(validateDescriptor({ ...document(), digest: 'doc' }).errors.join(' '), /content digest/);
});

test('a descriptor that carries code is refused before it enters the registry', () => {
  const result = parseDescriptor(JSON.stringify({ ...document(), code: 'require("child_process")' }));
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /may not carry code/);
  assert.match(parseDescriptor('not json').errors[0], /is JSON/);
  assert.match(parseDescriptor('[]').errors[0], /JSON object/);
  assert.equal(parseDescriptor(JSON.stringify(document())).valid, true);
});

test('an absent or removed adapter leaves the default operation intact', () => {
  assert.deepEqual(resolveAdapter({ adapters: ['document'], requested: 'mock-remote' }), {
    adapter: null,
    operation: 'default',
    intact: true,
    reason: 'mock-remote is not installed; the repository keeps its default operation',
  });
  assert.equal(resolveAdapter({ adapters: ['document'], requested: 'document' }).intact, false);
  assert.equal(resolveAdapter({ adapters: [] }).operation, 'default');
});

test('an adapter is used only at its pinned version and digest', () => {
  const pin = { version: '2.1.0', digest: 'sha256-remote' };
  assert.equal(pinned({ descriptor: remote(), pin }).pinned, true);
  assert.match(pinned({ descriptor: { ...remote(), version: '2.2.0' }, pin }).reason, /pinned at 2.1.0/);
  assert.match(pinned({ descriptor: { ...remote(), digest: 'sha256-other' }, pin }).reason, /does not match the pin/);
  assert.equal(pinned({ descriptor: remote(), pin: null }).pinned, false);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(conformance([document(), remote()]), conformance([document(), remote()]));
  const source = await readFile(new URL('../src/adapters/conformance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
