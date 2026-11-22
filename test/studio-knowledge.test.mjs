// ST08: the Constellation is a deterministic graph, with a table twin and the why/rank
// doors behind it. The corpus is built by the command, not hand-written here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { knowledgeGraph } from '../src/studio/knowledge.mjs';
import { constellation, layoutGraph, rankPanel, whyPanel } from '../src/studio/public/constellation.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

const front = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;

function corpusFixture() {
  return fixtureRepo({
    'simt.json': `${JSON.stringify({ work: { version: 2, scopes: [{ id: 'handbook', paths: ['handbook'], kind: 'document' }] } }, null, 2)}\n`,
    'handbook/retention.md': `${front({ id: 'retention', scope: { jurisdiction: 'DE' }, authority: 'reviewed' })}# Retention\n\nDevice checkout retention is 30 days.\n\n<!-- claim: id=retention.v subject=device-checkout predicate=retention type=number value=30 unit=days status=reviewed -->\n`,
    'handbook/policy.md': `${front({ id: 'policy', scope: { jurisdiction: 'DE' } })}# Policy\n\n<!-- claim: id=policy.v subject=device-checkout predicate=retention type=number value=30 unit=days status=proposed evidence=retention.v -->\n`,
    'handbook/unplaced.md': '# Unplaced draft\n\nNo declared scope or claim.\n',
  });
}

async function built() {
  const root = await corpusFixture();
  const build = await simt(['knowledge', 'build', '--scope', 'handbook', '--yes', '--json'], { cwd: root });
  assert.equal(build.code, 0, build.stderr + build.stdout);
  return root;
}

test('layout is deterministic and puts unknown-scope nodes in their own band', async () => {
  const root = await built();
  const payload = await knowledgeGraph(root);
  assert.equal(payload.ok, true);
  assert.ok(payload.graph.nodes.some((node) => node.unknownScope), 'the unplaced artifact was not classed unknown');
  const first = layoutGraph(payload.graph, payload.seed);
  const second = layoutGraph(payload.graph, payload.seed);
  assert.deepEqual(first, second);
  assert.ok(first.nodes.filter((node) => node.band === 'unknown').every((node) => node.y === 415));
  assert.ok(first.nodes.filter((node) => node.band === 'known').every((node) => node.y < 400));
});

test('the view carries the canvas, its table twin, edge styles and unknown-scope class', async () => {
  const payload = await knowledgeGraph(await built());
  const html = constellation(payload);
  assert.match(html, /<canvas id="constellation-canvas"/);
  assert.match(html, /constellation-table/);
  assert.match(html, /constellation-unknown/);
  assert.match(html, /constellation-proposed/);
  assert.match(html, /data-node-id=/);
  assert.match(html, /constellation-rank/);
  assert.match(html, /knowledge why --scope/);
});

test("the why and rank panels render the doors' own answers", () => {
  const why = whyPanel({
    ok: true,
    claim: { id: 'retention.v', subject: 'device', predicate: 'retention', value: 30, unit: 'days', status: 'reviewed' },
    source: { path: 'handbook/retention.md' },
    lineage: { total: 1, edges: 0 },
    impact: { total: 0, edges: 0 },
    conflicts: [],
  });
  assert.match(why, /retention\.v/);
  assert.match(why, /30 days/);
  assert.match(why, /handbook\/retention\.md/);
  const rank = rankPanel({
    ok: true,
    ranked: [{ id: 'retention.v', path: 'handbook/retention.md', citation: { anchor: 'retention', path: 'handbook/retention.md', lineStart: 1, lineEnd: 2 } }],
  });
  assert.match(rank, /handbook\/retention\.md/);
  assert.match(rank, /lines 1-2/);
});

test('the graph, why and rank routes read the built corpus and a cold corpus names the build', async (t) => {
  const root = await built();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const graph = await httpReq(studio.port, { path: '/api/knowledge/graph', headers: { cookie } });
  assert.equal(graph.status, 200, graph.body);
  const payload = JSON.parse(graph.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.scope, 'handbook');
  const claimId = payload.graph.nodes.find((node) => node.kind === 'claim')?.id;
  assert.ok(claimId, 'no claim node');

  const why = await httpReq(studio.port, {
    path: `/api/knowledge/why?scope=handbook&id=${encodeURIComponent(claimId)}`,
    headers: { cookie },
  });
  assert.equal(why.status, 200, why.body);
  assert.equal(JSON.parse(why.body).claim.id, claimId);

  const rank = await httpReq(studio.port, {
    path: '/api/knowledge/rank?scope=handbook&query=retention',
    headers: { cookie },
  });
  assert.equal(rank.status, 200, rank.body);
  assert.ok(JSON.parse(rank.body).ranked.length > 0);

  const coldStudio = await startStudio(await fixtureRepo());
  t.after(() => coldStudio.stop());
  const coldCookie = await session(coldStudio);
  const cold = await httpReq(coldStudio.port, { path: '/api/knowledge/graph', headers: { cookie: coldCookie } });
  assert.equal(cold.status, 200, cold.body);
  const coldPayload = JSON.parse(cold.body);
  assert.equal(coldPayload.ok, false);
  assert.match(coldPayload.remedy, /work setup|knowledge build/);
  assert.match(constellation(coldPayload), /Build the corpus/);
});
