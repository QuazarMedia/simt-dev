// A38: the three graph commands walk different graphs, and help must say which.

import test from 'node:test';
import assert from 'node:assert/strict';

import { simt } from './fixture.mjs';

const help = async (command) => {
  const result = await simt(['help', command], { env: { NO_COLOR: '1' } });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
};

test('help names the walk each graph command uses (A38)', async () => {
  const gate = await help('gate');
  assert.match(gate, /import closure/, 'gate must name the import closure');

  const impact = await help('impact');
  assert.match(impact, /import closure/, 'impact must name the import closure');

  const tests = await help('tests');
  assert.match(tests, /stored test edges/, 'tests must name the stored test edges');
  assert.match(tests, /--run/, 'tests must say that --run asks the gate');
});
