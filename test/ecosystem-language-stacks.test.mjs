import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ecosystems } from '../src/ci/dependabot.mjs';
import {
  dependabotEntries,
  ecosystemGateRows,
  languageExts,
  languageResolver,
  loadEcosystems,
} from '../src/ecosystem/records.mjs';
import { validateRecord } from '../src/ecosystem/schema.mjs';
import { defaultGates, planGates } from '../src/gates/index.mjs';
import { CARD_LIMIT_BYTES, commandCard } from '../src/kernel/card.mjs';
import { langOf } from '../src/index/store.mjs';
import { desiredRegion, loadRules } from '../src/projection/rules.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';
import { isTestPath } from '../src/testing/paths.mjs';
import { tempDir } from './fixture.mjs';

async function repo(files = {}) {
  const root = await tempDir('simt-language-stacks-');
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    if (body === null) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    }
  }
  return root;
}

async function cardFor(root) {
  const { stack, facts } = await fingerprint(root);
  return commandCard({ root, stack, facts });
}

function profileCount(region, id) {
  return region.profiles.filter((profile) => profile === id).length;
}

function focused(card, kind) {
  return card.lines.filter((line) => line.verb === 'focused' && line.kind === kind);
}

test('SE04 records and profiles validate without seeding C++ or Erlang gates', async () => {
  for (const id of ['dotnet', 'cpp', 'erlang']) {
    const record = loadEcosystems().find((entry) => entry.id === id);
    assert.ok(record, `${id} record is missing`);
    const checked = validateRecord(id, record);
    assert.equal(checked.ok, true, checked.problems?.join('\n'));
  }

  const rules = await loadRules();
  for (const id of ['fsharp', 'cpp', 'erlang']) {
    const rule = rules.find((entry) => entry.id === id);
    assert.ok(rule, `${id} profile is missing`);
    assert.equal(rule.error, null, rule.error);
    for (const line of rule.body.split('\n')) {
      if (line.startsWith('Applies to:')) assert.doesNotMatch(line, /has-[a-z0-9-]+/);
    }
  }

  const rows = ecosystemGateRows();
  assert.equal(rows.filter((row) => row.fact === 'has-dotnet-root').length, 1);
  assert.equal(rows.filter((row) => row.fact === 'has-fsharp').length, 0);
  assert.deepEqual(rows.filter((row) => row.id === 'cpp' || row.id === 'erlang'), []);
  for (const id of ['cpp', 'erlang']) {
    const record = loadEcosystems().find((entry) => entry.id === id);
    assert.equal(record.manifestOrder, undefined);
    assert.equal(record.gates, undefined);
  }
});

test('a nested F# project proves NuGet and F# evidence and selects each profile once', async () => {
  const root = await repo({
    'apps/Service/Service.fsproj': '<Project/>\n',
    'apps/Service/Library.fs': 'module Library\n',
    'apps/Service/Script.fsx': 'printfn "script"\n',
    'apps/Service/Library.fsi': 'val value: int\n',
    'tests/ServiceTests.fs': 'module ServiceTests\n',
  });
  const print = await fingerprint(root);
  assert.ok(print.facts.includes('has-fsharp'));
  assert.ok(print.facts.includes('has-nuget'));
  assert.equal(print.factEvidence['has-fsharp'], 'apps/Service/Service.fsproj');
  assert.equal(print.factEvidence['has-nuget'], 'apps/Service/Service.fsproj');

  const region = await desiredRegion(root, {});
  assert.equal(profileCount(region, 'dotnet'), 1);
  assert.equal(profileCount(region, 'fsharp'), 1);
  assert.equal(new Set(region.profiles).size, region.profiles.length);

  for (const ext of ['fs', 'fsx', 'fsi']) {
    assert.equal(languageResolver(root)[ext], 'fsharp');
    assert.equal(langOf(`apps/Service/Library.${ext}`, root), 'fsharp');
  }
  assert.equal(languageResolver(root).cs, 'csharp');
  assert.deepEqual(languageExts(root).fsharp, ['.fs', '.fsx', '.fsi']);
  assert.equal(isTestPath('tests/ServiceTests.fs', root), true);
  assert.equal(isTestPath('apps/Service/UnitTests.fs', root), true);
  assert.equal(isTestPath('apps/Service/Library.fs', root), false);

  const nuget = dependabotEntries(root).filter((entry) => entry.value === 'nuget');
  assert.deepEqual(nuget.map((entry) => entry.manifest).sort(), ['*.csproj', '*.fsproj']);
  assert.deepEqual(ecosystems(print.facts, print.stack, root).filter((entry) => entry.value === 'nuget'), [
    { value: 'nuget', manifest: '*.csproj' },
  ]);

  assert.equal(print.facts.includes('has-dotnet-root'), false);
  assert.deepEqual(defaultGates(print.stack, print.facts, root), defaultGates(print.stack, [], root));
  const planned = planGates(
    print.stack,
    { tools: ['dotnet'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    print.facts,
    root,
  );
  assert.deepEqual(planned.gates, { preCommit: [], prePush: [] });
  assert.deepEqual(planned.commands, {});
  assert.deepEqual((await cardFor(root)).lines, []);
});

test('a root F# project seeds runnable .NET gates and card commands', async () => {
  const root = await repo({ 'Service.fsproj': '<Project/>\n', 'Library.fs': 'module Library\n' });
  const print = await fingerprint(root);
  assert.ok(print.facts.includes('has-dotnet-root'));
  assert.ok(print.facts.includes('has-fsharp'));
  assert.ok(print.facts.includes('has-nuget'));
  assert.equal(print.factEvidence['has-dotnet-root'], 'Service.fsproj');

  const planned = planGates(
    print.stack,
    { tools: ['dotnet'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    print.facts,
    root,
  );
  assert.deepEqual(planned.gates, { preCommit: ['format'], prePush: ['test', 'typecheck'] });
  assert.deepEqual(planned.commands, {
    format: 'dotnet format --verify-no-changes',
    test: 'dotnet test',
    typecheck: 'dotnet build -warnaserror',
  });
  const card = await cardFor(root);
  assert.equal(card.lines.find((line) => line.verb === 'build')?.command, 'dotnet build');
  assert.equal(focused(card, '.NET')[0].command, 'dotnet test --filter {test}');
});

test('F# sources alone do not select .NET, while a C# project selects only dotnet', async () => {
  const sources = await repo({
    'src/App.fs': 'module App\n',
    'src/Script.fsx': 'printfn "script"\n',
    'src/App.fsproj.bak': '<Project/>\n',
    'fake/App.fsproj': null,
  });
  const sourcePrint = await fingerprint(sources);
  assert.equal(sourcePrint.facts.includes('has-fsharp'), false);
  assert.equal(sourcePrint.facts.includes('has-nuget'), false);
  const sourceRegion = await desiredRegion(sources, {});
  assert.equal(profileCount(sourceRegion, 'dotnet'), 0);
  assert.equal(profileCount(sourceRegion, 'fsharp'), 0);
  assert.deepEqual((await cardFor(sources)).lines, []);

  const csharp = await repo({ 'App.csproj': '<Project/>\n' });
  const csharpPrint = await fingerprint(csharp);
  assert.equal(csharpPrint.facts.includes('has-nuget'), true);
  assert.equal(csharpPrint.facts.includes('has-dotnet-root'), true);
  assert.equal(csharpPrint.facts.includes('has-fsharp'), false);
  const csharpRegion = await desiredRegion(csharp, {});
  assert.equal(profileCount(csharpRegion, 'dotnet'), 1);
  assert.equal(profileCount(csharpRegion, 'fsharp'), 0);
});

for (const row of [
  {
    name: 'CMake',
    files: { 'src/widget/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n' },
    fact: 'has-cmake',
    evidence: 'src/widget/CMakeLists.txt',
    absent: 'has-meson',
    kind: 'CMake',
    build: 'if [ -f meson.build ]; then meson compile -C build; else cmake --build build; fi',
    template: 'ctest --test-dir build -R {test}',
  },
  {
    name: 'Meson',
    files: { 'meson.build': "project('widget', 'c')\n" },
    fact: 'has-meson',
    evidence: 'meson.build',
    absent: 'has-cmake',
    kind: 'Meson',
    build: 'if [ -f meson.build ]; then meson compile -C build; else cmake --build build; fi',
    template: 'meson test -C build {test}',
  },
]) {
  test(`${row.name} evidence selects its conventional card and the cpp profile`, async () => {
    const root = await repo(row.files);
    const print = await fingerprint(root);
    assert.ok(print.facts.includes(row.fact));
    assert.equal(print.factEvidence[row.fact], row.evidence);
    assert.equal(print.facts.includes(row.absent), false);

    const region = await desiredRegion(root, {});
    assert.equal(profileCount(region, 'cpp'), 1);
    const card = await cardFor(root);
    const build = card.lines.find((line) => line.verb === 'build')?.command ?? '';
    assert.equal(build, row.build);
    assert.equal(focused(card, row.kind).length, 1);
    assert.equal(focused(card, row.kind)[0].command, row.template);
    assert.ok(card.bytes <= CARD_LIMIT_BYTES);
    assert.equal(ecosystemGateRows(root).some((entry) => entry.fact === row.fact), false);

    assert.equal(languageResolver(root).c, 'c');
    assert.equal(languageResolver(root).cpp, 'cpp');
    assert.equal(langOf('src/widget.c', root), 'c');
    assert.equal(langOf('src/widget.cpp', root), 'cpp');
    assert.equal(isTestPath('src/widget_test.cpp', root), true);
    assert.equal(isTestPath('src/test_parser.c', root), true);
    assert.equal(isTestPath('src/widget.cpp', root), false);
  });
}

test('C++ source and lookalike build files do not prove CMake or Meson', async () => {
  const root = await repo({
    'src/main.cpp': 'int main() {}\n',
    'CMakeLists.txt.bak': 'not a build definition\n',
    'docs/meson.build.md': 'not a build definition\n',
    'fake/CMakeLists.txt': null,
  });
  const print = await fingerprint(root);
  assert.equal(print.facts.includes('has-cmake'), false);
  assert.equal(print.facts.includes('has-meson'), false);
  assert.equal(profileCount(await desiredRegion(root, {}), 'cpp'), 0);
  assert.deepEqual((await cardFor(root)).lines, []);
});

for (const row of [
  {
    name: 'rebar3',
    files: { 'rebar.config': '{deps, []}.\n' },
    fact: 'has-rebar',
    absent: 'has-erlang-mk',
    kind: 'rebar3',
    build: 'if [ -f erlang.mk ]; then make; else rebar3 compile; fi',
    template: 'rebar3 ct --suite={test}',
  },
  {
    name: 'erlang.mk',
    files: { 'erlang.mk': 'include erlang.mk\n' },
    fact: 'has-erlang-mk',
    absent: 'has-rebar',
    kind: 'erlang.mk',
    build: 'if [ -f erlang.mk ]; then make; else rebar3 compile; fi',
    template: 'make ct CT_OPTS="-suite {test}"',
  },
]) {
  test(`${row.name} evidence selects its conventional card and the erlang profile`, async () => {
    const root = await repo(row.files);
    const print = await fingerprint(root);
    assert.ok(print.facts.includes(row.fact));
    assert.equal(print.factEvidence[row.fact], Object.keys(row.files)[0]);
    assert.equal(print.facts.includes(row.absent), false);

    const region = await desiredRegion(root, {});
    assert.equal(profileCount(region, 'erlang'), 1);
    const card = await cardFor(root);
    const build = card.lines.find((line) => line.verb === 'build')?.command ?? '';
    assert.equal(build, row.build);
    assert.equal(focused(card, row.kind).length, 1);
    assert.equal(focused(card, row.kind)[0].command, row.template);
    assert.ok(card.bytes <= CARD_LIMIT_BYTES);
    assert.equal(ecosystemGateRows(root).some((entry) => entry.fact === row.fact), false);

    assert.equal(languageResolver(root).erl, 'erlang');
    assert.equal(languageResolver(root).hrl, 'erlang');
    assert.equal(langOf('src/login.erl', root), 'erlang');
    assert.equal(langOf('include/login.hrl', root), 'erlang');
    assert.equal(isTestPath('src/login_SUITE.erl', root), true);
    assert.equal(isTestPath('src/login_tests.erl', root), true);
    assert.equal(isTestPath('src/login.erl', root), false);
  });
}

test('Erlang source and nested or renamed build files do not prove a runner', async () => {
  const root = await repo({
    'src/app.erl': '-module(app).\n',
    'nested/rebar.config': '{deps, []}.\n',
    'rebar.config.bak': '{deps, []}.\n',
    'erlang.mk.disabled': 'include erlang.mk\n',
  });
  const print = await fingerprint(root);
  assert.equal(print.facts.includes('has-rebar'), false);
  assert.equal(print.facts.includes('has-erlang-mk'), false);
  assert.equal(profileCount(await desiredRegion(root, {}), 'erlang'), 0);
  assert.deepEqual((await cardFor(root)).lines, []);
});

test('mixed build definitions select one profile and one focused runner per ecosystem', async () => {
  const cpp = await repo({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n',
    'meson.build': "project('widget', 'c')\n",
  });
  assert.equal(profileCount(await desiredRegion(cpp, {}), 'cpp'), 1);
  const cppCard = await cardFor(cpp);
  assert.equal(cppCard.lines.filter((line) => line.verb === 'focused').length, 1);
  assert.equal(focused(cppCard, 'CMake').length, 0);
  assert.equal(focused(cppCard, 'Meson').length, 1);

  const erlang = await repo({ 'rebar.config': '{deps, []}.\n', 'erlang.mk': 'include erlang.mk\n' });
  assert.equal(profileCount(await desiredRegion(erlang, {}), 'erlang'), 1);
  const erlangCard = await cardFor(erlang);
  assert.equal(erlangCard.lines.filter((line) => line.verb === 'focused').length, 1);
  assert.equal(focused(erlangCard, 'rebar3').length, 0);
  assert.equal(focused(erlangCard, 'erlang.mk').length, 1);
});
