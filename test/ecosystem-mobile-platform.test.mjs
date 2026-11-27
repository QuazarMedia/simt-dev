import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ecosystems } from '../src/ci/dependabot.mjs';
import { ecosystemGateRows, loadEcosystems } from '../src/ecosystem/records.mjs';
import { validateRecord } from '../src/ecosystem/schema.mjs';
import { defaultGates, planGates } from '../src/gates/index.mjs';
import { CARD_LIMIT_BYTES, commandCard } from '../src/kernel/card.mjs';
import { desiredRegion, loadRules } from '../src/projection/rules.mjs';
import { fingerprint, knownTags } from '../src/resolve/fingerprint.mjs';
import { tempDir } from './fixture.mjs';

async function repo(files = {}) {
  const root = await tempDir('simt-mobile-platform-');
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

async function detect(files) {
  const root = await repo(files);
  return { root, ...(await fingerprint(root)) };
}

async function cardFor(root) {
  const { stack, facts } = await fingerprint(root);
  return commandCard({ root, stack, facts });
}

function commandFor(card, label) {
  return card.lines.find((line) => line.label === label)?.command ?? null;
}

function profileCount(region, id) {
  return region.profiles.filter((profile) => profile === id).length;
}

const FLUTTER_PUBSPEC = `name: example
environment:
  sdk: ^3.8.0
dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.0
dev_dependencies:
  flutter_lints:
    sdk: flutter
`;

const KMP_BUILD = `plugins {
  kotlin("multiplatform")
  id("org.jetbrains.compose")
}
`;

test('SE03 records validate and seed only honest mobile platform tooling', () => {
  for (const id of ['flutter', 'xcode', 'kotlin-multiplatform', 'compose-multiplatform']) {
    const record = loadEcosystems().find((entry) => entry.id === id);
    assert.ok(record, `${id} record is missing`);
    const checked = validateRecord(id, record);
    assert.equal(checked.ok, true, checked.problems?.join('\n'));
  }

  const rows = ecosystemGateRows();
  const orders = loadEcosystems()
    .filter((record) => record.manifestOrder !== undefined)
    .map((record) => record.manifestOrder);
  assert.equal(new Set(orders).size, orders.length, 'manifestOrder values must be unique');
  const flutter = rows.find((row) => row.id === 'flutter');
  assert.equal(flutter.fact, 'has-flutter');
  assert.equal(flutter.tool, 'flutter');
  assert.deepEqual(flutter.preCommit, ['lint']);
  assert.deepEqual(flutter.prePush, ['test']);
  assert.deepEqual(flutter.commands, { lint: 'flutter analyze', test: 'flutter test' });
  assert.deepEqual(rows.find((row) => row.id === 'dart').unless, ['has-flutter']);

  const flutterRecord = loadEcosystems().find((entry) => entry.id === 'flutter');
  assert.equal(flutterRecord.probes[0].files[0], 'pubspec.yaml');
  assert.equal(typeof flutterRecord.probes[0].regex, 'string');
  assert.doesNotMatch(JSON.stringify(flutterRecord), /flutter format|flutter build|--platform|--target/);

  for (const id of ['xcode', 'kotlin-multiplatform', 'compose-multiplatform']) {
    const record = loadEcosystems().find((entry) => entry.id === id);
    assert.equal(record.manifestOrder, undefined, `${id} must not add a duplicate gate row`);
    assert.equal(record.gates, undefined, `${id} must reuse declared tooling`);
    assert.equal(rows.some((row) => row.id === id), false);
  }
  const xcode = loadEcosystems().find((entry) => entry.id === 'xcode');
  assert.deepEqual(xcode.markers, ['*.xcodeproj', '*.xcworkspace']);
  assert.doesNotMatch(JSON.stringify(xcode), /xcodebuild/);

  const kmp = loadEcosystems().find((entry) => entry.id === 'kotlin-multiplatform');
  const compose = loadEcosystems().find((entry) => entry.id === 'compose-multiplatform');
  assert.equal(kmp.card, undefined, 'there is no honest target-agnostic KMP focused task');
  assert.equal(compose.card, undefined);
  const jvm = loadEcosystems().find((entry) => entry.id === 'gradle').card.focused
    .find((entry) => entry.kind === 'JVM');
  assert.deepEqual(jvm.condition.unless, ['has-kotlin-multiplatform', 'has-compose-multiplatform']);
});

test('Flutter requires a Flutter SDK dependency and ignores incidental Flutter text', async () => {
  const positives = [
    FLUTTER_PUBSPEC,
    FLUTTER_PUBSPEC.replaceAll('\n', '\r\n'),
    'name: inline\ndependencies:\n  flutter: { sdk: flutter }\n',
    'name: inline_comment\ndependencies:\n  flutter: # SDK\n    sdk: flutter\n',
    'name: comments\ndependencies:\n  # HTTP client\n  http: ^1.0.0\n\n  # Flutter SDK\n  flutter:\n    sdk: flutter\n',
    'name: four_spaces\ndependencies:\n    http: ^1.0.0\n    flutter:\n        sdk: flutter\n',
  ];
  for (const pubspec of positives) {
    const found = await detect({ 'pubspec.yaml': pubspec });
    assert.ok(found.facts.includes('has-flutter'), pubspec);
    assert.ok(found.facts.includes('has-pubspec'));
    assert.equal(found.factEvidence['has-flutter'], 'pubspec.yaml');
    assert.equal(found.factEvidence['has-pubspec'], 'pubspec.yaml');
    assert.equal(knownTags(found.root).has('has-flutter'), true);
  }

  const negatives = [
    'name: plain\ndependencies:\n  http: ^1.0.0\n',
    'name: lint_only\ndev_dependencies:\n  flutter_lints:\n    sdk: flutter\n',
    'name: lint_dependency\ndependencies:\n  flutter_lints:\n    sdk: flutter\n',
    'name: path\ndependencies:\n  flutter:\n    path: ../flutter\n',
    'name: other\ndependencies:\n  other:\n    sdk: flutter\n',
    'name: nested\ndependencies:\n  wrapper:\n    flutter:\n      sdk: flutter\n',
    'name: inline_nested\ndependencies:\n  wrapper: { flutter: { sdk: flutter } }\n',
    'name: comment\ndependencies:\n  http: ^1.0.0\n\n# flutter:\n#   sdk: flutter\n',
  ];
  for (const pubspec of negatives) {
    const found = await detect({ 'pubspec.yaml': pubspec });
    assert.equal(found.facts.includes('has-flutter'), false, pubspec);
    assert.equal(found.facts.includes('has-pubspec'), true);
    assert.equal(found.factEvidence['has-flutter'], undefined);
  }
});

test('Flutter excludes Dart gates and focused card while keeping pub Dependabot coverage', async () => {
  const found = await detect({ 'pubspec.yaml': FLUTTER_PUBSPEC });
  assert.deepEqual(defaultGates(found.stack, found.facts, found.root), {
    preCommit: ['lint'],
    prePush: ['test'],
  });
  const planned = planGates(
    found.stack,
    { tools: ['dart', 'flutter'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    found.facts,
    found.root,
  );
  assert.deepEqual(planned.gates, { preCommit: ['lint'], prePush: ['test'] });
  assert.deepEqual(planned.commands, { lint: 'flutter analyze', test: 'flutter test' });

  const card = await cardFor(found.root);
  assert.deepEqual(card.lines.map((line) => [line.verb, line.command]), [
    ['test', 'flutter test'],
    ['lint', 'flutter analyze'],
    ['focused', 'flutter test {file}'],
  ]);
  assert.doesNotMatch(card.text, /dart |flutter format|flutter build/);
  assert.ok(card.bytes <= CARD_LIMIT_BYTES);
  assert.deepEqual(ecosystems(found.facts, found.stack, found.root), [
    { value: 'pub', manifest: 'pubspec.yaml' },
  ]);

  const dart = await detect({ 'pubspec.yaml': 'name: dart_only\n' });
  assert.deepEqual(defaultGates(dart.stack, dart.facts, dart.root), {
    preCommit: ['format', 'lint'],
    prePush: ['test'],
  });
  const dartPlan = planGates(
    dart.stack,
    { tools: ['dart'], scripts: {}, binaries: [], commands: {}, runner: 'none' },
    dart.facts,
    dart.root,
  );
  assert.deepEqual(dartPlan.commands, {
    format: 'dart format --output=none --set-exit-if-changed .',
    lint: 'dart analyze',
    test: 'dart test',
  });
  const dartCard = await cardFor(dart.root);
  assert.equal(commandFor(dartCard, 'focused test (Dart)'), 'dart test {file}');
  assert.equal(commandFor(dartCard, 'focused test (Flutter)'), null);
});

test('Xcode detection uses root project or workspace markers, not Swift packages', async () => {
  for (const marker of ['Example.xcodeproj', 'Example.xcworkspace']) {
    const found = await detect({ [`${marker}/contents`]: '' });
    assert.ok(found.facts.includes('has-xcode'));
    assert.equal(found.factEvidence['has-xcode'], marker);
    assert.equal(profileCount(await desiredRegion(found.root, {}), 'xcode'), 1);
    assert.deepEqual((await cardFor(found.root)).lines, []);
  }

  const swift = await detect({ 'Package.swift': '// swift-tools-version:5.9\n' });
  assert.equal(swift.facts.includes('has-swift-package'), true);
  assert.equal(swift.facts.includes('has-xcode'), false);
  const swiftRegion = await desiredRegion(swift.root, {});
  assert.equal(profileCount(swiftRegion, 'swift'), 1);
  assert.equal(profileCount(swiftRegion, 'xcode'), 0);

  for (const files of [
    { 'modules/Example.xcodeproj/project.pbxproj': '' },
    { 'Example.xcodeproj.backup/project.pbxproj': '' },
    { 'src/App.swift': 'print("hello")\n' },
  ]) {
    const found = await detect(files);
    assert.equal(found.facts.includes('has-xcode'), false, JSON.stringify(files));
    assert.equal(found.factEvidence['has-xcode'], undefined);
  }
});

test('Kotlin Multiplatform and Compose Multiplatform stay distinct from JVM Compose', async () => {
  for (const [file, text] of [
    ['build.gradle.kts', 'plugins { kotlin("multiplatform") }\n'],
    ['build.gradle', 'plugins { id "org.jetbrains.kotlin.multiplatform" version "2.2.0" }\n'],
    ['settings.gradle.kts', 'plugins { id("org.jetbrains.kotlin.multiplatform") }\n'],
    ['build.gradle.kts', '/* outer /* nested */ ignored */\nplugins { kotlin("multiplatform") }\n'],
  ]) {
    const found = await detect({ [file]: text });
    assert.equal(found.facts.includes('has-kotlin-multiplatform'), true, text);
    assert.equal(found.factEvidence['has-kotlin-multiplatform'], file);
    assert.equal(found.facts.includes('has-compose-multiplatform'), false);
  }

  for (const text of [
    'plugins { kotlin("jvm") }\n',
    'plugins { id("org.jetbrains.kotlin.jvm") version "2.2.0" }\n',
    'plugins {\n  // kotlin("multiplatform")\n}\n',
    '/* id("org.jetbrains.kotlin.multiplatform") */\n',
    '/* outer /* nested */ id("org.jetbrains.kotlin.multiplatform") */\n',
    '// id("org.jetbrains.compose")\n',
    '/* outer /* nested */ id("org.jetbrains.compose") */\n',
    '/* compose.multiplatform */\n',
  ]) {
    const found = await detect({ 'build.gradle.kts': text });
    assert.equal(found.facts.includes('has-kotlin-multiplatform'), false, text);
    assert.equal(found.facts.includes('has-compose-multiplatform'), false, text);
  }

  const compose = await detect({
    'build.gradle.kts': 'dependencies { implementation("org.jetbrains.compose.runtime:runtime:1.8.0") }\n',
  });
  assert.equal(compose.facts.includes('has-compose-multiplatform'), true);
  assert.equal(compose.factEvidence['has-compose-multiplatform'], 'build.gradle.kts');
  assert.equal(compose.facts.includes('has-kotlin-multiplatform'), false);

  const jvmCompose = await detect({
    'build.gradle.kts': `plugins {
  kotlin("jvm")
  id("org.jetbrains.kotlin.plugin.compose")
}
dependencies {
  implementation("androidx.compose.ui:ui:1.8.0")
}
`,
  });
  assert.equal(jvmCompose.facts.includes('has-kotlin-multiplatform'), false);
  assert.equal(jvmCompose.facts.includes('has-compose-multiplatform'), false);
});

test('KMP and Compose Multiplatform reuse Gradle without inheriting a JVM focused task', async () => {
  const found = await detect({
    'build.gradle.kts': KMP_BUILD,
    'shared/src/commonMain/kotlin/App.kt': 'fun app() = Unit\n',
  });
  assert.deepEqual(
    defaultGates(found.stack, found.facts, found.root),
    defaultGates(found.stack, [], found.root),
  );
  assert.deepEqual(planGates(found.stack, null, found.facts, found.root).commands, {});

  const card = await cardFor(found.root);
  assert.equal(commandFor(card, 'build'), './gradlew build');
  assert.deepEqual(card.lines.filter((line) => line.verb === 'focused'), []);
  const region = await desiredRegion(found.root, {});
  assert.equal(profileCount(region, 'jvm'), 1);
  assert.equal(profileCount(region, 'kotlin-multiplatform'), 1);
  assert.equal(profileCount(region, 'compose-multiplatform'), 1);

  const jvm = await detect({ 'build.gradle.kts': 'plugins { kotlin("jvm") }\n' });
  const jvmCard = await cardFor(jvm.root);
  assert.equal(commandFor(jvmCard, 'build'), './gradlew build');
  assert.equal(commandFor(jvmCard, 'focused test (JVM)'), './gradlew test --tests {class}');
  const jvmRegion = await desiredRegion(jvm.root, {});
  assert.equal(profileCount(jvmRegion, 'jvm'), 1);
  assert.equal(profileCount(jvmRegion, 'kotlin-multiplatform'), 0);
  assert.equal(profileCount(jvmRegion, 'compose-multiplatform'), 0);

  const composeOnly = await detect({
    'build.gradle.kts': 'plugins { id("org.jetbrains.compose") }\n',
  });
  assert.equal(profileCount(await desiredRegion(composeOnly.root, {}), 'compose-multiplatform'), 1);
  assert.deepEqual((await cardFor(composeOnly.root)).lines.filter((line) => line.verb === 'focused'), []);
});

test('SE03 profiles validate, select on their evidence and cover their platform contracts', async () => {
  const rules = await loadRules();
  const contracts = [
    {
      id: 'flutter',
      fact: 'has-flutter',
      files: { 'pubspec.yaml': FLUTTER_PUBSPEC },
      coverage: [/Flutter SDK/, /pubspec\.lock/, /widget/i, /flutter test/, /platform folders/i, /Semantics/, /build targets/i],
    },
    {
      id: 'xcode',
      fact: 'has-xcode',
      files: { 'Example.xcodeproj/project.pbxproj': '' },
      coverage: [/scheme/i, /workspace/i, /signing/i, /secrets/i, /simulator/i, /device/i, /asset catalogs/i, /Info\.plist/, /declared `xcodebuild`/i],
    },
    {
      id: 'kotlin-multiplatform',
      fact: 'has-kotlin-multiplatform',
      files: { 'build.gradle.kts': 'plugins { kotlin("multiplatform") }\n' },
      coverage: [/expect/, /actual/, /source sets/i, /target matrix/i, /resources/i, /java\.\*/, /Gradle wrapper/i],
    },
    {
      id: 'compose-multiplatform',
      fact: 'has-compose-multiplatform',
      files: { 'build.gradle.kts': KMP_BUILD },
      coverage: [/state/i, /Semantics/, /composeResources/, /target/i, /JVM/, /Gradle wrapper/i],
    },
  ];

  for (const contract of contracts) {
    const rule = rules.find((entry) => entry.id === contract.id);
    assert.ok(rule, `${contract.id} profile is missing`);
    assert.equal(rule.error, null, `${contract.id}: ${rule.error}`);
    assert.ok(rule.applies.includes(contract.fact), `${contract.id} does not select on ${contract.fact}`);
    assert.ok(rule.scope?.length > 0, `${contract.id} has no narrow scope`);
    for (const pattern of rule.scope) assert.ok(!['**', '**/*', '*'].includes(pattern));
    for (const line of rule.body.split('\n')) {
      if (line.startsWith('Applies to:')) assert.doesNotMatch(line, /`?has-[a-z0-9-]+`?/);
    }
    assert.doesNotMatch(rule.body, /\bsimt-dev\b|docs\/decisions\/|rules\/stacks\/|\bSIMT\b/);
    for (const pattern of contract.coverage) assert.match(rule.body, pattern, `${contract.id} lacks ${pattern}`);

    const found = await detect(contract.files);
    assert.ok(found.facts.includes(contract.fact), `${contract.id} evidence did not fire`);
    const region = await desiredRegion(found.root, {});
    assert.equal(profileCount(region, contract.id), 1, `${contract.id} was not selected exactly once`);
  }
});
