import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ecosystems } from '../src/ci/dependabot.mjs';
import { ecosystemGateRows, ecosystemProblems, loadEcosystems, matches } from '../src/ecosystem/records.mjs';
import { validateRecord } from '../src/ecosystem/schema.mjs';
import { lintRegistry } from '../src/graph/load.mjs';
import { commandCard } from '../src/kernel/card.mjs';
import { inferableDefect } from '../src/kernel/inferability.mjs';
import { loadRules, LOCAL_PROFILE_DIR } from '../src/projection/project.mjs';
import { __internals, fingerprint, KNOWN_TAGS, knownTags } from '../src/resolve/fingerprint.mjs';
import { tempDir } from './fixture.mjs';

async function repo(files = {}) {
  const root = await tempDir('ecosystem-probes-');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

const record = {
  v: 1,
  id: 'probe-fixture',
  facts: ['has-file-probe'],
  probes: [
    { fact: 'has-file-probe', files: ['nested/settings.ini'] },
    { fact: 'has-text-probe', files: ['config/settings.ini'], regex: '^enabled=true$' },
    {
      fact: 'has-json-probe',
      files: ['package.json'],
      json: { paths: [['dependencies', 'widget'], ['devDependencies', 'tool']] },
    },
    { fact: 'has-glob-probe', globs: ['**/*.tofu'] },
  ],
};

test('probe schema accepts the generic matchers and refuses ambiguous or unsafe input', () => {
  assert.equal(validateRecord('probe-fixture', record).ok, true);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', globs: ['*.x'] }] }).ok, true);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['../x'] }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['x'], regex: '[' }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['x'], globs: ['**/*.x'] }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', globs: ['**/*.x'], regex: 'x' }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['x'], regex: 'x', stripComments: 'yes' }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['x'], json: { paths: [['x']] }, stripComments: true }] }).ok, false);
  assert.equal(validateRecord('probe-fixture', { ...record, probes: [{ fact: 'has-x', files: ['x'], json: { paths: [null] } }] }).ok, false);
  for (const probe of [{ fact: 'has-x', files: 1 }, { fact: 'has-x', globs: 1 }]) {
    assert.doesNotThrow(() => validateRecord('probe-fixture', { ...record, probes: [probe] }));
    assert.equal(validateRecord('probe-fixture', { ...record, probes: [probe] }).ok, false);
  }
  for (const card of [
    { build: { condition: { fact: 'has-x', unless: 'has-y' } } },
    { focused: [{ condition: { fact: 'has-x', unless: 'has-y' } }] },
    { fallback: [{ condition: { fact: 'has-x', unless: 'has-y' } }] },
  ]) {
    assert.equal(validateRecord('probe-fixture', { ...record, card }).ok, false);
  }
  assert.equal(validateRecord('probe-fixture', { ...record, dependabot: [{ unless: 'has-x', value: 'npm', manifest: 'package.json' }] }).ok, false);
  assert.equal(
    validateRecord('probe-fixture', { ...record, languages: [{ lang: 'fixture', exts: ['.x'], canonical: '.x' }] }).ok,
    false,
  );
});

test('file, text, JSON and glob probes emit facts with the matching path as evidence', async () => {
  const root = await repo({
    'nested/settings.ini': 'other=true\n',
    'config/settings.ini': 'enabled=true',
    'package.json': { dependencies: { widget: '1' } },
    'modules/network/main.tofu': '',
    '.simt/ecosystems/probe-fixture.json': record,
  });
  const print = await fingerprint(root);
  assert.equal(print.factEvidence['has-file-probe'], 'nested/settings.ini');
  assert.equal(print.factEvidence['has-text-probe'], 'config/settings.ini');
  assert.equal(print.factEvidence['has-json-probe'], 'package.json');
  assert.equal(print.factEvidence['has-glob-probe'], 'modules/network/main.tofu');
});

test('a content probe reads at most its declared byte bound', async () => {
  const bounded = {
    v: 1,
    id: 'bounded',
    probes: [{ fact: 'has-tail', files: ['large.txt'], regex: 'needle' }],
  };
  const root = await repo({
    'large.txt': `${'x'.repeat(__internals.PROBE_BYTES)}needle`,
    '.simt/ecosystems/bounded.json': bounded,
  });
  assert.equal((await fingerprint(root)).facts.includes('has-tail'), false);
});

test('content probes do not follow symlinks outside the repository', async () => {
  const outside = await tempDir('ecosystem-probe-outside-');
  await writeFile(join(outside, 'settings.ini'), 'enabled=true\n');
  const linked = {
    v: 1,
    id: 'linked',
    probes: [
      { fact: 'has-linked-file', files: ['linked.ini'] },
      { fact: 'has-linked-text', files: ['linked.ini'], regex: 'enabled=true' },
      { fact: 'has-linked-parent', files: ['linked-dir/settings.ini'], regex: 'enabled=true' },
    ],
  };
  const root = await repo({ '.simt/ecosystems/linked.json': linked });
  await symlink(join(outside, 'settings.ini'), join(root, 'linked.ini'));
  await symlink(outside, join(root, 'linked-dir'));

  const print = await fingerprint(root);
  for (const fact of ['has-linked-file', 'has-linked-text', 'has-linked-parent']) {
    assert.equal(print.facts.includes(fact), false, fact);
    assert.equal(print.factEvidence[fact], undefined);
  }
});

test('glob probes and root file facts reject symlinks outside the repository', async () => {
  const outside = await tempDir('ecosystem-glob-outside-');
  await writeFile(join(outside, 'main.tf'), 'resource "example" "item" {}\n');
  const root = await repo({});
  await symlink(join(outside, 'main.tf'), join(root, 'main.tf'));

  const print = await fingerprint(root);
  assert.equal(print.facts.includes('has-terraform-root'), false);
  assert.equal(print.facts.includes('has-terraform'), false);
  assert.equal(print.factEvidence['has-terraform-root'], undefined);
  assert.equal(print.factEvidence['has-terraform'], undefined);
});

test('comment stripping removes code comments without hiding real declarations', async () => {
  const commented = {
    v: 1,
    id: 'commented',
    probes: [{ fact: 'has-uncommented', files: ['build.gradle.kts'], regex: 'enabled=true', stripComments: true }],
  };
  const root = await repo({
    'build.gradle.kts': '// enabled=true\n/* enabled=true */\n',
    '.simt/ecosystems/commented.json': commented,
  });
  assert.equal((await fingerprint(root)).facts.includes('has-uncommented'), false);
  await writeFile(join(root, 'build.gradle.kts'), '/* outer /* nested */ enabled=true */\n');
  assert.equal((await fingerprint(root)).facts.includes('has-uncommented'), false);
  await writeFile(join(root, 'build.gradle.kts'), 'val enabled=true // enabled=true\n');
  assert.equal((await fingerprint(root)).facts.includes('has-uncommented'), true);
});

test('a malformed Dependabot exclusion quarantines the whole local record', async () => {
  const root = await repo({
    '.simt/ecosystems/bad-dependabot.json': {
      v: 1,
      id: 'bad-dependabot',
      dependabot: [{ fact: 'has-fixture', unless: 'has-other', value: 'npm', manifest: 'package.json' }],
    },
  });
  assert.equal(loadEcosystems(root).some((entry) => entry.id === 'bad-dependabot'), false);
  assert.match(ecosystemProblems(root)[0].detail, /dependabot\[0\]\.unless/);
  assert.deepEqual(ecosystems([], [], root), []);
});

test('malformed probe lists and card exclusions quarantine local records instead of crashing or applying', async () => {
  const root = await repo({
    '.simt/ecosystems/bad-files.json': { v: 1, id: 'bad-files', probes: [{ fact: 'has-fixture', files: 1 }] },
    '.simt/ecosystems/bad-globs.json': { v: 1, id: 'bad-globs', probes: [{ fact: 'has-fixture', globs: 1 }] },
    '.simt/ecosystems/bad-card.json': {
      v: 1,
      id: 'bad-card',
      card: { focused: [{ kind: 'Fixture', condition: { fact: 'has-fixture', unless: 'has-other' }, template: 'fixture test {file}' }] },
    },
  });
  assert.doesNotThrow(() => loadEcosystems(root));
  for (const id of ['bad-files', 'bad-globs', 'bad-card']) {
    assert.equal(loadEcosystems(root).some((entry) => entry.id === id), false);
  }
  const problems = ecosystemProblems(root);
  assert.ok(problems.some((problem) => /probes\[0\]\.files must be a list/.test(problem.detail)));
  assert.ok(problems.some((problem) => /probes\[0\]\.globs must be a list/.test(problem.detail)));
  assert.ok(problems.some((problem) => /card\.focused\[0\]\.condition\.unless/.test(problem.detail)));
  assert.deepEqual((await commandCard({ root, facts: ['has-fixture', 'has-other'] })).lines, []);
});

test('record facts join the owning root vocabulary without leaking into the shipped set', async () => {
  const root = await repo({
    '.simt/ecosystems/probe-fixture.json': record,
    [`${LOCAL_PROFILE_DIR}/probe.md`]: `---\nsimt-id: probe\nsimt-title: Probe\nsimt-applies: [has-text-probe]\n---\n\n## Probe\n\nUse the declared command.\n`,
  });
  assert.equal(KNOWN_TAGS.has('has-text-probe'), false);
  assert.equal(knownTags(root).has('has-text-probe'), true);
  const profile = (await loadRules(root)).find((rule) => rule.id === 'probe');
  assert.equal(profile.error, null);
  assert.equal(
    inferableDefect('Use the runner. <!-- simt-inferable-when: has-text-probe -->', knownTags(root)),
    null,
  );
});

test('registry lint accepts a root-local record fact when given that root vocabulary', () => {
  const registry = {
    version: 1,
    capabilities: [{ id: 'probe', summary: 'Probe support' }],
    skills: [{
      name: 'probe',
      summary: 'Probe support',
      capabilities: ['probe'],
      stack: ['has-text-probe'],
      paths: ['**/*.probe'],
      keywords: ['probe'],
      bytes: 10,
      sources: [{ repo: 'fixture', path: 'probe.md', role: 'canonical', bytes: 10 }],
    }],
  };
  assert.ok(lintRegistry(registry).sync.some((error) => /has-text-probe/.test(error)));
  assert.deepEqual(lintRegistry(registry, new Set(['has-text-probe'])).sync, []);
});

test('unless excludes a positive condition, a gate row and a Dependabot entry', async () => {
  assert.equal(matches({ fact: 'has-pubspec', unless: ['has-flutter'] }, { facts: new Set(['has-pubspec', 'has-flutter']) }), false);
  assert.equal(matches({ fact: 'has-pubspec', unless: ['has-flutter'] }, { facts: new Set(['has-pubspec']) }), true);

  const root = await repo({
    '.simt/ecosystems/excluded.json': {
      v: 1,
      id: 'excluded',
      tool: 'fixture',
      facts: ['has-fixture'],
      manifestOrder: 99,
      gates: { preCommit: ['lint'], unless: ['has-other'], commands: { lint: 'fixture lint' } },
      card: { focused: [{ kind: 'Fixture', condition: { fact: 'has-fixture', unless: ['has-other'] }, template: 'fixture test {file}' }] },
      dependabot: [{ fact: 'has-fixture', unless: ['has-other'], value: 'npm', manifest: '/package.json' }],
    },
  });
  const row = ecosystemGateRows(root).find((entry) => entry.id === 'excluded');
  assert.deepEqual(row.unless, ['has-other']);
  assert.deepEqual(ecosystems(['has-fixture', 'has-other'], [], root), []);
  assert.deepEqual(ecosystems(['has-fixture'], [], root), [{ value: 'npm', manifest: '/package.json' }]);
  assert.deepEqual((await commandCard({ root, facts: ['has-fixture', 'has-other'] })).lines, []);
  assert.equal(
    (await commandCard({ root, facts: ['has-fixture'] })).lines.find((line) => line.verb === 'focused')?.command,
    'fixture test {file}',
  );
});
