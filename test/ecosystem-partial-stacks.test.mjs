import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ecosystems, renderDependabot } from '../src/ci/dependabot.mjs';
import {
  ecosystemGateRows,
  languageExts,
  languageResolver,
  loadEcosystems,
} from '../src/ecosystem/records.mjs';
import { defaultGates, planGates } from '../src/gates/index.mjs';
import { commandCard } from '../src/kernel/card.mjs';
import { langOf } from '../src/index/store.mjs';
import { loadRules, select } from '../src/projection/rules.mjs';
import { fingerprint, knownTags } from '../src/resolve/fingerprint.mjs';
import { tempDir } from './fixture.mjs';

async function repo(files = {}) {
  const root = await tempDir('simt-partial-stacks-');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

async function detect(files) {
  const root = await repo(files);
  return { root, ...(await fingerprint(root)) };
}

function commandFor(card, label) {
  return card.lines.find((line) => line.label === label)?.command ?? null;
}

const PARTIAL_STACKS = [
  {
    name: 'Composer',
    files: { 'composer.json': { name: 'example/php' } },
    fact: 'has-composer',
    evidence: 'composer.json',
    profile: 'php',
    dependabot: 'composer',
  },
  {
    name: 'Terraform',
    files: { 'infra/network/main.tf': '' },
    fact: 'has-terraform',
    absent: ['has-opentofu'],
    evidence: 'infra/network/main.tf',
    profile: 'terraform',
    dependabot: 'terraform',
  },
  {
    name: 'OpenTofu',
    files: { 'infra/network/main.tofu': '' },
    fact: 'has-opentofu',
    absent: ['has-terraform'],
    evidence: 'infra/network/main.tofu',
    profile: 'terraform',
    dependabot: 'terraform',
  },
  {
    name: 'Bun text lockfile',
    files: { 'package.json': { name: 'example/bun' }, 'bun.lock': '' },
    fact: 'has-bun-lock',
    evidence: 'bun.lock',
    profile: 'bun',
    dependabot: 'bun',
  },
  {
    name: 'Bun binary lockfile',
    files: { 'package.json': { name: 'example/bun' }, 'bun.lockb': '' },
    fact: 'has-bun-lock',
    evidence: 'bun.lockb',
    profile: 'bun',
    dependabot: 'bun',
  },
  {
    name: 'Dockerfile',
    files: { Dockerfile: 'FROM scratch\n' },
    fact: 'has-dockerfile',
    evidence: 'Dockerfile',
    profile: 'container',
    dependabot: 'docker',
  },
  {
    name: 'Compose',
    files: { 'compose.yml': 'services: {}\n' },
    fact: 'has-compose',
    evidence: 'compose.yml',
    profile: 'compose',
    dependabot: 'docker-compose',
  },
  {
    name: 'Dev Container',
    files: { '.devcontainer/devcontainer.json': { image: 'example/dev' } },
    fact: 'has-devcontainer',
    evidence: '.devcontainer/devcontainer.json',
    profile: 'devcontainer',
    dependabot: 'devcontainers',
  },
  {
    name: 'Git submodules',
    files: { '.gitmodules': '' },
    fact: 'has-submodules',
    evidence: '.gitmodules',
    profile: 'git-submodules',
    dependabot: 'gitsubmodule',
  },
];

test('partial stacks emit evidence, select their profiles and keep Dependabot coverage', async () => {
  for (const row of PARTIAL_STACKS) {
    const found = await detect(row.files);
    assert.ok(found.facts.includes(row.fact), `${row.name}: missing ${row.fact}`);
    assert.equal(found.factEvidence[row.fact], row.evidence, `${row.name}: wrong evidence`);
    for (const fact of row.absent ?? []) {
      assert.ok(!found.facts.includes(fact), `${row.name}: ${fact} must stay separate`);
    }

    const rules = await loadRules(found.root);
    const profile = rules.find((rule) => rule.id === row.profile);
    assert.ok(profile, `${row.name}: no ${row.profile} profile`);
    assert.equal(profile.error, null, `${row.name}: ${profile.error}`);
    assert.ok(profile.applies.includes(row.fact), `${row.name}: profile does not select on its evidence`);
    assert.ok(profile.scope?.length > 0, `${row.name}: profile has no narrow scope`);
    for (const pattern of profile.scope) assert.ok(!['**', '**/*', '*'].includes(pattern));
    for (const line of profile.body.split('\n')) {
      if (line.startsWith('Applies to:')) assert.doesNotMatch(line, /`?has-[a-z0-9-]+`?/);
    }

    const { selected } = select(rules, found.stack, found.facts);
    assert.ok(selected.some((rule) => rule.id === row.profile), `${row.name}: profile was not selected`);
    const watched = ecosystems(found.facts, found.stack, found.root);
    assert.ok(watched.some((entry) => entry.value === row.dependabot), `${row.name}: Dependabot entry missing`);
  }
});

test('OpenTofu is in the owning root vocabulary and Terraform globs do not cross formats', async () => {
  const tofu = await detect({ 'modules/object/main.tofu': '' });
  assert.equal(knownTags(tofu.root).has('has-opentofu'), true);
  assert.deepEqual(tofu.facts.filter((fact) => ['has-terraform', 'has-opentofu'].includes(fact)), ['has-opentofu']);

  const terraform = await detect({ 'modules/object/main.tf': '' });
  assert.deepEqual(
    terraform.facts.filter((fact) => ['has-terraform', 'has-opentofu'].includes(fact)),
    ['has-terraform'],
  );
});

test('PHP and HCL language metadata resolve their own extensions', () => {
  assert.deepEqual(languageExts().php, ['.php']);
  assert.equal(languageResolver().php, 'php');
  assert.equal(langOf('src/Example.php'), 'php');
  assert.deepEqual([...languageExts().hcl].sort(), ['.tf', '.tofu']);
  assert.equal(languageResolver().tf, 'hcl');
  assert.equal(languageResolver().tofu, 'hcl');
  assert.equal(langOf('infra/main.tf'), 'hcl');
  assert.equal(langOf('infra/main.tofu'), 'hcl');
});

test('a Bun lockfile excludes both npm Dependabot rows without losing Bun', async () => {
  for (const lockfile of ['bun.lock', 'bun.lockb']) {
    const found = await detect({
      'package.json': { name: 'example/bun', devDependencies: { typescript: '^5' } },
      [lockfile]: '',
    });
    assert.deepEqual(ecosystems(found.facts, found.stack, found.root), [
      { value: 'bun', manifest: 'bun.lock' },
    ]);
    const rendered = renderDependabot(found.facts, { stack: found.stack, root: found.root });
    assert.match(rendered, /package-ecosystem: "bun"/);
    assert.doesNotMatch(rendered, /package-ecosystem: "npm"/);
  }

  const npm = await detect({
    'package.json': { name: 'example/npm', devDependencies: { typescript: '^5' } },
    'package-lock.json': '{}',
  });
  assert.deepEqual(ecosystems(npm.facts, npm.stack, npm.root), [
    { value: 'npm', manifest: 'package.json' },
  ]);
});

test('Terraform and OpenTofu Dependabot rows dedupe by ecosystem value', async () => {
  const terraform = await detect({ 'main.tf': '' });
  assert.deepEqual(ecosystems(terraform.facts, terraform.stack, terraform.root), [
    { value: 'terraform', manifest: '*.tf' },
  ]);

  const tofu = await detect({ 'main.tofu': '' });
  assert.deepEqual(ecosystems(tofu.facts, tofu.stack, tofu.root), [
    { value: 'terraform', manifest: '*.tofu' },
  ]);

  const both = await detect({ 'main.tf': '', 'main.tofu': '' });
  assert.deepEqual(ecosystems(both.facts, both.stack, both.root), [
    { value: 'terraform', manifest: '*.tf' },
  ]);
  const rendered = renderDependabot(both.facts, { stack: both.stack, root: both.root });
  assert.equal(rendered.match(/package-ecosystem: "terraform"/g)?.length, 1);
});

test('Composer seeds only strict manifest lint and a project-local PHPUnit template', async () => {
  const found = await detect({ 'composer.json': { name: 'example/php' } });
  const row = ecosystemGateRows(found.root).find((entry) => entry.id === 'composer');
  assert.equal(row.tool, 'composer');
  assert.deepEqual(row.preCommit, ['lint']);
  assert.equal(row.prePush, undefined);
  assert.deepEqual(row.commands, { lint: 'composer validate --strict' });

  const planned = planGates(
    found.stack,
    { tools: ['composer'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    found.facts,
    found.root,
  );
  assert.deepEqual(planned.gates, { preCommit: ['lint'], prePush: [] });
  assert.deepEqual(planned.commands, { lint: 'composer validate --strict' });

  const card = await commandCard({ root: found.root, stack: found.stack, facts: found.facts });
  assert.equal(commandFor(card, 'lint'), 'composer validate --strict');
  assert.equal(commandFor(card, 'focused test (PHPUnit)'), 'vendor/bin/phpunit {file}');
  for (const verb of ['build', 'test', 'format', 'typecheck']) {
    assert.equal(commandFor(card, verb), null, `Composer must not guess a ${verb} command`);
  }
});

test('Terraform and OpenTofu seed their own format and lint commands', async () => {
  const ids = ['composer', 'terraform', 'opentofu'];
  const records = loadEcosystems().filter((entry) => ids.includes(entry.id));
  assert.equal(new Set(records.map((entry) => entry.manifestOrder)).size, records.length);
  assert.deepEqual(ecosystemGateRows().filter((entry) => ids.includes(entry.id)).map((entry) => entry.id), ids);

  for (const example of [
    { file: 'main.tf', fact: 'has-terraform', gateFact: 'has-terraform-root', id: 'terraform', tool: 'terraform' },
    { file: 'main.tofu', fact: 'has-opentofu', gateFact: 'has-opentofu-root', id: 'opentofu', tool: 'tofu' },
  ]) {
    const found = await detect({ [example.file]: '' });
    assert.ok(found.facts.includes(example.fact));
    assert.ok(found.facts.includes(example.gateFact));
    const row = ecosystemGateRows(found.root).find((entry) => entry.id === example.id);
    assert.equal(row.fact, example.gateFact);
    assert.equal(row.tool, example.tool);
    assert.deepEqual(row.preCommit, ['format']);
    assert.deepEqual(row.prePush, ['lint']);
    assert.deepEqual(row.commands, {
      format: `${example.tool} fmt -check -recursive`,
      lint: `${example.tool} validate`,
    });

    const planned = planGates(
      found.stack,
      { tools: [example.tool], scripts: {}, binaries: [], commands: {}, runner: 'none' },
      found.facts,
      found.root,
    );
    assert.deepEqual(planned.gates, { preCommit: ['format'], prePush: ['lint'] });
    assert.deepEqual(planned.commands, row.commands);

    const card = await commandCard({ root: found.root, stack: found.stack, facts: found.facts });
    assert.equal(commandFor(card, 'format'), row.commands.format);
    assert.equal(commandFor(card, 'lint'), row.commands.lint);
    for (const verb of ['build', 'test', 'typecheck']) {
      assert.equal(commandFor(card, verb), null, `${example.id} must not guess a ${verb} command`);
    }
  }
});

test('nested Terraform and OpenTofu modules keep coverage without seeding root commands', async () => {
  for (const example of [
    { file: 'infra/network/main.tf', fact: 'has-terraform', rootFact: 'has-terraform-root', tool: 'terraform' },
    { file: 'infra/network/main.tofu', fact: 'has-opentofu', rootFact: 'has-opentofu-root', tool: 'tofu' },
  ]) {
    const found = await detect({ [example.file]: '' });
    assert.ok(found.facts.includes(example.fact));
    assert.equal(found.facts.includes(example.rootFact), false);
    assert.deepEqual(defaultGates(found.stack, found.facts, found.root), defaultGates(found.stack, [], found.root));
    const planned = planGates(
      found.stack,
      { tools: [example.tool], scripts: {}, binaries: [], commands: {}, runner: 'none' },
      found.facts,
      found.root,
    );
    assert.deepEqual(planned.gates, { preCommit: [], prePush: [] });
    assert.deepEqual(planned.commands, {});
    assert.deepEqual((await commandCard({ root: found.root, stack: found.stack, facts: found.facts })).lines, []);
  }
});

test('mixed Terraform and OpenTofu roots scope duplicate gate names', async () => {
  const found = await detect({ 'main.tf': '', 'main.tofu': '' });
  assert.deepEqual(defaultGates(found.stack, found.facts, found.root), {
    preCommit: ['format', 'format@opentofu'],
    prePush: ['lint', 'lint@opentofu'],
  });
  const planned = planGates(
    found.stack,
    { tools: ['terraform', 'tofu'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    found.facts,
    found.root,
  );
  assert.deepEqual(planned.commands, {
    format: 'terraform fmt -check -recursive',
    'format@opentofu': 'tofu fmt -check -recursive',
    lint: 'terraform validate',
    'lint@opentofu': 'tofu validate',
  });
});

test('Bun reuses Node script gates and the card runs committed scripts through Bun', async () => {
  const found = await detect({
    'package.json': {
      name: 'example/bun',
      scripts: { build: 'node -e 0', lint: 'node -e 0', test: 'node --test test/*.test.mjs' },
    },
    'bun.lock': '',
  });
  assert.equal(loadEcosystems(found.root).find((entry) => entry.id === 'bun').manifestOrder, undefined);
  assert.equal(ecosystemGateRows(found.root).some((entry) => entry.id === 'bun' || entry.id === 'node'), false);
  assert.deepEqual(defaultGates(found.stack, found.facts, found.root), defaultGates(found.stack, [], found.root));

  const card = await commandCard({ root: found.root, stack: found.stack, facts: found.facts });
  assert.equal(commandFor(card, 'build'), 'bun run build');
  assert.equal(commandFor(card, 'lint'), 'bun run lint');
  assert.equal(commandFor(card, 'test'), 'bun run test');
  assert.equal(commandFor(card, 'focused test (Node)'), 'node --test {file}');

  const rule = (await loadRules(found.root)).find((entry) => entry.id === 'bun');
  assert.match(rule.body, /bun run <script>/);
  assert.match(rule.body, /manager-neutral/);
  assert.match(rule.body, /npx/);
});

test('container-adjacent records keep guidance and Dependabot but seed no guessed gates or card commands', async () => {
  const ids = ['docker', 'docker-compose', 'devcontainers', 'gitsubmodule'];
  assert.deepEqual(ids.filter((id) => ecosystemGateRows().some((entry) => entry.id === id)), []);

  for (const files of [
    { Dockerfile: 'FROM scratch\n' },
    { 'compose.yml': 'services: {}\n' },
    { '.devcontainer/devcontainer.json': { image: 'example/dev' } },
    { '.gitmodules': '' },
  ]) {
    const found = await detect(files);
    const card = await commandCard({ root: found.root, stack: found.stack, facts: found.facts });
    assert.deepEqual(card.lines, []);
    assert.equal(card.text, '');
  }
});
