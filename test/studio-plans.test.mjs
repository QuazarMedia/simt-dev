// ST06: the Board joins the plan, worktree and lease readers into one view.
//
// The fixture carries two plans so the board has more than one document to group. The
// view-model is pure; one server read closes the loop against `plan status --json`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeLeases } from '../src/lease.mjs';
import { boardPayload } from '../src/studio/board.mjs';
import { board, dependenciesOf, dependencyEdges } from '../src/studio/public/board.js';
import { LOCAL_DIR } from '../src/state.mjs';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

function plan(title, rows) {
  return `# ${title}

Status: **queued** · 2026-11-22

## Tracker

| ID | Slice | Phase | Lane | Tier | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
}

function fixture() {
  return fixtureRepo({
    'docs/plans/0001-alpha.md': plan('Alpha', [
      '| A1 | First ready slice | Observe | api | S | — | Queued | — |',
      '| A2 | Second slice | Observe | api | S | A1 | Queued | — |',
    ]),
    'docs/plans/0002-beta.md': plan('Beta', [
      '| B1 | A separate lane | Observe | views | M | — | Queued | — |',
    ]),
  });
}

test('dependency edges come from the tracker rows and name only carried slices', () => {
  assert.deepEqual(
    dependencyEdges([
      { id: 'A1', dependsOn: [] },
      { id: 'A2', dependsOn: ['A1', 'MISSING'] },
      { id: 'B1', dependsOn: ['A2'] },
    ]),
    [
      { from: 'A2', to: 'A1' },
      { from: 'B1', to: 'A2' },
    ],
  );
});

test('the board highlights plan next and shows worktree, lease and brief chips', async () => {
  const root = await fixture();
  await mkdir(join(root, LOCAL_DIR, 'worktrees', 'a1'), { recursive: true });
  await mkdir(join(root, LOCAL_DIR, 'briefs'), { recursive: true });
  await writeFile(join(root, LOCAL_DIR, 'briefs', 'a1.md'), '# A1 brief\n');
  await writeLeases(root, [
    {
      resource: { kind: 'path', id: `${LOCAL_DIR}/worktrees/a1` },
      holder: { session: 'alpha', harness: 'claude' },
      fence: 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      kind: 'slice',
      slice: 'A1',
    },
  ]);

  const payload = await boardPayload(root);
  assert.equal(payload.ok, true);
  assert.equal(payload.next.next.id, 'A1');
  assert.ok(payload.worktrees.some((worktree) => worktree.id === 'a1'));
  assert.equal(payload.leases[0].session, 'alpha');
  assert.equal(payload.briefs.A1, '# A1 brief\n');

  const html = board(payload);
  assert.match(html, /data-slice="A1"/);
  assert.match(html, /board-next/);
  assert.match(html, /data-from="A2" data-to="A1"/);
  assert.match(html, /lease alpha until/);
  assert.match(html, /worktree \.simt\/local\/worktrees\/a1/);
  assert.match(html, /A1 brief/);
  assert.match(html, /how this was computed/i);
});

test('the board payload carries the plan status document and its readers', async (t) => {
  const root = await fixture();
  await mkdir(join(root, LOCAL_DIR, 'worktrees', 'b1'), { recursive: true });
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const res = await httpReq(studio.port, { path: '/api/board', headers: { cookie } });
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'board');
  assert.equal(payload.next.next.id, 'A1');

  const cli = await simt(['plan', 'status', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(payload.plan, JSON.parse(cli.stdout));
  assert.ok(payload.slices.some((slice) => slice.id === 'A1' && dependenciesOf(slice).length === 0));
  assert.ok(payload.worktrees.some((worktree) => worktree.id === 'b1'));
});
