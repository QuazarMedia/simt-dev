import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plan, loadRules, select, render, checkTarget, checkTargets } from '../src/projection/project.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { BEGIN, END, compose, inject, parse } from '../src/projection/markers.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

async function fixture(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-proj-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    await writeFile(path, body);
  }
  return root;
}

test('every rule file carries an id', async () => {
  // A rule without an id would be projected with no traceable source, so
  // `simt-dev rules why` could never resolve it.
  const rules = await loadRules();
  assert.ok(rules.length >= 7, `expected core + 6 profiles, got ${rules.length}`);
  for (const r of rules) {
    assert.equal(r.error, null, `rules/${r.file}: ${r.error}`);
    assert.ok(r.id, `rules/${r.file} has no id`);
  }
});

test('every rule applies-to tag is one fingerprint can emit as a tag or a fact', async () => {
  // An unemittable tag silently never matches, which reads as "no rules apply".
  const { KNOWN_TAGS } = await import('../src/resolve/fingerprint.mjs');
  const rules = await loadRules();
  for (const r of rules) {
    if (!Array.isArray(r.applies)) continue;
    for (const tag of r.applies) {
      assert.ok(
        KNOWN_TAGS.has(tag),
        `rules/${r.file} applies to unknown tag "${tag}"`,
      );
    }
  }
});

test('selection is core plus intersecting profiles, in a stable order', () => {
  const rules = [
    { id: 'core', applies: 'always' },
    { id: 'workers', applies: ['cloudflare-workers', 'typescript'] },
    { id: 'react', applies: ['react'] },
    { id: 'node', applies: ['node'], fallback: true },
  ];
  const { selected, fallback } = select(rules, ['cloudflare-workers', 'typescript', 'node']);
  assert.deepEqual(selected.map((r) => r.id), ['core', 'workers']);
  assert.equal(fallback, false);
});

test('the fallback profile is only chosen when nothing more specific matched', () => {
  const rules = [
    { id: 'core', applies: 'always' },
    { id: 'react', applies: ['react'] },
    { id: 'node', applies: ['node'], fallback: true },
  ];
  const none = select(rules, ['node']);
  assert.deepEqual(none.selected.map((r) => r.id), ['core', 'node']);
  assert.equal(none.fallback, true);

  const specific = select(rules, ['node', 'react']);
  assert.deepEqual(specific.selected.map((r) => r.id), ['core', 'react']);
  assert.equal(specific.fallback, false, 'fallback must not stack with a specific profile');
});

test('a repo with no detectable signal still gets the shared rules', () => {
  const { selected, notes } = select([{ id: 'core', applies: 'always' }], []);
  assert.deepEqual(selected.map((r) => r.id), ['core']);
  assert.match(notes.join(' '), /no profile matched/);
});

test('a backend Workers repo does not receive the React profile', () => {
  // Regression: react-web once listed typescript/vitest/node-web/less, so every
  // Workers repo matched it. simt-social-api received React rules.
  const rules = [
    { id: 'core', applies: 'always' },
    { id: 'cloudflare-workers', applies: ['cloudflare-workers', 'typescript'] },
    { id: 'react-web', applies: ['react', 'react-router'] },
  ];
  const { selected } = select(rules, ['cloudflare-workers', 'typescript', 'node']);
  assert.equal(
    selected.some((r) => r.id === 'react-web'),
    false,
  );
});

test('a rendered region steps headings by one and gives each source one heading', async () => {
  // S34. A folded rule used to open at `### id` and then continue at `##`, and a
  // stack profile lost its H1, so "Applies to" read as the last section of core.
  // The region is embedded under the host document's H1, so H2 is the first level
  // that belongs to a source; from there a heading may climb by at most one.
  const root = await fixture({
    'build.gradle.kts': 'plugins { kotlin("jvm") }\n',
    'src/main/kotlin/Api.kt': 'class Api\n',
  });
  const desired = await desiredRegion(root, {});
  const region = desired.body;
  const levels = headingLevels(region);
  let prev = 1;
  for (const level of levels) {
    assert.ok(level <= prev + 1, `heading jumped from ${prev} to ${level} in:\n${region.slice(0, 400)}`);
    prev = level;
  }
  const h2 = region.split('\n').filter((line) => /^## \S/.test(line));
  assert.equal(h2.length, desired.profiles.length + desired.folded.length, h2.join('\n'));
  assert.equal(new Set(h2).size, h2.length, 'two sources shared one heading');
  assert.match(region, /## Core\n/);
  assert.match(region, /## Stack: jvm\n\nApplies to:/);
  assert.match(region, /## Process: test-gate\n/);
});

function headingLevels(markdown) {
  const levels = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+\S/.exec(line);
    if (match) levels.push(match[1].length);
  }
  return levels;
}

test('a region past a reader limit is reported, and place top clears it', async () => {
  // S37. Codex stops at 32 KiB. A hand-written prefix longer than that hides the
  // region, and check used to report the body as current.
  const region = compose('Body.', { sha: 'abc1234' });
  const root = await fixture({ 'AGENTS.md': `${'x'.repeat(40000)}\n${region}` });
  const before = await checkTargets(root);
  const hit = before.find((f) => f.status === 'beyond-read-limit');
  assert.ok(hit, before.map((f) => f.status).join(','));
  assert.match(hit.detail, /BEYOND-READ-LIMIT/);
  assert.match(hit.detail, /Codex/);

  await writeFile(join(root, MANIFEST_FILE), `${JSON.stringify({ projection: { place: 'top' } })}\n`);
  const planned = await plan(root);
  const agents = planned.targets.find((t) => t.file === 'AGENTS.md');
  await writeFile(agents.path, agents.text);
  const after = await checkTargets(root);
  assert.equal(after.find((f) => f.status === 'beyond-read-limit'), undefined);
  assert.ok(agents.text.indexOf('<!-- simt:begin -->') < 40000);
});

test('render strips frontmatter and the duplicated H1', () => {
  const body = render([
    { body: '---\nid: x\n---\n\n# Title\n\nRule one.\n' },
    { body: '# Other\n\nRule two.\n' },
  ]);
  assert.equal(body.includes('---'), false);
  assert.equal(body.includes('# Title'), false);
  assert.match(body, /Rule one\./);
  assert.match(body, /Rule two\./);
});

test('the projected region is idempotent', async () => {
  const root = await fixture({ 'build.gradle.kts': '' });
  const first = await plan(root);
  await writeFile(first.targets[0].path, first.targets[0].text);
  const second = await plan(root);
  assert.equal(second.targets[0].action, 'unchanged');
  assert.equal(second.targets[0].bytes, first.targets[0].bytes);
});

test('sync never touches hand-written content outside the markers', async () => {
  // The sentinel is a nonsense token on purpose. An earlier version used the word
  // "stale", which then collided with ordinary prose in the generated header and
  // failed the test for the wrong reason.
  const handWritten = `# My repo\n\nHouse rules that belong to me.\n\n${BEGIN}\nZZ-OLD-REGION-BODY-ZZ\n${END}\n\n## My own section\n\nStill mine.\n`;
  const root = await fixture({ 'pyproject.toml': '', 'AGENTS.md': handWritten });
  const result = await plan(root);
  const text = result.targets[0].text;
  assert.match(text, /House rules that belong to me\./);
  assert.match(text, /## My own section/);
  assert.equal(text.includes('ZZ-OLD-REGION-BODY-ZZ'), false, 'the old region body must be replaced');
});

test('check reports current, drift, unmanaged and absent distinctly', async () => {
  const managed = await fixture({ 'pyproject.toml': '' });
  const first = await plan(managed);
  await writeFile(first.targets[0].path, first.targets[0].text);
  assert.equal((await checkTarget(managed)).status, 'current');

  // Drift: an identical body recorded against a different simt-dev SHA must
  // still read as drift, or `simt-dev check` is blind to the provenance change.
  // The meta must be reproduced exactly, including the sources header that
  // compose() embeds; omitting it would itself look like drift.
  const { diff } = await import('../src/projection/markers.mjs');
  const src = [...first.targets[0].text.matchAll(/simt:sources=([^\s]+)/g)].map((m) => m[1]);
  const sources = src.length === 1 ? src[0].split(',') : [];
  assert.equal(diff(first.targets[0].text, first.targets[0].body, { sha: first.targets[0].sha, sources }).action, 'unchanged');
  assert.equal(diff(first.targets[0].text, first.targets[0].body, { sha: 'beefcafe', sources }).action, 'updated');

  const unmanaged = await fixture({ 'pyproject.toml': '', 'AGENTS.md': '# Mine only\n' });
  assert.equal((await checkTarget(unmanaged)).status, 'unmanaged');

  const absent = await fixture({ 'pyproject.toml': '' });
  assert.equal((await checkTarget(absent)).status, 'absent');

  const malformed = await fixture({
    'pyproject.toml': '',
    'AGENTS.md': `${BEGIN}\nno end marker\n`,
  });
  assert.equal((await checkTarget(malformed)).status, 'malformed');
});

test('a malformed region is refused rather than duplicated', async () => {
  // Appending a second region would duplicate every rule while reporting success.
  const root = await fixture({ 'pyproject.toml': '', 'AGENTS.md': `${BEGIN}\nbroken\n` });
  const result = await plan(root);
  assert.equal(result.targets[0].action, 'malformed');
  assert.ok(result.targets[0].reason);
});

test('plan writes nothing', async () => {
  const root = await fixture({ 'pyproject.toml': '' });
  await plan(root);
  await assert.rejects(() => readFile(join(root, 'AGENTS.md'), 'utf8'));
});

test('the region records the simt-dev sha so drift is diagnosable', async () => {
  const root = await fixture({ 'pyproject.toml': '' });
  const result = await plan(root);
  // The alternation with `sha=unknown` used to be here, and it was the assertion that
  // let the sentinel survive: a stamp the tool cannot read back still satisfied it.
  // `compose` now throws on anything the marker grammar rejects, so there is no second
  // value to allow (ADR-032).
  assert.match(result.targets[0].text, /simt:sha=[0-9a-f]{7,40}/);
  assert.doesNotMatch(result.targets[0].text, /simt:sha=unknown/);
  const state = parse(result.targets[0].text);
  assert.equal(state.status, 'ok');
  assert.equal(state.sha, result.targets[0].sha);
});
test('a surface problem is reported in `surfaceProblems`, not in `mdcProblems`', async () => {
  // The mislabelling is visible in the payload, not only in the printed line. Both
  // writers check `surfaceProblems` first and print the right sentence, so the printed
  // output is correct whether or not the fold below is in place — which means the CLI
  // tests pass against a `plan()` that still lies.
  //
  // `--json` and the MCP surface read these fields directly. A consumer of
  // `mdcProblems` sees a surface typo described as a rule that cannot be projected, and
  // no amount of correct prose further down the output corrects the field it read.
  const root = await fixture({
    [MANIFEST_FILE]: JSON.stringify(
      { id: 'x', version: 1, surfaces: ['cursor', 'not-a-surface'], gates: {} },
      null,
      2,
    ),
  });

  const p = await plan(root, {});
  assert.equal(p.surfaceProblems.length, 1);
  assert.match(p.surfaceProblems[0], /unknown surface "not-a-surface"/);

  // Every shipped rule rendered; there is nothing wrong with any of them.
  assert.equal(p.rules.filter((r) => r.error).length, 0);
  assert.deepEqual(
    p.mdcProblems,
    [],
    `a surface problem reached mdcProblems, which is reported as "canonical .mdc rule(s) cannot be projected": ${JSON.stringify(p.mdcProblems)}`,
  );
});
