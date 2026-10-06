import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprint, STACK_TAGS, FACT_TAGS, KNOWN_TAGS } from '../src/resolve/fingerprint.mjs';
import { plan, loadRules, select, checkTarget, LOCAL_PROFILE_DIR } from '../src/projection/project.mjs';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt-dev.mjs');
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
  assert.equal(
    result.targets[0].body.includes('uv run -m pytest'),
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
  assert.match(failed.text, /INVALID\s+\.simt-dev\/profiles\/house\.md/);
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