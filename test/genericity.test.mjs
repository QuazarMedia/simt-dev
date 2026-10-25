import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprint, STACK_TAGS, FACT_TAGS, KNOWN_TAGS, __internals } from '../src/resolve/fingerprint.mjs';
import { plan, loadRules, select, checkTarget, LOCAL_PROFILE_DIR } from '../src/projection/project.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

// The shipped binary, not this module graph: a guard that only fires because of how
// the tool is wired inside its own checkout is not a guard.
async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, text: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, text: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

async function fixture(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-generic-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    if (body === null) await mkdir(path, { recursive: true });
    else await writeFile(path, body);
  }
  return root;
}

const PROFILE = (id, applies, body) =>
  `---\nsimt-id: ${id}\nsimt-title: ${id}\nsimt-applies: [${applies}]\n---\n\n## ${id}\n\n${body}\n`;

// --- facts: the observable half of detection -------------------------------

test('fingerprint emits facts for ecosystems nobody here has profiles for', async () => {
  const go = await fixture({ 'go.mod': 'module x\n' });
  const rust = await fixture({ 'Cargo.toml': '[package]\nname="x"\n' });
  const ruby = await fixture({ Gemfile: "source 'x'\n" });
  const jvm = await fixture({ 'pom.xml': '<project/>\n' });

  assert.deepEqual((await fingerprint(go)).facts, ['has-go-mod']);
  assert.ok((await fingerprint(rust)).facts.includes('has-cargo-toml'));
  assert.ok((await fingerprint(ruby)).facts.includes('has-gemfile'));
  assert.ok((await fingerprint(jvm)).facts.includes('has-maven-pom'));
});

test('a fact names the file that proved it', async () => {
  const root = await fixture({ 'pyproject.toml': '[project]\n', migrations: null });
  const result = await fingerprint(root);
  assert.equal(result.factEvidence['has-pyproject'], 'pyproject.toml');
  assert.equal(result.factEvidence['has-migrations-dir'], 'migrations');
  for (const fact of result.facts) {
    assert.ok(result.factEvidence[fact], `fact ${fact} has no evidence`);
  }
});

test('a directory fact fires on a path with a slash in it', async () => {
  // S07. A `dir` candidate holding a slash used to be probed with isFile, which is
  // never true for a directory, so these four facts could not fire on any repo that
  // had them. Measured on the estate before the fix: seven repositories have
  // `.github/workflows/`, and not one of them emitted `has-ci-workflows`.
  const root = await fixture({
    '.github/workflows': null,
    'docs/decisions': null,
    'db/migrate': null,
    'db/schema': null,
  });
  const result = await fingerprint(root);
  assert.equal(result.factEvidence['has-ci-workflows'], '.github/workflows');
  assert.equal(result.factEvidence['has-decisions-dir'], 'docs/decisions');
  assert.equal(result.factEvidence['has-migrations-dir'], 'db/migrate');
  assert.equal(result.factEvidence['has-schema-dir'], 'db/schema');
});

test('a directory fact does not fire on a file that happens to be named after it', async () => {
  // The control for the test above, because probing by presence rather than by kind
  // passes both of them: `names.has` is true for the file below and false for every
  // directory in the fixture above, so a presence probe would fail the first and
  // pass this one. Only a probe that asks "is it a directory" gets both right.
  const root = await fixture({ 'docs/decisions': 'not a directory\n', schema: 'not a directory\n' });
  const result = await fingerprint(root);
  assert.equal(result.facts.includes('has-decisions-dir'), false);
  assert.equal(result.facts.includes('has-schema-dir'), false);
});

test('the same fixture reports its nested evidence through doctor', async () => {
  // Through the shipped binary: the acceptance is about what a reader of `doctor`
  // sees, and a guard that only fires inside this checkout is not a guard.
  const root = await fixture({ '.github/workflows': null, 'docs/decisions': null });
  const { code, text } = await run(['doctor', '--root', root, '--json']);
  assert.equal(code, 0, text);
  const out = JSON.parse(text.slice(text.indexOf('{')));
  assert.deepEqual(Object.keys(out.factEvidence).sort(), ['has-ci-workflows', 'has-decisions-dir']);
  assert.equal(out.factEvidence['has-ci-workflows'], '.github/workflows');
  assert.equal(out.factEvidence['has-decisions-dir'], 'docs/decisions');
});

test('no file fact names a path the root listing cannot see', () => {
  // The other half of the same defect, still latent. A `file` candidate is matched
  // against the root listing, which stops at the root, so a `file` fact naming a
  // nested path would sit in the table forever matching nothing - the shape S07
  // found, wearing the other kind. Failing here is how the next person finds out
  // that a nested file fact needs a different mechanism, not a table entry.
  for (const fact of __internals.FACTS) {
    if (fact.kind !== 'file') continue;
    for (const candidate of fact.paths) {
      assert.ok(
        !candidate.includes('/'),
        `fact ${fact.name} names "${candidate}", which the root listing cannot reach`,
      );
    }
  }
});

test('a workspace fact is emitted from either pnpm-workspace.yaml or package.json workspaces', async () => {
  const viaYaml = await fixture({ 'pnpm-workspace.yaml': 'packages: []\n' });
  const viaPkg = await fixture({ 'package.json': JSON.stringify({ workspaces: ['packages/*'] }) });
  const neither = await fixture({ 'package.json': JSON.stringify({ name: 'x' }) });

  assert.ok((await fingerprint(viaYaml)).facts.includes('has-node-workspace'));
  assert.ok((await fingerprint(viaPkg)).facts.includes('has-node-workspace'));
  assert.equal((await fingerprint(neither)).facts.includes('has-node-workspace'), false);
});

test('an unparseable package.json yields an absent fact, never a wrong one', async () => {
  const root = await fixture({ 'package.json': '{ not json' });
  const result = await fingerprint(root);
  assert.equal(result.facts.includes('has-node-workspace'), false);
  assert.ok(result.evidence.includes('package.json:unparseable'));
});

test('an unreadable root reports every collection empty rather than throwing', async () => {
  const result = await fingerprint(join(tmpdir(), 'simt-does-not-exist-xyz'));
  assert.equal(result.error, 'unreadable-root');
  assert.deepEqual(result.stack, []);
  assert.deepEqual(result.facts, []);
});

// --- the vocabulary is derived, so the two cannot desynchronise -------------

test('every fact name is has-* and lives in the emitted vocabulary', () => {
  for (const fact of FACT_TAGS) {
    assert.match(fact, /^has-[a-z0-9-]+$/, `fact "${fact}" is not has-*`);
  }
  for (const fact of FACT_TAGS) {
    assert.ok(KNOWN_TAGS.has(fact));
  }
  assert.deepEqual(
    [...KNOWN_TAGS].sort(),
    [...new Set([...STACK_TAGS, ...FACT_TAGS])].sort(),
  );
});

test('no fact merely restates a stack tag', () => {
  // A fact that duplicates a tag is a second name for one observation, which is
  // the duplication the estate's own review agent blocks. `has-typescript` was
  // cut for exactly this reason.
  for (const fact of FACT_TAGS) {
    assert.equal(STACK_TAGS.has(fact), false, `fact "${fact}" restates a stack tag`);
  }
});

// --- the headline promise: a new ecosystem needs no code change ------------

test('a profile selects on a fact with no matching stack tag at all', () => {
  const rules = [
    { id: 'core', applies: 'always' },
    { id: 'cargo', applies: ['has-cargo-toml'] },
  ];
  // `stack` is empty on purpose: nothing here knows about Rust.
  const { selected } = select(rules, [], ['has-cargo-toml', 'has-readme']);
  assert.deepEqual(
    selected.map((r) => r.id),
    ['core', 'cargo'],
  );
});

test('each shipped ecosystem profile selects on its own fact (S40)', async () => {
  // The acceptance row: a fingerprint fixture with an asserted fact and the profile
  // that fact must reach. One marker file has to select the region a repo reads —
  // maven is in the table because its profile (jvm) predates it and applies on the
  // same fact.
  const rows = [
    { marker: 'Cargo.toml', fact: 'has-cargo-toml', profile: 'rust' },
    { marker: 'go.mod', fact: 'has-go-mod', profile: 'go' },
    { marker: 'App.csproj', fact: 'has-nuget', profile: 'dotnet' },
    { marker: 'Package.swift', fact: 'has-swift-package', profile: 'swift' },
    { marker: 'deno.json', fact: 'has-deno-config', profile: 'deno' },
    { marker: 'Gemfile', fact: 'has-gemfile', profile: 'ruby' },
    { marker: 'pubspec.yaml', fact: 'has-pubspec', profile: 'dart' },
    { marker: 'mix.exs', fact: 'has-mix', profile: 'elixir' },
    { marker: 'pom.xml', fact: 'has-maven-pom', profile: 'jvm' },
  ];
  const rules = await loadRules();
  for (const { marker, fact, profile } of rows) {
    const root = await fixture({ [marker]: 'x' });
    const fp = await fingerprint(root);
    assert.ok(
      fp.facts.includes(fact),
      `${marker} did not emit ${fact}: ${fp.facts.join(', ')}`,
    );
    const { selected } = select(rules, fp.stack, fp.facts);
    assert.ok(
      selected.some((r) => r.id === profile),
      `${marker} (facts: ${fp.facts.join(', ')}) did not select ${profile}: ${selected.map((r) => r.id).join(', ')}`,
    );
  }
});

test('facts reach the region through plan, not only through select', async () => {
  const root = await fixture({
    'Cargo.toml': '[package]\nname="x"\n',
    [`${LOCAL_PROFILE_DIR}/rust.md`]: PROFILE('rust', 'has-cargo-toml', 'Run cargo, never a bare rustc.'),
  });
  const result = await plan(root);
  assert.ok(result.facts.includes('has-cargo-toml'));
  assert.ok(result.profiles.includes('rust'), `got profiles ${result.profiles}`);
  assert.ok(result.targets[0].body.includes('never a bare rustc'));
});

// --- a profile selects on what the repository RUNS ON -------------------------

const deps = (dependencies) => JSON.stringify({ name: 'x', dependencies });

/**
 * Each row of S28's finding, as a repository that has to reach a profile set.
 *
 * `stack` is asserted next to `profiles` on purpose: a row claims what the repository
 * IS, and a fixture that quietly stopped being a TypeScript library would still prove
 * the profile is reachable. That is a weaker claim than the row makes, and it is the
 * one a mutation produces.
 */
const S28_ROWS = [
  {
    row: 'any TypeScript library is not a Worker',
    files: { 'package.json': deps({ typescript: '^5' }), 'index.ts': 'export const x = 1;\n' },
    stack: ['node', 'typescript'],
    // S45 moved the language spelling out of core into a fallback profile, so a
    // TypeScript library receives it alongside `node`. The row's claim is unchanged:
    // `cloudflare-workers` is not among the selected profiles.
    profiles: ['core', 'node', 'typescript'],
  },
  {
    row: 'a Spring or Ktor backend on Gradle is a JVM, not Android',
    files: { 'build.gradle.kts': 'plugins { kotlin("jvm") }\n', 'src/main/kotlin/Api.kt': 'class Api\n' },
    // `kotlin` IS expected here, and used not to be. The comment this replaces read:
    // "the extension sample walks two levels and `src/main/kotlin` is three down, so a
    // Ktor backend is identified here by its build file" — a test that recorded a
    // detection bound as though it were the correct answer, which is how S32's defect
    // passed as a designed limitation. The bound is now a count rather than a depth, so
    // the sample sees the file and this backend is identified by its language as well.
    stack: ['gradle', 'kotlin'],
    profiles: ['core', 'jvm'],
  },
  {
    row: 'React Native and Expo are not React web',
    files: { 'package.json': deps({ react: '^18', 'react-native': '^0.74', expo: '^51' }) },
    stack: ['node', 'react', 'react-native'],
    profiles: ['core', 'react-native'],
  },
  {
    row: 'a Poetry project is not a uv project',
    files: { 'pyproject.toml': '[tool.poetry]\nname = "x"\n', 'poetry.lock': '' },
    stack: ['python'],
    profiles: ['core', 'python'],
  },
  {
    row: 'Hono runs on Node, so it is not evidence of Workers',
    files: { 'package.json': deps({ hono: '^4' }), 'src/index.ts': 'export const app = 1;\n' },
    stack: ['hono', 'node', 'typescript'],
    // S45's fallback applies here too: hono has no profile of its own, so nothing
    // more specific matched. The row's claim is about Workers, not TypeScript.
    profiles: ['core', 'node', 'typescript'],
  },
  {
    row: 'a plain wrangler.json is evidence of Workers',
    files: { 'package.json': deps({ hono: '^4' }), 'wrangler.json': '{}\n' },
    stack: ['cloudflare-workers', 'hono', 'node'],
    profiles: ['core', 'cloudflare-workers'],
  },
  {
    row: 'a browser React app is React web',
    files: { 'package.json': deps({ react: '^18', 'react-dom': '^18' }) },
    stack: ['node', 'react', 'react-dom'],
    profiles: ['core', 'react-web'],
  },
  {
    row: 'an Android module is Android',
    files: { 'app/src/main/AndroidManifest.xml': '<manifest/>\n', 'app/build.gradle.kts': '\n' },
    stack: ['gradle'],
    profiles: ['core', 'android', 'jvm'],
  },
  {
    row: 'a uv project is Python and uv',
    files: { 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '' },
    stack: ['python'],
    profiles: ['core', 'python', 'uv'],
  },
];

test('a profile selects on what the repository runs on, not on what it is written in', async () => {
  const rules = await loadRules();
  for (const entry of S28_ROWS) {
    const root = await fixture(entry.files);
    const fp = await fingerprint(root);
    assert.deepEqual(
      fp.stack,
      entry.stack,
      `${entry.row}: the fixture no longer is what the row claims`,
    );
    const { selected } = select(rules, fp.stack, fp.facts);
    // Unsorted on purpose: `core` comes first because it applies always, and the rest
    // follow in the order the profile files are read. Sorting would drop that, and the
    // order is what a reader of the region's source list sees.
    assert.deepEqual(
      selected.map((r) => r.id),
      entry.profiles,
      `${entry.row} selected the wrong profiles`,
    );
  }
});

test('sources in a standard Gradle layout are sampled at any depth', async () => {
  // S32. `app/src/main/kotlin/a/b/C.kt` is six directories down. The sample used to
  // stop at two, so this file emitted nothing and a Gradle backend was never `kotlin`.
  const root = await fixture({ 'app/src/main/kotlin/a/b/C.kt': 'class C\n' });
  const result = await fingerprint(root);
  assert.ok(result.stack.includes('kotlin'), result.stack.join(','));
});

test('tracked sources are read from the index, and ignored or untracked ones are not', async () => {
  // The walk would see every one of these files. The index is what makes the three
  // answers different, so a fallback that runs whenever the index is empty would pass
  // the first assertion and fail the other two — which is the bug the empty-array
  // check exists to prevent.
  const tracked = await fixture({ 'app/src/main/kotlin/a/b/C.kt': 'class C\n', 'README': 'x\n' });
  await exec('git', ['init'], { cwd: tracked });
  await exec('git', ['add', '-A'], { cwd: tracked });
  assert.ok((await fingerprint(tracked)).stack.includes('kotlin'));

  const java = join(tracked, 'src/main/java/com/example/App.java');
  await mkdir(join(java, '..'), { recursive: true });
  await writeFile(java, 'class App {}\n');
  const dirty = await fingerprint(tracked);
  assert.equal(dirty.stack.includes('java'), false, dirty.stack.join(','));

  const ignored = await fixture({
    'app/src/main/kotlin/a/b/C.kt': 'class C\n',
    '.gitignore': '*.kt\n',
    'README': 'x\n',
  });
  await exec('git', ['init'], { cwd: ignored });
  await exec('git', ['add', '-A'], { cwd: ignored });
  assert.equal((await fingerprint(ignored)).stack.includes('kotlin'), false);
});

test('the extension sample stops at its path bound', async () => {
  // One file past the bound, sorted after the fillers, so removing the bound — or
  // counting only names that have an extension — lets `z.kt` through. Both halves,
  // because they each have their own loop and a test of one would leave the other free.
  const bound = __internals.SAMPLE_BOUND;
  const fillers = async (root) => {
    const dir = join(root, 'm');
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: bound }, (_, i) => writeFile(join(dir, `${String(i).padStart(5, '0')}.txt`), '')),
    );
    await writeFile(join(root, 'z.kt'), 'class Z\n');
  };

  const walked = await fixture();
  await fillers(walked);
  assert.equal((await fingerprint(walked)).stack.includes('kotlin'), false);

  const indexed = await fixture();
  await fillers(indexed);
  await exec('git', ['init'], { cwd: indexed });
  await exec('git', ['add', '-A'], { cwd: indexed });
  assert.equal((await fingerprint(indexed)).stack.includes('kotlin'), false);
});

test('the react-web and react-native rows differ only by the renderer', async () => {
  // The pair the finding turns on. Before S28 both arrived as `node, react`, so no
  // change to a profile could have separated them; the separation had to come from a
  // tag that says which platform renders. Asserting the shared half too, because the
  // two rows are only comparable if they agree on everything else.
  const web = S28_ROWS.find((r) => r.row === 'a browser React app is React web');
  const native = S28_ROWS.find((r) => r.row === 'React Native and Expo are not React web');
  const shared = web.stack.filter((tag) => native.stack.includes(tag));
  assert.deepEqual(shared, ['node', 'react']);
  assert.ok(!native.stack.includes('react-dom'));
  assert.ok(!web.stack.includes('react-native'));
});

// --- a glob fact, the third kind ---------------------------------------------

test('a glob fact names the file that proved it, not the shape that matched', async () => {
  // `doctor` answers "why did you think that?", and the pattern is not an answer. A
  // fact that reported its own pattern would pass this test if it reported nothing at
  // all, which is why the matched path is asserted rather than the fact's presence.
  const root = await fixture({ 'app/src/main/AndroidManifest.xml': '<manifest/>\n' });
  const result = await fingerprint(root);
  assert.equal(result.factEvidence['has-android-manifest'], 'app/src/main/AndroidManifest.xml');
  assert.equal(
    result.factEvidence['has-android-manifest'].includes('**'),
    false,
    'evidence must be a path, not the pattern that searched for one',
  );
});

test('a glob fact is bounded, and a path past the bound is not a fact', async () => {
  // The bound is stated in `GLOB_DEPTH`, and the depth a real ecosystem puts its
  // manifest at is the reason for its value: `app/src/main/AndroidManifest.xml` is
  // three directories down, so a bound of two would make the fact the shape S07 found
  // - present in the table, unreachable in every repository that has it.
  // GLOB_DEPTH counts directories descended, so `app/src/main` is inside it and
  // `app/core/src/main` is not: three levels below the root is the Android Gradle
  // plugin's own source-set layout, and one more is a repository nobody described.
  const inside = await fixture({ 'a/src/main/AndroidManifest.xml': '<m/>\n' });
  const outside = await fixture({ 'a/b/src/main/AndroidManifest.xml': '<m/>\n' });
  assert.ok(
    (await fingerprint(inside)).facts.includes('has-android-manifest'),
    'the bound must reach the Android Gradle plugin source-set convention',
  );
  assert.equal(
    (await fingerprint(outside)).facts.includes('has-android-manifest'),
    false,
    'the bound must not be a scan',
  );
});

test('a glob fact ignores vendored and hidden directories', async () => {
  // The same reason the extension sample skips them: detection reads a repository's
  // own source, not the copy of someone else's inside it.
  const root = await fixture({
    'node_modules/pkg/src/main/AndroidManifest.xml': '<m/>\n',
    '.gradle/caches/src/main/AndroidManifest.xml': '<m/>\n',
  });
  assert.equal((await fingerprint(root)).facts.includes('has-android-manifest'), false);
});

test('a glob fact is also emitted when the shape is at the root', async () => {
  // A star-star stands for zero directories as well as many. A walk that only
  // descended would report `services/api/uv.lock` and miss the plain `uv.lock` that
  // every single-package uv repository has.
  const root = await fixture({ 'uv.lock': '' });
  assert.equal((await fingerprint(root)).factEvidence['has-uv-lock'], 'uv.lock');
});

test('no glob fact names a shape that is really a path', async () => {
  // Without a star-star a `glob` candidate is a `file` or `dir` candidate with a walk
  // attached, which costs a directory traversal to learn something two `stat` calls
  // already said. The kind is what says which mechanism answers it.
  for (const fact of __internals.FACTS) {
    if (fact.kind !== 'glob') continue;
    for (const candidate of fact.paths) {
      assert.ok(
        candidate.includes('**'),
        `fact ${fact.name} declares kind "glob" but "${candidate}" names no shape`,
      );
    }
  }
});

test('a local profile naming a tag the detector never emits is reported', async () => {
  // The same defect class S28's own applies lists are at risk of: a tag the engine
  // cannot produce selects nothing, and before this check it loaded without complaint.
  const root = await fixture({
    'pyproject.toml': '[project]\nname = "x"\n',
    [`${LOCAL_PROFILE_DIR}/bad.md`]: '---\nsimt-id: bad\nsimt-applies: [pyton]\n---\nbody\n',
  });
  const local = (await loadRules(root)).filter((r) => r.origin === 'local');
  assert.equal(local.length, 1);
  assert.equal(
    local[0].error,
    'simt-applies names "pyton", which fingerprint() never emits, so this profile could never be selected',
  );
});

// --- repo-local profiles ----------------------------------------------------

test('a local profile is loaded, selected, and named in the region header', async () => {
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    [`${LOCAL_PROFILE_DIR}/house.md`]: PROFILE('house', 'has-pyproject', 'House rule one.'),
  });
  const local = (await loadRules(root)).filter((r) => r.origin === 'local');
  assert.equal(local.length, 1);
  assert.equal(local[0].id, 'house');
  assert.equal(local[0].source, `${LOCAL_PROFILE_DIR}/house.md`);

  const target = (await plan(root)).targets[0];
  assert.ok(target.body.includes('House rule one.'));
  assert.ok(target.sha);
});

test('a local profile shadows a central profile of the same id instead of stacking', async () => {
  // Two profiles claiming one id would project the same rules twice, and
  // duplicated source-of-truth text is a review blocker, not a style nit.
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    [`${LOCAL_PROFILE_DIR}/python.md`]: PROFILE('python', 'python', 'Ours, not theirs.'),
  });
  const result = await plan(root);
  assert.ok(result.notes.some((n) => n.includes('local profile python shadows')));
  assert.equal(
    result.profiles.filter((p) => p === 'python').length,
    1,
    'the id must appear once',
  );
  assert.ok(result.targets[0].body.includes('Ours, not theirs.'));
  // `fail_under` rather than a `uv` line: S28 moved the uv invocation rules into
  // their own profile, so a sentinel taken from the uv section now passes on any
  // shadowed body at all - the assertion cannot tell a shadow from a coincidence.
  assert.equal(
    result.targets[0].body.includes('fail_under'),
    false,
    'the shadowed central body must not survive',
  );
});

test('two local profiles sharing an id are reported, and the first wins', async () => {
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    [`${LOCAL_PROFILE_DIR}/a-python.md`]: PROFILE('python', 'python', 'From a.'),
    [`${LOCAL_PROFILE_DIR}/b-python.md`]: PROFILE('python', 'python', 'From b.'),
  });
  const result = await plan(root);
  assert.ok(
    result.notes.some((n) => n.includes('duplicate profile id python')),
    `notes were ${JSON.stringify(result.notes)}`,
  );
  const body = result.targets[0].body;
  assert.ok(body.includes('From a.'));
  assert.equal(body.includes('From b.'), false);
});

test('loadRules without a root returns central rules only', async () => {
  const all = await loadRules();
  assert.ok(all.every((r) => r.origin === 'central'));
  assert.ok(all.every((r) => r.source.startsWith('rules/')));
});

test('plan and check agree when a local profile is in play', async () => {
  // The divergence this guards against is the step-6 bug: plan and checkTarget
  // computing the region differently, so CI reports drift on a clean tree.
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    'AGENTS.md': '# Service\n',
    [`${LOCAL_PROFILE_DIR}/house.md`]: PROFILE('house', 'has-pyproject', 'House rule one.'),
  });
  const target = (await plan(root)).targets[0];
  await writeFile(join(root, 'AGENTS.md'), target.text);
  const finding = await checkTarget(root);
  assert.equal(finding.status, 'current', `status was ${finding.status}: ${finding.detail ?? ''}`);
});

test('a profile with no id in a repo is reported, not silently projected', async () => {
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    [`${LOCAL_PROFILE_DIR}/broken.md`]: '---\nsimt-title: no id\nsimt-applies: [has-pyproject]\n---\n\nBody.\n',
  });
  const local = (await loadRules(root)).filter((r) => r.origin === 'local');
  assert.equal(local[0].id, null);
  assert.equal(local[0].error, 'missing simt-id in frontmatter');
});

test('the gate fails a repo-local profile that uses the unprefixed spelling', async () => {
  // The rule that an unrecognised key is a defect only means something if the command
  // a repo runs reaches it. `check` used to read rules for the tool, not for the repo
  // being checked, so the one file in this whole mechanism that a repo owns — its own
  // profile — was the one file it could not fail on.
  const bare = '---\nsimt-id: house\napplies: [has-pyproject]\n---\n\nHouse rule one.\n';
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    'AGENTS.md': '# Service\n',
    [`${LOCAL_PROFILE_DIR}/house.md`]: bare,
  });

  const failed = await run(['check', '--root', root]);
  assert.notEqual(failed.code, 0, `check passed a profile it cannot read:\n${failed.text}`);
  assert.match(failed.text, /INVALID\s+\.simt\/profiles\/house\.md/);
  assert.match(failed.text, /key "applies" is this tool's own.*spelled "simt-applies"/);

  // Prefixed, the same profile is not a defect. The gate may still report drift —
  // nothing here has been synced — but this finding must be gone, and with it the
  // reason a bare-keyed profile was indistinguishable from a well-formed one.
  await writeFile(join(root, `${LOCAL_PROFILE_DIR}/house.md`), PROFILE('house', 'has-pyproject', 'House rule one.'));
  const fixed = await run(['check', '--root', root]);
  assert.doesNotMatch(fixed.text, /house\.md.*spelled "simt-applies"/);
});

test('content before and after the markers survives a local-profile round trip', async () => {
  const before = '# Service\n\nHouse rules.\n';
  const root = await fixture({
    'pyproject.toml': '[project]\n',
    'AGENTS.md': before,
    [`${LOCAL_PROFILE_DIR}/house.md`]: PROFILE('house', 'has-pyproject', 'House rule one.'),
  });
  const target = (await plan(root)).targets[0];
  await writeFile(join(root, 'AGENTS.md'), target.text);
  const again = (await plan(root)).targets[0];
  assert.equal(again.action, 'unchanged');
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith(before));
});