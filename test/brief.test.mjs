// The task brief (R27).
//
// A packet is a function of the tree, the task text and the index: no clock, no locale,
// no network, no environment. These tests hold it to that, because the property that
// makes a packet reviewable is that the same input gives the same bytes — and the
// property that makes it usable is that it fits the ceiling and names what it cut.
//
// They run the real binary rather than the function, because what a reader gets is the
// binary's stdout: the one compact JSON line, the exit code, the packet as printed.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLI } from '../src/name.mjs';
import { assembleBrief } from '../src/brief/assemble.mjs';
import { reindex } from '../src/index/store.mjs';
import { git } from './fixture.mjs';
import { simt as simtCli } from './fixture.mjs';


const run = (root, args) => simtCli([...args, '--root', root], { maxBuffer: 8 << 20 });

/** A repository with one source file, one test that imports it, and a test script. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await writeFile(
    join(root, 'test', 'keep.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\n\ntest('keep', () => assert.equal(keep(1), 1));\n",
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('a task that names a file produces its kind, its file and its test', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  assert.equal(code, 0);
  assert.match(stdout, /^TASK\n/);
  assert.ok(stdout.includes('kind bugfix'), stdout);
  assert.ok(stdout.includes('src/keep.mjs'), stdout);
  assert.ok(stdout.includes('src/keep.mjs -> test/keep.test.mjs'), stdout);
  assert.ok(stdout.includes('npm run test'), stdout);
});

test('--proof attaches the proof summary and the default packet is unchanged (A39)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const plain = await run(root, ['brief', 'fix the keep helper', '--json']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal('proof' in JSON.parse(plain.stdout), false, 'the default packet gained a field');

  const proofed = await run(root, ['brief', 'fix the keep helper', '--json', '--proof']);
  assert.equal(proofed.code, 0, proofed.stderr);
  const doc = JSON.parse(proofed.stdout);
  assert.equal(typeof doc.proof.complete, 'boolean');
  assert.ok(Array.isArray(doc.proof.omittedObligations));
});

test('a stale index warns the packet instead of quoting yesterday (Q42)', async (t) => {
  // The delivered packet may not rebuild the index, so it says it is old.
  // Removing README after the build makes the stored tree older than the
  // worktree; the packet keeps its files and carries the caution.
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await reindex(root);
  await git(['-C', root, 'rm', '-q', 'README.md']);
  await git(['-C', root, 'commit', '-qm', 'drop readme']);
  const packet = await assembleBrief({ root, task: 'fix the keep helper', build: false, federate: false });
  assert.equal(packet.cold, undefined);
  const cautions = (packet.items ?? []).filter((item) => item.section === 'CAUTIONS').map((item) => item.text);
  assert.ok(
    cautions.some((text) => text.includes('the index predates the current tree')),
    `no staleness caution in: ${JSON.stringify(cautions)}`,
  );
});

test("a decision's command token resolves against the registry, not the tool's shell card (Q52)", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-001-keep.md'),
    '# ADR-001 — keep stays\n\nAffects: `src/keep.mjs`, `simt init`\n\nStatus: accepted\n',
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'record decision']);

  const cautionsOf = (packet) =>
    (packet.items ?? []).filter((item) => item.section === 'CAUTIONS').map((item) => item.text);
  const known = await assembleBrief({
    root,
    task: 'fix the keep helper in src/keep.mjs',
    federate: false,
    commands: ['init'],
  });
  assert.ok(
    !cautionsOf(known).some((text) => text.includes('nothing resolves')),
    `a command the tool has was reported unresolved: ${JSON.stringify(cautionsOf(known))}`,
  );

  // The same packet without the registry reports it, which is what made the token a
  // false caution rather than a fact about the decision.
  const blind = await assembleBrief({
    root,
    task: 'fix the keep helper in src/keep.mjs',
    federate: false,
    commands: [],
  });
  assert.ok(cautionsOf(blind).some((text) => text.includes('simt init')), JSON.stringify(cautionsOf(blind)));
});

test('a generated-region caution names a file with a region, not a file that quotes the marker (Q52)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.md'), 'The marker `simt:begin` appears in prose only.\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'notes']);

  const quoted = await assembleBrief({
    root,
    task: 'fix the keep helper in src/keep.mjs',
    federate: false,
  });
  const quotes = (quoted.items ?? []).filter((item) => item.text.startsWith('generated — edit the source'));
  assert.equal(quotes.length, 0, `prose quoting the marker was reported as generated: ${JSON.stringify(quotes)}`);

  await writeFile(
    join(root, 'AGENTS.md'),
    '# Rules\n\n<!-- simt:begin -->\n<!-- simt:generated -->\ngenerated body\n<!-- simt:end -->\n',
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'region']);
  const carrying = await assembleBrief({
    root,
    task: 'fix the keep helper in src/keep.mjs',
    federate: false,
  });
  const named = (carrying.items ?? []).filter((item) => item.text.startsWith('generated — edit the source'));
  assert.equal(named.length, 1);
  assert.match(named[0].text, /AGENTS\.md/);
  assert.doesNotMatch(named[0].text, /notes\.md/);
});

test('two runs of the same brief are the same bytes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  const second = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  assert.equal(first.code, 0);
  assert.equal(second.stdout, first.stdout);
});

test('a packet that had to shrink fits its ceiling and says what it cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const whole = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--budget', '300']);
  assert.equal(code, 0);
  assert.ok(Buffer.byteLength(stdout.trimEnd()) <= 300, `${Buffer.byteLength(stdout.trimEnd())} bytes`);
  assert.ok(Buffer.byteLength(stdout) < Buffer.byteLength(whole.stdout), 'the ceiling did nothing');
  assert.match(stdout, /cut \d+ of \d+ items to fit 300: .+/);
  // What a reader cannot recover from a wrong guess is never the thing that goes.
  assert.ok(stdout.includes('npm run test'), stdout);
});

test('a budget of 0 is the whole packet, and nothing is cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--budget', '0']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('cut '), stdout);
});

test('--explain names every item and why it was kept or cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, [
    'brief',
    'fix the keep helper in src/keep.mjs',
    '--budget',
    '300',
    '--explain',
  ]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('\nEXPLAIN\n'), stdout);
  assert.match(stdout, /keep TASK 1\/3 worth 8: kind bugfix/);
  assert.match(stdout, /cut \w+ \d+\/\d+ worth \d+: /);
  assert.match(stdout, /\n     the kind chooses the commands/);
});

test('--json is one compact document and carries the packet it names', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--json']);
  assert.equal(code, 0);
  assert.equal(stdout.trim().split('\n').length, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, 'bugfix');
  assert.equal(payload.bytes, Buffer.byteLength(payload.text));
  assert.ok(payload.sections.FILES.length > 0, stdout);
  assert.ok(payload.sections.FILES.some((line) => line.includes('src/keep.mjs')), stdout);
  assert.ok(payload.text.startsWith('TASK\n'));
});

test('the kind chooses the commands, so a docs task is not offered a build', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'improve the wording of the README', '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.kind, 'docs');
  assert.ok(payload.sections.COMMANDS.length > 0, stdout);
  assert.ok(!payload.sections.COMMANDS.some((line) => line.includes('build')), stdout);
});

test(`the brief refuses two tasks and a budget that is not a number`, async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const two = await run(root, ['brief', 'one', 'two']);
  assert.equal(two.code, 2);
  assert.match(two.stderr, new RegExp(`run: ${CLI} brief`, 'u'));
  const bad = await run(root, ['brief', 'one', '--budget', 'not-a-number']);
  assert.equal(bad.code, 2);
});

// --- the knowledge pointer ----------------------------------------------------
//
// The section is a pointer, not an index: the directory, the cheat sheet, and one
// usage line per door the repository authored. It reads no claim, so a claim id in
// the files never crosses into the packet, and a repository without the directory
// keeps the packet it had before the section existed.

/** The six conventional inputs, each shaped for the door that reads it. */
const KNOWLEDGE_INPUTS = {
  'claims.json': { claims: [{ id: 'claim:only-in-the-file', subject: 's', predicate: 'p', value: 'v' }] },
  'units.json': { units: [] },
  'debt.json': { items: [] },
  'impact.json': { graph: { nodes: [{ id: 'n1' }], edges: [] }, change: { refs: ['n1'] } },
  'derivations.json': { receipts: [] },
  'export.json': { schema: 'simt.bundle/1', version: 1, facts: [] },
};

/** Author knowledge inputs under `.simt/knowledge/`, committed so the tree is clean. */
async function knowledgeFixture(root, { readme = true, files = Object.keys(KNOWLEDGE_INPUTS) } = {}) {
  const dir = join(root, '.simt', 'knowledge');
  await mkdir(dir, { recursive: true });
  if (readme) await writeFile(join(dir, 'README.md'), '# knowledge\n');
  for (const name of files) {
    await writeFile(join(dir, name), JSON.stringify(KNOWLEDGE_INPUTS[name], null, 2));
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'knowledge inputs']);
}

const knowledgeLines = (packet) =>
  (packet.items ?? []).filter((item) => item.section === 'KNOWLEDGE').map((item) => item.text);

test('a repository with knowledge inputs gets a pointer section and no claim ids (K3)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await knowledgeFixture(root);

  const packet = await assembleBrief({ root, task: 'fix the keep helper', budget: 0, federate: false });
  const lines = knowledgeLines(packet);

  // The directory line, the README line, and one usage line per door.
  assert.ok(
    lines.some((line) => line.includes('.simt/knowledge/') && !line.includes('README')),
    JSON.stringify(lines),
  );
  assert.ok(lines.some((line) => line.includes('.simt/knowledge/README.md')), JSON.stringify(lines));
  for (const door of ['why', 'rank', 'debt', 'impact', 'derivations', 'import']) {
    assert.ok(
      lines.some((line) => line.startsWith(`${door}: `)),
      `no ${door} usage line in ${JSON.stringify(lines)}`,
    );
  }
  // Pointer only: the claim id in claims.json is not enumerated.
  assert.ok(!lines.join('\n').includes('claim:only-in-the-file'), 'the pointer enumerated a claim');
});

test('a repository without the knowledge directory has no KNOWLEDGE section (K3)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const packet = await assembleBrief({ root, task: 'fix the keep helper', budget: 0, federate: false });
  assert.deepEqual(knowledgeLines(packet), []);
  assert.equal(packet.sections.KNOWLEDGE, undefined);
});

test('the pointer offers only the doors and README the repository authored (K3)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await knowledgeFixture(root, { readme: false, files: ['claims.json'] });

  const lines = knowledgeLines(
    await assembleBrief({ root, task: 'fix the keep helper', budget: 0, federate: false }),
  );
  assert.ok(lines.some((line) => line.startsWith('why: ')), JSON.stringify(lines));
  assert.ok(!lines.some((line) => line.startsWith('rank: ')), JSON.stringify(lines));
  assert.ok(!lines.some((line) => line.includes('README.md')), JSON.stringify(lines));
});

test('the printed brief carries the KNOWLEDGE heading only when the directory exists (K3)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bare = await run(root, ['brief', 'fix the keep helper', '--budget', '0']);
  assert.equal(bare.code, 0);
  assert.doesNotMatch(bare.stdout, /\nKNOWLEDGE\n/);

  await knowledgeFixture(root);
  const pointed = await run(root, ['brief', 'fix the keep helper', '--budget', '0']);
  assert.equal(pointed.code, 0);
  assert.match(pointed.stdout, /\nKNOWLEDGE\n/);
  assert.match(pointed.stdout, /\.simt\/knowledge\/README\.md/);
  assert.match(pointed.stdout, /simt knowledge rank --input \.simt\/knowledge\/units\.json/);
});

/** A fixture whose tree also authored knowledge inputs under `.simt/knowledge/`. */
async function withKnowledge(files) {
  const root = await fixture();
  const dir = join(root, '.simt', 'knowledge');
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'knowledge inputs']);
  return root;
}

test('a tree with knowledge inputs gains a pointer to the directory, the README and the doors (K3)', async (t) => {
  const root = await withKnowledge({
    'README.md': '# knowledge\n\nThe cheat sheet.\n',
    'claims.json': { claims: [{ id: 'claim:secret-123', subject: 's', predicate: 'p', value: 'v' }] },
    'units.json': { units: [{ id: 'u1', path: 'src/keep.mjs', text: 't' }] },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  // `--budget 0` keeps the whole packet, so the pointer is never the thing the
  // ceiling happened to cut.
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--json', '--budget', '0']);
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  const lines = payload.sections.KNOWLEDGE ?? [];

  assert.ok(lines.some((line) => line.includes('.simt/knowledge/')), stdout);
  assert.ok(lines.some((line) => line.includes('.simt/knowledge/README.md')), stdout);
  assert.ok(lines.some((line) => line.startsWith('why:') && line.includes('claims.json')), stdout);
  assert.ok(lines.some((line) => line.startsWith('rank:') && line.includes('units.json')), stdout);
  // A door whose input is absent is not offered: the pointer never names a file
  // the repository has not authored.
  assert.ok(!lines.some((line) => line.startsWith('debt:')), stdout);
  // Pointer only: a claim id in the file never reaches the packet.
  assert.ok(!stdout.includes('claim:secret-123'), 'the packet enumerated a claim');
});

test('a tree without knowledge inputs gains no KNOWLEDGE section (K3)', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--json']);
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  assert.equal('KNOWLEDGE' in payload.sections, false, 'the section appeared without inputs');
  assert.doesNotMatch(stdout, /KNOWLEDGE/);

  // The printed packet carries no empty heading either: a section with nothing is
  // absent, not a blank line.
  const printed = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  assert.doesNotMatch(printed.stdout, /\nKNOWLEDGE\n/);
});
