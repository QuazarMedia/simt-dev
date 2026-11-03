// A lease says what enforces it (W37). A file claim is checked on this host by the pre-edit hook
// and by nothing else; a report that lists claims without that level implies exclusion it cannot
// deliver.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'simt-lease-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function run(cwd, args) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

test('a listed claim reports its enforcement level and the race that remains', () => {
  const dir = repo();
  run(dir, ['lease', 'src/a.mjs', '--session', 'alpha', '--yes']);
  const listed = JSON.parse(run(dir, ['lease', '--json']));
  assert.equal(listed.leases.length, 1);
  assert.equal(listed.enforcement, 'advisory-cross-host');
  assert.match(listed.residualRace, /other host/);
});

test('the text report says the same thing the json does', () => {
  const dir = repo();
  run(dir, ['lease', 'src/a.mjs', '--session', 'alpha', '--yes']);
  const text = run(dir, ['lease']);
  assert.match(text, /enforced advisory-cross-host/);
  assert.match(text, /race/);
});
