// A35: `required` or `properties` without `type` still describes an object.

import test from 'node:test';
import assert from 'node:assert/strict';

import { check } from '../src/mcp/schema.mjs';

const schema = { required: ['x'], properties: { x: { type: 'string' } } };

test('a schema with required but no type rejects a non-object (A35)', () => {
  const rejected = check('not-an-object', schema);
  assert.notEqual(rejected, null);
  assert.match(rejected, /expected an object/);

  assert.equal(check({ x: 'ok' }, schema), null);
  assert.equal(check({}, schema), '$: missing required property "x"');
  assert.equal(check({ x: 1 }, schema), '$.x: expected string, got number');
});

test('an explicit object type keeps its own type error (A35)', () => {
  const rejected = check(null, { type: 'object', required: ['x'] });
  assert.match(rejected, /expected object, got null/);
});
