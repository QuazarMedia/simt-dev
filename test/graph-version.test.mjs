// A30: a registry version this lint cannot read is an error, not a clean pass.

import test from 'node:test';
import assert from 'node:assert/strict';

import { lintRegistry } from '../src/graph/load.mjs';

const registry = (version) => ({
  ...(version === undefined ? {} : { version }),
  capabilities: [{ id: 'cap', summary: 'a capability' }],
  skills: [{ name: 'skill', summary: 'a skill', capabilities: ['cap'], stack: ['node'] }],
});

test('a registry version other than 1 is one error and the lint stops (A30)', () => {
  const future = lintRegistry(registry(2)).sync;
  assert.deepEqual(future, ['version: 2 is not the supported version 1']);

  const missing = lintRegistry(registry(undefined)).sync;
  assert.deepEqual(missing, ["version: <missing> is not the supported version 1"]);

  const current = lintRegistry(registry(1)).sync;
  assert.equal(current.some((message) => message.startsWith('version:')), false);
});
