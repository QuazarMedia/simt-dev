import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plan, loadRules, select, render, checkTarget } from '../src/projection/project.mjs';
import { BEGIN, END, compose, inject, parse } from '../src/projection/markers.mjs';

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
  const src = [...first.targets[0].text.matchAll(/simt-dev:sources=([^\s]+)/g)].map((m) => m[1]);
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
  assert.match(result.targets[0].text, /simt-dev:sha=[0-9a-f]{7,40}/);
  assert.doesNotMatch(result.targets[0].text, /simt-dev:sha=unknown/);
  const state = parse(result.targets[0].text);
  assert.equal(state.status, 'ok');
  assert.equal(state.sha, result.targets[0].sha);
});