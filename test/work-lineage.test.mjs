// Plan 0006 WK04: native metadata, identity and source lineage.
//
// What this pins, in the order the failures matter:
//
//   * A known metadata field this reader cannot read is reported, not silently dropped, while
//     a document's own frontmatter keys are left alone.
//   * A declared id survives a move; a path map covers the files that cannot carry one; and two
//     documents that resolve to one id are reported as a duplicate rather than merged.
//   * Only a claim a maintainer marked `reviewed` is reviewed. A reviewed document does not
//     review its markers.
//   * A document's dates become the claim's applicability only when both ends are declared,
//     and the temporal answer is the engine's, not this module's.
//   * Sections are evidence candidates, a missing source, an unknown anchor and a proposed link
//     are three separate findings, and every reference keeps the text it was written as.
//   * `check` validates the identity map with the same reader the build uses.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ALWAYS_DENIED, buildCorpus } from '../src/knowledge/corpus.mjs';
import { knowledgeInputFindings } from '../src/knowledge/inputs.mjs';
import {
  IDENTITY_FILE,
  describeArtifact,
  identityMap,
  parseMetadataFrontmatter,
  readIdentityMap,
  readMetadata,
} from '../src/knowledge/lineage.mjs';
import { applicableClaims } from '../src/knowledge/validity.mjs';
import { git, simt, tempDir } from './fixture.mjs';

const scope = { id: 'docs', paths: ['docs'], kind: 'document' };
const claim = (fields) => `<!-- claim:${fields} -->`;

function doc(meta, body) {
  return meta === null ? body : `---\n${meta.join('\n')}\n---\n${body}`;
}

function corpusOf(files, { identities = {} } = {}) {
  return buildCorpus({
    scope,
    candidates: Object.keys(files).map((path) => ({ path, tracked: true, bytes: Buffer.byteLength(files[path]) })),
    policy: { deny: ALWAYS_DENIED, identities },
    read: async (path) => (Object.hasOwn(files, path) ? Buffer.from(files[path], 'utf8') : null),
    sidecar: async () => null,
  });
}

const codesOf = (problems) => [...new Set(problems.map((problem) => problem.code))].sort();

test('the frontmatter subset reads scalars, inline JSON and lists, and leaves other keys alone', () => {
  const front = [
    'id: handbook.rates',
    'type: requirement',
    'scope: {"jurisdiction": "de"}',
    'validFrom: 2025-01-01',
    'knownAt: 2025-01-01',
    'sources:',
    '  - docs/req.md#retention',
    '  - {"path": "docs/appendix.md", "type": "requirement", "proposed": true}',
    'title: Rates',
    'tags: [rates, vat]',
  ].join('\n');

  const { fields, problems } = parseMetadataFrontmatter(front, { path: 'docs/rates.md' });
  assert.deepEqual(problems, []);
  assert.equal(fields.get('id'), 'handbook.rates');
  assert.deepEqual(fields.get('scope'), { jurisdiction: 'de' });
  assert.equal(fields.get('sources').length, 2);
  assert.equal(fields.has('title'), false, 'a document key this reader does not own was interpreted');
  assert.equal(fields.has('tags'), false);
});

test('a known field in a shape the subset cannot read is reported where it starts', () => {
  const front = ['id: x', 'scope:', '  jurisdiction: de', 'sources: |', '  - no'].join('\n');
  const { problems } = parseMetadataFrontmatter(front, { path: 'docs/x.md' });
  assert.deepEqual(codesOf(problems), ['unsupported-schema']);
  assert.equal(problems.length, 2, 'both the nested scope and the block scalar are findings');
  assert.match(problems.map((problem) => problem.field).join(','), /scope,sources/);
});

test('a declared field with an impossible value names the field and the value', () => {
  const fields = new Map([
    ['validFrom', '2025-13-01'],
    ['type', 'chapter'],
    ['authority', 'approved'],
    ['scope', 'de'],
  ]);
  const { metadata, problems } = readMetadata(fields, { path: 'docs/x.md' });
  assert.deepEqual(codesOf(problems), ['ambiguous-scope', 'invalid-date', 'unsupported-schema']);
  assert.equal(metadata.validFrom, null, 'an invalid date was kept');
  assert.equal(metadata.type, null);
  assert.equal(metadata.scope, null);
  assert.match(problems.find((problem) => problem.code === 'ambiguous-scope').remedy, /jurisdiction/);
});

test('an identity map reports a duplicate id and an unknown key, and maps the rest', () => {
  const map = readIdentityMap({ paths: { 'docs/b.md': 'doc.rates', 'docs/a.md': './docs/a.md', 'docs/c.md': '', 'docs/d.md': 'doc.rates' }, extra: 1 });
  assert.deepEqual(codesOf(map.problems), ['duplicate-id', 'unsupported-schema']);
  assert.match(map.problems.find((problem) => problem.code === 'duplicate-id').message, /docs\/b\.md, docs\/d\.md/);
  assert.deepEqual(identityMap(map.paths), { 'docs/b.md': 'doc.rates', 'docs/a.md': './docs/a.md', 'docs/d.md': 'doc.rates' });
  assert.deepEqual(readIdentityMap(null).problems.map((problem) => problem.code), ['unsupported-schema']);
});

test('a declared id survives a move, with or without an identity map', () => {
  const text = doc(['id: handbook.rates'], '# Rates\n\n30 days.\n');
  assert.equal(describeArtifact({ path: 'docs/old.md', text }).artifact.id, 'handbook.rates');
  assert.equal(describeArtifact({ path: 'docs/moved/here.md', text }).artifact.id, 'handbook.rates', 'the id did not travel with the file');

  const mapped = describeArtifact({ path: 'docs/moved.md', text: '# Rates\n', identities: { 'docs/moved.md': 'handbook.rates' } });
  assert.equal(mapped.artifact.id, 'handbook.rates');
  assert.equal(describeArtifact({ path: 'docs/plain.md', text: '# Rates\n' }).artifact.id, 'docs/plain.md');
});

test('two documents that resolve to one id are reported, not merged', async () => {
  const files = {
    'docs/a.md': doc(['id: handbook.rates'], '# A\n'),
    'docs/b.md': doc(['id: handbook.rates'], '# B\n'),
  };
  const corpus = await corpusOf(files);
  assert.equal(corpus.counts.artifacts, 2);
  const duplicates = corpus.problems.filter((problem) => problem.code === 'duplicate-id');
  assert.equal(duplicates.length, 2, 'each path that produces the shared id is named');
  assert.deepEqual(duplicates.map((problem) => problem.path).sort(), ['docs/a.md', 'docs/b.md']);
  assert.equal(corpus.units.length, 2, 'the sections themselves are still indexed');
});

test('two versions and a revised later observation give the historical answer', async () => {
  const first = doc(
    ['id: rates.2025', 'validFrom: 2025-01-01', 'validTo: 2025-12-31', 'knownAt: 2025-01-01'],
    `# Rates\n\n${claim('id=rates.2025 subject=rates predicate=retention type=string value="30 days" status=reviewed')}\n`,
  );
  const second = doc(
    ['id: rates.2026', 'validFrom: 2026-01-01', 'knownAt: 2026-01-01'],
    `# Rates\n\n${claim('id=rates.2026 subject=rates predicate=retention type=string value="60 days" status=reviewed')}\n`,
  );
  const corpus = await corpusOf({ 'docs/rates-2025.md': first, 'docs/rates-2026.md': second });
  const claims = corpus.artifacts.flatMap((artifact) => artifact.claims);
  assert.equal(claims.length, 2);
  assert.equal(claims.every((entry) => entry.authority === 'reviewed'), true);

  const historical = applicableClaims(claims, { subject: 'rates', predicate: 'retention', asOf: '2025-06-01', knownAt: '2025-12-31' });
  assert.equal(historical.result, 'applicable');
  assert.equal(historical.claims[0].id, 'rates.2025');
  assert.match(historical.excluded.map((entry) => entry.reason).join(','), /not-known/);

  const later = applicableClaims(claims, { subject: 'rates', predicate: 'retention', asOf: '2026-06-01', knownAt: '2026-06-01' });
  assert.equal(later.result, 'applicable');
  assert.equal(later.claims[0].id, 'rates.2026');
  assert.match(later.excluded.map((entry) => entry.reason).join(','), /expired/);
});

test('a reviewed document does not review its markers, and no dates means no window', async () => {
  const text = doc(
    ['authority: reviewed'],
    `# Rates\n\n${claim('id=rates.a subject=rates predicate=retention type=string value="30 days"')}\n${claim('id=rates.b subject=rates predicate=notice type=string value="7 days" status=reviewed')}\n`,
  );
  const corpus = await corpusOf({ 'docs/rates.md': text });
  const artifact = corpus.artifacts[0];
  assert.equal(artifact.authority, 'reviewed');
  assert.deepEqual(artifact.claims.map((entry) => [entry.id, entry.authority]), [['rates.a', 'proposed'], ['rates.b', 'reviewed']]);
  assert.equal(artifact.claims.every((entry) => entry.applicability === null), true, 'a claim with no dates invented a window');
  assert.equal(corpus.units.every((unit) => unit.authority === 'evidence' && unit.basis === 'section'), true);
});

test('references keep their text, and a missing source, unknown anchor and proposed link are separate', async () => {
  const requirements = '# Requirements\n\n## Retention\n\nKeep 30 days.\n';
  const rates = doc(
    [
      'id: handbook.rates',
      'sources:',
      '  - docs/req.md#retention',
      '  - docs/missing.md',
      '  - {"path": "docs/req.md", "anchor": "nowhere"}',
      '  - {"path": "docs/req.md", "anchor": "retention", "proposed": true}',
    ],
    '# Rates\n',
  );
  const corpus = await corpusOf({ 'docs/req.md': requirements, 'docs/rates.md': rates });
  const artifact = corpus.artifacts.find((entry) => entry.path === 'docs/rates.md');
  assert.equal(artifact.sources.length, 4, 'a reference was dropped');
  assert.equal(artifact.sources[0].ref, 'docs/req.md#retention');
  assert.equal(artifact.sources[0].exists, true);
  assert.equal(artifact.sources[0].anchorFound, true);
  assert.deepEqual(
    corpus.problems.map((problem) => [problem.code, problem.path]).sort(),
    [['proposed-link', 'docs/rates.md'], ['uncertain-anchor', 'docs/rates.md'], ['unresolved-source', 'docs/rates.md']],
  );
  assert.equal(artifact.sources[1].exists, false);
  assert.equal(artifact.sources[2].anchorFound, false);
  assert.equal(artifact.sources[3].proposed, true);
});

test('a sidecar overrides frontmatter, and an unknown sidecar key is a mistake', () => {
  const text = doc(['id: from.frontmatter'], '# Rates\n');
  const sidecar = JSON.stringify({ id: 'from.sidecar', language: 'de', colonne: 'x' });
  const { artifact, problems } = describeArtifact({ path: 'docs/rates.md', text, sidecar });
  assert.equal(artifact.id, 'from.sidecar');
  assert.equal(artifact.language, 'de');
  assert.deepEqual(problems.map((problem) => problem.code), ['unsupported-schema']);
  assert.equal(problems[0].field, 'colonne');
});

test('a metadata sidecar is read with its document, and never indexed as a document itself', async () => {
  const files = { 'docs/rates.md': '# Rates\n\n30 days.\n' };
  const sidecars = { 'docs/rates.md': JSON.stringify({ id: 'handbook.rates', validFrom: '2025-01-01', knownAt: '2025-01-01' }) };
  const corpus = await buildCorpus({
    scope,
    candidates: [...Object.keys(files), 'docs/rates.md.meta.json'].map((path) => ({ path, tracked: true, bytes: 32 })),
    policy: { deny: ALWAYS_DENIED, identities: {} },
    read: async (path) => (Object.hasOwn(files, path) ? Buffer.from(files[path], 'utf8') : null),
    sidecar: async (path) => (Object.hasOwn(sidecars, path) ? sidecars[path] : null),
  });
  assert.deepEqual(corpus.artifacts.map((artifact) => artifact.id), ['handbook.rates']);
  assert.equal(corpus.artifacts[0].applicability.recordedFrom, '2025-01-01', 'the sidecar was not read with its document');
  const row = corpus.inventory.find((entry) => entry.path === 'docs/rates.md.meta.json');
  assert.equal(row.state, 'sidecar');
  assert.match(row.reason, /metadata sidecar of docs\/rates\.md/);
  assert.equal(corpus.counts.sidecar, 1);
  assert.equal(corpus.counts.indexed, 1);
});

test('check validates the identity map with the same reader the build uses', async () => {
  const root = await tempDir('simt-identities-');
  mkdirSync(join(root, '.simt/knowledge'), { recursive: true });
  writeFileSync(join(root, IDENTITY_FILE), `${JSON.stringify({ paths: { 'docs/a.md': '' } }, null, 2)}\n`);
  const findings = await knowledgeInputFindings(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /must be a non-empty string/);
  assert.match(findings[0].remedy, /cited by/);

  writeFileSync(join(root, IDENTITY_FILE), `${JSON.stringify({ paths: { 'docs/a.md': 'handbook.a' } }, null, 2)}\n`);
  assert.deepEqual(await knowledgeInputFindings(root), []);
});

// --- the command, against a real repository ---------------------------------

async function repo(files) {
  const root = await tempDir('simt-lineage-');
  await git(['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'simt.json'), `${JSON.stringify({ work: { version: 2, scopes: [{ id: 'docs', paths: ['docs'], kind: 'document' }] } }, null, 2)}\n`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

const build = async (root) => {
  const run = await simt(['knowledge', 'build', '--scope', 'docs', '--yes', '--root', root, '--json']);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
};

test('a moved document keeps the id its identity map declares, across a rebuild', async () => {
  const root = await repo({
    'docs/rates.md': doc(['validFrom: 2025-01-01', 'knownAt: 2025-01-01', 'scope: {"jurisdiction": "de"}'], `# Rates\n\n${claim('id=rates.retention subject=rates predicate=retention type=string value="30 days" status=reviewed')}\n`),
    'docs/notes.md': '# Notes\n\nplain text\n',
    '.simt/knowledge/identities.json': `${JSON.stringify({ paths: { 'docs/notes.md': 'handbook.notes' } }, null, 2)}\n`,
  });

  const first = await build(root);
  assert.deepEqual(first.artifacts.map((artifact) => artifact.id).sort(), ['docs/rates.md', 'handbook.notes']);
  assert.equal(first.counts.claims, 1);
  const stored = JSON.parse(readFileSync(join(root, '.simt/local/corpus/docs.json'), 'utf8'));
  assert.equal(stored.schema, 2, 'the corpus did not record the shape it is in');
  assert.equal(stored.artifacts.find((artifact) => artifact.path === 'docs/rates.md').applicability.recordedFrom, '2025-01-01');

  await git(['-C', root, 'mv', 'docs/notes.md', 'docs/handbook-notes.md']);
  writeFileSync(join(root, '.simt/knowledge/identities.json'), `${JSON.stringify({ paths: { 'docs/handbook-notes.md': 'handbook.notes' } }, null, 2)}\n`);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'move']);

  const second = await build(root);
  const moved = second.artifacts.find((artifact) => artifact.path === 'docs/handbook-notes.md');
  assert.equal(moved.id, 'handbook.notes', 'the id did not survive the move');
  assert.equal(second.units.filter((unit) => unit.path === 'docs/handbook-notes.md').every((unit) => unit.artifact.startsWith('handbook.notes')), true);

  // A malformed map stops the build instead of quietly losing every id in it.
  // A duplicate in the map is the same ambiguity a duplicate frontmatter id is: reported per
  // path, so the build still produces a corpus. A map that cannot be read is the fatal case.
  writeFileSync(join(root, '.simt/knowledge/identities.json'), `${JSON.stringify({ paths: { 'docs/rates.md': 'shared.id', 'docs/handbook-notes.md': 'shared.id' } }, null, 2)}\n`);
  const ambiguous = await build(root);
  assert.deepEqual(ambiguous.artifacts.map((artifact) => artifact.id), ['shared.id', 'shared.id']);
  assert.deepEqual(ambiguous.problems.filter((problem) => problem.code === 'duplicate-id').map((problem) => problem.path).sort(), ['docs/handbook-notes.md', 'docs/rates.md']);

  writeFileSync(join(root, '.simt/knowledge/identities.json'), '{ "paths": [] }\n');
  const refused = await simt(['knowledge', 'build', '--scope', 'docs', '--root', root]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /identities\.json/);

  rmSync(join(root, '.simt/knowledge/identities.json'));
});
