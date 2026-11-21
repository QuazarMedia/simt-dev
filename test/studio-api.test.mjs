// ST02: the studio API serves the doors' own objects (ADR-212, ADR-035).
//
// Parity is the assertion: for each route the studio's JSON deep-equals the CLI's
// --json document on the same fixture repository, because the bridge runs the same
// handlers through the same envelope. The status snapshot stamps `at: Date.now()`,
// so that one field is compared as a number and set aside - two reads of the same
// repository at two moments differ only there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { simt, tempDir } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';

const PLAN = `# fixture plan

## 3. Tracker

| ID | Slice | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- |
| F01 | first | — | Queued | |
| F02 | second | F01 | Queued | |

### F01 — first

**Finding.** the first slice

### F02 — second

**Finding.** the second slice
`;

test('every read route answers the CLI\'s own --json document', async (t) => {
  const root = await fixtureRepo({ 'docs/plans/0001-fixture.md': PLAN });
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  for (const [path, args] of [
    ['/api/status', ['status']],
    ['/api/plan', ['plan', 'status']],
    ['/api/plan/next', ['plan', 'next']],
    ['/api/plan/next?id=F02', ['plan', 'next', 'F02']],
    ['/api/work', ['work', 'inspect']],
  ]) {
    const res = await httpReq(studio.port, { path, headers: { cookie } });
    assert.equal(res.status, 200, `${path}: ${res.body}`);
    assert.match(res.headers['content-type'], /application\/json/);
    const cli = await simt([...args, '--json'], { cwd: root });
    assert.equal(cli.code, 0, `${args.join(' ')}: ${cli.stderr}`);
    const served = JSON.parse(res.body);
    const printed = JSON.parse(cli.stdout);
    if (path === '/api/status') {
      assert.equal(typeof served.at, 'number');
      assert.equal(typeof printed.at, 'number');
      delete served.at;
      delete printed.at;
    }
    assert.deepEqual(served, printed, path);
  }
});

test('the check route answers the gate without writing its cache', async (t) => {
  const root = await fixtureRepo();
  const before = await treeDigest(root);
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  const res = await httpReq(studio.port, { path: '/api/check', headers: { cookie } });
  assert.equal(res.status, 200, res.body);
  assert.equal(await treeDigest(root), before, 'the studio check wrote to the repository');

  // The CLI check writes its line cache; the studio's answer must still be the same
  // document, because the cache is a speed, not a fact.
  const cli = await simt(['check', '--json'], { cwd: root });
  assert.deepEqual(JSON.parse(res.body), JSON.parse(cli.stdout));
});

test('a door refusal is the CLI refusal document, field for field', async (t) => {
  const root = await fixtureRepo({ 'docs/plans/0001-fixture.md': PLAN });
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  const res = await httpReq(studio.port, { path: '/api/plan/next?id=NOPE', headers: { cookie } });
  assert.equal(res.status, 400);
  const cli = await simt(['plan', 'next', 'NOPE', '--json'], { cwd: root });
  assert.equal(cli.code, 2);
  assert.deepEqual(JSON.parse(res.body), JSON.parse(cli.stdout));
});

test('a traversal or absolute id is refused with the containment remedy', async (t) => {
  const root = await fixtureRepo({ 'docs/plans/0001-fixture.md': PLAN });
  const outside = await tempDir('simt-studio-outside-');
  await symlink(outside, join(root, 'escape'));
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  for (const id of ['../escape', '/etc/passwd', 'escape']) {
    const res = await httpReq(studio.port, {
      path: `/api/plan/next?id=${encodeURIComponent(id)}`,
      headers: { cookie },
    });
    assert.equal(res.status, 403, id);
    const refusal = JSON.parse(res.body);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error, 'STUDIO_PATH_DENIED');
    assert.match(refusal.remedy, /outside the repository/);
  }
});

test('an unknown api route answers the refusal shape, not a page', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const res = await httpReq(studio.port, { path: '/api/not-yet', headers: { cookie } });
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  const refusal = JSON.parse(res.body);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, 'STUDIO_UNKNOWN_ROUTE');
  assert.match(refusal.remedy, /\/api\/status/);
});

test('the api rides behind the same session guard as the shell', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const res = await httpReq(studio.port, { path: '/api/status' });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error, 'STUDIO_NO_SESSION');
});