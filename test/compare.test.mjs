// simt-dev compare - workspace discovery and matrix rows.
//
// The fixture repos here are synthetic and minimal, because the properties worth
// testing are properties of the ALGORITHM: how a `.git` file is classified, what
// happens when a manifest is broken, which conditions produce a problem line. A
// test that copies a real repo would pass for the wrong reason whenever the real
// repo happens to be healthy.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { plan } from '../src/projection/project.mjs';

import { classify, discover, ownerFromGitdir, parseGitdirPointer, slugMatchesDir } from '../src/compare/discover.mjs';
import { buildRow, summarise } from '../src/compare/row.mjs';
import { readHooksState } from '../src/compare/hooksstate.mjs';
import { classifyGateCommand, classifyRuleViolations, learnAcrossEstate, renderAdrDraft, renderLearningLines } from '../src/compare/learn.mjs';
import { GATES } from '../src/hooks/gates.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, cmd } from './fixture.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');

const exec = promisify(execFile);
const made = [];

/** Run a command for its --json payload. */
async function json(args) {
  const { stdout } = await exec('node', [BIN, ...args, '--json'], { maxBuffer: 16 << 20 });
  return JSON.parse(stdout);
}

/**
 * The same, for a command that is expected to fail.
 *
 * `json` rejects on a non-zero exit, which is right for every other caller here and
 * useless for the one question this file has to ask: what does the gate say about a
 * repository whose gate is red. A helper that cannot read a failing command's output
 * is a helper that can only ever compare two green things.
 */
async function failingJson(args) {
  try {
    const { stdout } = await exec('node', [BIN, ...args, '--json'], { maxBuffer: 16 << 20 });
    return { code: 0, payload: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code ?? 1, payload: JSON.parse(error.stdout) };
  }
}

/**
 * A git repo with a real HEAD, because every command under test shells out to git.
 * `into` places it inside an existing workspace, which is what the discovery tests
 * need - each repo must be a sibling of the others, not in its own temp root.
 */
async function gitRepo(name, files = {}, into = null) {
  const parent = into ?? (await mkdtemp(join(tmpdir(), 'simt-compare-')));
  const root = join(parent, name);
  made.push(root);
  await mkdir(root, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  if (Object.keys(files).length > 0) {
    await exec('git', ['add', '-A'], { cwd: root });
    await git(['commit', '-qm', 'seed'], { cwd: root });
  }
  return root;
}

/** Rebuild a minimal row so summarise() can be compared against the JSON shape. */
function rowsOf(payload) {
  return payload.rows.map((r) => ({
    adoption: r.adoption,
    region: r.region,
    pinnedSha: r.pinnedSha,
    hooksRouted: r.hooksRouted,
    foreignHooks: r.foreignHooks,
    problems: r.problems,
  }));
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'simt-compare-ws-'));
  made.push(root);
  return root;
}

/**
 * Put a real generated region in place, the way a repo that has run
 * `simt-dev init && simt-dev sync` would look. Returns the SHA it was stamped with, so a
 * test can assert on a mismatch against a specific version rather than whatever
 * HEAD happens to be.
 */
async function adopt(root) {
  const { targets } = await plan(root);
  await writeFile(targets[0].path, targets[0].text);
  return { sha: targets[0].sha };
}

const CONTEXT = {
  expectedSha: 'aaaaaaa',
  gates: new Set(Object.keys(GATES)),
  gateKinds: new Map(Object.entries(GATES).map(([n, g]) => [n, g.kind])),
};

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

// --- discovery -------------------------------------------------------------

test('a directory with a .git directory is a repo', async () => {
  const root = await gitRepo('normal');
  assert.equal((await classify(root)).kind, 'repo');
});

test('a directory with a .git file is a worktree, not a repo', async () => {
  // The estate has exactly this shape (.wt-wear-redesign), and a stat-following
  // scan that only looked for directories would report it as unmanaged - i.e.
  // silently wrong rather than loudly absent.
  const root = await scratch();
  const owner = await gitRepo('app');
  await mkdir(join(owner, '.git', 'worktrees', '-wt-redesign'), { recursive: true });
  await mkdir(join(root, '.wt-redesign'));
  await writeFile(
    join(root, '.wt-redesign', '.git'),
    `gitdir: ${join(owner, '.git', 'worktrees', '-wt-redesign')}\n`,
  );

  const result = await classify(join(root, '.wt-redesign'));
  assert.equal(result.kind, 'worktree');
  assert.equal(result.ownerName, 'app');
  assert.equal(result.ownerMatches, true);
});

test('a worktree is attributed to its owner, and the slug/dir mismatch is reported', async () => {
  const root = await scratch();
  const owner = await gitRepo('app');
  await mkdir(join(owner, '.git', 'worktrees', '-wt-redesign'), { recursive: true });
  await mkdir(join(root, '.wt-renamed'));
  await writeFile(
    join(root, '.wt-renamed', '.git'),
    `gitdir: ${join(owner, '.git', 'worktrees', '-wt-redesign')}\n`,
  );

  const result = await classify(join(root, '.wt-renamed'));
  assert.equal(result.kind, 'worktree');
  // The owner is still recoverable from the path, but the slug can no longer
  // identify the worktree, so the mismatch must be visible rather than assumed away.
  assert.equal(result.ownerName, 'app');
  assert.equal(result.ownerMatches, false);
});

test('a .git file that is not a gitdir pointer is not treated as a repo', async () => {
  const root = await scratch();
  await mkdir(join(root, 'weird'));
  await writeFile(join(root, 'weird', '.git'), 'this is not a pointer\n');
  assert.equal((await classify(join(root, 'weird'))).kind, 'directory');
});

test('a non-repo directory is counted, not dropped', async () => {
  // simt-space-review is 25 PNGs. Hiding it would hide the fact that a workspace
  // member is unmanaged, which is exactly the kind of finding compare exists for.
  const root = await scratch();
  await gitRepo('a', {}, root);
  await mkdir(join(root, 'screenshots'));

  const found = await discover(root);
  assert.equal(found.repos.length, 1);
  assert.equal(found.directories.length, 1);
  assert.ok(found.directories[0].endsWith('screenshots'));
});

test('discovery is stable across runs so two runs diff cleanly', async () => {
  const root = await scratch();
  for (const name of ['zeta', 'alpha', 'mu']) await gitRepo(name, {}, root);

  const first = await discover(root);
  const second = await discover(root);
  assert.deepEqual(first.repos, second.repos);
  assert.deepEqual(
    first.repos.map((p) => p.split('/').pop()),
    ['alpha', 'mu', 'zeta'],
  );
});

test('an unreadable workspace reports an error instead of an empty estate', async () => {
  const found = await discover(join(tmpdir(), 'simt-does-not-exist-9f3a'));
  assert.ok(found.error);
  assert.deepEqual(found.repos, []);
});

test('gitdir parsing and slug matching', () => {
  assert.equal(parseGitdirPointer('gitdir: /a/b/.git/worktrees/-wt'), '/a/b/.git/worktrees/-wt');
  assert.equal(parseGitdirPointer('nothing here'), null);
  assert.equal(ownerFromGitdir('/a/b/.git/worktrees/-wt').ownerDir, '/a/b');
  assert.equal(ownerFromGitdir('/a/b/.git'), null);
  // The slug drops the leading dot, so both sides normalise before comparing.
  assert.equal(slugMatchesDir('-wt-wear-redesign', '.wt-wear-redesign'), true);
  assert.equal(slugMatchesDir('-wt-x', '.wt-y'), false);
});

// --- hooks state -----------------------------------------------------------

test('a repo with no core.hooksPath reports not routed', async () => {
  const root = await gitRepo('nohooks');
  const state = await readHooksState(root);
  assert.equal(state.current, null);
  assert.equal(state.routed, false);
});

test('a worktree does not inherit the parent repo hooks routing', async () => {
  // The parent routes hooks; the worktree is a separate checkout with separate
  // config. Treating it as hooked would report a gate that does not run there.
  const root = await gitRepo('hooked');
  await exec('git', ['config', 'core.hooksPath', '.simt-hooks'], { cwd: root });
  assert.equal((await readHooksState(root)).routed, true);
});

// --- rows ------------------------------------------------------------------

test('an unmanaged repo has no problems - it is the expected mid-migration state', async () => {
  // If a repo that has not adopted made compare exit non-zero, every run during a
  // migration would be red and people would stop reading it.
  const root = await gitRepo('fresh', { 'README.md': 'x' });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'unmanaged');
  assert.deepEqual(row.problems, []);
});

test('an unadopted repo is not also reported as lacking a region', async () => {
  const root = await gitRepo('fresh', { 'README.md': 'x' });
  const row = await buildRow(root, CONTEXT);
  // One root cause (not adopted) must not produce two findings.
  assert.equal(row.problems.length, 0);
});

test('a broken manifest makes the row broken and names the parse failure', async () => {
  const root = await gitRepo('broken', { [MANIFEST_FILE]: '{ not json' });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'broken');
  assert.equal(row.problems.length, 1);
  assert.match(row.problems[0], cmd('{manifest} unparseable'));
});

test('an adopted repo with no region is a problem', async () => {
  const root = await gitRepo('adopted-noregion', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'adopted-noregion', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'adopted');
  assert.ok(row.problems.some((p) => /no generated region/.test(p)));
});

test('an adopted repo that routes hooks nowhere is a problem', async () => {
  const root = await gitRepo('adopted-nohooks', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'adopted-nohooks', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.hooksRouted, false);
  assert.ok(row.problems.some((p) => /no core\.hooksPath; commits are ungated/.test(p)));
});

test('an adopted repo whose core.hooksPath points elsewhere names the existing value', async () => {
  const root = await gitRepo('adopted-otherhooks', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'adopted-otherhooks', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  await exec('git', ['config', 'core.hooksPath', 'scripts/git-hooks'], { cwd: root });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /"scripts\/git-hooks"/.test(p)));
});

test('a gate the dispatcher does not know is a problem', async () => {
  const root = await gitRepo('badgate', {
    [MANIFEST_FILE]: JSON.stringify({
      id: 'badgate',
      gates: { preCommit: ['format', 'warp-drive'], prePush: ['test'] },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /gate "warp-drive" is not a known gate/.test(p)));
});

test('a command-kind gate with no declared command is a problem', async () => {
  // The dispatcher fails closed on this at commit time, so compare must see it
  // before a commit does.
  const root = await gitRepo('nocommmand', {
    [MANIFEST_FILE]: JSON.stringify({
      id: 'nocommmand',
      gates: { preCommit: ['codegen-drift'], prePush: ['test'], commands: {} },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /no declared command/.test(p)));
});

test('a declared command that no gate invokes is reported, not ignored', async () => {
  const root = await gitRepo('orphancmd', {
    [MANIFEST_FILE]: JSON.stringify({
      id: 'orphancmd',
      gates: { preCommit: ['format'], prePush: ['test'], commands: { memory: 'scripts/memcheck.sh' } },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /declared command "memory" is in no gate list/.test(p)));
});

test('the same gate declared on both hooks is reported once, not twice', async () => {
  const root = await gitRepo('dupe', {
    [MANIFEST_FILE]: JSON.stringify({
      id: 'dupe',
      gates: { preCommit: ['format'], prePush: ['format'] },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  const unknown = row.problems.filter((p) => /not a known gate/.test(p));
  assert.equal(unknown.length, 0);
  assert.deepEqual([...new Set(row.gatesDeclared)], ['format']);
});

test('a hand-edited region is not reported as a version mismatch', async () => {
  // The two drift causes need different readings. When the recorded SHA already
  // matches this simt-dev, telling the reader their pin is stale sends them
  // looking for a version problem that does not exist.
  const root = await gitRepo('hand-edited', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'hand-edited', gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const built = await adopt(root);
  const file = join(root, 'AGENTS.md');
  // Inside the markers. Appending after the END marker is hand-owned content by
  // design, so it must NOT count as drift - that is the containment guarantee.
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('## Git', '## Git\n\nA human edited the generated text.'));

  const row = await buildRow(root, { ...CONTEXT, expectedSha: built.sha });
  assert.equal(row.region, 'drift');
  assert.equal(row.recordedSha, built.sha);
  assert.ok(row.problems.some((p) => /hand-edited/.test(p)));
  assert.equal(row.problems.filter((p) => /but this simt-dev is/.test(p)).length, 0);
});

test('content added OUTSIDE the region is not drift', async () => {
  // The containment guarantee: hand-owned bytes around the markers survive a
  // round trip untouched, so a `compare` that called them drift would be
  // reporting the projection engine's failure as the author's mistake.
  const root = await gitRepo('contained', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'contained', gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const built = await adopt(root);
  const file = join(root, 'AGENTS.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\n## My own notes\n`);
  assert.equal((await buildRow(root, { ...CONTEXT, expectedSha: built.sha })).region, 'current');
});

test('a region from an older simt-dev IS reported as a version mismatch', async () => {
  const root = await gitRepo('behind', {
    [MANIFEST_FILE]: JSON.stringify({ id: 'behind', gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const built = await adopt(root);
  const file = join(root, 'AGENTS.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace(built.sha, '0ddb3a9'));

  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /but this simt-dev is/.test(p)));
});

test('a manifest stack that no marker supports is reported, not silently reconciled', async () => {
  const root = await gitRepo('liar', {
    [MANIFEST_FILE]: JSON.stringify({
      id: 'liar',
      stack: ['python'],
      gates: { preCommit: [], prePush: [] },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.deepEqual(row.declaredStack, ['python']);
  assert.deepEqual(row.stack, []);
  assert.ok(row.problems.some((p) => /declares python but no marker proves it/.test(p)));
});

test('a manifest that omits a detected tag is reported the other way', async () => {
  const root = await gitRepo('omits', {
    'pyproject.toml': '{}',
    [MANIFEST_FILE]: JSON.stringify({ id: 'omits', stack: [], gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /detected python but the manifest omits it/.test(p)));
});

test('a manifest that agrees with detection produces no stack problem', async () => {
  const root = await gitRepo('agrees', {
    'pyproject.toml': '{}',
    [MANIFEST_FILE]: JSON.stringify({
      id: 'agrees',
      stack: ['python'],
      gates: { preCommit: [], prePush: [] },
    }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.problems.filter((p) => /stack disagrees/.test(p)).length, 0);
});

// --- summary ---------------------------------------------------------------

test('summarise counts adoption, drift and shas without judgement', () => {
  const rows = [
    { adoption: 'adopted', region: 'current', pinnedSha: 'aaaaaaa', hooksRouted: true, problems: [] },
    { adoption: 'adopted', region: 'drift', pinnedSha: 'bbbbbbb', hooksRouted: false, problems: ['x'] },
    { adoption: 'unmanaged', region: 'absent', pinnedSha: null, hooksRouted: false, problems: [] },
  ];
  const s = summarise(rows);
  assert.equal(s.repos, 3);
  assert.equal(s.adopted, 2);
  assert.equal(s.unmanaged, 1);
  assert.equal(s.drifted, 1);
  assert.equal(s.current, 1);
  assert.equal(s.hooksRouted, 1);
  assert.equal(s.withProblems, 1);
  // (none) sorts last: it is not a SHA and must not head the list.
  assert.deepEqual(s.shas, [['aaaaaaa', 1], ['bbbbbbb', 1], ['(none)', 1]]);
});

// --- command surface -------------------------------------------------------

test('compare against a workspace with no repos fails with a remedy', async () => {
  const root = await scratch();
  const code = await dispatch(['compare', '--root', root]);
  assert.equal(code, 3); // EXIT.CONFIG
});

test('compare --root on a single repo compares that repo, not its children', async () => {
  // ADR-014: a single repository is a first-class case, not a usage error. The old
  // behaviour scanned the CHILDREN of the given path, so naming one repo reported
  // "contains no git repositories" and exit 3 - a false statement about the estate.
  const root = await gitRepo('lonely');
  await mkdir(join(root, 'simt-dev'), { recursive: true });
  const code = await dispatch(['compare', '--root', root]);
  assert.equal(code, 0);

  const payload = await json(['compare', '--root', root]);
  assert.equal(payload.shape, 'repo');
  assert.equal(payload.root, root);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].name, 'lonely');
});

test('compare --root on a workspace directory still reports the workspace shape', async () => {
  const root = await scratch();
  await gitRepo('one', { 'README.md': 'x' }, root);
  await gitRepo('two', { 'README.md': 'x' }, root);
  const payload = await json(['compare', '--root', root]);
  assert.equal(payload.shape, 'workspace');
  assert.deepEqual(payload.rows.map((r) => r.name).sort(), ['one', 'two']);
});

test('compare is not registered as unimplemented any more', async () => {
  // Guards the STEPS registry: an entry left behind would make a real run fail
  // UNSUPPORTED after the code works.
  const root = await scratch();
  await gitRepo('ok', { 'README.md': 'x' });
  const code = await dispatch(['compare', '--root', root]);
  assert.notEqual(code, 5);
});
// --- repos that run their own hooks ---------------------------------------
// The takeover guard asks for consent at install time. `compare` is where a
// rollout actually reads the estate, so it has to say what adoption will cost -
// as a note, because "not adopted yet" is the normal state and a dashboard that
// goes red for it is a dashboard everyone ignores.

test('compare: a repo running its own hooks is a note, not a problem', async () => {
  const ws = await scratch();
  const quiet = await gitRepo('quiet', { 'README.md': 'x\n' }, ws);
  const own = await gitRepo('own-hooks', { 'README.md': 'x\n' }, ws);
  await writeFile(join(own, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(join(own, '.git', 'hooks', 'pre-commit'), 0o755);

  const payload = await json(['compare', '--root', ws]);
  const row = payload.rows.find((r) => r.name === 'own-hooks');
  assert.deepEqual(row.foreignHooks.map((h) => h.event), ['pre-commit']);
  assert.equal(row.problems.length, 0, 'an unadopted repo with its own hooks is not broken');
  assert.equal(row.notes.length, 1);
  assert.match(row.notes[0], /runs its own pre-commit \(\d+ bytes\)/);
  assert.match(row.notes[0], /hooks install will replace it and asks first/);
  assert.equal(payload.summary.withOwnHooks, 1);
  assert.ok(quiet);
});

test('compare: notes never change the exit code', async () => {
  const ws = await scratch();
  const own = await gitRepo('own-hooks', { 'README.md': 'x\n' }, ws);
  await writeFile(join(own, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(join(own, '.git', 'hooks', 'pre-commit'), 0o755);
  // exec rejects on a non-zero exit, so a successful call IS the assertion.
  const { stdout } = await exec('node', [BIN, 'compare', '--root', ws], { maxBuffer: 16 << 20 });
  assert.match(stdout, /run their own hooks; adopting replaces them \(a note, not a problem\)/);
});

test('summarise: counts repos with their own hooks, and tolerates a partial row', async () => {
  const summary = summarise([
    { adoption: 'adopted', region: 'current', pinnedSha: 'aaa', hooksRouted: true, foreignHooks: [], problems: [] },
    { adoption: 'unmanaged', region: 'absent', pinnedSha: null, hooksRouted: false, foreignHooks: [{ event: 'pre-commit', bytes: 10 }], problems: [] },
    { adoption: 'unmanaged', region: 'absent', pinnedSha: null, hooksRouted: false, problems: [] },
  ]);
  assert.equal(summary.withOwnHooks, 1);
  assert.equal(summary.withProblems, 0);
});

test('compare --json: the summary block carries every field summarise computes', async () => {
  // The JSON summary was a hand-listed copy of summarise()'s output, which is
  // why `withOwnHooks` reached the text render and vanished from the machine
  // surface. A copied list of names is a list that rots; assert the two agree.
  const ws = await scratch();
  await gitRepo('one', { 'README.md': 'x\n' }, ws);
  const payload = await json(['compare', '--root', ws]);
  const fromSummarise = summarise(rowsOf(payload));
  for (const key of Object.keys(fromSummarise)) {
    if (['root', 'shape', 'source', 'expectedSha'].includes(key)) continue;
    assert.ok(key in payload.summary, `compare --json summary is missing "${key}"`);
  }
});

test('compare --json: every row carries notes and foreignHooks, even when empty', async () => {
  // A field present only when non-empty is a field an agent has to guess about.
  const ws = await scratch();
  await gitRepo('one', { 'README.md': 'x\n' }, ws);
  const payload = await json(['compare', '--root', ws]);
  for (const row of payload.rows) {
    assert.ok(Array.isArray(row.notes), `${row.name} has no notes array`);
    assert.ok(Array.isArray(row.foreignHooks), `${row.name} has no foreignHooks array`);
  }
});

// --- S25: what the row reports is what an agent is told -----------------------

/**
 * An adopted repo that projects a rule file per surface, as a Cursor repo does.
 *
 * `plan()` writes the region only, so the `.mdc` files are written here from the
 * plan's own target list - a fixture invented independently of the code would pass for
 * the wrong reason the moment the target shape changed, which is how the seam test in
 * `test/markers.test.mjs` came to pass while asserting nothing.
 */
async function repoWithRuleFiles(name, files = {}) {
  const root = await gitRepo(name, {
    [MANIFEST_FILE]: JSON.stringify({
      id: name,
      stack: ['node'],
      // copilot, not cursor: its reader does not read AGENTS.md (ADR-046), so it is
      // still planned a rule file per surface. Choosing cursor here would have made
      // this fixture project none, and the test would have stopped covering the gate
      // without failing loudly - which is what happened the first time.
      surfaces: ['opencode', 'copilot'],
      gates: { preCommit: [], prePush: [] },
    }),
    'package.json': JSON.stringify({ name: 'a', private: true }) + '\n',
    'AGENTS.md': '# mine\n',
    ...files,
  });
  const built = await plan(root);
  // `plan()` flattens the region, the rule files and the baselines into one list, so
  // the rule files are picked out by the surface directory rather than by a suffix:
  // the suffix was `.mdc` when this helper was written, and cursor no longer gets a
  // file at all, so a suffix would have silently matched nothing.
  const ruleFiles = built.targets.filter((t) => /\/(rules|instructions)\//.test(t.path));
  assert.ok(ruleFiles.length > 0, 'the fixture must project at least one rule file, or it proves nothing');
  await writeFile(join(root, 'AGENTS.md'), built.targets[0].text);
  for (const t of ruleFiles) {
    await mkdir(join(t.path, '..'), { recursive: true });
    await writeFile(t.path, t.text);
  }
  return { root, sha: built.targets[0].sha, ruleFiles };
}

test('a stale rule file on an adopted repo is a problem, and it is named (S25)', async () => {
  // The gate read `row.adoption` before anything assigned it, so it compared against
  // the initialiser's 'unmanaged' and could never fire. The row still SHOWED the stale
  // file in its `rules` column, which is what made this survive review: the dashboard
  // looked like it was reporting drift while its problems list - and therefore its
  // exit code - said nothing.
  const { root, sha } = await repoWithRuleFiles('stale-rule-file');
  const before = await buildRow(root, { ...CONTEXT, expectedSha: sha });
  assert.ok(before.ruleFiles.total > 0, 'the fixture must project a rule file, or it proves nothing');
  assert.equal(before.ruleFiles.total, before.ruleFiles.current, 'the fixture must start current, or the test proves nothing');
  assert.equal(before.problems.filter((p) => /rule files are not current/.test(p)).length, 0);

  // Inside the markers. Appending after the END marker is hand-owned content by design
  // and is correctly not drift - so an appended line makes this test fail, which it did,
  // and a fixture that asserts nothing is the same defect in a different coat.
  const victim = join(root, '.github/instructions/intake-questions.instructions.md');
  const text = await readFile(victim, 'utf8');
  const stamp = /<!-- simt:sha=[0-9a-f]{40} -->/.exec(text);
  assert.ok(stamp, 'the fixture must contain a generated region to edit');
  await writeFile(victim, text.replace(stamp[0], `${stamp[0]}\nA HUMAN EDIT INSIDE THE REGION.`));

  const after = await buildRow(root, { ...CONTEXT, expectedSha: sha });
  assert.deepEqual(after.ruleFiles.stale, ['.github/instructions/intake-questions.instructions.md']);
  const problem = after.problems.find((p) => /rule files are not current/.test(p));
  assert.ok(problem, `a stale rule file must be a problem; problems were ${JSON.stringify(after.problems)}`);
  // Named, not summarised: "something is stale" is not actionable and this command
  // exists to be acted on.
  assert.match(problem, /\.github\/instructions\/intake-questions\.instructions\.md/);
  assert.match(problem, cmd('run: {cli} sync --yes'));
});

test('an unmanaged repo with stray rule files is still not a problem (S25)', async () => {
  // The other half of the gate, and the reason it is gated at all: a repo mid-migration
  // has its own files and reporting them as "not current" turns the normal state of most
  // repos on day one into a red estate. Fixing the gate must not turn this on.
  const root = await gitRepo('unmanaged-strays', {
    '.cursor/rules/mine.mdc': '---\n---\nnope\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'unmanaged');
  assert.equal(row.problems.filter((p) => /rule files are not current/.test(p)).length, 0);
});

test('compare reports the profiles sync would project (S25)', async () => {
  // `profiles` was documented as "profile ids that would be selected", initialised to
  // `[]`, and never assigned - so every row in every run of the estate dashboard
  // reported no profiles. The two values are computed from the same `select()` call on
  // the same inputs; this asserts they agree rather than trusting that comment, because
  // the comment was true while the code was not.
  const { root, sha } = await repoWithRuleFiles('profiles-row');
  const row = await buildRow(root, { ...CONTEXT, expectedSha: sha });
  const planned = await plan(root);
  assert.deepEqual(row.profiles, planned.profiles);
  assert.ok(row.profiles.length > 0, 'the fixture must select at least one profile, or the field could still be empty and pass');
});

test('compare reports an orphaned rule file as a note, never a problem (S12)', async () => {
  // ADR-021 ruling 6: simt-dev never deletes a file it once generated. So a generated
  // rule file whose surface now folds the rule into AGENTS.md cannot be repaired by
  // any command, and calling it a problem would put a repo permanently red with a
  // remedy that is a lie. There is a note, naming the file and the delete.
  const root = await gitRepo('orphaned-rule-file', {
    'package.json': '{"name":"a","private":true}\n',
    [MANIFEST_FILE]: JSON.stringify({
      id: 'orphaned-rule-file',
      stack: ['node'],
      surfaces: ['opencode', 'copilot'],
      gates: { preCommit: [], prePush: [] },
    }),
    'AGENTS.md': '# mine\n',
  });
  const built = await plan(root);
  await writeFile(join(root, 'AGENTS.md'), built.targets[0].text);
  for (const t of built.targets.filter((x) => x.path.includes('/instructions/'))) {
    await mkdir(join(t.path, '..'), { recursive: true });
    await writeFile(t.path, t.text);
  }
  // A cursor-shaped leftover from before ADR-046, planted from a real generated file
  // so the region marker is the tool's own rather than a hand-written approximation.
  const src = built.targets.find((x) => x.path.includes('/instructions/'));
  await mkdir(join(root, '.cursor/rules'), { recursive: true });
  await writeFile(join(root, '.cursor/rules/test-gate.mdc'), src.text.replace(/\.md\b/g, '.mdc'));

  const row = await buildRow(root, { ...CONTEXT, expectedSha: built.targets[0].sha });
  assert.deepEqual(row.ruleFiles.orphaned, ['.cursor/rules/test-gate.mdc']);
  // A note, not a problem: the difference is the exit code, and no remedy can fix it.
  assert.equal(row.problems.filter((p) => /repeat text already folded/.test(p)).length, 0);
  const note = row.notes.find((n) => /repeat text already folded/.test(n));
  assert.ok(note, `expected a note; notes were ${JSON.stringify(row.notes)}`);
  assert.match(note, /delete them/);
  assert.match(note, /will not remove a file it wrote/);
  // ...and it is not counted among the rule files it cannot repair either.
  assert.deepEqual(row.ruleFiles.stale, []);
});

// A gate that refuses is a fact about the repository, and a dashboard that does not
// count it is describing a different repository. This row said `current` for all
// fourteen adopted repositories in the estate while `check` exited 1 in every one of
// them: the region was current, the manifest was not, and the row only looked at the
// region.
//
// The test is a PARITY test - both surfaces driven at one fixture and compared -
// rather than two assertions written separately, because that is the shape ADR-052
// found drifting in the budget loops: two copies of one question, each asserted, each
// unable to see the other.
test('every finding check refuses on, this row reports', async () => {
  const { provenanceDigest } = await import('../src/projection/project.mjs');
  const { MANIFEST_COMMENT } = await import('../src/projection/manifest.mjs');

  const root = await gitRepo('stale-manifest');
  const { sha } = await adopt(root);
  // The estate's own shape: adopted, region current, and a manifest written before
  // `projection.version` existed. Every value in the file is true.
  await writeFile(
    join(root, MANIFEST_FILE),
    `${JSON.stringify(
      {
        ...MANIFEST_COMMENT,
        id: 'stale-manifest',
        stack: [],
        limits: { coverage: null, fileLines: { warn: 400, error: 1000 } },
        gates: { preCommit: [], prePush: [] },
        localSkills: [], profiles: [], substitutions: {}, surfaces: null,
        projection: { simtDevSha: sha },
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(await provenanceDigest() !== sha, false, 'the fixture must carry this build\'s own digest');

  // What the gate says. Through the shipped binary, because the claim under test is
  // about the tool a reader runs rather than about a function in this repository.
  const checked = await failingJson(['check', '--root', root]);
  const refused = checked.payload.findings.filter((f) => f.status === 'stale-generated-field');

  // What the dashboard says, about the same bytes, with no write in between.
  const row = await buildRow(root, { ...CONTEXT, expectedSha: sha });
  const named = row.problems.filter((p) => p.includes('generated field'));

  assert.equal(refused.length, 1, `the fixture must be refused by check: ${JSON.stringify(refused)}`);
  assert.equal(
    named.length,
    refused.length,
    `check refuses ${refused.length} manifest finding(s) and this row reports ${named.length}`,
  );
  assert.match(named[0], /run: simt check|run: .*sync --yes/);

  // And the repair both of them name actually clears it, so parity is not two
  // commands agreeing on a defect neither can fix.
  await exec('node', [BIN, 'sync', '--root', root, '--yes'], { maxBuffer: 16 << 20 });
  const after = await failingJson(['check', '--root', root]);
  assert.equal(
    after.payload.findings.filter((f) => f.status === 'stale-generated-field').length,
    0,
    'the named remedy did not clear the finding',
  );
});

// `hooksComplete` is the number the estate roll-out is measured on, and it was
// computed from a predicate `hooks install` did not use: `compare` defaulted to "a
// shim is wanted for every event". A repository declaring only `prePush` gates was
// therefore reported incomplete for the pre-commit shim it has no reason to write, and
// running `hooks install` as many times as you liked could not clear it.
//
// Parity again, for the same reason as the manifest finding above: two copies of one
// question, each asserted, each unable to see the other.
test('a repo is complete exactly when install has nothing left to write', async () => {
  const root = await (async () => {
    const d = await mkdtemp(join(tmpdir(), 'simt-compare-complete-'));
    made.push(d);
    await exec('git', ['init', '-q'], { cwd: d });
    await exec('git', ['config', 'user.email', 't@e.com'], { cwd: d });
    await exec('git', ['config', 'user.name', 'T'], { cwd: d });
    await writeFile(join(d, 'package.json'), JSON.stringify({ name: 'r', scripts: { test: 'true' } }));
    await writeFile(join(d, 'AGENTS.md'), '# r\n');
    await exec('git', ['add', '-A'], { cwd: d });
    await exec('git', ['commit', '-qm', 'init'], { cwd: d });
    return d;
  })();

  // prePush gates only: no pre-commit gate, so no pre-commit shim is wanted.
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'r', stack: [], surfaces: null, gates: { preCommit: [], prePush: ['test'] } }, null, 2),
  );

  await exec('node', [BIN, 'hooks', 'install', '--root', root, '--yes'], { maxBuffer: 16 << 20 });
  const row = await buildRow(root, CONTEXT);

  assert.equal(row.hooksRouted, true, 'the repository is routed');
  assert.equal(
    row.hooksComplete,
    true,
    `a repo with no pre-commit gate must not be incomplete for having no pre-commit shim: ${JSON.stringify(row.problems)}`,
  );
  assert.deepEqual(row.problems.filter((p) => /not installed/.test(p)), []);

  // And the converse: declare a pre-commit gate it cannot run, and the missing shim
  // must be a problem again. A predicate that always says "yes" passes the row above
  // for the wrong reason, exactly as an always-false one would.
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'r', stack: [], surfaces: null, gates: { preCommit: ['lint'], prePush: ['test'] } }, null, 2),
  );
  const after = await buildRow(root, CONTEXT);
  assert.match(
    after.problems.join('\n'),
    /pre-commit not installed/,
    'a declared gate with no shim is still a defect',
  );
  assert.equal(after.hooksComplete, false);
});

// --- R36: estate learning through compare ----------------------------------

test('R36: classifyGateCommand and classifyRuleViolations map commands and hook denials deterministically', () => {
  assert.deepEqual(classifyGateCommand('npm run --silent lint'), { gate: 'lint', adr: 'ADR-004' });
  assert.deepEqual(classifyGateCommand('node --test test/unit.test.mjs'), { gate: 'test', adr: 'ADR-003' });
  assert.deepEqual(
    classifyGateCommand('scripts/check-mem.sh', { gates: { commands: { memory: 'scripts/check-mem.sh' } } }),
    { gate: 'memory', adr: 'ADR-003' },
  );

  const pushHit = classifyRuleViolations({
    kind: 'hook-denial',
    errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
    keywords: ['push'],
  });
  assert.deepEqual(pushHit, [{ rule: 'push', adr: 'ADR-001', kind: 'policy' }]);

  const reviewHit = classifyRuleViolations({
    kind: 'review-block',
    errorLine: 'BLOCK: refactored outside the blast radius (ADR-002)',
    keywords: ['blast'],
  });
  assert.deepEqual(reviewHit, [{ rule: 'ADR-002', adr: 'ADR-002', kind: 'adr' }]);
});

test('R36: compare aggregates ledgers, hook denials, and zero-value rules across a workspace into byte-identical ADR drafts', async () => {
  const ws = await scratch();
  const repoA = await gitRepo('alpha', { 'README.md': 'a\n' }, ws);
  const repoB = await gitRepo('beta', { 'README.md': 'b\n' }, ws);

  await mkdir(join(repoA, '.simt', 'bench', 'runs'), { recursive: true });
  await mkdir(join(repoB, '.simt', 'bench', 'runs'), { recursive: true });

  // Ledger entries for alpha and beta: test fails repeatedly and is slow, lint is fast and passes.
  const alphaLedger = [
    {
      v: 1,
      ts: '2026-10-19T10:00:00Z',
      tree: '1111111111111111111111111111111111111111',
      cmd: 'npm run --silent test',
      exit: 1,
      ms: 2400,
      outputDigest: 'sha256-aaa',
      summary: '0 pass, 1 fail',
      errorLine: 'not ok 1 - suite failed',
      signature: 'sha256-111',
    },
    {
      v: 1,
      ts: '2026-10-19T10:01:00Z',
      tree: '2222222222222222222222222222222222222222',
      cmd: 'npm run --silent lint',
      exit: 0,
      ms: 120,
      outputDigest: 'sha256-bbb',
      summary: 'exit 0',
    },
  ];
  const betaLedger = [
    {
      v: 1,
      ts: '2026-10-19T11:00:00Z',
      tree: '3333333333333333333333333333333333333333',
      cmd: 'npm run --silent test',
      exit: 1,
      ms: 3100,
      outputDigest: 'sha256-ccc',
      summary: '0 pass, 2 fail',
      errorLine: 'not ok 1 - suite failed',
      signature: 'sha256-111',
    },
    {
      v: 1,
      ts: '2026-10-19T11:05:00Z',
      tree: '4444444444444444444444444444444444444444',
      cmd: 'npm run --silent typecheck',
      exit: 0,
      ms: 1850,
      outputDigest: 'sha256-ddd',
      summary: 'exit 0',
    },
  ];

  await writeFile(join(repoA, '.simt', 'ledger.jsonl'), `${alphaLedger.map((x) => JSON.stringify(x)).join('\n')}\n`);
  await writeFile(join(repoB, '.simt', 'ledger.jsonl'), `${betaLedger.map((x) => JSON.stringify(x)).join('\n')}\n`);

  // Hook denials and review-block candidates across alpha and beta.
  const alphaLessons = [
    {
      v: 1,
      id: 'c-0001',
      ts: '2026-10-19T10:02:00Z',
      kind: 'hook-denial',
      signature: 'sha256-push',
      errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
      summary: 'Push needs explicit approval (ADR-001); ask the user.',
      cmd: 'git push origin main',
      paths: [],
      keywords: ['push'],
      evidence: ['git push origin main'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
    {
      v: 1,
      id: 'c-0002',
      ts: '2026-10-19T10:03:00Z',
      kind: 'hook-denial',
      signature: 'sha256-rewrite',
      errorLine: 'Never amend, rebase, reset --hard, force-push or --no-verify unless asked (ADR-017).',
      summary: 'Never amend, rebase, reset --hard, force-push or --no-verify unless asked (ADR-017).',
      cmd: 'git commit --no-verify -m x',
      paths: [],
      keywords: ['rewrite'],
      evidence: ['git commit --no-verify -m x'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
  ];
  const betaLessons = [
    {
      v: 1,
      id: 'c-0001',
      ts: '2026-10-19T11:02:00Z',
      kind: 'hook-denial',
      signature: 'sha256-push',
      errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
      summary: 'Push needs explicit approval (ADR-001); ask the user.',
      cmd: 'git push',
      paths: [],
      keywords: ['push'],
      evidence: ['git push'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
  ];

  await writeFile(join(repoA, '.simt', 'lessons.jsonl'), `${alphaLessons.map((x) => JSON.stringify(x)).join('\n')}\n`);
  await writeFile(join(repoB, '.simt', 'lessons.jsonl'), `${betaLessons.map((x) => JSON.stringify(x)).join('\n')}\n`);

  // Ablation run records in alpha showing `core:style` has dR = 0 and dC > 0 (`current` costs more than `no-core-style`).
  const benchRecords = [
    {
      task: 't-01',
      arm: 'no-core-style',
      rep: 1,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      resolved: true,
      gatesPassed: true,
      costUsd: 0.01,
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 },
    },
    {
      task: 't-01',
      arm: 'current',
      rep: 1,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      resolved: true,
      gatesPassed: true,
      costUsd: 0.04,
      usage: { input: 4000, cacheRead: 0, cacheWrite: 0, output: 200 },
    },
  ];
  await writeFile(join(repoA, '.simt', 'bench', 'runs', 'r-01.json'), `${JSON.stringify(benchRecords[0])}\n`);
  await writeFile(join(repoA, '.simt', 'bench', 'runs', 'r-02.json'), `${JSON.stringify(benchRecords[1])}\n`);

  // Run `compare` twice (both JSON and text) and assert byte-identical output and expected rankings.
  const firstJson = await exec('node', [BIN, 'compare', '--root', ws, '--json'], { maxBuffer: 16 << 20 });
  const secondJson = await exec('node', [BIN, 'compare', '--root', ws, '--json'], { maxBuffer: 16 << 20 });
  assert.equal(firstJson.stdout, secondJson.stdout, 'compare --json must be byte-identical across runs on the same ledgers');

  const firstText = await exec('node', [BIN, 'compare', '--root', ws], { maxBuffer: 16 << 20 });
  const secondText = await exec('node', [BIN, 'compare', '--root', ws], { maxBuffer: 16 << 20 });
  assert.equal(firstText.stdout, secondText.stdout, 'compare text report must be byte-identical across runs on the same ledgers');

  const payload = JSON.parse(firstJson.stdout);
  const { learning } = payload;
  assert.ok(learning, 'compare --json must include learning block');
  assert.equal(learning.reposWithLedgers, 2);
  assert.equal(learning.reposWithDenials, 2);
  assert.equal(learning.totalLedgerRuns, 4);
  assert.equal(learning.totalHookDenials, 3);

  // Most-violated rules: push (2 across alpha, beta) then rewrite (1 in alpha).
  assert.equal(learning.mostViolatedRules.length, 2);
  assert.equal(learning.mostViolatedRules[0].rule, 'push');
  assert.equal(learning.mostViolatedRules[0].adr, 'ADR-001');
  assert.equal(learning.mostViolatedRules[0].count, 2);
  assert.deepEqual(learning.mostViolatedRules[0].repos, ['alpha', 'beta']);
  assert.equal(learning.mostViolatedRules[1].rule, 'rewrite');
  assert.equal(learning.mostViolatedRules[1].count, 1);

  // Most-failing gates: test (2/2 failed).
  assert.equal(learning.mostFailingGates.length, 1);
  assert.equal(learning.mostFailingGates[0].gate, 'test');
  assert.equal(learning.mostFailingGates[0].failures, 2);
  assert.equal(learning.mostFailingGates[0].runs, 2);
  assert.equal(learning.mostFailingGates[0].failRate, 1);

  // Slowest gates: test (p95 3100ms), typecheck (p95 1850ms), lint (p95 120ms).
  assert.deepEqual(
    learning.slowestGates.map((g) => g.gate),
    ['test', 'typecheck', 'lint'],
  );

  // Rules with no measured value: core:style (dR = 0, dC > 0).
  assert.equal(learning.noValueRules.length, 1);
  assert.equal(learning.noValueRules[0].sectionId, 'core:style');
  assert.equal(learning.noValueRules[0].dR, 0);
  assert.ok(learning.noValueRules[0].dC > 0);

  // ADR drafts generated for violated rules, failing gate, slow gate (typecheck >= 1000ms), and no-value rule.
  const categories = learning.adrDrafts.map((d) => `${d.category}:${d.target}`);
  assert.deepEqual(categories, [
    'violated-rule:push',
    'violated-rule:rewrite',
    'failing-gate:test',
    'slow-gate:typecheck',
    'no-value-rule:core:style',
  ]);
  for (const draft of learning.adrDrafts) {
    assert.match(draft.markdown, /^---\nsimt-affects:/);
    assert.match(draft.markdown, /Status: draft/);
    assert.match(draft.markdown, /## Rulings/);
  }

  // Text output includes the learning summary and draft lines.
  assert.match(firstText.stdout, /learning\s+4 ledger run\(s\) across 2 repo\(s\), 3 hook denial\(s\) across 2 repo\(s\), 5 ADR draft\(s\)/);
  assert.match(firstText.stdout, /violated\s+push \(ADR-001\)\s+count=2\s+repos=alpha,beta/);
  assert.match(firstText.stdout, /failing\s+test \(ADR-003\)\s+failures=2\/2 \(100%\)/);
  assert.match(firstText.stdout, /novalue\s+core:style\s+dR=0/);
  assert.match(firstText.stdout, /draft\s+ADR-DRAFT-001\s+\[violated-rule\]/);

  // Direct call with reversed repo order produces the exact same structure and markdown.
  const learnForward = await learnAcrossEstate([repoA, repoB]);
  const learnReverse = await learnAcrossEstate([repoB, repoA]);
  assert.deepEqual(learnForward, learnReverse);
  assert.ok(renderAdrDraft({ draftId: 'ADR-DRAFT-001', category: 'test', title: 'T', context: 'C', rulings: ['R'] }).includes('Status: draft'));
  assert.ok(renderLearningLines(learnForward, { force: true }).some((l) => l.includes('Status: draft')));
});
