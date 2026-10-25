// simt-dev shared - carrying a workspace's repeated rules once, in the reader's home.
//
// Plan 0003 R11, ADR-084. Review 0002 S38 measured seven repositories loading 90 KB of
// always-on rules of which 72% was a paragraph an earlier root had already loaded. The
// command under test moves the repeated half into a file every reader loads before they
// open a repository, and leaves each region carrying what is left.
//
// Two properties are worth more here than the shape of the report, and both are why this
// file exists:
//
//   1. THE WRITE LANDS IN `$HOME`. Every test that installs gets a throwaway home through
//      the environment, because `os.homedir()` honours `$HOME` and a suite that wrote to
//      the developer's real `~/.config/opencode/AGENTS.md` would be a suite that damages
//      the machine it runs on.
//   2. THE REGION MUST NOT DEPEND ON THAT HOME DIRECTORY. `sync` and `check` both read the
//      region, CI has no copy to read, and a projection that depended on what one machine
//      had installed would report drift on a tree it had just written.
//
// Fixtures are staged in temp directories with no siblings, per ADR-031.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { declaredShared } from '../src/projection/manifest.mjs';
import {
  sharedCoverage,
  sharedState,
  sharedTargets,
  writeSharedFile,
} from '../src/projection/shared.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-shared-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * A repository's own house rule.
 *
 * `simt-applies: always` rather than `[node]` on purpose: a profile that names the stack
 * would itself satisfy the stack's profile selection, which displaces the fallback stack
 * profile, and the fixture would then be measuring two differences at once. An always
 * profile is added alongside it.
 */
const HOUSE_LOCAL = [
  '---',
  'simt-id: house-local',
  'simt-title: House local',
  'simt-applies: always',
  'simt-priority: convention',
  '---',
  '',
  '# House local',
  '',
  'Prose only this repository wants.',
  '',
].join('\n');

/**
 * A workspace of sibling repositories, each adopted and synced, with a throwaway home.
 *
 * Adopted with `init --yes` rather than with a manifest written here, because `init` is
 * the path a reader takes and it drops the gates this repository cannot run: a manifest
 * written by hand declares npm gates that a repository with no scripts cannot run, and
 * `check` then exits non-zero for a reason that has nothing to do with sharing.
 */
async function estate(names, { profiles = {} } = {}) {
  const ws = await scratch('simt-shared-ws-');
  const env = { HOME: await scratch('simt-shared-home-'), SIMT_DEV_WORKSPACE: 'off' };
  const roots = [];
  for (const name of names) {
    const root = join(ws, name);
    await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`);
    await writeFile(join(root, 'README.md'), `# ${name}\n`);
    if (profiles[name] !== undefined) {
      await writeFile(join(root, '.simt', 'profiles', 'house-local.md'), profiles[name]);
    }
    await git(['init', '-q', root]);
    await git(['-C', root, 'add', '.']);
    await git(['-C', root, 'commit', '-qm', 'seed']);
    const adopted = await run(['init', root, '--yes'], env);
    assert.equal(adopted.code, 0, `init failed in ${name}:\n${adopted.out}`);
    const synced = await run(['sync', '--yes', '--root', root], env);
    assert.equal(synced.code, 0, `sync failed in ${name}:\n${synced.out}`);
    roots.push(root);
  }
  return { ws, roots, env, home: env.HOME, copy: join(env.HOME, '.config/opencode/AGENTS.md') };
}

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** The `--json` payload of one run. A failing command's payload is the interesting half of
 *  the preview, so this reads both paths rather than rejecting on a non-zero exit. */
async function runJson(args, env = {}) {
  const result = await run([...args, '--json'], env);
  let json = null;
  try {
    json = JSON.parse(result.out.trim().split('\n').pop());
  } catch {
    /* left null so the assertion reports the raw output */
  }
  return { ...result, json };
}

const regionOf = (root) => readFile(join(root, 'AGENTS.md'), 'utf8');

/** Swap `$HOME` for the length of one call, and hand back the environment to run in. */
async function asReader(home, body) {
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  try {
    return await body();
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.CODEX_HOME;
  }
}

test('a shared copy is written where the loader table says the harness reads one', async () => {
  const home = await scratch('simt-shared-home-');
  const paths = await asReader(home, async () => {
    const targets = await sharedTargets(['claude', 'claude-md', 'codex', 'cursor', 'opencode', 'not-a-surface']);
    return new Map(targets.map((t) => [t.surface, t]));
  });

  assert.equal(paths.get('opencode').path, join(home, '.config/opencode/AGENTS.md'));
  // The plan named `~/.claude/CLAUDE.md`; the table records a flat rules directory that
  // loads before project rules, and a file the harness never reads buys nothing.
  assert.equal(paths.get('claude').path, join(home, '.claude/rules/simt.md'));
  // Cursor and Copilot keep user rules in their own settings, which is not a file this
  // tool can project — so the answer is a block to paste, and the reason says so.
  assert.equal(paths.get('cursor').path, null);
  assert.match(paths.get('cursor').why, /settings/);
  assert.equal(paths.get('claude-md').path, null);
  assert.equal(paths.get('not-a-surface').path, null);
  // With neither global file present, Codex reads `AGENTS.md`. Writing an override where
  // the reader has none would shadow the global file they do have.
  assert.equal(paths.get('codex').path, join(home, '.codex/AGENTS.md'));
  assert.equal(paths.get('codex').cap.bytes, 32768);
});

test('the global file a reader already has is the one this tool writes into', async () => {
  const home = await scratch('simt-shared-home-');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex/AGENTS.override.md'), '# mine\n');

  const chosen = await asReader(home, async () => (await sharedTargets(['codex']))[0]);
  assert.equal(chosen.path, join(home, '.codex/AGENTS.override.md'));
  assert.match(chosen.why, /AGENTS\.md/, 'the reader is told which file was passed over');

  // `CODEX_HOME` is the documented override of `~/.codex`, and the table records it: a
  // copy under `~` on that machine is a file Codex does not read.
  const elsewhere = join(home, 'codex-home');
  process.env.CODEX_HOME = elsewhere;
  try {
    const overridden = (await sharedTargets(['codex']))[0];
    assert.equal(overridden.path, join(elsewhere, 'AGENTS.md'));
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test('a declaration this tool did not write cannot drop a rule out of a region', async () => {
  // The manifest is a file people edit by hand, and a typo in it would silently shrink a
  // region — so anything this tool does not recognise as a declaration is no declaration.
  assert.equal(declaredShared(null).level, null);
  assert.equal(declaredShared({}).level, null);
  assert.equal(declaredShared({ shared: { level: 'group', rules: ['core'] } }).level, null);
  assert.equal(declaredShared({ shared: { level: 'user' } }).rules.size, 0);
  assert.equal(declaredShared({ shared: { level: 'user', rules: 'core' } }).rules.size, 0);
  const declared = declaredShared({ shared: { level: 'user', rules: ['b', 'a', 'b', 7] } });
  assert.equal(declared.level, 'user');
  assert.deepEqual([...declared.rules], ['b', 'a']);
});

test('plan says what a workspace would do, and writes nothing', async () => {
  const { ws, env, copy } = await estate(['alpha', 'beta']);
  const before = await regionOf(join(ws, 'alpha'));
  const path = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const planned = await run(['shared', 'plan', '--root', ws], env);
  assert.equal(planned.code, 0, planned.out);
  assert.match(planned.out, new RegExp(`^shared {3}${path(ws)} {2}2 repositories {2}\\(flag\\)$`, 'm'));
  assert.match(planned.out, /^rules {4}\d+ of \d+ ids carried once {2}\d+ B$/m);
  assert.match(planned.out, new RegExp(`^ {2}${path(copy)} {2}OpenCode`, 'm'));
  assert.match(planned.out, /^manifest simt\.json in each repository {2}shared\.level = user/m);
  assert.match(planned.out, /nothing written; re-run with: simt shared install --yes/);
  await assert.rejects(readFile(copy), /ENOENT/, 'plan must not create the file it prints');
  assert.equal(await regionOf(join(ws, 'alpha')), before);

  // The preview is the same question asked by the command that would act on it, so it
  // answers with the same states and still writes nothing.
  const preview = await run(['shared', 'install', '--root', ws], env);
  assert.notEqual(preview.code, 0);
  assert.match(preview.out, new RegExp(`^ {2}absent {3}${path(copy)}$`, 'm'));
  assert.match(preview.out, /^manifest declared:alpha declared:beta$/m);
  assert.match(preview.out, /nothing written; re-run with: simt shared install --yes/);
  await assert.rejects(readFile(copy), /ENOENT/);
  const manifest = JSON.parse(await readFile(join(ws, 'alpha', MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.shared, undefined, 'a preview must not declare anything either');
});

test("a repository's own rule stays in its region, and says why it was not carried", async () => {
  const { ws, roots, env } = await estate(['alpha', 'beta'], { profiles: { alpha: HOUSE_LOCAL } });

  const planned = await run(['shared', 'plan', '--root', ws], env);
  assert.match(planned.out, /^left in every region {2}1 rule\(s\) no root can hand over:$/m);
  assert.match(planned.out, /^ {2}house-local {2}is a repository's own profile or pack policy/m);
  assert.match(planned.out, /^rules {4}5 of 6 ids carried once/m);

  const installed = await run(['shared', 'install', '--yes', '--root', ws], env);
  assert.equal(installed.code, 0, installed.out);
  for (const root of [join(ws, 'alpha'), join(ws, 'beta')]) {
    await run(['sync', '--yes', '--root', root], env);
  }
  const alpha = await regionOf(join(ws, 'alpha'));
  const beta = await regionOf(join(ws, 'beta'));
  assert.match(alpha, /Prose only this repository wants\./, "alpha's own rule stays where it was written");
  assert.ok(!beta.includes('Prose only this repository wants.'), 'and it never appears in a sibling');
  assert.ok(!alpha.includes('Local prose for alpha'), 'nor in the shared copy');
});

test('install writes the copy, declares every repository, and leaves the regions alone', async () => {
  const { ws, roots, env, copy } = await estate(['alpha', 'beta']);
  const alpha = join(ws, 'alpha');
  const path = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = await regionOf(alpha);

  const installed = await run(['shared', 'install', '--yes', '--root', ws], env);
  assert.equal(installed.code, 0, installed.out);
  assert.match(installed.out, new RegExp(`^ {2}created {2}${path(copy)}$`, 'm'));
  assert.match(installed.out, new RegExp(`^ {2}declared {2}${path(alpha)}/${MANIFEST_FILE}$`, 'm'));
  assert.match(installed.out, /^regions {2}2 repository region\(s\) change on their next simt sync$/m);
  assert.match(installed.out, /^verify {3}simt doctor/m);

  const sharedText = await readFile(copy, 'utf8');
  assert.match(sharedText, /^<!-- simt:begin -->/m);
  assert.match(sharedText, /simt shared install --yes/, 'the header names the command that repairs it, not sync');
  assert.ok(!sharedText.includes('simt sync --yes'), 'sync cannot regenerate a file in the home directory');

  for (const root of roots) {
    const declared = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
    assert.equal(declared.shared.level, 'user');
    assert.ok(declared.shared.rules.includes('core'), 'every root declares what it handed over');
  }
  // Declaring is not projecting: the region still carries everything until `sync` runs, so
  // a reader who reads the plan and stops has a consistent repository.
  assert.equal(await regionOf(alpha), before);
  const drifted = await run(['check', '--root', alpha], env);
  assert.match(drifted.out, /AGENTS\.md/);
  assert.notEqual(drifted.code, 0, 'check must notice that the declaration changed the region');

  await run(['sync', '--yes', '--root', alpha], env);
  const checked = await run(['check', '--root', alpha], env);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /^CURRENT {4}AGENTS\.md$/m);
});

test('a region stops carrying what the copy carries, and names how to read it', async () => {
  const { ws, roots, env } = await estate(['alpha', 'beta']);
  await run(['shared', 'install', '--yes', '--root', ws], env);
  for (const root of roots) await run(['sync', '--yes', '--root', root], env);
  const region = await regionOf(join(ws, 'beta'));
  const { bytes: before } = { bytes: Buffer.byteLength(region) };

  assert.match(region, /^## Rules not in this region$/m);
  assert.match(region, /^- Core — hard, carried once per workspace in your reader's user-level rules file instead; if your reader has no copy, run: simt shared install\. Show it with: simt rules show core$/m);
  assert.match(region, /^- Process: slice-commit — unclassified, carried once per workspace/m);
  assert.ok(!region.includes('Where a rule cites a decision'), 'the core body moved out of the region');
  // The parts that are not repeated stay: the command card is this repository's evidence
  // and no other repository's copy of it would be true here.
  assert.match(region, /^Commands for this repository:$/m);

  const plan = await runJson(['shared', 'plan', '--root', ws], env);
  const saving = plan.json.perRoot.reduce((n, r) => n + r.bytes, 0);
  assert.ok(saving > 0);
  assert.ok(before < 20000, `the region is a delta, not the whole projection (${before} B)`);
});

test('the region does not depend on what the reader has installed', async () => {
  // The property CI depends on. `sync` renders from the repository alone, so the same
  // repository renders the same bytes on a machine with no copy, with a stale copy, and
  // with a copy written by somebody else.
  const { ws, roots, env } = await estate(['alpha', 'beta']);
  await run(['shared', 'install', '--yes', '--root', ws], env);
  await run(['sync', '--yes', '--root', roots[0]], env);
  const here = await regionOf(roots[0]);

  const elsewhere = await scratch('simt-shared-home-');
  await mkdir(join(elsewhere, '.config', 'opencode'), { recursive: true });
  await writeFile(join(elsewhere, '.config/opencode/AGENTS.md'), '# somebody else wrote this\n');
  await run(['sync', '--yes', '--root', roots[0]], { HOME: elsewhere, SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(await regionOf(roots[0]), here, 'a foreign copy in the home directory changes nothing');

  // And a repository that declared shared rules but has no copy at all still renders the
  // delta rather than falling back to the full projection, because the fallback would
  // make `check` disagree with itself between two machines reading the same commit.
  await rm(join(env.HOME, '.config/opencode/AGENTS.md'));
  await run(['sync', '--yes', '--root', roots[0]], env);
  assert.equal(await regionOf(roots[0]), here);
  assert.ok(!here.includes('Where a rule cites a decision'));
});

test('doctor reports the reader\'s copy, and is silent where nothing was declared', async () => {
  // Silent is the point: a `doctor` line every repository carries is a line every reader
  // learns to skip, so a repository that declared nothing says nothing at all.
  const quiet = await estate(['solo']);
  const silent = await runJson(['doctor', '--root', quiet.roots[0]], quiet.env);
  assert.equal(silent.json.shared.declared, false);
  assert.ok(!/^shared\s/m.test(silent.out), 'a repository that declared nothing gets no shared line');

  const { ws, env, copy } = await estate(['alpha', 'beta']);
  await run(['shared', 'install', '--yes', '--root', ws], env);
  for (const root of [join(ws, 'alpha'), join(ws, 'beta')]) await run(['sync', '--yes', '--root', root], env);

  const current = await run(['doctor', '--root', join(ws, 'beta')], env);
  assert.match(current.out, /^shared {4}current {2}1 user-level file\(s\) carry every rule this repository handed over$/m);
  const payload = await runJson(['doctor', '--root', join(ws, 'beta')], env);
  assert.equal(payload.json.shared.state, 'current');
  assert.equal(payload.json.shared.rules.includes('core'), true);

  // Absent is not the same as silent: the repository declared a copy and this machine has
  // none, which is a missing file and one command rather than nothing to say.
  await rm(copy);
  const absent = await runJson(['doctor', '--root', join(ws, 'alpha')], env);
  assert.equal(absent.json.shared.state, 'absent');
  assert.match(absent.json.shared.detail, /simt shared install --yes/);

  // Stale is not the same as absent either: the reader has a copy and it is the wrong one.
  // A copy written by an older release — the region intact, one rule fewer — is the case
  // this state exists for, and the missing rule is named rather than counted.
  await run(['shared', 'install', '--yes', '--root', ws], env);
  const whole = await readFile(copy, 'utf8');
  const lastRule = whole.indexOf('## Process: test-gate');
  await writeFile(copy, `${whole.slice(0, lastRule)}${whole.slice(whole.indexOf('<!-- simt:end -->'))}`);
  const stale = await runJson(['doctor', '--root', join(ws, 'beta')], env);
  assert.equal(stale.json.shared.state, 'stale');
  assert.match(stale.json.shared.detail, /is missing test-gate; run: simt shared install --yes/);

  // And a copy this tool cannot parse is neither stale nor absent: reinstalling it would
  // not help, because the file has two beginnings or no end and the remedy is not a
  // command. Saying so is the difference between a report and a guess.
  await writeFile(copy, whole.slice(0, whole.indexOf('## Process: test-gate')));
  const unreadable = await runJson(['doctor', '--root', join(ws, 'beta')], env);
  assert.equal(unreadable.json.shared.state, 'unreadable');
  assert.match(unreadable.json.shared.detail, /could not be read/);
});

test('the estate meter counts the copy once, and the single repository counts it too', async () => {
  const { ws, roots, env, copy } = await estate(['alpha', 'beta']);
  const before = await runJson(['tokens', '--repos', '--root', ws], env);
  assert.equal(before.json.totals.sharedBytes, 0, 'a reader with no copy is not charged for one');

  await run(['shared', 'install', '--yes', '--root', ws], env);
  for (const root of roots) await run(['sync', '--yes', '--root', root], env);

  const after = await runJson(['tokens', '--repos', '--root', ws], env);
  const sharedBytes = Buffer.byteLength(await readFile(copy, 'utf8'));
  assert.equal(after.json.totals.sharedBytes, sharedBytes, 'the copy is counted once, whole');
  assert.equal(
    after.json.totals.estateBytes,
    after.json.totals.generatedBytes + sharedBytes,
    'and the estate figure is the regions plus the copy, not the regions alone',
  );
  assert.ok(after.json.totals.generatedBytes < before.json.totals.generatedBytes, 'the regions shrank');
  assert.ok(
    after.json.totals.estateBytes < before.json.totals.generatedBytes,
    'and the estate costs less than it did before anything moved',
  );
  assert.deepEqual(
    after.json.totals.sharedFiles.map((f) => ({ bytes: f.bytes, rules: f.rules })),
    [{ bytes: sharedBytes, rules: 5 }],
    'and the report names the file and how many rules it carries',
  );

  // One repository is the default way to run this command, so a figure that only counted
  // the copy for the `--repos` mode would be the smaller lie on the more common path.
  const one = await runJson(['tokens', '--root', roots[0]], env);
  assert.equal(one.json.totals.sharedBytes, sharedBytes);
  const oneText = await run(['tokens', '--root', roots[0]], env);
  const estateText = await run(['tokens', '--repos', '--root', ws], env);
  assert.match(estateText.out, /^shared {3}\d+ B carried once in 1 user-level file\(s\) {2}estate total \d+ B$/m);
  assert.match(oneText.out, /^shared {3}\d+ B carried once in 1 user-level file\(s\) {2}always-on for you: \d+ B$/m);
});

test('the reader\'s own prose survives an install, and a second install writes nothing', async () => {
  // The most likely file in a reader's home directory to contain something they wrote
  // themselves, so only the bytes between the markers are ours — and the same bytes come
  // back the second time rather than churning the file.
  const dir = await scratch('simt-shared-file-');
  const path = join(dir, 'nested', 'AGENTS.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '# My own instructions\n\nKeep this paragraph.\n');
  const rules = [
    { id: 'core', rendered: '## Core\n\nCore body.' },
    { id: 'python', rendered: '## Stack: python\n\nPython body.' },
  ];
  const meta = { sha: 'abc1234', sources: ['rules/core.md', 'rules/stacks/python.md'] };

  const first = await writeSharedFile(path, rules, meta);
  assert.equal(first.action, 'added');
  assert.equal(first.created, false, 'the file existed, and its own prose is why it is not ours');
  const text = await readFile(path, 'utf8');
  assert.match(text, /^# My own instructions$/m);
  assert.match(text, /Keep this paragraph\./);
  assert.match(text, /Core body\./);

  const fresh = await writeSharedFile(join(dir, 'fresh', 'AGENTS.md'), rules, meta);
  assert.equal(fresh.created, true, 'a file this command brought into existence says so');
  assert.match(await readFile(join(dir, 'fresh', 'AGENTS.md'), 'utf8'), /Core body\./);

  const second = await writeSharedFile(path, rules, meta);
  assert.equal(second.action, 'unchanged', 'the same rules must not rewrite the file');
  assert.equal(await readFile(path, 'utf8'), text);

  // The two states `doctor` reads, on the file it reads them from.
  const state = await sharedState(path, rules, meta);
  assert.equal(state.state, 'current', 'the region compares, not the whole file the reader owns');
  const one = [rules[0]];
  const coverage = await sharedCoverage(path, one);
  assert.equal(coverage.state, 'current', 'a copy carrying more than this repository declared is current for it');
  assert.equal(coverage.checked, 1);
  const both = await sharedCoverage(path, rules);
  assert.equal(both.state, 'current');
  assert.equal(both.checked, 2);

  const short = await writeSharedFile(join(dir, 'short.md'), one, { sha: 'abc1234', sources: ['rules/core.md'] });
  const shortCoverage = await sharedCoverage(short.path, rules);
  assert.equal(shortCoverage.state, 'stale');
  assert.deepEqual(shortCoverage.missing, ['python']);
  assert.deepEqual(await sharedState(join(dir, 'absent.md'), rules, meta), { state: 'absent' });
});

test('a workspace with no repositories fails with a remedy rather than an empty plan', async () => {
  const empty = await scratch('simt-shared-empty-');
  const failed = await run(['shared', 'plan', '--root', empty]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.out, /no git repositories/);
  assert.match(failed.out, /point --root at the directory holding the repositories/);
});