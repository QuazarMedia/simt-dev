// The inferability filter (plan 0003 R09): a rule line the repository already proves does
// not ship, and every removal is visible to the author who asked for it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { desiredRegion, loadRules } from '../src/projection/rules.mjs';
import { buildManifest } from '../src/projection/manifest.mjs';
import { CARD_VERBS } from '../src/kernel/card.mjs';
import { filterInferable, inferableDefect, parseInferable } from '../src/kernel/inferability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

const MARKED = '- Use the wrapper that is in the repository.';
const KEEP = '- Never vendor a dependency.';

/**
 * A local profile whose marked line is the one under test. The line's evidence is a
 * parameter because that is the whole of the mechanism: the same line leaves or stays
 * depending on what the repository commits.
 */
function profile(marker, priority = 'convention', marked = MARKED) {
  return `---
simt-id: house
simt-title: House
simt-applies: [has-go-mod]
simt-priority: ${priority}
---

# House

${marked} <!-- simt-inferable-when: ${marker} -->

${KEEP}
`;
}

/** A Go repository: `go.mod` proves `has-go-mod`, and its card names build/test/lint/format. */
async function goRepo(marker, { priority = 'convention', marked = MARKED, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-inferable-'));
  await mkdir(join(root, '.simt-dev', 'profiles'), { recursive: true });
  await writeFile(join(root, 'go.mod'), 'module example\n');
  if (marker !== null) {
    await writeFile(join(root, '.simt-dev', 'profiles', 'house.md'), profile(marker, priority, marked));
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

async function declare(root, extra) {
  const base = buildManifest({ root, stack: ['go'], sha: 'abc1234', version: '0.2.1' });
  await writeFile(join(root, 'simt.json'), JSON.stringify({ ...base, ...extra }, null, 2));
}

async function cli(args) {
  try {
    const { stdout } = await exec(process.execPath, [BIN, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, text: stdout };
  } catch (err) {
    return { code: err.code ?? 1, text: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a line the repository already proves leaves the region', async () => {
  const root = await goRepo('card:lint');
  const desired = await desiredRegion(root, {});
  assert.ok(!desired.body.includes(MARKED));
  assert.deepEqual(desired.inferable.map((x) => x.expr), ['card:lint']);
  assert.equal(desired.inferable[0].rule, 'house');
});

test('the marker never reaches the reader, whether or not its line is dropped', async () => {
  const root = await goRepo('card:typecheck');
  const desired = await desiredRegion(root, {});
  // Go has no typecheck verb, so nothing proves this claim and the line stays.
  assert.ok(desired.body.includes(MARKED));
  assert.ok(!desired.body.includes('simt-inferable-when'));
  assert.deepEqual(desired.inferable, []);
});

test('the lines nobody marked are untouched', async () => {
  const root = await goRepo('card:lint');
  const desired = await desiredRegion(root, {});
  assert.ok(desired.body.includes(KEEP));
});

test('a conjunction drops only when every term holds', async () => {
  const both = await goRepo('has-go-mod + card:lint');
  assert.ok(!(await desiredRegion(both, {})).body.includes(MARKED));

  const half = await goRepo('has-go-mod + has-cargo-toml');
  assert.ok((await desiredRegion(half, {})).body.includes(MARKED));
});

test('a fact the repository proves by its files is enough on its own', async () => {
  const root = await goRepo('has-go-mod');
  assert.ok(!(await desiredRegion(root, {})).body.includes(MARKED));
});

test('a declared gate is evidence too', async () => {
  const root = await goRepo('gate:lint');
  await declare(root, { gates: { preCommit: ['lint'], prePush: [], commands: {} } });
  const desired = await desiredRegion(root, {});
  assert.ok(!desired.body.includes(MARKED));
  assert.deepEqual(desired.inferable.map((x) => x.expr), ['gate:lint']);
});

test('a marked block leaves whole, not one wrapped line of it', async () => {
  const wrapped = `- Use the wrapper that is in the repository, because it names the
  version the build was tested with.`;
  const root = await goRepo('card:lint', { marked: wrapped });
  const desired = await desiredRegion(root, {});
  assert.ok(!desired.body.includes('Use the wrapper'));
  assert.ok(!desired.body.includes('version the build was tested with'));
});

test('the filter is about this repository\u2019s evidence, not about the mode', async () => {
  const root = await goRepo('card:lint', { priority: 'hard' });
  await declare(root, { mode: 'kernel' });
  const desired = await desiredRegion(root, {});
  assert.equal(desired.mode, 'kernel');
  // `hard` is packed by the kernel, so the rule is in the region — and the line is gone
  // because it is inferable, not because the mode set it aside.
  assert.ok(desired.body.includes(KEEP));
  assert.ok(!desired.body.includes(MARKED));
});

test('a term the tool cannot check is a defect, not an unproved claim', async () => {
  const root = await goRepo('has-cargo-tooml');
  const house = (await loadRules(root)).find((r) => r.id === 'house');
  assert.match(house.error, /has-cargo-tooml/);
  // A defect never drops content: a typo must not silently shorten the projection.
  assert.ok((await desiredRegion(root, {})).body.includes(MARKED));
});

test('check reports the defect, so a repository learns about it without a projection', async () => {
  const root = await goRepo('gate:lintt');
  const { text } = await cli(['check', '--json', '--root', root]);
  const payload = JSON.parse(text);
  const invalid = payload.findings.filter((f) => f.status === 'invalid');
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].detail, /gate:lintt/);
  assert.match(invalid[0].file, /house\.md$/);
});

test('two markers on one block are a broken rule, not two claims', () => {
  const body = `- One line. <!-- simt-inferable-when: has-go-mod --> <!-- simt-inferable-when: card:test -->`;
  assert.match(inferableDefect(body), /more than one/);
});

test('the vocabulary is closed: an unknown verb and an unknown gate are both defects', () => {
  assert.match(inferableDefect('x <!-- simt-inferable-when: card:publish -->'), /card:publish/);
  assert.match(inferableDefect('x <!-- simt-inferable-when: gate:lintt -->'), /gate:lintt/);
  assert.match(inferableDefect('x <!-- simt-inferable-when: -->'), /names no evidence/);
  assert.equal(inferableDefect(`x <!-- simt-inferable-when: card:${CARD_VERBS[0]} -->`), null);
  assert.deepEqual(parseInferable('has-go-mod + card:lint'), ['has-go-mod', 'card:lint']);
});

test('a body with no marker is returned by identity, so no repository diffs for nothing', () => {
  const body = `# House\n\n${MARKED}\n\n${KEEP}\n`;
  const filtered = filterInferable(body, new Set(['has-go-mod', 'card:lint']));
  assert.equal(filtered.changed, false);
  assert.equal(filtered.body, body);
  assert.deepEqual(filtered.removed, []);
});

test('two renders of the same repository are byte-identical', async () => {
  const root = await goRepo('card:lint');
  const first = await desiredRegion(root, {});
  const second = await desiredRegion(root, {});
  assert.equal(first.body, second.body);
});

test('the removal is reported by default, and --explain names it and its evidence', async () => {
  const root = await goRepo('card:test');
  const quiet = await desiredRegion(root, {});
  assert.ok(quiet.notes.some((n) => n.startsWith('inferability: dropped 1 line(s)')));
  assert.ok(!quiet.notes.some((n) => n.startsWith('inferable:')));

  const loud = await desiredRegion(root, { explain: true });
  assert.ok(
    loud.notes.includes(
      `inferable: house dropped "${MARKED}" \u2014 proved by card:test`,
    ),
  );
});

test('sync prints the explanation, because a flag that changes nothing is a defect', async () => {
  const root = await goRepo('card:lint');
  const quiet = await cli(['sync', '--root', root]);
  assert.ok(quiet.text.includes('inferability: dropped 1 line(s)'));
  assert.ok(!quiet.text.includes('proved by card:lint'));

  const loud = await cli(['sync', '--explain', '--root', root]);
  assert.ok(loud.text.includes(`inferable: house dropped "${MARKED}" \u2014 proved by card:lint`));
});
