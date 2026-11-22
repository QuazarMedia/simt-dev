// ST12: control is the writer's own preview, confirmed by the digest of the plan that was
// shown. A stale plan writes nothing; a matching one journals the CLI's write set.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { CONTROL_ALLOWLIST, controlApply, controlPreview } from '../src/studio/control.mjs';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';

async function root(files = {}) {
  return realpath(await fixtureRepo(files));
}

const setup = { command: 'work setup', args: [], flags: { scope: 'handbook', path: 'handbook', kind: 'document' } };

async function post(studio, cookie, path, body) {
  const res = await fetch(`${studio.base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('preview writes nothing and apply with the matching digest writes the previewed set', async () => {
  const repo = await root();
  const before = await treeDigest(repo);
  const preview = await controlPreview(repo, setup);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.ok(preview.plan.files.includes('simt.json'));
  assert.match(preview.digest, /^sha256-/);
  assert.equal(await treeDigest(repo), before, 'preview changed bytes');

  const applied = await controlApply(repo, { ...setup, digest: preview.digest });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual([...applied.written].sort(), [...preview.plan.files].sort());
  assert.ok(applied.journal, 'the writer did not commit a journal set');
  const manifest = JSON.parse(await readFile(join(repo, 'simt.json'), 'utf8'));
  assert.ok(manifest.work.scopes.some((scope) => scope.id === 'handbook'));
  const events = await readFile(join(repo, '.simt', 'local', 'events.jsonl'), 'utf8');
  assert.match(events, /write\.committed/);

  const undoPreview = await controlPreview(repo, { command: 'undo', args: [], flags: {} });
  assert.equal(undoPreview.ok, true, JSON.stringify(undoPreview));
  const undone = await controlApply(repo, { command: 'undo', args: [], flags: {}, digest: undoPreview.digest });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  await assert.rejects(readFile(join(repo, 'simt.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(repo, '.gitignore'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# studio fixture\n', 'undo changed an untouched file');
});

test('a stale digest is refused and changes no bytes', async () => {
  const repo = await root();
  const preview = await controlPreview(repo, setup);
  assert.equal(preview.ok, true);
  await writeFile(join(repo, 'simt.json'), '{"work":{"version":2,"scopes":[]}}\n');
  const changed = await treeDigest(repo);
  const result = await controlApply(repo, { ...setup, digest: preview.digest });
  assert.equal(result.ok, false);
  assert.match(result.error, /plan changed after preview/);
  assert.equal(await treeDigest(repo), changed, 'a stale apply wrote bytes');
});

test('the control route refuses an off-allowlist command before running it', async (t) => {
  const repo = await root();
  const studio = await startStudio(repo);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const refused = await post(studio, cookie, '/api/control/preview', { command: 'rm -rf .', args: [], flags: {} });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /allowlist/);
  assert.deepEqual(CONTROL_ALLOWLIST, ['work setup', 'knowledge build', 'slice start', 'slice finish', 'plan done', 'sync', 'undo']);
});

test('the applied write set equals the CLI writer for the same arguments', async () => {
  const viaControl = await root();
  const viaCli = await root();
  const preview = await controlPreview(viaControl, setup);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const applied = await controlApply(viaControl, { ...setup, digest: preview.digest });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const cli = await simt(['work', 'setup', '--scope', 'handbook', '--path', 'handbook', '--kind', 'document', '--yes', '--root', viaCli], { cwd: viaCli });
  assert.equal(cli.code, 0, cli.stderr + cli.stdout);
  for (const path of applied.written) {
    assert.equal(await readFile(join(viaControl, path), 'utf8'), await readFile(join(viaCli, path), 'utf8'), path);
  }
});
