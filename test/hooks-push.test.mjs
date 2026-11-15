// A12: the HEAD worktree was materialised only when `skipTest === null`. A push that
// earned ADR-120's skip therefore ran lint and format against the author's checkout, so
// an uncommitted edit could fail a gate and block a push it was not part of.
//
// The probe is a lint gate that fails when `dirty.txt` is in its cwd and records that cwd:
// with the fix it sees the detached HEAD tree, and the dirty file only exists in the
// checkout the author is standing in.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, keepTemp } from './fixture.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

test('a skipped test gate still runs lint on the committed tree (A12)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-push-tree-'));
  keepTemp(root);
  const cwdOut = join(root, 'lint-cwd.txt');

  await git(['init', '-q', '.'], { cwd: root });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fx', scripts: { lint: 'node lint.mjs', test: 'exit 0' } }, null, 2),
  );
  await writeFile(
    join(root, 'lint.mjs'),
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.LINT_CWD_OUT, process.cwd());",
      "process.exit(existsSync('dirty.txt') ? 1 : 0);",
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates: { preCommit: [], prePush: ['test', 'lint'] } }, null, 2),
  );
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  // The passing run ADR-120 accepts as evidence about this exact tree.
  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '1580 pass, 0 fail', gate: 'test', kind: 'test' });

  // Work the author has not committed: it belongs to no push and must reach no gate.
  await writeFile(join(root, 'dirty.txt'), 'wip\n');
  process.env.LINT_CWD_OUT = cwdOut;
  try {
    const result = await runGates('pre-push', { root, manifest: { gates: { preCommit: [], prePush: ['test', 'lint'] } } });

    const testGate = result.gates.find((g) => g.name === 'test');
    assert.equal(testGate.status, 'skipped');
    assert.match(testGate.detail, /already passing/);

    const lint = result.gates.find((g) => g.name === 'lint');
    assert.equal(lint.status, 'passed', 'lint saw the uncommitted edit');
    assert.equal(result.failed, false);

    const lintCwd = (await readFile(cwdOut, 'utf8')).trim();
    assert.notEqual(lintCwd, root, 'the lint gate ran in the dirty checkout');
    assert.match(lintCwd, /head-gate-/, 'the lint gate did not run in a HEAD worktree');
  } finally {
    delete process.env.LINT_CWD_OUT;
  }
});
