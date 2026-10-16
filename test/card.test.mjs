// The command card: the exact commands for this repository, at the top of the region (R10).
//
// Three questions, and the third is the one a reader's trust depends on. Does the card
// carry the commands a repository can actually run, per ecosystem? Is it byte-stable and
// under its 600 B ceiling? And does it lead the region in BOTH modes — because a card that
// appeared only in `kernel` would be absent for every repository that kept the default,
// which is the reader who has the commands nowhere else.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { CARD_LIMIT_BYTES, commandCard } from '../src/kernel/card.mjs';
import { buildManifest, ECOSYSTEMS } from '../src/projection/manifest.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';

/** A throwaway repository. A `null` value makes a directory. */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-card-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body ?? '');
  }
  return root;
}

/** The card for a fixture, computed the way `desiredRegion` computes it. */
async function cardFor(root, manifest = null) {
  const { stack, facts } = await fingerprint(root);
  const card = await commandCard({ root, manifest, stack, facts });
  if (manifest === null) assert.ok(card.lines.length > 0, 'a fixture with a marker must carry a card');
  return card;
}

function commandFor(card, label) {
  return card.lines.find((line) => line.label === label)?.command ?? null;
}

// ------------------------------------------------------------------ ten ecosystems, one card each

// Every fixture below proves one ecosystem by a marker file alone, so the card is derived
// from committed evidence and nothing else. `expect` is the command the card must name for
// each verb; the ecosystem table is the source of truth for the non-npm rows, which is the
// point — the card and the gate list must not name two different commands for one repo.
const ECOSYSTEMS_FIXTURES = [
  {
    name: 'node',
    files: {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', 'format:check': 'prettier --check .', typecheck: 'tsc --noEmit' },
      }),
    },
    expect: { build: 'npm run build', test: 'npm run test', lint: 'npm run lint', format: 'npm run format:check', typecheck: 'npm run typecheck' },
    focused: 'npm test -- {file}',
  },
  {
    name: 'cargo',
    files: { 'Cargo.toml': '[package]\nname = "x"\n' },
    expect: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings', format: 'cargo fmt --check' },
    focused: 'cargo test {name}',
  },
  {
    name: 'go',
    files: { 'go.mod': 'module x\n' },
    expect: { build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...', format: 'test -z "$(gofmt -l .)"' },
    focused: 'go test ./{pkg} -run {Test}',
  },
  {
    name: 'python',
    files: { 'pyproject.toml': '[project]\nname = "x"\n' },
    expect: { test: 'pytest' },
    focused: 'pytest {file}::{test}',
  },
  {
    name: 'uv',
    files: { 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': 'version = 1\n' },
    // The uv profile forbids the console script: `uv run pytest` can import a different
    // copy of the package than the one under test. The card must say `-m pytest`.
    expect: { test: 'uv run -m pytest' },
    focused: 'uv run -m pytest {file}::{test}',
  },
  {
    name: 'gradle',
    files: { 'build.gradle.kts': 'plugins { kotlin("jvm") }\n', gradlew: '#!/bin/sh\n' },
    expect: { build: './gradlew build' },
    focused: './gradlew test --tests {class}',
  },
  {
    name: 'android',
    files: { 'build.gradle.kts': 'plugins { id("com.android.application") }\n', 'app/src/main/AndroidManifest.xml': '<manifest/>\n', gradlew: '#!/bin/sh\n' },
    expect: {},
    focused: './gradlew :{module}:testDebugUnitTest --tests {class}',
  },
  {
    name: 'maven',
    files: { 'pom.xml': '<project/>\n', mvnw: '#!/bin/sh\n' },
    expect: { test: './mvnw -q verify' },
    focused: './mvnw test -Dtest={class}',
  },
  {
    name: 'dotnet',
    files: { 'App.csproj': '<Project/>\n' },
    expect: { build: 'dotnet build', test: 'dotnet test', format: 'dotnet format --verify-no-changes', typecheck: 'dotnet build -warnaserror' },
    focused: 'dotnet test --filter {test}',
  },
  {
    name: 'swift',
    files: { 'Package.swift': '// swift-tools-version:5.9\n' },
    expect: { build: 'swift build', test: 'swift test', format: 'swift format lint -r .', typecheck: 'swift build' },
    focused: 'swift test --filter {test}',
  },
  {
    name: 'deno',
    files: { 'deno.json': '{}\n' },
    expect: { test: 'deno test', lint: 'deno lint', format: 'deno fmt --check', typecheck: 'deno check .' },
    focused: 'deno test {file}',
  },
  {
    name: 'ruby',
    files: { Gemfile: 'source "https://rubygems.org"\n' },
    expect: { test: 'bundle exec rspec', format: 'bundle exec rubocop' },
    focused: 'bundle exec rspec {file}',
  },
  {
    name: 'dart',
    files: { 'pubspec.yaml': 'name: x\n' },
    expect: { test: 'dart test', lint: 'dart analyze', format: 'dart format --output=none --set-exit-if-changed .' },
    focused: 'dart test {file}',
  },
  {
    name: 'elixir',
    files: { 'mix.exs': 'defmodule X do\nend\n' },
    expect: { build: 'mix compile', test: 'mix test', format: 'mix format --check-formatted' },
    focused: 'mix test {file}',
  },
];

test('every ecosystem fixture carries a card under the ceiling with its commands', async () => {
  assert.ok(ECOSYSTEMS_FIXTURES.length >= 10, 'R10 is measured on ten ecosystems or more');

  for (const eco of ECOSYSTEMS_FIXTURES) {
    const root = await fixture(eco.files);
    const card = await cardFor(root);
    assert.ok(
      card.bytes > 0 && card.bytes <= CARD_LIMIT_BYTES,
      `${eco.name}: ${card.bytes} bytes is not within 1..${CARD_LIMIT_BYTES}`,
    );
    assert.match(card.text, /^Commands for this repository:\n\n- /, `${eco.name}: the card has no lead-in`);
    for (const [verb, command] of Object.entries(eco.expect)) {
      assert.equal(commandFor(card, verb), command, `${eco.name}: the ${verb} command is wrong`);
    }
    const focused = card.lines.find((line) => line.verb === 'focused');
    assert.ok(focused, `${eco.name}: a focused-test template is the headline content`);
    assert.equal(focused.command, eco.focused, `${eco.name}: the focused template is wrong`);
    assert.match(focused.label, /^focused test \(/, `${eco.name}: the template is not labelled as one`);
    assert.match(focused.command, /\{|\}/, `${eco.name}: a template must carry its placeholder`);
  }
});

test('the non-npm card commands are the gate table s commands, not a second answer', async () => {
  // The card reuses ECOSYSTEMS so the two cannot drift. Pinned here rather than trusting the
  // fixture list above: a change to the gate table that the card ignored would otherwise be
  // invisible until a repository shipped a command its own gate did not run.
  for (const eco of ECOSYSTEMS) {
    const files = {};
    for (const path of markerFiles(eco.fact)) files[path] = path.endsWith('.csproj') || path.endsWith('.sln') ? '<Project/>\n' : '';
    if (eco.fact === 'has-go-mod') files['go.mod'] = 'module x\n';
    if (eco.fact === 'has-cargo-toml') files['Cargo.toml'] = '[package]\nname = "x"\n';
    if (eco.fact === 'has-gemfile') files.Gemfile = 'source "https://rubygems.org"\n';
    if (eco.fact === 'has-pubspec') files['pubspec.yaml'] = 'name: x\n';
    if (eco.fact === 'has-swift-package') files['Package.swift'] = '// swift-tools-version:5.9\n';
    if (eco.fact === 'has-mix') files['mix.exs'] = 'defmodule X do\nend\n';
    if (eco.fact === 'has-deno-config') files['deno.json'] = '{}\n';
    if (eco.fact === 'has-maven-pom') files['pom.xml'] = '<project/>\n';
    const root = await fixture(files);
    const card = await cardFor(root);
    for (const [verb, command] of Object.entries(eco.commands)) {
      assert.equal(commandFor(card, verb), command, `${eco.fact}: the card changed ${verb}`);
    }
  }
});

/** The marker path each ecosystem's fact is detected by, for the test-building helper. */
function markerFiles(fact) {
  const map = {
    'has-cargo-toml': ['Cargo.toml'],
    'has-go-mod': ['go.mod'],
    'has-nuget': ['App.csproj'],
    'has-swift-package': ['Package.swift'],
    'has-deno-config': ['deno.json'],
    'has-gemfile': ['Gemfile'],
    'has-pubspec': ['pubspec.yaml'],
    'has-mix': ['mix.exs'],
    'has-maven-pom': ['pom.xml'],
  };
  return map[fact] ?? [];
}

test('the card is byte-identical on two renders of the same repository', async () => {
  // The region is required to diff meaningfully across machines (P4, R13). The card reads
  // committed evidence only, so two renders must be equal — this is the test that would
  // fail the day somebody reaches for PATH or node_modules to make a card "more accurate".
  for (const eco of ECOSYSTEMS_FIXTURES) {
    const root = await fixture(eco.files);
    const first = await cardFor(root);
    const second = await cardFor(root);
    assert.equal(first.text, second.text, `${eco.name}: two renders differ`);
    assert.deepEqual(first.lines, second.lines, `${eco.name}: the line list differs`);
  }
});

// ------------------------------------------------------------------ the commands actually run

test('every command on a clean Node card exits 0', async () => {
  // The one ecosystem whose toolchain this package can assume, and the accept criterion R10
  // states: the commands run on a clean fixture. The remaining nine carry the gate table's
  // own commands, asserted equal above; their toolchains are not installed in this image,
  // and installing ten of them to re-run ten commands is not this test's job.
  const root = await fixture({
    'package.json': JSON.stringify({
      name: 'x',
      scripts: { build: 'node -e 0', test: 'node --test test/*.test.mjs', lint: 'node -e 0', 'format:check': 'node -e 0', typecheck: 'node -e 0' },
    }),
    'test/smoke.test.mjs': "import { test } from 'node:test';\ntest('smoke', () => {});\n",
  });
  const card = await cardFor(root);

  const ran = [];
  for (const line of card.lines) {
    if (line.verb === 'focused') continue; // a template is not a command; it is labelled as one
    execFileSync('sh', ['-c', line.command], { cwd: root, stdio: 'pipe' });
    ran.push(line.command);
  }
  assert.deepEqual(ran, ['npm run build', 'npm run test', 'npm run lint', 'npm run format:check', 'npm run typecheck']);
});

// ------------------------------------------------------------------ the card leads the region

test('the card is the first bytes of the region', async () => {
  const root = await fixture({ 'Cargo.toml': '[package]\nname = "x"\n' });
  const desired = await desiredRegion(root, {});
  assert.ok(
    desired.body.startsWith('Commands for this repository:\n'),
    `the card does not lead the region:\n${desired.body.slice(0, 120)}`,
  );
  assert.match(desired.body, /- build: `cargo build`/);
});

test('kernel mode keeps the card, because the mode defers rules and not commands', async () => {
  const root = await fixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
  const manifest = buildManifest({ root, stack: ['python'], sha: 'abc1234', version: '0.2.2' });
  await writeFile(join(root, 'simt.json'), `${JSON.stringify({ ...manifest, mode: 'kernel' }, null, 2)}\n`);

  const desired = await desiredRegion(root, {});
  assert.equal(desired.mode, 'kernel');
  assert.ok(
    desired.body.startsWith('Commands for this repository:\n'),
    'a kernel that dropped the card would withhold the one command a reader most needs',
  );
  assert.match(desired.body, /- test: `pytest`/);
});

// ------------------------------------------------------------------ the ceiling is enforced, not hoped

test('a card over the ceiling drops the least valuable lines and says which', async () => {
  const root = await fixture({ 'Cargo.toml': '[package]\nname = "x"\n' });
  const pad = (c) => `${c} ${'abcdefghij'.repeat(20)}`;
  const manifest = {
    gates: { commands: { build: pad('b'), test: pad('t'), lint: pad('l'), format: pad('f'), typecheck: pad('y') } },
  };
  const card = await cardFor(root, manifest);

  assert.ok(card.bytes <= CARD_LIMIT_BYTES, `${card.bytes} bytes is over the ceiling`);
  assert.deepEqual(card.dropped, ['format', 'typecheck', 'lint'], 'the drop order is format, typecheck, lint, build');
  assert.equal(commandFor(card, 'test'), pad('t'), 'the test command is never dropped');
  assert.equal(commandFor(card, 'build'), pad('b'));

  // And the drop is reported where a reader of the command sees it, never only in the bytes.
  await writeFile(join(root, 'simt.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const desired = await desiredRegion(root, {});
  assert.match(desired.notes.join('\n'), /command card: dropped format, typecheck, lint/);
});

test('a card that fits reports no drop, so the note means something when it appears', async () => {
  const root = await fixture({ 'Cargo.toml': '[package]\nname = "x"\n' });
  const card = await cardFor(root);
  assert.deepEqual(card.dropped, []);
  const desired = await desiredRegion(root, {});
  assert.doesNotMatch(desired.notes.join('\n'), /command card: dropped/);
});
