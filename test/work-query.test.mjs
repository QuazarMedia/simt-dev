// Plan 0006 WK05: querying the repository directly, with citations and dates.
//
// What this pins, in the order the failures matter:
//
//   * A cold repository is refused with the build command, not answered from a guess; a
//     warm one answers from the corpus the build wrote.
//   * Every hit carries a citation a maintainer can open: path, anchor, line and byte
//     range, and the revision it was read from.
//   * A wrong-scope unit is excluded before scoring, an unplaceable one stays a separate
//     class, and nothing about scope is inferred from the query's spelling.
//   * Both time axes answer the historical question, and a contradiction shows both sides.
//   * A section without a reviewed claim is a citation with the supported way to add one,
//     not a refusal that hides the source the search found.
//   * A changed source makes the corpus stale, and the refusal names the rebuild.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CORPUS_DIR } from '../src/knowledge/corpus.mjs';
import { corpusDocument, rankCorpus } from '../src/knowledge/query.mjs';
import { git, simt, tempDir } from './fixture.mjs';

const WORK = { version: 2, scopes: [{ id: 'handbook', paths: ['handbook'], kind: 'document' }] };

const front = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')}\n---\n`;

const FILES = {
  'handbook/retention-old.md': `${front({
    id: 'retention.old',
    scope: { jurisdiction: 'DE' },
    language: 'en',
    authority: 'reviewed',
    validFrom: '2024-01-01',
    validTo: '2025-01-01',
    knownAt: '2024-01-02',
  })}# Retention 2024\n\nDevice checkout retention is 14 days.\n\n<!-- claim: id=retention.old.v subject=device-checkout predicate=retention type=number value=14 unit=days status=reviewed -->\n`,
  'handbook/retention-new.md': `${front({
    id: 'retention.new',
    scope: { jurisdiction: 'DE' },
    language: 'en',
    authority: 'reviewed',
    validFrom: '2025-01-01',
    knownAt: '2025-01-02',
  })}# Retention\n\nDevice checkout retention is 30 days.\n\n<!-- claim: id=retention.new.v subject=device-checkout predicate=retention type=number value=30 unit=days status=reviewed evidence=retention.old.v -->\n`,
  // The same words under a jurisdiction the German questions do not ask about.
  'handbook/retention-fr.md': `${front({ id: 'retention.fr', scope: { jurisdiction: 'FR' }, language: 'fr' })}# Rétention\n\nDevice checkout retention is 90 days.\n`,
  // Matching words and no declared scope: unplaceable, not silently dropped.
  'handbook/retention-unknown.md': '# Retention draft\n\nDevice checkout retention is unclear.\n',
  'handbook/checkout.jp.md': `${front({ id: 'checkout.jp', language: 'ja' })}# 保管\n\nデバイスの保管期間は30日です。\n`,
  'handbook/plain.md': '# Plain\n\nAn ordinary section about retention, with no metadata and no claim.\n',
};

async function repo(files = FILES, work = WORK) {
  const root = await tempDir('simt-query-');
  await git(['-C', root, 'init', '-q']);
  if (work !== null) writeFileSync(join(root, 'simt.json'), `${JSON.stringify({ work }, null, 2)}\n`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

const build = async (root) => {
  const run = await simt(['knowledge', 'build', '--scope', 'handbook', '--root', root, '--json', '--yes']);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(run.stdout);
};

const rank = async (root, args) => simt(['knowledge', 'rank', '--scope', 'handbook', '--root', root, '--json', ...args]);
const why = async (root, id, args = []) => simt(['knowledge', 'why', id, '--scope', 'handbook', '--root', root, '--json', ...args]);

// A --json refusal is a JSON envelope on stdout, not a line on stderr.
const refusal = (run) => {
  assert.notEqual(run.code, 0);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ok, false);
  return `${payload.error}\n${payload.remedy}`;
};

test('a cold repository is refused with the build command, and a warm one answers', async () => {
  const root = await repo();
  const cold = refusal(await rank(root, ['--query', 'retention']));
  assert.match(cold, /no corpus is built for scope `handbook`/);
  assert.match(cold, /simt knowledge build --scope handbook --yes/);
  assert.match(refusal(await why(root, 'retention.new.v')), /no corpus is built/);

  await build(root);
  const warm = await rank(root, ['--query', 'device checkout retention']);
  assert.equal(warm.code, 0, warm.stderr);
  const payload = JSON.parse(warm.stdout);
  assert.equal(payload.command, 'knowledge rank');
  assert.equal(payload.scope, 'handbook');
  assert.ok(payload.ranked.length > 0, 'the built corpus answered nothing');
  assert.ok(payload.ranked.some((hit) => hit.path === 'handbook/retention-new.md'));
});

test('every hit carries a citation whose byte range opens the source it names', async () => {
  const root = await repo();
  await build(root);
  const payload = JSON.parse((await rank(root, ['--query', 'device checkout retention'])).stdout);
  const corpus = JSON.parse(readFileSync(join(root, CORPUS_DIR, 'handbook.json'), 'utf8'));
  for (const hit of payload.ranked) {
    const cite = hit.citation;
    assert.ok(cite != null, `${hit.id} carries no citation`);
    assert.equal(typeof cite.anchor, 'string');
    assert.ok(cite.lineEnd >= cite.lineStart);
    assert.match(cite.revision, /^committed:/, 'a committed source was not labelled committed');
    assert.equal(cite.provenance, 'committed');
    const unit = corpus.units.find((record) => record.id === hit.id);
    const bytes = readFileSync(join(root, cite.path));
    assert.equal(bytes.subarray(cite.byteStart, cite.byteEnd).toString('utf8'), unit.text, 'the citation does not index the file');
  }
  const reviewed = payload.ranked.find((hit) => hit.path === 'handbook/retention-new.md');
  assert.equal(reviewed.authorityBasis, 'reviewed');
  const plain = JSON.parse((await rank(root, ['--query', 'ordinary section retention'])).stdout);
  const evidence = plain.ranked.find((hit) => hit.path === 'handbook/plain.md');
  assert.equal(evidence.authorityBasis, 'evidence', 'a section without metadata claimed a reviewed basis');
});

test('a wrong scope is excluded before scoring, and an unplaceable unit stays its own class', async () => {
  const root = await repo();
  await build(root);
  const scoped = JSON.parse((await rank(root, ['--query', 'device checkout retention', '--where', 'jurisdiction=DE'])).stdout);
  assert.equal(scoped.ranked.some((hit) => hit.path === 'handbook/retention-fr.md'), false, 'a French source answered a German question');
  assert.ok(scoped.excluded.some((entry) => entry.reason === 'scope-mismatch'));
  assert.ok(scoped.unknownScope.some((entry) => entry.path === 'handbook/retention-unknown.md'), 'the unplaceable unit was silently dropped');
  assert.deepEqual(scoped.where, { jurisdiction: 'DE' });

  // Without a required dimension the French source is a legitimate hit: nothing is inferred
  // from the query's spelling.
  const open = JSON.parse((await rank(root, ['--query', 'device checkout retention'])).stdout);
  assert.ok(open.ranked.some((hit) => hit.path === 'handbook/retention-fr.md'));
  assert.deepEqual(open.unknownScope, []);
});

test('a CJK question retrieves its section, and an exact id is a plain citation lookup', async () => {
  const root = await repo();
  await build(root);
  const jp = JSON.parse((await rank(root, ['--query', '保管 期間'])).stdout);
  assert.ok(jp.ranked.some((hit) => hit.path === 'handbook/checkout.jp.md'), 'the Japanese section was not retrieved');

  const exact = JSON.parse((await rank(root, ['--query', 'retention.new'])).stdout);
  assert.ok(exact.exact.length > 0, 'the named artifact was not found by exact lookup');
  assert.ok(exact.exact.every((entry) => entry.citation.path === 'handbook/retention-new.md'));
  const byPath = JSON.parse((await rank(root, ['--query', 'handbook/retention-new.md'])).stdout);
  assert.ok(byPath.exact.length > 0, 'a path is not a citation lookup');
});

test('a cited path and anchor can be reopened after assigning an artifact id', async () => {
  const root = await repo();
  await build(root);
  const path = 'handbook/retention-new.md';
  const ref = path + '#retention';
  const ranked = JSON.parse((await rank(root, ['--query', ref])).stdout);
  const expected = ranked.exact[0].citation;
  assert.equal(expected.path, path);
  assert.equal(expected.artifact, 'retention.new#retention');
  const reopened = await why(root, ref);
  assert.equal(reopened.code, 0, reopened.stdout);
  assert.deepEqual(JSON.parse(reopened.stdout).source, expected);
});

test('a scoped limit counts distinct sources and a source name beats incidental mentions', async () => {
  const root = await repo({
    'handbook/a-overview.md': '# Overview\n\n## First\n\nIntegration check status polling.\n\n## Second\n\nIntegration check status polling.',
    'handbook/b-runbook.md': '# Runbook\n\nIntegration check polling.',
    'handbook/integration-check-status.md': '# Integration check-status\n\nPolls the service.',
  });
  await build(root);
  const result = JSON.parse((await rank(root, ['--query', 'integration check status polling', '--limit', '3'])).stdout);
  assert.deepEqual(result.ranked.map(({ path }) => path), [
    'handbook/integration-check-status.md', 'handbook/a-overview.md', 'handbook/b-runbook.md',
  ]);
  assert.equal(result.ranked[0].citation.anchor, 'integration-check-status');
});

test('exact queries obey the same scope and permission constraints as ranked queries', async () => {
  const root = await repo();
  await build(root);
  const path = 'handbook/retention-fr.md';
  const options = ['--query', path, '--where', 'jurisdiction=DE'];
  const result = JSON.parse((await rank(root, options)).stdout);
  assert.deepEqual(result.exact, []);
  assert.ok(result.excluded.some(({ reason }) => reason === 'scope-mismatch'));

  const corpus = { units: [{ path, id: 'private-section', permission: 'private', text: 'detail' }] };
  const restricted = rankCorpus(corpus, { query: 'private-section', permissions: [] });
  assert.deepEqual(restricted.exact, []);
  assert.deepEqual(restricted.ranked, []);
});

test('both time axes answer the historical question, not the newest document', async () => {
  const root = await repo();
  await build(root);
  const then = JSON.parse((await why(root, 'retention.old.v', ['--as-of', '2024-06-01', '--known-at', '2024-06-01'])).stdout);
  assert.equal(then.at.result, 'applicable');
  assert.deepEqual(then.at.claims.map((claim) => claim.id), ['retention.old.v']);
  assert.equal(then.scope, 'handbook');
  assert.equal(then.source.path, 'handbook/retention-old.md');

  const now = JSON.parse((await why(root, 'retention.old.v', ['--as-of', '2025-06-01', '--known-at', '2025-06-01'])).stdout);
  assert.deepEqual(now.at.claims.map((claim) => claim.id), ['retention.new.v']);

  // The new claim declares its evidence, so the lineage walk reaches the old one.
  const lineage = JSON.parse((await why(root, 'retention.new.v')).stdout);
  assert.ok(lineage.lineage.reachable.includes('retention.old.v'), 'the declared evidence edge was not followed');
});

test('a contradiction shows both sides, each with its own source', async () => {
  const rival = `${front({
    id: 'retention.rival',
    scope: { jurisdiction: 'DE' },
    authority: 'reviewed',
    validFrom: '2025-01-01',
    knownAt: '2025-01-02',
  })}# Rival retention\n\nDevice checkout retention is 45 days.\n\n<!-- claim: id=retention.rival.v subject=device-checkout predicate=retention type=number value=45 unit=days status=reviewed -->\n`;
  const root = await repo({ ...FILES, 'handbook/retention-rival.md': rival });
  await build(root);
  const payload = JSON.parse((await why(root, 'retention.new.v')).stdout);
  const finding = payload.conflicts.find((entry) => entry.verdict === 'contradiction');
  assert.ok(finding !== undefined, 'the contradiction was not reported');
  assert.ok(finding.claims.includes('retention.new.v') && finding.claims.includes('retention.rival.v'));
});

test('a section without a reviewed claim is a citation with the way to add one', async () => {
  const root = await repo();
  await build(root);
  const section = await why(root, 'handbook/plain.md#plain');
  assert.equal(section.code, 0, section.stderr);
  const payload = JSON.parse(section.stdout);
  assert.equal(payload.claim, null);
  assert.equal(payload.kind, 'section');
  assert.equal(payload.source.path, 'handbook/plain.md');
  assert.equal(payload.source.authorityBasis, 'evidence');
  assert.match(payload.reason, /no reviewed claim states it/);
  assert.match(payload.addClaim.marker, /<!-- claim: /);
  assert.match(payload.addClaim.remedy, /simt knowledge build --scope handbook --yes/);

  const artifact = JSON.parse((await why(root, 'handbook/plain.md')).stdout);
  assert.equal(artifact.kind, 'artifact');
  assert.equal(artifact.source.path, 'handbook/plain.md');

  const missing = refusal(await why(root, 'no-such-id'));
  assert.match(missing, /no claim or section `no-such-id`/);
  assert.match(missing, /simt knowledge rank --scope handbook/);
});

test('a changed source makes the corpus stale, and the rebuild is the way back', async () => {
  const root = await repo();
  await build(root);
  writeFileSync(join(root, 'handbook/retention-new.md'), `${FILES['handbook/retention-new.md']}\nAn edited line.\n`);
  const stale = refusal(await rank(root, ['--query', 'retention']));
  assert.match(stale, /stale/);
  assert.match(stale, /handbook\/retention-new\.md changed/);
  assert.match(stale, /simt knowledge build --scope handbook --yes/);

  await build(root);
  const fresh = await rank(root, ['--query', 'retention']);
  assert.equal(fresh.code, 0, fresh.stderr);
});

test('an unconfigured repository and an undeclared scope are refused by name', async () => {
  const bare = await repo({ 'README.md': 'a repository that declares no work\n' }, null);
  const unconfigured = refusal(await rank(bare, ['--query', 'retention']));
  assert.match(unconfigured, /declares no work/);
  assert.match(unconfigured, /simt work setup/);

  const root = await repo();
  const undeclared = refusal(await simt(['knowledge', 'rank', '--scope', 'nowhere', '--query', 'retention', '--root', root, '--json']));
  assert.match(undeclared, /`nowhere` is not a declared scope/);
  assert.match(undeclared, /declared scopes are `handbook`/);
});

test('the two input modes are exclusive, and a bad --where names the dimension', async () => {
  const root = await repo();
  await build(root);
  const both = await simt(['knowledge', 'rank', '--scope', 'handbook', '--input', 'units.json', '--query', 'x', '--root', root]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--input or --scope, not both/);
  const bothWhy = await simt(['knowledge', 'why', 'x', '--scope', 'handbook', '--claims', 'claims.json', '--root', root]);
  assert.equal(bothWhy.code, 2);
  assert.match(bothWhy.stderr, /--claims or --scope, not both/);
  const badWhere = refusal(await rank(root, ['--query', 'retention', '--where', 'country=DE']));
  assert.match(badWhere, /not a scope dimension/);
  assert.match(badWhere, /jurisdiction/);
});

test('the explicit-file mode still answers beside a configured scope', async () => {
  const root = await repo();
  await build(root);
  writeFileSync(join(root, 'units.json'), JSON.stringify({ units: [{ id: 'u1', path: 'x.md', text: 'retention', scope: {}, authority: 1 }] }));
  const run = await simt(['knowledge', 'rank', '--input', join(root, 'units.json'), '--query', 'retention', '--root', root, '--json']);
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(payload.ranked.map((hit) => hit.id), ['u1']);
  assert.equal(payload.scope, undefined, 'the file mode grew a scope field');
});

test('a missing answer says why, and the query module reads nothing', async () => {
  const root = await repo();
  await build(root);
  const payload = JSON.parse((await rank(root, ['--query', 'xylophone'])).stdout);
  assert.deepEqual(payload.ranked, []);
  assert.ok(payload.reasons.length > 0, 'an empty answer carried no reason');

  const source = readFileSync(new URL('../src/knowledge/query.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.now|new Date\(\)/);
  const first = rankCorpus({ scope: 's', artifacts: [], units: [] }, { query: 'x' });
  const second = rankCorpus({ scope: 's', artifacts: [], units: [] }, { query: 'x' });
  assert.deepEqual(second, first);
});

test('corpus edges come only from resolved, non-proposed references', () => {
  const artifact = (id, path, sources, authority = 'reviewed') => ({ id, path, type: 'document', authority, declared: true, claims: [], sources });
  const ref = (path, extra = {}) => ({ path, exists: true, anchorFound: true, proposed: false, type: null, ...extra });
  const corpus = {
    artifacts: [
      artifact('a', 'docs/a.md', [ref('docs/b.md'), ref('docs/b.md', { proposed: true }), ref('docs/gone.md', { exists: false })]),
      artifact('b', 'docs/b.md', []),
      artifact('c', 'docs/c.md', [ref('docs/b.md')], 'declared'),
    ],
    units: [],
  };
  const doc = corpusDocument(corpus);
  assert.deepEqual(doc.edges, [
    { from: 'a', to: 'b', kind: 'derived-from', status: 'reviewed' },
    { from: 'c', to: 'b', kind: 'derived-from', status: 'proposed' },
  ]);
  assert.deepEqual(doc.authority, [], 'a corpus invented an authority order');
});
test('the opt-in fielded policy reaches file input, repository rank and scoped briefs', async () => {
  const root = await repo();
  await build(root);
  const selected = ['--retrieval', 'v2'];
  const scoped = await rank(root, ['--query', 'device checkout retention', '--where', 'jurisdiction=DE', ...selected]);
  assert.equal(scoped.code, 0, scoped.stdout);
  const ranked = JSON.parse(scoped.stdout);
  assert.equal(ranked.retrieval, 'v2');
  assert.ok(ranked.ranked.every(({ citation }) => citation.scope.jurisdiction === 'DE'));
  assert.ok(ranked.excluded.every(({ id }) => id === null));

  const brief = await simt(['brief', 'device checkout retention', '--scope', 'handbook', '--root', root, ...selected, '--json']);
  assert.equal(brief.code, 0, brief.stdout);
  const packet = JSON.parse(brief.stdout);
  assert.equal(packet.retrieval, 'v2');
  assert.ok(packet.proof.citations.some(({ id }) => id === 'handbook/retention-new.md'));

  const input = join(root, 'input.json');
  writeFileSync(input, JSON.stringify({
    permissionsHeld: [],
    units: [
      { id: 'secret', text: 'privileged retention', permission: 'restricted' },
      { id: 'public', label: 'Retention', text: 'public guidance' },
    ],
  }));
  const args = ['knowledge', 'rank', '--input', input, '--query', 'retention', '--json'];
  const plain = JSON.parse((await simt(args)).stdout);
  const fielded = JSON.parse((await simt([...args, ...selected])).stdout);
  assert.equal(plain.retrieval, undefined);
  assert.equal(fielded.retrieval, 'v2');
  assert.equal(fielded.schemaVersion, plain.schemaVersion);
  assert.deepEqual(fielded.ranked.map(({ id }) => id), ['public']);
  assert.deepEqual(fielded.excluded, [{ id: null, reason: 'permission' }]);
  assert.match(refusal(await simt([...args, '--retrieval', 'future'])), /unknown retrieval mode/);
});
