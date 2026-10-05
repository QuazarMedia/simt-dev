import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMdcRules, renderMdc, mdcFrontmatter } from '../src/projection/mdc.mjs';
import { inject } from '../src/projection/markers.mjs';

const scratch = () => mkdtemp(join(tmpdir(), 'simt-mdc-'));

test('the three canonical rules are present and complete', async () => {
  const rules = await loadMdcRules();
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((r) => r.id), ['intake-questions', 'preview-postflight', 'test-gate']);
  for (const rule of rules) {
    assert.equal(rule.error, null, `${rule.id}: ${rule.error}`);
    assert.equal(rule.alwaysApply, true);
    assert.ok(rule.description && rule.description.length > 10);
    assert.match(rule.target, /^\.cursor\/rules\/[^/]+\.mdc$/, rule.target);
  }
});

test('a rule missing id or target is a defect, not a default', () => {
  const rule = { id: null, substitutions: [], body: 'x' };
  const shape = (r) => (r.id === null ? 'missing id in frontmatter' : r.target === null ? 'missing target in frontmatter' : null);
  assert.equal(shape(rule), 'missing id in frontmatter');
  assert.equal(shape({ id: 'a', target: null }), 'missing target in frontmatter');
  assert.equal(shape({ id: 'a', target: 'b' }), null);
});

test('test-gate carries BOTH complementary BLOCK bullets', async () => {
  const rules = await loadMdcRules();
  const gate = rules.find((r) => r.id === 'test-gate');
  const { body } = renderMdc(gate);
  assert.match(body, /Consumer side:/);
  assert.match(body, /Producer side:/);
});

test('the 6/8 partial-pass example survives (it was silently deleted in one copy)', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'test-gate'));
  assert.match(body, /6\/8 passing/);
});

test('preview-postflight carries BOTH the build-config and credential bullets', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'));
  assert.match(body, /SOCIAL_API_BASE_URL/);
  assert.match(body, /operator keychain only/);
});

test('the Allowed Without Account section is restored (media had deleted it)', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'));
  assert.match(body, /## Allowed Without Account/);
  assert.match(body, /D1 migration verification/);
});

test('intake keeps migrations in the ask-trigger list', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'intake-questions'));
  assert.match(body, /contracts,\s+migrations, or risk/);
});

test('a default is used when the repo declares nothing', async () => {
  const rules = await loadMdcRules();
  const { body, problems } = renderMdc(rules.find((r) => r.id === 'intake-questions'));
  assert.deepEqual(problems, []);
  assert.match(body, /docs\/plans\/\*/);
});

test('a declared substitution replaces the default', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'intake-questions'), {
    plansGlob: '../simt-social/docs/plans/*',
  });
  assert.match(body, /\.\.\/simt-social\/docs\/plans\/\*/);
  assert.doesNotMatch(body, /`docs\/plans\/\*`/);
});

test('an empty declaration DROPS its line rather than printing a blank', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'), {
    productionDomainNote: '',
  });
  assert.doesNotMatch(body, /productionDomainNote/);
  // The surrounding sections must survive the drop intact.
  assert.match(body, /## Requirements/);
  assert.match(body, /## Forbidden/);
  // And the file must not be left with a blank run where the line used to be.
  assert.doesNotMatch(body, /\n{3,}/);
});

test('a substitution with neither a default nor a declaration is reported', () => {
  const rule = {
    id: 'x',
    substitutions: [{ key: 'k', default: undefined }],
    body: 'value is {{k}}',
  };
  const { problems } = renderMdc(rule);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no default and none declared/);
});

test('rendering with no substitutions leaves no placeholder behind', async () => {
  for (const rule of await loadMdcRules()) {
    const { body, problems } = renderMdc(rule);
    assert.deepEqual(problems, [], rule.id);
    assert.doesNotMatch(body, /\{\{/, rule.id);
  }
});

test('frontmatter keeps description and alwaysApply outside the region', () => {
  const rule = { id: 'test-gate', description: 'desc here', alwaysApply: true };
  const fm = mdcFrontmatter(rule);
  assert.match(fm, /^---\ndescription: desc here\nalwaysApply: true\n---$/);
});

test('a projected rule is idempotent through inject', async () => {
  const rules = await loadMdcRules();
  const rule = rules.find((r) => r.id === 'test-gate');
  const { body } = renderMdc(rule);
  const meta = { sha: 'abc1234', sources: [rule.source] };
  const first = inject('', body, meta);
  assert.equal(first.action, 'added');
  const second = inject(first.text, body, meta);
  assert.equal(second.action, 'unchanged');
});

test('the rules are pure content: no absolute path or repo name leaks in', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule);
    assert.doesNotMatch(body, /said\.elimam/, rule.id);
    assert.doesNotMatch(body, /\/Users\//, rule.id);
  }
});
// --- the conflict scanner must be able to REACH .mdc files ---------------------
//
// The estate's three always-on .mdc families were its worst-drifted content, and
// `simt init` reported `CONFLICTS none detected` on the repo holding them, because
// RULE_FILES named only AGENTS.md/CLAUDE.md/CONTRIBUTING.md. A detector that only
// looks at the filenames it was written for misses a whole rule surface added later.

import { rulePaths, scanDocument } from '../src/projection/conflicts.mjs';

test('rulePaths finds hand-written rules by name and by glob', async () => {
  const dir = await scratch();
  await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), '# a\n');
  await writeFile(join(dir, '.cursor', 'rules', 'test-gate.mdc'), '---\n---\n');
  await writeFile(join(dir, '.cursor', 'rules', 'README.txt'), 'ignored\n');
  await writeFile(join(dir, '.cursor', 'rules', 'preview-postflight.mdc'), '---\n---\n');

  const found = (await rulePaths(dir)).map((p) => p.slice(dir.length + 1));
  assert.ok(found.includes('AGENTS.md'));
  assert.ok(found.includes(join('.cursor', 'rules', 'test-gate.mdc')));
  assert.ok(found.includes(join('.cursor', 'rules', 'preview-postflight.mdc')));
  assert.ok(!found.some((p) => p.endsWith('README.txt')), 'a non-markdown file was collected');
  // Stable across runs, so two `init` invocations produce a diffable report.
  assert.deepEqual(
    (await rulePaths(dir)).map((p) => p.slice(dir.length + 1)),
    found,
    'order must be stable for a diffable report',
  );
});

test('rulePaths returns just the named files when no rule dir exists', async () => {
  const dir = await scratch();
  const found = await rulePaths(dir);
  assert.deepEqual(found.map((p) => p.slice(dir.length + 1)), ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']);
});

test('a conflict inside a .mdc rule is detected', async () => {
  const text = '---\ndescription: x\nalwaysApply: true\n---\n\n# Rogue\nAlways commit and pushed with a conventional message.\n';
  const found = scanDocument(text, '.cursor/rules/rogue.mdc');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'conflict');
  assert.equal(found[0].adr, 'ADR-001');
});

test('autonomous-push is matched in every phrasing the estate actually used', () => {
  // garmin's own DoD, plus the two other forms a different author wrote. An
  // anchored pattern matching only the first reported a real rule as clean.
  for (const phrase of [
    '8. Committed and pushed with a conventional message',
    'Always commit and pushed with a conventional message',
    'Then commit and push without asking',
  ]) {
    const found = scanDocument(`# DoD\n- ${phrase}\n`, 'AGENTS.md');
    assert.ok(
      found.some((f) => f.id === 'autonomous-push'),
      `missed: ${phrase}`,
    );
  }
});
