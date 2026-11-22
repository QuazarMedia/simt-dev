import assert from 'node:assert/strict';
import { test } from 'node:test';

import { directionalGraph, expandDirectional, HOP_CAP } from '../src/index/directional.mjs';

const connect = (src, kind, dst, weight) => ({ src, kind, dst, weight });

test('favors containment and upstream callers over popular downstream utilities', () => {
  const match = 'sym:feature.mjs#render@1';
  const caller = 'sym:controller.mjs#dispatch@1';
  const utility = 'sym:util.mjs#format@1';
  const enclosing = 'file:feature.mjs';
  const sibling = 'sym:feature.mjs#refresh@24';
  const edges = [
    connect(enclosing, 'contains', match),
    connect(enclosing, 'contains', sibling),
    connect(caller, 'calls_symbol', match),
    connect(match, 'calls_symbol', utility),
    ...Array.from({ length: 80 }, (_, index) => connect(`sym:screen-${index}.mjs#update@1`, 'calls_symbol', utility)),
  ];
  const hits = expandDirectional(directionalGraph(edges), [{ node: match, score: 1, exact: true }]);
  assert.ok(hits.findIndex(({ node }) => node === caller) < hits.findIndex(({ node }) => node === utility));
  assert.ok(hits.findIndex(({ node }) => node === enclosing) < hits.findIndex(({ node }) => node === utility));
  assert.deepEqual(hits.find(({ node }) => node === caller).witness.steps, [
    { src: match, dst: caller, kind: 'called_by', weight: 0.85 },
  ]);
  assert.deepEqual(hits.find(({ node }) => node === sibling).witness.steps.map(({ kind }) => kind), ['enclosed_by', 'contains']);
  for (const { node, witness } of hits) {
    assert.equal(witness.seed, match);
    assert.equal(witness.steps.at(-1).dst, node);
  }
});

test('damps high-degree lexical seeds, keeps explicit anchors and weights co-change', () => {
  const hub = 'file:hub.mjs';
  const candidate = 'file:related.mjs';
  const graph = directionalGraph([
    connect(hub, 'cochange', candidate, 0.5),
    ...Array.from({ length: 40 }, (_, index) => connect(`file:screen-${index}.mjs`, 'imports_symbol', hub)),
  ]);
  const lexical = expandDirectional(graph, [{ node: hub, score: 1 }]).find(({ node }) => node === candidate);
  const exact = expandDirectional(graph, [{ node: hub, score: 1, exact: true }]).find(({ node }) => node === candidate);
  // The capped frontier can omit a weak relation in a large star. Isolate the
  // direct co-change evidence from stronger arcs by marking their sources as seeds.
  assert.equal(lexical, undefined);
  assert.equal(exact, undefined);
  const otherSeeds = Array.from({ length: 40 }, (_, index) => ({ node: `file:screen-${index}.mjs`, score: 0.01 }));
  const damped = expandDirectional(graph, [...otherSeeds, { node: hub, score: 1 }]).find(({ node }) => node === candidate);
  const anchor = expandDirectional(graph, [...otherSeeds, { node: hub, score: 1, exact: true }]).find(({ node }) => node === candidate);
  assert.equal(anchor.score, 0.3);
  assert.ok(Math.abs(damped.score - 0.3 / Math.log2(43)) < Number.EPSILON);
});

test('caps each of two hops and scores the same after shuffling edges and seeds', () => {
  const edges = [connect('b', 'calls_symbol', 'destination'), connect('a', 'calls_symbol', 'destination')];
  const seeds = [{ node: 'destination', score: 1 }, { node: 'seed', score: 2 }];
  for (let index = 0; index < 40; index += 1) {
    edges.push(connect('seed', 'contains', `branch:${index}`), connect(`branch:${index}`, 'contains', `leaf:${index}`));
  }
  const ranked = expandDirectional(directionalGraph(edges), seeds);
  assert.equal(ranked.filter(({ node }) => node.startsWith('branch:')).length, HOP_CAP - 2);
  assert.equal(ranked.filter(({ node }) => node.startsWith('leaf:')).length, HOP_CAP - 2);
  assert.deepEqual(ranked, expandDirectional(directionalGraph(edges.toReversed()), seeds.toReversed()));
});

test('sums converging paths and records the strongest individual witness', () => {
  const graph = directionalGraph([
    connect('early', 'contains', 'result'),
    connect('later', 'calls_symbol', 'result'),
  ]);
  const [hit] = expandDirectional(graph, [
    { node: 'early', score: 0.2, exact: true },
    { node: 'later', score: 0.9, exact: true },
  ]);
  assert.equal(hit.witness.seed, 'later');
  assert.equal(hit.witness.steps[0].kind, 'calls_symbol');
  assert.ok(Math.abs(hit.score - (0.2 * 0.9 + 0.9 * 0.35) / 2 ** 0.55) < Number.EPSILON);
});
