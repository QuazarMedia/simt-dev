// Plan 0004 W22: evidence-grounded impact and counterexamples.
//
// The fixture crosses representations on purpose: a source reaches a claim, the requirement
// document built from it, the design note, the recipe, the graduated helper, the test and the
// remote object the recipe affects. An import walk can see none of those edges, which is why
// the report is built on the typed graph. The failures pinned here: a proposed edge counted
// as a dependency, a scope the question did not ask about appearing in the set, a truncated
// walk read as complete, a lesson from another tenant becoming an instruction, and one copied
// assertion counted as several pieces of evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildClaimGraph } from '../src/knowledge/claims.mjs';
import { digestOf } from '../src/knowledge/observations.mjs';
import { IMPACT_BUCKETS, IMPACT_SCHEMA_VERSION, impactReport, lessonsFor } from '../src/knowledge/impact.mjs';

const reviewed = (from, to, kind) => ({ from, to, kind, status: 'reviewed' });
const proposed = (from, to, kind) => ({ from, to, kind, status: 'proposed' });

function chainGraph() {
  return buildClaimGraph({
    artifacts: [
      { id: 'src:de-2024', kind: 'source' },
      { id: 'doc:de-requirements', kind: 'document' },
      { id: 'tdd:de-rates', kind: 'tdd' },
      { id: 'recipe:create', kind: 'recipe' },
      { id: 'helper:create', kind: 'helper' },
      { id: 'test:de-vat', kind: 'test' },
      { id: 'obj:calc', kind: 'remote-object' },
      { id: 'obj:other', kind: 'remote-object' },
    ].map((artifact) => ({ ...artifact, scope: { jurisdiction: 'DE' } })),
    claims: [{ id: 'claim:de-vat', subject: 'de.vat', predicate: 'standard-rate', type: 'number', value: 19, unit: '%', scope: { jurisdiction: 'DE' } }],
    edges: [
      reviewed('claim:de-vat', 'src:de-2024', 'derived-from'),
      reviewed('doc:de-requirements', 'claim:de-vat', 'derived-from'),
      reviewed('tdd:de-rates', 'doc:de-requirements', 'implements'),
      reviewed('recipe:create', 'tdd:de-rates', 'implements'),
      reviewed('helper:create', 'recipe:create', 'implements'),
      reviewed('test:de-vat', 'claim:de-vat', 'verifies'),
      reviewed('recipe:create', 'obj:calc', 'affects-object'),
      proposed('helper:create', 'obj:other', 'affects-object'),
    ],
  });
}

const DE = { jurisdiction: 'DE' };

test('the impact set is exact across the chain, bucketed by what each thing is', () => {
  const report = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE } });
  assert.equal(report.version, IMPACT_SCHEMA_VERSION);
  assert.deepEqual(IMPACT_BUCKETS, ['claims', 'artifacts', 'recipes', 'helpers', 'tests', 'remoteObjects', 'sources', 'other']);
  assert.deepEqual(report.affected, {
    claims: ['claim:de-vat'],
    artifacts: ['doc:de-requirements', 'tdd:de-rates'],
    recipes: ['recipe:create'],
    helpers: ['helper:create'],
    tests: ['test:de-vat'],
    remoteObjects: ['obj:calc'],
    sources: [],
    other: [],
  });
  assert.equal(report.complete, true);
  assert.equal(report.conservative, false);
  assert.deepEqual(report.cycles, []);
});

test('an edge nobody reviewed is reported beside the answer, never inside it', () => {
  const report = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE } });
  assert.equal(report.affected.remoteObjects.includes('obj:other'), false, 'a proposed edge was counted as a dependency');
  assert.ok(report.proposed.includes('obj:other'), JSON.stringify(report.proposed));
  assert.equal(report.complete, true, 'a proposed edge alone made the answer incomplete');
});

test('a scope the question did not ask about is excluded, and a missing one is unknown', () => {
  const graph = {
    nodes: [
      { id: 'src:a', kind: 'source' },
      { id: 'claim:de', kind: 'claim', scope: { jurisdiction: 'DE' } },
      { id: 'claim:fr', kind: 'claim', scope: { jurisdiction: 'FR' } },
      { id: 'claim:bare', kind: 'claim' },
    ],
    edges: [
      reviewed('claim:de', 'src:a', 'derived-from'),
      reviewed('claim:fr', 'src:a', 'derived-from'),
      reviewed('claim:bare', 'src:a', 'derived-from'),
    ],
  };
  const report = impactReport({ graph, change: { refs: ['src:a'], scopes: DE } });
  assert.deepEqual(report.affected.claims, ['claim:de']);
  assert.deepEqual(report.excluded, [{ id: 'claim:fr', reason: 'scope-mismatch' }]);
  assert.deepEqual(report.unknown, [{ ref: 'claim:bare', reason: 'scope-missing' }]);
  assert.equal(report.complete, false);
  assert.equal(report.conservative, true);
});

test('bound exhaustion is an incomplete answer that asks for conservative verification', () => {
  const report = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE }, limits: { nodes: 2 } });
  assert.equal(report.truncated, true);
  assert.equal(report.complete, false);
  assert.equal(report.conservative, true);
  assert.equal(Object.values(report.affected).flat().length, 2);
  assert.match(report.reasons.join(' '), /stopped at 2 node\(s\)/);
  assert.match(report.reasons.join(' '), /unreported rather than unaffected/);
});

test('a ref the graph does not hold and a cycle are both named', () => {
  const graph = {
    nodes: [{ id: 'a', kind: 'document' }, { id: 'b', kind: 'document' }],
    edges: [reviewed('a', 'b', 'imports-context'), reviewed('b', 'a', 'imports-context')],
  };
  const report = impactReport({ graph, change: { refs: ['missing-ref', 'a'] } });
  assert.deepEqual(report.unknown, [{ ref: 'missing-ref', reason: 'not-in-graph' }]);
  assert.deepEqual(report.cycles, ['a']);
  assert.match(report.reasons.join(' '), /cycles through a/);
});

test('a generation receipt puts its output in the set, and an unknown receipt is a frontier', () => {
  const receipts = [
    {
      id: 'r-req',
      output: { path: 'Germany/requirements.md', digest: digestOf('requirements v1') },
      inputs: [{ ref: 'src:de-2024', digest: digestOf('source v1') }],
      complete: true,
    },
  ];
  const derivations = { receipts, outputs: ['Italy/requirements.md'], changes: [{ ref: 'src:de-2024', digest: digestOf('source v2') }] };
  const report = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE }, derivations });
  assert.ok(report.affected.artifacts.includes('Germany/requirements.md'));
  assert.deepEqual(report.unknown, [{ ref: 'Italy/requirements.md', reason: 'no-generation-receipt' }]);
  assert.equal(report.conservative, true);
});

test('a lesson from another tenant is excluded and its text never appears', () => {
  const lessons = [
    { id: 'fail-a', kind: 'failure', scope: DE, lineage: 'lineage-1', text: 'the rate page cited itself in a circle' },
    { id: 'fail-a-copy', kind: 'failure', scope: DE, lineage: 'lineage-1', text: 'the rate page cited itself in a circle' },
    { id: 'example-b', kind: 'exemplar', scope: DE, lineage: 'lineage-2', text: 'cite the bulletin directly' },
    { id: 'tenant-b', kind: 'failure', scope: DE, tenant: 'tenant-b', lineage: 'lineage-3', text: 'DROP TABLE rates' },
    { id: 'fr-only', kind: 'failure', scope: { jurisdiction: 'FR' }, lineage: 'lineage-4', text: 'french rate guidance' },
  ];
  const report = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE, tenant: 'tenant-a' }, lessons });

  assert.deepEqual(report.lessons.counterexamples.map((row) => row.id), ['fail-a']);
  assert.deepEqual(report.lessons.exemplars.map((row) => row.id), ['example-b']);
  assert.deepEqual(report.lessons.excluded, [{ id: 'fr-only', reason: 'scope-mismatch' }, { id: 'tenant-b', reason: 'tenant' }]);
  assert.doesNotMatch(JSON.stringify(report), /DROP TABLE/, 'a lesson from another tenant reached the report');
  assert.doesNotMatch(JSON.stringify(report), /french rate guidance/);

  const ownTenant = impactReport({ graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE, tenant: 'tenant-b' }, lessons });
  assert.ok(ownTenant.lessons.counterexamples.some((row) => row.id === 'tenant-b'), 'a lesson was withheld from its own tenant');
});

test('one assertion copied into several lessons is one piece of evidence', () => {
  const lessons = [
    { id: 'l1', kind: 'failure', scope: DE, lineage: 'same-source', text: 'one' },
    { id: 'l2', kind: 'failure', scope: DE, lineage: 'same-source', text: 'one, copied' },
    { id: 'l3', kind: 'failure', scope: DE, lineage: 'same-source', text: 'one, copied again' },
    { id: 'l4', kind: 'failure', scope: DE, lineage: 'other-source', text: 'two' },
  ];
  const report = lessonsFor({ lessons, scopes: DE });
  assert.deepEqual(report.counterexamples.map((row) => row.id), ['l1', 'l4']);
  assert.deepEqual(report.counterexamples.map((row) => row.copies), [3, 1]);
  assert.deepEqual(report.counterexamples.map((row) => row.corroborating), [1, 1], 'three copies were counted as three corroborating sources');
});

test('a scoped report will not adopt an unscoped lesson, and no report adopts another tenant\'s', () => {
  const lessons = [
    { id: 'bare', kind: 'failure', text: 'applies to everyone, allegedly' },
    { id: 'scoped', kind: 'failure', scope: DE, text: 'german' },
    { id: 'tenant', kind: 'failure', scope: DE, tenant: 'tenant-b', text: 'tenant b only' },
  ];
  // With no scope named there is nothing for an unscoped lesson to conflict with.
  const unscoped = lessonsFor({ lessons });
  assert.deepEqual(unscoped.excluded, [{ id: 'tenant', reason: 'tenant' }]);
  assert.deepEqual(unscoped.counterexamples.map((row) => row.id), ['bare', 'scoped']);

  const scoped = lessonsFor({ lessons, scopes: DE });
  assert.deepEqual(scoped.excluded, [{ id: 'bare', reason: 'scope-missing' }, { id: 'tenant', reason: 'tenant' }]);
  assert.deepEqual(scoped.counterexamples.map((row) => row.id), ['scoped']);
});

test('the report is deterministic, and the module reads nothing', async () => {
  const input = { graph: chainGraph(), change: { refs: ['src:de-2024'], scopes: DE }, lessons: [{ id: 'l', kind: 'exemplar', scope: DE, text: 'ok' }] };
  assert.deepEqual(impactReport(structuredClone(input)), impactReport(input));
  assert.throws(() => impactReport({ change: { refs: ['x'] } }), /needs a claim graph with nodes/);
  const source = await readFile(new URL('../src/knowledge/impact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
