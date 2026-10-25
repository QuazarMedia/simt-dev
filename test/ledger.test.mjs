// The evidence ledger (R17, ADR-087).
//
// The property the accept names: a green run is evidence for one tree, and editing
// any file makes that evidence about a tree that no longer exists. The private index
// is the other half — taking the tree must not stage the file the author left alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { treeId, recordRun, readLedger, claimsVerification } from '../src/ledger/index.mjs';
import { evidenceCommand } from '../src/commands/evidence.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { hooksCommand } from '../src/commands/hooks.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-ledger-'));
  await git(['init', '-q', root]);
  await writeFile(join(root, 'a.txt'), 'a\n');
  await git(['-C', root, 'add', 'a.txt']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('naming the tree does not stage anything', async () => {
  const root = await repo();
  await writeFile(join(root, 'left-alone.txt'), 'no\n');
  const before = (await git(['-C', root, 'status', '--porcelain'])).stdout;
  await treeId(root);
  const after = (await git(['-C', root, 'status', '--porcelain'])).stdout;
  assert.equal(after, before);
  assert.match(after, /left-alone\.txt/);
  await rm(root, { recursive: true, force: true });
});

test('editing a file after a green run invalidates the evidence', async () => {
  const root = await repo();
  const first = await recordRun(root, { cmd: 'node --test test/x.test.mjs', exit: 0, ms: 10, output: '12 pass, 0 fail\n' });
  const shown = await readLedger(root);
  assert.equal(shown.entries.filter((e) => e.tree === first.tree && e.exit === 0).length, 1);

  await writeFile(join(root, 'a.txt'), 'b\n');
  const next = await treeId(root);
  assert.notEqual(next, first.tree);
  const later = await readLedger(root);
  assert.equal(later.entries.filter((e) => e.tree === next).length, 0);
  assert.equal(later.entries.filter((e) => e.tree === first.tree).length, 1);
  await rm(root, { recursive: true, force: true });
});

test('a claim needs a passing run for this tree, and block is the only hard failure', async () => {
  assert.equal(claimsVerification('tests pass'), true);
  assert.equal(claimsVerification('Verified the fix.'), true);
  assert.equal(claimsVerification('still unverified'), false);
  assert.equal(claimsVerification('not verified yet'), false);

  const root = await repo();
  const message = join(root, 'COMMIT_EDITMSG');
  await writeFile(message, 'fix the gate\n\ntests pass\n');
  await writeFile(join(root, 'simt.json'), '{ "gates": { "evidence": "warn" } }\n');
  assert.equal(await evidenceCommand(['check', message], { root }), 0);

  await writeFile(join(root, 'simt.json'), '{ "gates": { "evidence": "block" } }\n');
  assert.equal(await evidenceCommand(['check', message], { root }), 1);

  await recordRun(root, { cmd: 'node --test', exit: 0, ms: 4, output: '1 pass\n' });
  assert.equal(await evidenceCommand(['check', message], { root }), 0);

  await writeFile(join(root, 'a.txt'), 'changed after the run\n');
  assert.equal(await evidenceCommand(['check', message], { root }), 1);
  await rm(root, { recursive: true, force: true });
});

test('hooks install writes the claim check only when the repository asks, and removes it when the ask goes', async () => {
  const root = await repo();
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify({ gates: { preCommit: ['test'], commands: { test: 'true' }, evidence: 'block' } })}\n`,
  );
  assert.equal(await hooksCommand('install', [], { root, yes: true }), 0);
  const shim = await readFile(join(root, '.simt-hooks', 'commit-msg'), 'utf8');
  assert.match(shim, /evidence check "\$1"/);
  const staged = (await git(['-C', root, 'diff', '--cached', '--name-only'])).stdout;
  assert.equal(staged, '');

  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify({ gates: { preCommit: ['test'], commands: { test: 'true' } } })}\n`,
  );
  assert.equal(await hooksCommand('install', [], { root, yes: true }), 0);
  await assert.rejects(readFile(join(root, '.simt-hooks', 'commit-msg'), 'utf8'));
  await rm(root, { recursive: true, force: true });
});

test('a hand-written commit-msg does not replace the claim check', async () => {
  const root = await repo();
  const hook = join(root, '.git', 'hooks', 'commit-msg');
  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  await chmod(hook, 0o755);
  await writeFile(
    join(root, 'simt.json'),
    `${JSON.stringify({ gates: { preCommit: ['test'], commands: { test: 'true' }, evidence: 'warn' } })}\n`,
  );
  assert.equal(await hooksCommand('install', [], { root, yes: true }), 0);
  const shim = await readFile(join(root, '.simt-hooks', 'commit-msg'), 'utf8');
  assert.match(shim, /evidence check "\$1"/);
  assert.doesNotMatch(shim, /chain-shim/);
  await rm(root, { recursive: true, force: true });
});

test('a gate the dispatcher runs is recorded against the tree', async () => {
  const root = await repo();
  const manifest = { gates: { preCommit: ['test'], commands: { test: 'echo 1 pass' } } };
  const result = await runGates('pre-commit', { root, manifest });
  assert.equal(result.failed, false, JSON.stringify(result.gates));
  const tree = await treeId(root);
  const { entries } = await readLedger(root);
  const line = entries.find((e) => e.tree === tree && e.cmd === 'echo 1 pass');
  assert.ok(line, JSON.stringify(entries));
  assert.equal(line.exit, 0);
  assert.equal(line.summary, '1 pass, 0 fail');
  const text = await readFile(join(root, '.simt', 'ledger.jsonl'), 'utf8');
  assert.equal(text.includes('echo 1 pass\n'), false, 'the output itself is not the ledger');
  await rm(root, { recursive: true, force: true });
});
