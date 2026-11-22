// ST11: the Helm is generated from the spec, and its API route is a read-only allowlist
// rather than a shell. A writer path is refused before a command function can run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import { SPEC } from '../src/commands/spec.mjs';
import { helmCatalog, helmRow } from '../src/studio/helm.mjs';
import { fieldsFor, helm, invocation, resultPanel } from '../src/studio/public/helm.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';

const front = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;

test('the palette list is exactly the spec read-only rows, and knowledge rank generates its CLI spelling', async () => {
  const expected = SPEC.filter((row) => row.writes === undefined).map((row) => row.path);
  assert.deepEqual(helmCatalog().map((row) => row.path), expected);
  assert.equal(helmRow('knowledge build'), null);
  assert.equal(helmRow('knowledge rank')?.path, 'knowledge rank');

  const row = SPEC.find((entry) => entry.path === 'knowledge rank');
  const fields = fieldsFor(row);
  assert.ok(fields.some((field) => field.kind === 'flag' && field.name === 'scope' && field.boolean === false));
  assert.equal(
    invocation(row, { 'flag:scope': 'handbook', 'flag:query': 'retention' }),
    'simt knowledge rank --scope handbook --query retention',
  );
  const html = helm({ ok: true, commands: [{ path: row.path, summary: row.summary, usage: row.usage, flags: row.flags, runnable: true }] });
  assert.match(html, /data-command="knowledge rank"/);
  assert.match(html, /helm-form-panel/);
});

test('a writer path is unreachable from the helm route and writes no bytes', async (t) => {
  const root = await realpath(await fixtureRepo());
  const before = await treeDigest(root);
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  for (const path of ['work setup', 'sync', 'plan done', 'not a command']) {
    const res = await httpReq(studio.port, { path: `/api/helm?path=${encodeURIComponent(path)}`, headers: { cookie } });
    assert.equal(res.status, 403, `${path}: ${res.body}`);
    assert.equal(JSON.parse(res.body).ok, false);
  }
  assert.equal(await treeDigest(root), before, 'the helm wrote while refusing');
});

test('knowledge rank round-trips through the helm API to the CLI JSON', async (t) => {
  const root = await realpath(await fixtureRepo({
    'simt.json': `${JSON.stringify({ work: { version: 2, scopes: [{ id: 'handbook', paths: ['handbook'], kind: 'document' }] } }, null, 2)}\n`,
    'handbook/retention.md': `${front({ id: 'retention', scope: { jurisdiction: 'DE' }, authority: 'reviewed' })}# Retention\n\nDevice checkout retention is 30 days.\n\n<!-- claim: id=retention.v subject=device-checkout predicate=retention type=number value=30 unit=days status=reviewed -->\n`,
  }));
  const build = await simt(['knowledge', 'build', '--scope', 'handbook', '--yes', '--root', root], { cwd: root });
  assert.equal(build.code, 0, build.stderr + build.stdout);
  const cli = await simt(['knowledge', 'rank', '--scope', 'handbook', '--query', 'retention', '--root', root, '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr + cli.stdout);

  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const catalog = await httpReq(studio.port, { path: '/api/helm', headers: { cookie } });
  assert.equal(catalog.status, 200, catalog.body);
  assert.deepEqual(JSON.parse(catalog.body).commands, helmCatalog());

  const flags = encodeURIComponent(JSON.stringify({ scope: 'handbook', query: 'retention' }));
  const res = await httpReq(studio.port, {
    path: `/api/helm?path=${encodeURIComponent('knowledge rank')}&args=${encodeURIComponent('[]')}&flags=${flags}`,
    headers: { cookie },
  });
  assert.equal(res.status, 200, res.body);
  const served = JSON.parse(res.body);
  assert.deepEqual(served.document, JSON.parse(cli.stdout));
  const rendered = resultPanel(served);
  assert.match(rendered, /JSON tree/);
  assert.match(rendered, /raw document/);
});
