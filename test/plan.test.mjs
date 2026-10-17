import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { loadPlanState, planNext } from '../src/plan/index.mjs';
import { CLI } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt-dev.mjs');
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-tracker-'));
  made.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

const WAVE = `# review

## 9. Order of work

| Wave | Slices | Exit criterion |
| --- | --- | --- |
| **0: stop the bleeding** | S08, S24, S10, S01 (+ S20 pack-install test) | packed install |

## 3. Tracker

| ID | Slice | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- |
| S08 | restage | — | Queued | |
| S24 | sync writes | S08 | Queued | |
| S10 | contract | — | Complete | abc |
| S01 | provenance | — | Accepted | |

### S08 — restage

**Finding.** the restage bug

**Fix.** stage the index only

**Accept.** a partial stage is refused

### S24 — sync writes

**Finding.** sync wrote the file

### S10 — contract

**Finding.** flags disagreed
`;

test('a document without a tracker is not an index', async () => {
  const state = await loadPlanState(ROOT);
  const names = state.docs.map((doc) => doc.name);
  assert.ok(names.includes('0002-simt-dev-cli.md'));
  assert.ok(names.includes('0003-intelligence-amplifier-research-plan.md'));
  assert.ok(names.includes('0002-full-review-adoption-and-public-release.md'));
  assert.ok(!names.includes('0001-centralise-agent-rules.md'));
  assert.ok(!names.includes('0001-release-readiness-review.md'));
});

test('a wave dependency resolves through the other document', async () => {
  const state = await loadPlanState(ROOT);
  const r01 = state.slices.find((slice) => slice.id === 'R01');
  assert.ok(r01);
  assert.deepEqual(r01.resolvedDeps.map((dep) => dep.id), ['S08', 'S24', 'S10', 'S01', 'S29', 'S27', 'S23', 'S05']);
  assert.deepEqual(r01.unknownDeps, []);
  assert.ok(r01.resolvedDeps.every((dep) => dep.doc.startsWith('0002-full-review')));

  const r12 = state.slices.find((slice) => slice.id === 'R12');
  assert.deepEqual(r12.resolvedDeps.map((dep) => dep.id), ['S41', 'S50']);
  assert.deepEqual(r12.unknownDeps, []);
});

test('plan next on a review returns the wave 0 slice and only its section', async () => {
  const root = await repo({ 'docs/reviews/0002-review.md': WAVE });
  const result = cli(['plan', 'next', '--root', root]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /slice\s+S08/);
  assert.match(result.stdout, /state\s+queued/);
  assert.match(result.stdout, /the restage bug/);
  assert.equal(result.stdout.includes('sync wrote the file'), false);
  assert.equal(result.stdout.includes('flags disagreed'), false);

  const named = cli(['plan', 'next', 'S24', '--root', root]);
  assert.match(named.stdout, /slice\s+S24/);
  assert.match(named.stdout, /sync wrote the file/);
  assert.equal(named.stdout.includes('the restage bug'), false);
});

test('an accepted dependency does not unblock, and a note is not a dependency', async () => {
  const root = await repo({
    'docs/plans/0099.md': `# t

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| A1 | first | — | Accepted |
| A2 | second | A1 | Queued |
| A3 | third | A2 (optional) | Queued |
| A4 | fourth | — | Queued |

### A4 — fourth

**Accept.** ready
`,
  });
  const state = await loadPlanState(root);
  assert.equal(state.slices.find((slice) => slice.id === 'A2').ready, false);
  assert.deepEqual(state.slices.find((slice) => slice.id === 'A3').resolvedDeps.map((dep) => dep.id), ['A2']);
  const result = cli(['plan', 'next', '--root', root]);
  assert.match(result.stdout, /slice\s+A4/);
  assert.equal(result.stdout.includes('### A2'), false);
});

test('plan status counts by document', async () => {
  const result = cli(['plan', 'status', '--root', ROOT]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /0003-intelligence-amplifier-research-plan\.md/);
  assert.match(result.stdout, /ready\s+\d+/);
  const json = cli(['plan', 'status', '--json', '--root', ROOT]);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  assert.ok(payload.ready > 0);
});

test('plan next on this repository returns one section, not the document', async () => {
  const result = cli(['plan', 'next', '--json', '--root', ROOT]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.next.state, 'queued');
  assert.match(payload.next.section, new RegExp(`^#{1,3}[^\\n]*\\b${payload.next.id}\\b`));
  const file = await readFile(payload.next.path, 'utf8');
  assert.ok(payload.next.sectionBytes < Buffer.byteLength(file));
  assert.equal(payload.next.sectionBytes, Buffer.byteLength(payload.next.section));
});

test('a later section is not copied into the index', async () => {
  const blob = `BLOB ${'x'.repeat(200_000)}`;
  const root = await repo({
    'docs/plans/0099.md': `# t

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| A1 | one | — | Queued |
| A2 | two | — | Queued |

### A1 — one

short

### A2 — two

${blob}
`,
  });
  const started = performance.now();
  const result = await planNext(root);
  const elapsed = performance.now() - started;
  assert.equal(result.next.id, 'A1');
  assert.equal(result.next.section.includes('BLOB'), false);
  assert.ok(elapsed < 500, `plan next took ${elapsed}ms`);
});

test('plan done rewrites one row and records evidence where the tracker has a column', async () => {
  const root = await repo({
    'docs/plans/0099.md': `# t

## Tracker

| ID | Slice | Phase | Depends on | Size | Needs ADR | Success metric | State |
| --- | --- | --- | --- | --- | --- | --- | --- |
| X01 | First | 1 | — | S | — | runs | Queued |
| X02 | Second | 1 | X01 | S | — | — | Queued |
`,
    'docs/reviews/0002-r.md': `# r

| ID | Slice | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- |
| Y01 | one | — | Queued | |
| Y02 | two | Y01 | **Queued** (held) | note |
`,
  });
  const plan = join(root, 'docs', 'plans', '0099.md');
  const before = await readFile(plan, 'utf8');
  const done = cli(['plan', 'done', 'X01', 'abcdef1234', '--root', root, '--yes', '--test', 'npm test']);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /changed\s+yes/);
  assert.match(done.stdout, /no evidence column/);
  const after = await readFile(plan, 'utf8');
  const changed = before.split('\n').flatMap((line, index) => (line === after.split('\n')[index] ? [] : [index]));
  assert.deepEqual(changed, [6]);
  assert.equal(after.split('\n')[6], '| X01 | First | 1 | — | S | — | runs | Complete |');

  const again = cli(['plan', 'done', 'X01', 'abcdef1234', '--root', root, '--yes', '--test', 'npm test']);
  assert.match(again.stdout, /changed\s+no/);
  assert.equal(await readFile(plan, 'utf8'), after);

  const review = join(root, 'docs', 'reviews', '0002-r.md');
  const marked = cli(['plan', 'done', 'Y02', '1234abcd', '--root', root, '--yes', '--test', 'npm test']);
  assert.equal(marked.code, 0, marked.stderr);
  assert.match(marked.stdout, /evidence 1234abcd/);
  const reviewText = await readFile(review, 'utf8');
  assert.match(reviewText, /\| Y02 \| two \| Y01 \| \*\*Complete\*\* \(held\) \| note — 1234abcd · test: npm test \|/);
  assert.match(reviewText, /\| Y01 \| one \| — \| Queued \|/);
});

test('plan done previews unless told to write, and a bad cell is refused', async () => {
  const body = `# t

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| Z01 | only | — | Queued |
`;
  const root = await repo({ 'docs/plans/0099.md': body });
  const path = join(root, 'docs', 'plans', '0099.md');
  const preview = cli(['plan', 'done', 'Z01', 'deadbeef', '--root', root, '--test', 'npm test']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /dry-run/);
  assert.match(preview.stdout, /would\s+Queued -> Complete/);
  assert.equal(await readFile(path, 'utf8'), body);

  const both = cli(['plan', 'done', 'Z01', '--root', root, '--yes', '--dry-run']);
  assert.match(both.stdout, /dry-run/);
  assert.equal(await readFile(path, 'utf8'), body);

  const piped = cli(['plan', 'done', 'Z01', '--root', root, '--yes', '--test', 'npm test | cat']);
  assert.notEqual(piped.code, 0);
  assert.match(piped.stderr, /pipe or a newline/);
  assert.equal(await readFile(path, 'utf8'), body);

  const unknown = cli(['plan', 'done', 'nope', '--root', root, '--yes']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /no tracked slice named nope/);

  const state = cli(['plan', 'done', 'Z01', '--root', root, '--yes', '--state', 'Ship it']);
  assert.notEqual(state.code, 0);
  assert.match(state.stderr, /unknown state/);
  assert.equal(await readFile(path, 'utf8'), body);
});

test('the same id in two documents is not a guess', async () => {
  const root = await repo({
    'docs/plans/0001.md': `# a

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| A1 | one | — | Queued |
`,
    'docs/reviews/0002.md': `# b

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| A1 | one | — | Queued |
`,
  });
  const result = cli(['plan', 'done', 'A1', '--root', root, '--yes']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /appears in 2 documents/);
  assert.match(await readFile(join(root, 'docs', 'plans', '0001.md'), 'utf8'), /Queued/);
});

test('mcp exposes the same two calls, and plan_done does not write', async () => {
  const { TOOLS } = await import('../src/mcp/tools.mjs');
  const names = TOOLS.map((tool) => tool.name);
  assert.ok(names.includes('plan_next'));
  assert.ok(names.includes('plan_done'));
  const done = TOOLS.find((tool) => tool.name === 'plan_done');
  const root = await repo({
    'docs/plans/0099.md': `# t

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| Z01 | only | — | Queued |
`,
  });
  const path = join(root, 'docs', 'plans', '0099.md');
  const before = await readFile(path, 'utf8');
  const preview = await done.run({ root, id: 'Z01', sha: 'abc' });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wouldChange, true);
  assert.match(preview.remedy, new RegExp(`${CLI} plan done Z01 abc --yes`));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('the delivered template is what a repository gets', async () => {
  const file = JSON.parse(await readFile(join(ROOT, 'templates', 'plan', 'tracker.json'), 'utf8'));
  const state = await loadPlanState(ROOT);
  assert.equal(state.error, undefined);
  assert.equal(state.format.name, file.name);
  assert.deepEqual(state.format.directories.map((dir) => dir.path), file.directories.map((dir) => dir.path));
  const help = cli(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /simt\.json key plans/);
  assert.match(help.stdout, /tracker/);
  for (const dir of file.directories) assert.match(help.stdout, new RegExp(dir.path.replaceAll('/', '\\/')));
});

test('the plans key moves the directories and keeps the delivered columns', async () => {
  const root = await repo({
    'simt.json': `${JSON.stringify({
      plans: {
        directories: [
          { kind: 'plans', path: 'planning' },
          { kind: 'reviews', path: 'notes' },
        ],
      },
    })}\n`,
    'docs/plans/0001.md': '| ID | State |\n| --- | --- |\n| Z9 | Queued |\n',
    'planning/0004.md': `# p

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| A1 | one | review 2 S1 | Queued |
`,
    'notes/0002-r.md': `# r

| ID | Slice | Depends on | State |
| --- | --- | --- | --- |
| S1 | other | — | Complete |
`,
  });
  const state = await loadPlanState(root);
  assert.equal(state.format.name, 'tracker');
  assert.deepEqual(state.slices.map((slice) => slice.id).sort(), ['A1', 'S1']);
  assert.equal(state.slices.find((slice) => slice.id === 'A1').ready, true);
  assert.equal(state.slices.some((slice) => slice.id === 'Z9'), false);
});

test('a legacy manifest carries the plans key the same way', async () => {
  const root = await repo({
    'simt-dev.json': `${JSON.stringify({
      plans: {
        directories: [
          { kind: 'plans', path: 'planning' },
          { kind: 'reviews', path: 'notes' },
        ],
      },
    })}\n`,
    'planning/0001.md': '| ID | State |\n| --- | --- |\n| A1 | Queued |\n',
    'docs/plans/0001.md': '| ID | State |\n| --- | --- |\n| Z9 | Queued |\n',
  });
  const state = await loadPlanState(root);
  assert.equal(state.format.name, 'tracker');
  assert.deepEqual(state.slices.map((slice) => slice.id), ['A1']);
});

test('a template replaces the columns, the states and the reference words', async () => {
  const root = await repo({
    'simt.json': `${JSON.stringify({
      plans: {
        name: 'acme',
        directories: [
          { kind: 'plans', word: 'rfc', path: 'notes/rfcs' },
          { kind: 'reviews', word: 'review', path: 'notes/reviews' },
        ],
        id: { pattern: '^FEATURE-[0-9]+$', headers: ['task'] },
        columns: {
          state: ['progress'],
          depends: ['blocked by'],
          title: ['title'],
          evidence: ['proof'],
        },
        states: [
          { id: 'waiting', write: 'Waiting', read: ['waiting'] },
          { id: 'shipped', write: 'Shipped', read: ['shipped'], satisfies: true },
        ],
        ready: 'waiting',
        dependency: { group: '^phases?\\s+(.+)$' },
        wave: { label: ['phase'], members: ['items'] },
      },
    })}\n`,
    'docs/plans/0001.md': '| ID | State |\n| --- | --- |\n| Z9 | Queued |\n',
    'notes/rfcs/0007-one.md': `# rfc

| Phase | Items |
| --- | --- |
| **1: first** | FEATURE-1

| Task | Title | Blocked by | Progress | Proof |
| --- | --- | --- | --- | --- |
| FEATURE-1 | alpha | — | Waiting | |
| FEATURE-2 | beta | rfc 7 phase 1 | Waiting | |
`,
  });
  const next = await planNext(root);
  assert.equal(next.next.id, 'FEATURE-1');
  const done = cli(['plan', 'done', 'FEATURE-1', 'abc', '--test', 'npm test', '--root', root, '--yes']);
  assert.equal(done.code, 0, done.stderr);
  const text = await readFile(join(root, 'notes', 'rfcs', '0007-one.md'), 'utf8');
  assert.match(text, /\| FEATURE-1 \| alpha \| — \| Shipped \| abc · test: npm test \|/);
  assert.match(text, /\| FEATURE-2 \| beta \| rfc 7 phase 1 \| Waiting \|/);
  const after = await planNext(root);
  assert.equal(after.next.id, 'FEATURE-2');
});

test('a plans key that cannot be read is not silently the default', async () => {
  const broken = await repo({
    'simt.json': '{',
    'docs/plans/0001.md': '| ID | State |\n| --- | --- |\n| Z9 | Queued |\n',
  });
  const invalid = cli(['plan', 'status', '--root', broken]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /simt\.json/);
  assert.match(invalid.stderr, /fix simt\.json so it parses/);
  assert.doesNotMatch(invalid.stdout, /Z9/);

  const outside = await repo({
    'simt.json': `${JSON.stringify({
      plans: {
        directories: [
          { kind: 'plans', path: '../plans' },
          { kind: 'reviews', path: 'docs/reviews' },
        ],
      },
    })}\n`,
  });
  const escaped = cli(['plan', 'next', '--root', outside]);
  assert.notEqual(escaped.code, 0);
  assert.match(escaped.stderr, /inside the repository/);
  assert.match(escaped.stderr, /plans key in simt\.json/);

  const pattern = await repo({
    'simt.json': `${JSON.stringify({ plans: { id: { pattern: '(' } } })}\n`,
  });
  const badPattern = cli(['plan', 'status', '--root', pattern]);
  assert.notEqual(badPattern.code, 0);
  assert.match(badPattern.stderr, /id\.pattern/);
});
