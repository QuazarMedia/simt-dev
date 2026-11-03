// Plan 0004 W13: claims, typed values and dependency edges.
//
// The failures pinned here are the ones that make a lineage claim untrustworthy. A number
// and a string that look alike must not become one assertion, and neither must two claims
// with different units. A proposed edge must be findable and must not appear in the impact
// set a check would use. And prose must stay unassessed: the fixture here contains a
// sentence that states a fact plainly, and the parser is asserted not to turn it into a
// claim, because it has no grounds to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CLAIMS_SCHEMA_VERSION,
  EDGE_KINDS,
  buildClaimGraph,
  claimKey,
  extractClaims,
  impact,
  lineage,
  proposedEdges,
  readClaim,
  sameClaim,
  unifyClaims,
} from '../src/knowledge/claims.mjs';

const claim = (overrides) => readClaim({
  id: 'de-vat',
  subject: 'de.vat',
  predicate: 'standard-rate',
  type: 'number',
  value: 19,
  unit: '%',
  status: 'reviewed',
  ...overrides,
}).claim;

const DOCUMENT = [
  '# Rate notes',
  '',
  'The standard rate applies to most goods and services.',
  '',
  '<!-- claim: id=de-vat subject=de.vat predicate=standard-rate value=19 type=number unit=% status=reviewed -->',
  '<!-- claim: id=de-vat-effective subject=de.vat predicate=effective-from value=2025-01-01 type=string status=reviewed -->',
  '',
  'The reduction for food was announced in the same bulletin.',
  '<!-- claim: id=de-food subject=de.food predicate=standard-rate value=7 type=number unit=% status=proposed unti=% -->',
].join('\n');

function graphFixture() {
  const artifacts = [
    { id: 'src:de-2024', kind: 'source', path: 'Germany/sources/rate-2024.md' },
    { id: 'doc:de-rates', kind: 'document', path: 'Germany/rates.md' },
    { id: 'tdd:de-rates', kind: 'tdd', path: 'Germany/tdd/rates.md' },
    { id: 'recipe:create', kind: 'recipe', path: 'recipes/create-calculation.md' },
    { id: 'helper:create', kind: 'helper', path: 'helpers/create_calculation.py' },
    { id: 'obj:calc', kind: 'remote-object' },
  ];
  const claims = [claim()];
  const edges = [
    { from: 'claim:de-vat', to: 'src:de-2024', kind: 'derived-from', status: 'reviewed' },
    { from: 'doc:de-rates', to: 'claim:de-vat', kind: 'derived-from', status: 'reviewed' },
    { from: 'tdd:de-rates', to: 'doc:de-rates', kind: 'implements', status: 'reviewed' },
    { from: 'recipe:create', to: 'tdd:de-rates', kind: 'implements', status: 'reviewed' },
    { from: 'helper:create', to: 'recipe:create', kind: 'implements', status: 'reviewed' },
    { from: 'claim:de-vat', to: 'obj:calc', kind: 'affects-object', status: 'reviewed' },
  ];
  return buildClaimGraph({
    artifacts,
    claims: [{ ...claims[0], id: 'claim:de-vat' }],
    edges,
  });
}

test('a number and a string that look alike are different claims, and so are two units', () => {
  assert.equal(CLAIMS_SCHEMA_VERSION, 1);
  const number = claim();
  const string = claim({ type: 'string', value: '19' });
  assert.notEqual(claimKey(number), claimKey(string));
  assert.equal(sameClaim(number, string), false, 'a typed value unified with a string of itself');

  const percent = claim();
  const bare = claim({ unit: null });
  assert.equal(sameClaim(percent, bare), false, 'a unitless value unified with a percentage');

  const spaced = claim({ subject: '  de.vat ' });
  assert.equal(sameClaim(percent, spaced), true, 'normalising surrounding space changed the identity');

  const groups = unifyClaims([percent, claim({ id: 'de-vat-copy' }), string, bare]);
  assert.equal(groups.length, 3, JSON.stringify(groups.map((group) => group.claims.map((entry) => entry.id))));
  assert.deepEqual(groups.find((group) => group.claims.length === 2).claims.map((entry) => entry.id), ['de-vat', 'de-vat-copy']);
});

test('a claim missing its type, subject or matching value is refused, not repaired', () => {
  const untyped = readClaim({ id: 'a', subject: 's', predicate: 'p', value: 19 });
  assert.match(untyped.problems.join('\n'), /type must be one of/);

  assert.match(readClaim({ id: 'a', predicate: 'p', type: 'number', value: 1 }).problems.join('\n'), /subject must be a non-empty string/);

  const mismatched = readClaim({ id: 'a', subject: 's', predicate: 'p', type: 'number', value: '19' });
  assert.match(mismatched.problems.join('\n'), /needs a finite number value/);

  assert.match(readClaim({ id: 'a', subject: 's', predicate: 'p', type: 'number', value: 1, status: 'maybe' }).problems.join('\n'), /status must be one of/);
  assert.equal(readClaim({ id: 'a', subject: 's', predicate: 'p', type: 'number', value: 1 }).claim.status, 'proposed', 'an unreviewed claim is proposed by default');
});

test('explicit markers become claims, prose stays unassessed, and a misspelt field is reported', () => {
  const extracted = extractClaims(DOCUMENT, { path: 'Germany/rates.md' });
  assert.equal(extracted.version, CLAIMS_SCHEMA_VERSION);
  assert.equal(extracted.path, 'Germany/rates.md');
  assert.deepEqual(extracted.claims.map((entry) => entry.id), ['de-vat', 'de-vat-effective']);
  assert.equal(extracted.claims[0].value, 19);
  assert.equal(extracted.claims[1].type, 'string', 'a date is carried as the string it was declared');
  assert.equal(extracted.claims[1].value, '2025-01-01');

  const problems = extracted.problems.map((entry) => entry.message).join('\n');
  assert.match(problems, /unknown claim field `unti`/, 'a misspelt field vanished instead of being reported');
  assert.equal(extracted.claims.some((entry) => entry.id === 'de-food'), false);

  assert.equal(extracted.unassessed, 3, 'the heading and the two sentences, none of which declared a claim');
  assert.equal(extracted.claims.some((entry) => /standard rate applies/.test(JSON.stringify(entry))), false, 'prose was turned into a claim');
});

test('lineage and reverse impact are exact on the source-claim-document-TDD-recipe-helper chain', () => {
  const graph = graphFixture();
  assert.deepEqual(graph.problems, []);
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    'src:de-2024',
    'doc:de-rates',
    'tdd:de-rates',
    'recipe:create',
    'helper:create',
    'obj:calc',
    'claim:de-vat',
  ]);

  assert.deepEqual(impact(graph, 'src:de-2024').reachable, [
    'src:de-2024',
    'claim:de-vat',
    'doc:de-rates',
    'tdd:de-rates',
    'recipe:create',
    'helper:create',
  ]);
  assert.deepEqual(lineage(graph, 'helper:create').reachable, [
    'helper:create',
    'recipe:create',
    'tdd:de-rates',
    'doc:de-rates',
    'claim:de-vat',
    'src:de-2024',
    'obj:calc',
  ]);
  assert.deepEqual(impact(graph, 'missing').unknown, true);
  assert.deepEqual(impact(graph, 'missing').reachable, []);
});

test('a proposed edge is queryable and excluded from impact until it is reviewed', () => {
  const graph = buildClaimGraph({
    artifacts: [{ id: 'helper:create', kind: 'helper' }, { id: 'obj:calc', kind: 'remote-object' }],
    edges: [{ from: 'helper:create', to: 'obj:calc', kind: 'affects-object' }],
  });
  assert.deepEqual(graph.problems, []);
  assert.deepEqual(proposedEdges(graph).map((edge) => `${edge.from} ${edge.kind} ${edge.to}`), ['helper:create affects-object obj:calc']);
  assert.deepEqual(impact(graph, 'obj:calc').reachable, ['obj:calc'], 'an unreviewed edge answered an impact question');
  assert.deepEqual(impact(graph, 'obj:calc', { includeProposed: true }).reachable, ['obj:calc', 'helper:create']);
});

test('contradiction and supersession are findings, not dependencies', () => {
  const graph = buildClaimGraph({
    artifacts: [{ id: 'claim:a', kind: 'claim' }, { id: 'claim:b', kind: 'claim' }],
    edges: [
      { from: 'claim:a', to: 'claim:b', kind: 'contradicts', status: 'reviewed' },
      { from: 'claim:b', to: 'claim:a', kind: 'supersedes', status: 'reviewed' },
    ],
  });
  assert.deepEqual(impact(graph, 'claim:a').reachable, ['claim:a']);
  assert.deepEqual(lineage(graph, 'claim:a').reachable, ['claim:a']);
  assert.equal(graph.edges.length, 2, 'the edges are recorded even though they are not traversed');
});

test('a dangling edge and an unknown kind are problems, never nodes created in passing', () => {
  const graph = buildClaimGraph({
    artifacts: [{ id: 'doc:a', kind: 'document' }],
    edges: [
      { from: 'doc:a', to: 'doc:absent', kind: 'derived-from', status: 'reviewed' },
      { from: 'doc:a', to: 'doc:a', kind: 'mentions', status: 'reviewed' },
    ],
  });
  assert.deepEqual(graph.edges, []);
  const problems = graph.problems.join('\n');
  assert.match(problems, /names a node the graph does not have/);
  assert.match(problems, /edge kind "mentions" is not one of/);
  assert.deepEqual(EDGE_KINDS, [
    'supports',
    'contradicts',
    'derived-from',
    'supersedes',
    'imports-context',
    'implements',
    'generated-by',
    'verifies',
    'affects-object',
  ]);
});

test('a cycle terminates, is reported, and a bound says it stopped early', () => {
  const graph = buildClaimGraph({
    artifacts: [
      { id: 'doc:a', kind: 'document' },
      { id: 'doc:b', kind: 'document' },
      { id: 'doc:c', kind: 'document' },
    ],
    edges: [
      { from: 'doc:a', to: 'doc:b', kind: 'imports-context', status: 'reviewed' },
      { from: 'doc:b', to: 'doc:a', kind: 'imports-context', status: 'reviewed' },
      { from: 'doc:b', to: 'doc:c', kind: 'imports-context', status: 'reviewed' },
    ],
  });
  const walked = lineage(graph, 'doc:a');
  assert.deepEqual(walked.reachable, ['doc:a', 'doc:b', 'doc:c']);
  assert.deepEqual(walked.cycles, ['doc:a']);
  assert.equal(walked.truncated, false);

  const bounded = lineage(graph, 'doc:a', { limit: 2 });
  assert.equal(bounded.truncated, true, 'a bound that stopped the walk did not say so');
});

test('the same graph is the same answer twice, and the module reads nothing', async () => {
  assert.deepEqual(graphFixture(), graphFixture());
  const source = await readFile(new URL('../src/knowledge/claims.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|node:http|fetch\(|process\.env|Date\.|Math\.random/);
});
