// Q70: an ecosystem is a data record under `ecosystems/`, not a row in a table the
// engine edits (ADR-013). This file is the regression net for that ruling, and for
// the four failures the review named as evidence:
//
//   - adding PHP (`has-composer` already exists as a fact) needed 4-5 code edits
//   - a declared `build` or `e2e` gate failed as "unknown gate"
//   - `fingerprint.mjs` carried an estate-specific `wear-os` rule
//   - the W06 facets (card lines, Dependabot entries, language tables) lived in
//     separate tables that could drift apart from the gate rows
//
// The byte-identity groups pin the views against the tables they replace: if a
// facet ever needs a code edit again to make a product work, one of them fails.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cardBuilds,
  cardFallbacks,
  cardFocused,
  dependabotEntries,
  ecosystemGateRows,
  languageExts,
  languageResolver,
  loadEcosystems,
  testConventions,
} from '../src/ecosystem/records.mjs';
import { ecosystems } from '../src/ci/dependabot.mjs';
import { GATES, getGate } from '../src/hooks/gates.mjs';
import { gateRunnable } from '../src/projection/manifest.mjs';
import { fingerprint, STACK_TAGS } from '../src/resolve/fingerprint.mjs';
import { isTestPath } from '../src/testing/paths.mjs';

async function tmpRoot() {
  return await mkdtemp(join(tmpdir(), 'ecosystem-records-'));
}

// --- The records load --------------------------------------------------------

test('the shipped records load, one per file, ids unique', () => {
  const records = loadEcosystems();
  assert.equal(records.length, 20);
  assert.equal(new Set(records.map((r) => r.id)).size, 20);
});

test('composer is PHP-as-data: one record drives Dependabot with no code edit', () => {
  assert.deepEqual(
    dependabotEntries().find((e) => e.value === 'composer'),
    { fact: 'has-composer', value: 'composer', manifest: 'composer.json' },
  );
  // End to end: a repo with nothing but a composer.json gets an entry. Before Q70
  // this needed a row added to the table in ci/dependabot.mjs.
  assert.deepEqual(ecosystems(['has-composer']), [{ value: 'composer', manifest: 'composer.json' }]);
});

// --- Declared command gates ----------------------------------------------------

test('a name under gates.commands is a valid command gate, synthesized not central', () => {
  assert.deepEqual(getGate('e2e', { e2e: 'playwright test' }), {
    name: 'e2e',
    kind: 'command',
    adr: 'ADR-010',
    why: 'declared by the repository under gates.commands',
  });
  assert.equal(getGate('e2e'), null, 'a name with no declared command is not a gate');
  assert.equal(getGate('e2e', { e2e: '   ' }), null, 'a blank command is not a command');
});

test('a central gate is never shadowed by a declared command', () => {
  assert.deepEqual(getGate('test', { test: 'something else' }), GATES.test);
});

test('gateRunnable accepts the declared command for a synthesized gate', () => {
  const gate = getGate('build', { build: 'mix compile' });
  assert.deepEqual(gateRunnable(gate, { commands: { build: 'mix compile' } }), {
    runnable: true,
    why: 'runs: mix compile',
  });
  assert.deepEqual(gateRunnable(null, {}), { runnable: false, why: 'unknown gate' });
});

// --- The estate special case is gone ------------------------------------------

test('a wear/ directory no longer emits the wear-os stack tag', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'wear'));
  await writeFile(join(root, 'wear', 'app.js'), '// a module that is not a wearable\n');
  const fp = await fingerprint(root);
  assert.ok(!fp.stack.includes('wear-os'), `stack: ${fp.stack.join(', ')}`);
  assert.ok(!fp.signals.includes('wear-os'));
  assert.ok(!fp.evidence.includes('wear/'));
  assert.ok(!STACK_TAGS.has('wear-os'), 'wear-os is no longer a stack tag the tool can emit');
});

// --- Byte identity with the tables the views replace ---------------------------

test('ecosystemGateRows reproduces the pre-Q70 manifest table byte for byte', () => {
  assert.deepEqual(ecosystemGateRows(), [
    {
      fact: 'has-cargo-toml',
      tool: 'cargo',
      preCommit: ['format', 'lint'],
      prePush: ['test'],
      commands: { format: 'cargo fmt --check', lint: 'cargo clippy -- -D warnings', test: 'cargo test' },
    },
    {
      fact: 'has-go-mod',
      tool: 'go',
      preCommit: ['format', 'lint'],
      prePush: ['test'],
      commands: { format: 'test -z "$(gofmt -l .)"', lint: 'go vet ./...', test: 'go test ./...' },
    },
    {
      fact: 'has-nuget',
      tool: 'dotnet',
      preCommit: ['format'],
      prePush: ['test', 'typecheck'],
      commands: { format: 'dotnet format --verify-no-changes', test: 'dotnet test', typecheck: 'dotnet build -warnaserror' },
    },
    {
      fact: 'has-swift-package',
      tool: 'swift',
      preCommit: ['format'],
      prePush: ['test', 'typecheck'],
      commands: { format: 'swift format lint -r .', test: 'swift test', typecheck: 'swift build' },
    },
    {
      fact: 'has-deno-config',
      tool: 'deno',
      preCommit: ['format', 'lint'],
      prePush: ['test', 'typecheck'],
      commands: { format: 'deno fmt --check', lint: 'deno lint', test: 'deno test', typecheck: 'deno check .' },
    },
    {
      fact: 'has-gemfile',
      tool: 'bundle',
      preCommit: ['format'],
      prePush: ['test'],
      commands: { format: 'bundle exec rubocop', test: 'bundle exec rspec' },
    },
    {
      fact: 'has-pubspec',
      tool: 'dart',
      preCommit: ['format', 'lint'],
      prePush: ['test'],
      commands: { format: 'dart format --output=none --set-exit-if-changed .', lint: 'dart analyze', test: 'dart test' },
    },
    {
      fact: 'has-mix',
      tool: 'mix',
      preCommit: ['format'],
      prePush: ['test'],
      commands: { format: 'mix format --check-formatted', test: 'mix test' },
    },
    // The Maven row has no preCommit: the wrapper is a file the repository commits,
    // and a repo with a pom.xml and no wrapper cannot run `./mvnw -q verify`.
    { fact: 'has-maven-pom', tool: 'mvnw', file: true, prePush: ['test'], commands: { test: './mvnw -q verify' } },
  ]);
});

test('dependabotEntries reproduces the pre-Q70 table in its order', () => {
  assert.deepEqual(dependabotEntries(), [
    { stack: 'node', value: 'npm', manifest: 'package.json' },
    { stack: 'typescript', value: 'npm', manifest: 'package.json' },
    { fact: 'has-pyproject', value: 'pip', manifest: 'pyproject.toml' },
    { fact: 'has-requirements', value: 'pip', manifest: 'requirements.txt' },
    { fact: 'has-go-mod', value: 'gomod', manifest: 'go.mod' },
    { fact: 'has-cargo-toml', value: 'cargo', manifest: 'Cargo.toml' },
    { fact: 'has-gemfile', value: 'bundler', manifest: 'Gemfile' },
    { fact: 'has-composer', value: 'composer', manifest: 'composer.json' },
    { fact: 'has-maven-pom', value: 'maven', manifest: 'pom.xml' },
    { fact: 'has-dockerfile', value: 'docker', manifest: 'Dockerfile' },
    { fact: 'has-compose', value: 'docker-compose', manifest: 'compose file' },
    { fact: 'has-terraform', value: 'terraform', manifest: '*.tf' },
    { stack: 'gradle', value: 'gradle', manifest: 'build.gradle' },
    { fact: 'has-submodules', value: 'gitsubmodule', manifest: '.gitmodules' },
    { fact: 'has-nuget', value: 'nuget', manifest: '*.csproj' },
    { fact: 'has-pubspec', value: 'pub', manifest: 'pubspec.yaml' },
    { fact: 'has-swift-package', value: 'swift', manifest: 'Package.swift' },
    { fact: 'has-mix', value: 'mix', manifest: 'mix.exs' },
    { fact: 'has-uv-lock', value: 'uv', manifest: 'uv.lock' },
    { fact: 'has-bun-lock', value: 'bun', manifest: 'bun.lock' },
    { fact: 'has-devcontainer', value: 'devcontainers', manifest: 'devcontainer.json' },
  ]);
});

test('cardBuilds reproduces the pre-Q70 build table', () => {
  assert.deepEqual(cardBuilds(), [
    { condition: { fact: 'has-cargo-toml' }, command: 'cargo build' },
    { condition: { fact: 'has-go-mod' }, command: 'go build ./...' },
    { condition: { fact: 'has-nuget' }, command: 'dotnet build' },
    { condition: { fact: 'has-swift-package' }, command: 'swift build' },
    { condition: { fact: 'has-mix' }, command: 'mix compile' },
    { condition: { stack: 'gradle' }, command: './gradlew build' },
  ]);
});

test('cardFocused reproduces the pre-Q70 focused table, the Node row as a template object', () => {
  assert.deepEqual(cardFocused(), [
    { kind: 'Android', condition: { fact: 'has-android-manifest' }, template: './gradlew :{module}:testDebugUnitTest --tests {class}' },
    { kind: 'JVM', condition: { stack: 'gradle' }, template: './gradlew test --tests {class}' },
    { kind: 'Maven', condition: { fact: 'has-maven-pom' }, template: './mvnw test -Dtest={class}' },
    { kind: 'Go package', condition: { fact: 'has-go-mod' }, template: 'go test ./{pkg} -run {Test}' },
    { kind: 'Rust', condition: { fact: 'has-cargo-toml' }, template: 'cargo test {name}' },
    { kind: 'Python', condition: { fact: 'has-uv-lock' }, template: 'uv run -m pytest {file}::{test}' },
    { kind: 'Python', condition: { facts: ['has-pyproject', 'has-requirements'] }, template: 'pytest {file}::{test}' },
    { kind: '.NET', condition: { fact: 'has-nuget' }, template: 'dotnet test --filter {test}' },
    { kind: 'Swift', condition: { fact: 'has-swift-package' }, template: 'swift test --filter {test}' },
    { kind: 'Deno', condition: { fact: 'has-deno-config' }, template: 'deno test {file}' },
    { kind: 'Ruby', condition: { fact: 'has-gemfile' }, template: 'bundle exec rspec {file}' },
    { kind: 'Dart', condition: { fact: 'has-pubspec' }, template: 'dart test {file}' },
    { kind: 'Elixir', condition: { fact: 'has-mix' }, template: 'mix test {file}' },
    // The one row whose shape depends on the repo's own runner: a static default and
    // a dynamic form resolved against the committed test script, never `npx` (ADR-010).
    {
      kind: 'Node',
      condition: { stack: 'node' },
      template: { static: 'node --test {file}', ifScriptMatches: 'vitest|jest', dynamic: '{runner} test -- {file}' },
    },
  ]);
});

test('cardFallbacks reproduces the pre-Q70 fallback table', () => {
  assert.deepEqual(cardFallbacks(), [
    { condition: { fact: 'has-uv-lock' }, commands: { test: 'uv run -m pytest' } },
    { condition: { facts: ['has-pyproject', 'has-requirements'] }, commands: { test: 'pytest' } },
  ]);
});

// --- The language tables -------------------------------------------------------

test('languageExts reproduces the pre-Q70 extension table', () => {
  assert.deepEqual(languageExts(), {
    javascript: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
    typescript: ['.ts', '.tsx', '.js', '.mjs', '.jsx'],
    kotlin: ['.kt', '.kts'],
    java: ['.java'],
    python: ['.py'],
    go: ['.go'],
    rust: ['.rs'],
    swift: ['.swift'],
    dart: ['.dart'],
    ruby: ['.rb'],
    csharp: ['.cs'],
  });
});

test('languageResolver reproduces the pre-Q70 resolver map', () => {
  assert.deepEqual(languageResolver(), {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    kt: 'kotlin',
    kts: 'kotlin',
    java: 'java',
    py: 'python',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    dart: 'dart',
    rb: 'ruby',
    cs: 'csharp',
  });
});

test('testConventions dedupes to exactly the two pre-Q70 regex sources', () => {
  // Sorted: the records arrive in readdir order, and the invariant is the SET of
  // sources, not their order — a positional pin would fail on a reordered readdir.
  const sources = [...new Set(testConventions().flatMap((c) => c.base ?? []))].sort();
  assert.deepEqual(sources, ['^test_[^/]+\\.py$', 'Tests?\\.(?:java|kt)$'].sort());
});

test('isTestPath keeps the pre-Q70 classification through the data-driven patterns', () => {
  assert.equal(isTestPath('test_foo.py'), true, 'pytest convention');
  assert.equal(isTestPath('FooTest.java'), true, 'JVM convention');
  assert.equal(isTestPath('BarTests.kt'), true, 'JVM convention');
  assert.equal(isTestPath('src/App.kt'), false, 'production kotlin');
  assert.equal(isTestPath('lib/util.py'), false, 'production python');
});

// --- Repo-local overrides ------------------------------------------------------

test('a repo-local .simt/ecosystems/ overrides the shipped set', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, '.simt', 'ecosystems');
  await mkdir(local, { recursive: true });
  // A same-id record that omits a field keeps the shipped one: the merge is shallow.
  await writeFile(join(local, 'composer.json'), JSON.stringify({ id: 'composer' }));
  // A new id appends.
  await writeFile(
    join(local, 'myeco.json'),
    JSON.stringify({ id: 'myeco', dependabot: [{ order: 99, fact: 'has-myeco', value: 'myeco', manifest: 'myeco.toml' }] }),
  );
  // A record that does not parse is skipped, never a crash: the shipped set wins.
  await writeFile(join(local, 'broken.json'), '{ not json');

  const records = loadEcosystems(root);
  const composer = records.find((r) => r.id === 'composer');
  assert.equal(composer.dependabot[0].manifest, 'composer.json', 'omitted field keeps the shipped value');
  assert.ok(records.some((r) => r.id === 'myeco'), 'a new id appends');
  assert.equal(records.length, 21, 'the broken record is skipped, not fatal');

  assert.deepEqual(
    dependabotEntries(root).find((e) => e.value === 'myeco'),
    { fact: 'has-myeco', value: 'myeco', manifest: 'myeco.toml' },
  );
});

test('a root with no .simt/ reads the shipped set alone', async () => {
  const root = await tmpRoot();
  await rm(root, { recursive: true, force: true });
  assert.deepEqual(loadEcosystems(root), loadEcosystems());
});
