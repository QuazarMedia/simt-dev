// Review 0003 Q81: the taxonomy's invariants, held over the spec rather than a fixture.
//
// These are the properties the merge can break silently: an alias pointing at a path that
// no longer exists still parses as a string, and a group default that is not a member of
// its group resolves to a command nobody wrote.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ALIASES, GROUP_DEFAULTS, SPEC, SPEC_PATHS, tierOf } from '../src/commands/spec.mjs';

test('every alias resolves to a path this spec declares', () => {
  const paths = new Set(SPEC_PATHS);
  const missing = [...ALIASES].filter(([, target]) => !paths.has(target)).map(([alias, target]) => `${alias} -> ${target}`);
  assert.deepEqual(missing, []);
});

test('no alias shadows a path, so one spelling never means two commands', () => {
  const paths = new Set(SPEC_PATHS);
  assert.deepEqual([...ALIASES.keys()].filter((alias) => paths.has(alias)), []);
});

test('every group default is a member of the group it defaults', () => {
  for (const [group, sub] of GROUP_DEFAULTS) {
    assert.ok(SPEC_PATHS.includes(`${group} ${sub}`), `${group} defaults to ${sub}, which is not a path`);
  }
});

test('a command whose work needs a corpus is advanced even when its group is core', () => {
  assert.equal(tierOf('skills find'), 'core');
  assert.equal(tierOf('skills compile'), 'advanced');
  assert.equal(tierOf('skills eval'), 'advanced');
  assert.equal(tierOf('gate'), 'core');
  assert.equal(tierOf('pack new'), 'advanced');
});

test('the merged spellings stay one command each', () => {
  assert.equal(ALIASES.get('evidence show'), 'evidence');
  // The four that answer "why" keep their own paths; the merge lives in the handler.
  for (const path of ['why', 'rules why', 'skills why', 'explain']) {
    assert.ok(SPEC_PATHS.includes(path), `${path} is no longer dispatchable`);
  }
});
