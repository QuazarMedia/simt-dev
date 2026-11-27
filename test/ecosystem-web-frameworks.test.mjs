import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ecosystemGateRows, loadEcosystems } from '../src/ecosystem/records.mjs';
import { validateRecord } from '../src/ecosystem/schema.mjs';
import { loadRules, select } from '../src/projection/project.mjs';
import { fingerprint, KNOWN_TAGS } from '../src/resolve/fingerprint.mjs';
import { tempDir } from './fixture.mjs';

const FRAMEWORKS = [
  { record: 'nextjs', profile: 'nextjs', facts: ['has-next'] },
  { record: 'vue-nuxt', profile: 'vue-nuxt', facts: ['has-nuxt', 'has-vue'] },
  { record: 'svelte-sveltekit', profile: 'svelte-sveltekit', facts: ['has-sveltekit', 'has-svelte'] },
  { record: 'angular', profile: 'angular', facts: ['has-angular'] },
];

const PROBES = [
  { fact: 'has-next', key: 'next', dependencies: 'my-next-app', devDependencies: '@next/env' },
  { fact: 'has-nuxt', key: 'nuxt', dependencies: 'nuxt-helper', devDependencies: '@nuxt/test-utils' },
  { fact: 'has-vue', key: 'vue', dependencies: 'vue-router', devDependencies: '@vue/test-utils' },
  { fact: 'has-sveltekit', key: '@sveltejs/kit', dependencies: '@sveltejs/adapter-static', devDependencies: '@sveltejs/kit-helper' },
  { fact: 'has-svelte', key: 'svelte', dependencies: 'not-svelte', devDependencies: 'svelte-check' },
  { fact: 'has-angular', key: '@angular/core', dependencies: '@angular/common', devDependencies: '@angular-devkit/build-angular' },
];

const FRAMEWORK_IDS = new Set(FRAMEWORKS.map((entry) => entry.profile));
const FRAMEWORK_FACTS = new Set(PROBES.map((entry) => entry.fact));

async function repo(files = {}) {
  const root = await tempDir('ecosystem-web-frameworks-');
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return root;
}

function manifest(dependencies, devDependencies = {}) {
  return {
    name: 'framework-fixture',
    packageManager: 'pnpm@10.0.0',
    dependencies,
    devDependencies,
  };
}

for (const { fact, key } of PROBES) {
  test(`${fact} detects the exact key in either dependency section with package.json evidence`, async () => {
    for (const section of ['dependencies', 'devDependencies']) {
      const root = await repo({ 'package.json': { [section]: { [key]: '1.0.0' } } });
      const print = await fingerprint(root);
      assert.ok(print.facts.includes(fact), `${section} did not emit ${fact}`);
      assert.equal(print.factEvidence[fact], 'package.json');
    }
  });

  test(`${fact} ignores incidental names, other sections and different casing`, async () => {
    const probe = PROBES.find((entry) => entry.fact === fact);
    const root = await repo({
      'package.json': {
        name: 'not-the-framework',
        dependencies: {
          [probe.dependencies]: '1.0.0',
          [key.toUpperCase()]: '1.0.0',
        },
        devDependencies: { [probe.devDependencies]: '1.0.0' },
        peerDependencies: { [key]: '1.0.0' },
        optionalDependencies: { [key]: '1.0.0' },
        scripts: { test: `echo ${key}` },
      },
    });
    const print = await fingerprint(root);
    assert.equal(print.facts.includes(fact), false);
    assert.equal(print.factEvidence[fact], undefined);
  });
}

test('framework probes do not infer a root framework from a nested package.json', async () => {
  const root = await repo({
    'package.json': manifest({ unrelated: '1.0.0' }),
    'packages/web/package.json': manifest({
      next: '1.0.0',
      nuxt: '1.0.0',
      vue: '1.0.0',
      '@sveltejs/kit': '1.0.0',
      svelte: '1.0.0',
      '@angular/core': '1.0.0',
    }),
  });
  const print = await fingerprint(root);
  assert.deepEqual(print.facts.filter((fact) => FRAMEWORK_FACTS.has(fact)), []);
});

test('framework records carry exact probes and no duplicate gate or Dependabot rows', () => {
  const records = loadEcosystems();
  const gates = ecosystemGateRows();
  for (const framework of FRAMEWORKS) {
    const matching = records.filter((record) => record.id === framework.record);
    assert.equal(matching.length, 1, `${framework.record} must have one record`);
    const [record] = matching;
    assert.equal(validateRecord(record.id, record).ok, true);
    assert.deepEqual(record.probes.map((probe) => probe.fact), framework.facts);
    for (const probe of record.probes) {
      const { key } = PROBES.find((entry) => entry.fact === probe.fact);
      assert.deepEqual(probe.files, ['package.json']);
      assert.deepEqual(probe.json.paths, [
        ['dependencies', key],
        ['devDependencies', key],
      ]);
    }
    assert.equal(record.manifestOrder, undefined, `${framework.record} must not seed a Node gate`);
    assert.equal(record.gates, undefined, `${framework.record} must not duplicate gate commands`);
    assert.equal(record.dependabot, undefined, `${framework.record} must not duplicate npm Dependabot`);
    assert.equal(gates.some((row) => row.id === framework.record), false);
  }
});

test('framework facts are known and their profiles are valid, specific and narrowly scoped', async () => {
  const rules = await loadRules();
  for (const framework of FRAMEWORKS) {
    for (const fact of framework.facts) assert.equal(KNOWN_TAGS.has(fact), true, `${fact} is not known`);
    const rule = rules.find((entry) => entry.id === framework.profile);
    assert.ok(rule, `${framework.profile} profile is missing`);
    assert.equal(rule.error, null, rule.error);
    assert.equal(rule.fallback, false);
    assert.deepEqual(rule.applies, framework.facts);
    assert.ok(rule.scope.length > 0);
    assert.equal(rule.scope.some((pattern) => ['**', '**/*', '*'].includes(pattern)), false);
    for (const line of rule.body.split('\n')) {
      if (line.startsWith('Applies to:')) assert.doesNotMatch(line, /`?has-[a-z0-9-]+`?/);
    }
  }
});

test('every framework profile carries the Node/TypeScript baseline and its own guidance', async () => {
  const guidance = {
    nextjs: [
      /App Router/, /Pages Router/, /server components by default/, /use client/, /server-only/,
      /cache policy/, /route handlers/i, /generateMetadata/, /never client-ify/,
    ],
    'vue-nuxt': [
      /Vue SPA/, /Nuxt/, /Composition API/, /defineProps/, /reactivity/i, /SSR/,
      /server\/api/, /useFetch/, /Auto-import/,
    ],
    'svelte-sveltekit': [
      /plain Svelte/, /SvelteKit/, /runes/, /legacy/, /\bload\b/, /Form actions/,
      /\+server/, /SSR/, /stale closure state/, /accessibility/i,
    ],
    angular: [
      /bootstrapApplication/, /standalone/, /signals/i, /typed reactive/i, /inject\(\)/,
      /OnPush/, /HttpClient/, /route configuration/i, /strictTemplates/,
    ],
  };
  const baseline = [
    'packageManager', 'lockfile', "repository's wrapper", '<manager> run <script>',
    '`format`', '`format:check`', '`lint`', '`typecheck`', '`test`', '`strict`',
    'No `any`', 'unsafe casts',
  ];
  const rules = await loadRules();
  for (const framework of FRAMEWORKS) {
    const rule = rules.find((entry) => entry.id === framework.profile);
    for (const text of baseline) assert.ok(rule.body.includes(text), `${framework.profile} omits ${text}`);
    for (const pattern of guidance[framework.profile]) {
      assert.match(rule.body, pattern, `${framework.profile} omits ${pattern}`);
    }
  }
});

const SELECTIONS = [
  { name: 'Next.js', profile: 'nextjs', pkg: manifest({ next: '^16.0.0' }, { typescript: '^5.9.0' }) },
  { name: 'Vue SPA', profile: 'vue-nuxt', pkg: manifest({ vue: '^3.5.0' }, { typescript: '^5.9.0' }) },
  { name: 'Nuxt', profile: 'vue-nuxt', pkg: manifest({ nuxt: '^4.0.0', vue: '^3.5.0' }, { typescript: '^5.9.0' }) },
  { name: 'Svelte', profile: 'svelte-sveltekit', pkg: manifest({ svelte: '^5.0.0' }, { typescript: '^5.9.0' }) },
  {
    name: 'SvelteKit',
    profile: 'svelte-sveltekit',
    pkg: manifest({ '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0' }, { typescript: '^5.9.0' }),
  },
  { name: 'Angular', profile: 'angular', pkg: manifest({ '@angular/core': '^20.0.0' }, { typescript: '^5.9.0' }) },
];

for (const { name, profile, pkg } of SELECTIONS) {
  test(`${name} selects only its framework profile and suppresses Node/TypeScript fallbacks`, async () => {
    const root = await repo({ 'package.json': pkg });
    const print = await fingerprint(root);
    const result = select(await loadRules(root), print.stack, print.facts);
    const ids = result.selected.map((rule) => rule.id);
    assert.deepEqual(ids.filter((id) => FRAMEWORK_IDS.has(id)), [profile]);
    assert.ok(ids.includes('core'));
    assert.equal(ids.includes('node'), false);
    assert.equal(ids.includes('typescript'), false);
    assert.equal(result.fallback, false);
  });
}

test('incidental framework names select the Node/TypeScript fallbacks, not a framework profile', async () => {
  const root = await repo({
    'package.json': manifest(
      Object.fromEntries(PROBES.map((probe) => [probe.dependencies, '1.0.0'])),
      { typescript: '^5.9.0', ...Object.fromEntries(PROBES.map((probe) => [probe.devDependencies, '1.0.0'])) },
    ),
  });
  const print = await fingerprint(root);
  const result = select(await loadRules(root), print.stack, print.facts);
  const ids = result.selected.map((rule) => rule.id);
  assert.deepEqual(ids.filter((id) => FRAMEWORK_IDS.has(id)), []);
  assert.ok(ids.includes('node'));
  assert.ok(ids.includes('typescript'));
  assert.equal(result.fallback, true);
});
