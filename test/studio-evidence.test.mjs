// ST07: Custody groups every ledger run by the tree it proved.
//
// The fixture writes the ledger directly because the view's contract is the reader's
// output, not the writer's bookkeeping. One server test keeps `/api/evidence` identical to
// the CLI and checks the chain route's current-tree claim verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LEDGER_FILE, treeId } from '../src/ledger/index.mjs';
import { evidenceChains } from '../src/studio/evidence.mjs';
import { custody } from '../src/studio/public/custody.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

async function ledgerFixture() {
  const root = await fixtureRepo();
  const current = await treeId(root);
  const entries = [
    { v: 2, tree: current, subjectTree: current, indexTree: current, gate: 'test', kind: 'test', cmd: 'npm test', exit: 0, outcome: 'passed', ms: 12, summary: '2 pass' },
    { v: 2, tree: current, subjectTree: current, indexTree: current, gate: 'lint', kind: 'script', cmd: 'npm run lint', exit: 1, outcome: 'failed', ms: 3, summary: '1 finding' },
    { v: 2, tree: 'old-tree', subjectTree: 'old-tree', gate: 'test', kind: 'test', cmd: 'npm test', exit: 0, outcome: 'passed', ms: 20, summary: '2 pass' },
    { v: 1, tree: 'legacy-tree', exit: 0, cmd: 'npm test' },
  ];
  await mkdir(dirname(join(root, LEDGER_FILE)), { recursive: true });
  await writeFile(join(root, LEDGER_FILE), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return { root, current };
}

test('chains group by tree, keep failures visible and mark v1 lines local-only', async () => {
  const { root, current } = await ledgerFixture();
  const payload = await evidenceChains(root);
  assert.equal(payload.ok, true);
  assert.equal(payload.tree, current);
  assert.deepEqual(payload.chains.map((chain) => chain.tree), [current, 'legacy-tree', 'old-tree']);
  const now = payload.chains[0];
  assert.equal(now.current, true);
  assert.equal(now.stale, false);
  assert.equal(now.links.filter((link) => link.outcome === 'failed').length, 1);
  assert.equal(now.links.find((link) => link.gate === 'lint').adr, 'ADR-004');
  assert.equal(payload.chains.find((chain) => chain.tree === 'old-tree').stale, true);
  const legacy = payload.chains.find((chain) => chain.tree === 'legacy-tree').links[0];
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.localOnly, true);
  assert.equal(legacy.outcome, 'passed');
});

test('Custody renders current, stale, failed and local-only links distinctly', async () => {
  const { root } = await ledgerFixture();
  const html = custody(await evidenceChains(root));
  assert.match(html, /custody-current/);
  assert.match(html, /custody-stale/);
  assert.match(html, /custody-failed/);
  assert.match(html, /local-only/);
  assert.match(html, /ADR-004/);
  assert.match(html, /the hook owns lint/);
  assert.match(html, /check a commit-message claim/);
  assert.match(html, /how this was computed/i);
});

test('the chain route returns the ledger groups and a claim verdict', async (t) => {
  const { root, current } = await ledgerFixture();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  const evidence = await httpReq(studio.port, { path: '/api/evidence', headers: { cookie } });
  assert.equal(evidence.status, 200, evidence.body);
  const cli = await simt(['evidence', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(evidence.body), JSON.parse(cli.stdout));

  const res = await httpReq(studio.port, {
    path: '/api/evidence/chains?claim=tests%20pass',
    headers: { cookie },
  });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.tree, current);
  assert.equal(payload.chains[0].current, true);
  assert.equal(payload.claim.claims, true);
  assert.equal(payload.claim.supported, true);
});
