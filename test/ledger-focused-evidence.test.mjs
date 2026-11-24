// ADR-258 (plan 0010, PT04): the focused pre-push run records `kind: 'test-focused'`
// and must not count as test evidence. ADR-120's skip is earned by a run of the full
// suite, `kind: 'test'`; a focused pass proves the selected files passed, not that
// the suite a claim is about passed. `isTestKind` answers `kind === 'test'` exactly
// for a line that names its kind, which is what this pins.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, keepTemp } from './fixture.mjs';
import { hasTestEvidence, readLedger, recordRun } from '../src/ledger/index.mjs';

const TREE = 'e'.repeat(40);

test('a passing test-focused line is not test evidence', () => {
  const focused = { v: 2, tree: TREE, exit: 0, gate: 'test', kind: 'test-focused', cmd: 'node --test a.test.mjs', outcome: 'passed' };
  assert.equal(hasTestEvidence([focused], TREE), false);
});

test('a passing test line on the same tree is evidence', () => {
  const full = { v: 2, tree: TREE, exit: 0, gate: 'test', kind: 'test', cmd: 'npm test', outcome: 'passed' };
  assert.equal(hasTestEvidence([full], TREE), true);
});

test('a focused run recorded by the tool reads back as no evidence, until a full suite runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-evidence-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  await git(['commit', '-qm', 'base', '--allow-empty'], { cwd: root });

  await recordRun(root, { cmd: 'node --test a.test.mjs', exit: 0, ms: 100, output: '1 pass', gate: 'test', kind: 'test-focused' });
  const afterFocused = await readLedger(root);
  assert.equal(hasTestEvidence(afterFocused.entries, afterFocused.entries[0].tree), false);

  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '10 pass', gate: 'test', kind: 'test' });
  const afterFull = await readLedger(root);
  assert.equal(hasTestEvidence(afterFull.entries, afterFull.entries[0].tree), true);
});
