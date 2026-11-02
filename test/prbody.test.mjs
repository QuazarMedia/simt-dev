// The pull request body (review 0003 Q92).
//
// `prbody.mjs` assembles a body from the ledger, the changed decisions, the check cache and
// ADR-008's verdict vocabulary. It had no direct test: `simt pr-body` was exercised through
// the binary, so what an empty repository, an unreadable base and a missing ledger each
// produce was never pinned - and those are exactly the states the body exists to report
// instead of hiding.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildPrBody, renderPrBody } from '../src/prbody.mjs';
import { git, tempDir } from './fixture.mjs';

async function repo() {
  const root = await tempDir('prbody-');
  await git(['init', '-q', root]);
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('a tree with no run and no check is a residual risk, not an approval', async () => {
  const root = await repo();
  await writeFile(join(root, 'src.mjs'), 'export const x = 1;\n');
  const report = await buildPrBody(root);
  assert.equal(report.error, null);
  assert.equal(report.verdict, 'APPROVE WITH RESIDUAL RISK');
  assert.ok(report.unreviewed.includes('no passing run is recorded for this tree'), JSON.stringify(report.unreviewed));
  assert.ok(report.unreviewed.includes('gate state unmeasured (no check has run)'), JSON.stringify(report.unreviewed));
  // The verdict and what it leaves out travel together: a residual-risk body that did not
  // list its gaps would be an approval with a different word on it.
  assert.match(renderPrBody(report), /Verdict: APPROVE WITH RESIDUAL RISK/);
  assert.match(renderPrBody(report), /Not reviewed:/);
});

test('the worktree diff is the path list, and .simt state is not content', async () => {
  const root = await repo();
  await writeFile(join(root, 'src.mjs'), 'export const x = 1;\n');
  await mkdir(join(root, '.simt'), { recursive: true });
  await writeFile(join(root, '.simt', 'ledger.jsonl'), '\n');
  const report = await buildPrBody(root);
  assert.deepEqual(report.paths, ['src.mjs']);
});

test('a changed decision record is named with its id, title and status', async () => {
  const root = await repo();
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-900-a-fixture-ruling.md'),
    '# ADR-900 — the fixture explains itself\n\nStatus: accepted\n',
  );
  const report = await buildPrBody(root);
  assert.deepEqual(report.decisions, [
    {
      path: 'docs/decisions/ADR-900-a-fixture-ruling.md',
      id: 'ADR-900',
      title: 'the fixture explains itself',
      status: 'accepted',
    },
  ]);
  assert.match(renderPrBody(report), /- ADR-900 — the fixture explains itself \(accepted\)/);
});

test('an unknown base is refused, and a known one is the range the body reports', async () => {
  const root = await repo();
  const unknown = await buildPrBody(root, { base: 'no-such-ref' });
  assert.match(unknown.error, /unknown base no-such-ref/);
  const head = await buildPrBody(root, { base: 'HEAD' });
  assert.equal(head.error, null);
  assert.equal(head.base, 'HEAD');
  assert.match(renderPrBody(head), /range HEAD\.\.\.HEAD, plus worktree/);
});

test('the body renders the four sections in one order, every time', async () => {
  const root = await repo();
  await writeFile(join(root, 'src.mjs'), 'export const x = 1;\n');
  const text = renderPrBody(await buildPrBody(root));
  const order = ['## Evidence', '## Changed decisions', '## Gates', '## Residual risk (ADR-008)'];
  const at = order.map((heading) => text.indexOf(heading));
  assert.deepEqual([...at].sort((a, b) => a - b), at, text);
  assert.ok(at.every((i) => i >= 0), text);
  // Fixed order and a trailing newline are what let a snapshot pin this byte for byte.
  assert.ok(text.endsWith('\n'));
  assert.equal(text, renderPrBody(await buildPrBody(root)));
});
