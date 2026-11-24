// ADR-258 (plan 0010, PT05): a failed `test` run records the failing test ids in its
// ledger line (`failedTests`) so the next push can re-run exactly them. Ids, not logs:
// the line's output digest keeps the detail. A run that passes, or whose output the
// parser cannot read, carries no `failedTests`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, keepTemp } from './fixture.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { readLedger, recordRun } from '../src/ledger/index.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

test('recordRun carries failedTests when given, and omits the key when not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-fail-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  await git(['commit', '-qm', 'base', '--allow-empty'], { cwd: root });

  await recordRun(root, { cmd: 'npm test', exit: 1, ms: 100, output: 'boom', gate: 'test', kind: 'test', failedTests: ['a.test.mjs > t1'] });
  let [line] = (await readLedger(root)).entries;
  assert.deepEqual(line.failedTests, ['a.test.mjs > t1']);

  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 100, output: 'ok', gate: 'test', kind: 'test' });
  line = (await readLedger(root)).entries.at(-1);
  assert.equal('failedTests' in line, false);
});

test('a failed test gate records the failing ids from its TAP output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-fail-dispatch-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node tap.mjs' } }, null, 2));
  await writeFile(join(root, 'tap.mjs'), "process.stdout.write('TAP version 13\\nok 1 - first\\nnot ok 2 - second\\n');\nprocess.exit(1);\n");
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], gates: { preCommit: ['test'] } }, null, 2));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.gates.find((g) => g.name === 'test').status, 'failed');
  const { entries } = await readLedger(root);
  const line = entries.at(-1);
  assert.equal(line.kind, 'test');
  assert.equal(line.exit, 1);
  assert.deepEqual(line.failedTests, ['second']);
});

test('a failed test gate whose output the parser cannot read carries no failedTests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-fail-noparse-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node tap.mjs' } }, null, 2));
  await writeFile(join(root, 'tap.mjs'), "process.stderr.write('it exploded\\n');\nprocess.exit(1);\n");
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], gates: { preCommit: ['test'] } }, null, 2));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  await runGates('pre-commit', { root, manifest });

  const { entries } = await readLedger(root);
  assert.equal('failedTests' in entries.at(-1), false);
});
