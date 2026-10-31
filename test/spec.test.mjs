// The spec is the registry (review 0003 Q60).
//
// Four copies of the command list had already disagreed when the review found them:
// README lacked `bench critic`, `ci` and `plugin`; help named seven `--reader` values
// where the binary knew eight. A list nothing checks drifts, so the check is this file:
// the spec and the dispatch map must name the same paths, in both directions, and a
// default must point at a path that exists.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GROUP_DEFAULTS, SPEC, SPEC_PATHS } from '../src/commands/spec.mjs';
import { COMMANDS, GROUPS, IMPLEMENTED } from '../src/commands/index.mjs';

test('spec: the registry and the spec name the same commands, both directions', () => {
  assert.deepEqual(SPEC_PATHS, Object.keys(IMPLEMENTED).sort());
  assert.equal(new Set(SPEC_PATHS).size, SPEC.length, 'a path is declared twice');
});

test('spec: every group default is a real subcommand of the group it names', () => {
  for (const [group, sub] of GROUP_DEFAULTS) {
    assert.ok(SPEC_PATHS.includes(`${group} ${sub}`), `${group} defaults to ${sub}, which is not a path`);
  }
  for (const row of SPEC) {
    if (row.defaultFor === undefined) continue;
    assert.equal(row.path.split(' ')[0], row.defaultFor, `${row.path} declares a default for ${row.defaultFor}`);
  }
});

test('spec: dispatch reads the same defaults the spec declares', () => {
  assert.deepEqual([...GROUPS], [...GROUP_DEFAULTS]);
});

test('spec: a summary is one phrase, not a placeholder', () => {
  for (const row of SPEC) {
    assert.ok(row.summary.length > 10 && row.summary.length <= 95, `${row.path}: ${row.summary.length} chars`);
    assert.doesNotMatch(row.summary, /\.$/, `${row.path} ends with a period`);
  }
});
