// simt compare - workspace discovery and matrix rows.
//
// The fixture repos here are synthetic and minimal, because the properties worth
// testing are properties of the ALGORITHM: how a `.git` file is classified, what
// happens when a manifest is broken, which conditions produce a problem line. A
// test that copies a real repo would pass for the wrong reason whenever the real
// repo happens to be healthy.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { plan } from '../src/projection/project.mjs';

import { classify, discover, ownerFromGitdir, parseGitdirPointer, slugMatchesDir } from '../src/compare/discover.mjs';
import { buildRow, summarise } from '../src/compare/row.mjs';
import { readHooksState } from '../src/compare/hooksstate.mjs';
import { GATES } from '../src/hooks/gates.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: root });
  }
  return root;
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'simt-compare-ws-'));
  made.push(root);
  return root;
}

/**
 * Put a real generated region in place, the way a repo that has run
 * `simt init && simt sync` would look. Returns the SHA it was stamped with, so a
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
  const root = await gitRepo('broken', { 'simt-dev.json': '{ not json' });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'broken');
  assert.equal(row.problems.length, 1);
  assert.match(row.problems[0], /simt-dev\.json unparseable/);
});

test('an adopted repo with no region is a problem', async () => {
  const root = await gitRepo('adopted-noregion', {
    'simt-dev.json': JSON.stringify({ id: 'adopted-noregion', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.adoption, 'adopted');
  assert.ok(row.problems.some((p) => /no generated region/.test(p)));
});

test('an adopted repo that routes hooks nowhere is a problem', async () => {
  const root = await gitRepo('adopted-nohooks', {
    'simt-dev.json': JSON.stringify({ id: 'adopted-nohooks', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.equal(row.hooksRouted, false);
  assert.ok(row.problems.some((p) => /no core\.hooksPath; commits are ungated/.test(p)));
});

test('an adopted repo whose core.hooksPath points elsewhere names the existing value', async () => {
  const root = await gitRepo('adopted-otherhooks', {
    'simt-dev.json': JSON.stringify({ id: 'adopted-otherhooks', gates: { preCommit: ['format'], prePush: ['test'] } }),
    'AGENTS.md': '# mine\n',
  });
  await exec('git', ['config', 'core.hooksPath', 'scripts/git-hooks'], { cwd: root });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /"scripts\/git-hooks"/.test(p)));
});

test('a gate the dispatcher does not know is a problem', async () => {
  const root = await gitRepo('badgate', {
    'simt-dev.json': JSON.stringify({
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
    'simt-dev.json': JSON.stringify({
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
    'simt-dev.json': JSON.stringify({
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
    'simt-dev.json': JSON.stringify({
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
    'simt-dev.json': JSON.stringify({ id: 'hand-edited', gates: { preCommit: [], prePush: [] } }),
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
    'simt-dev.json': JSON.stringify({ id: 'contained', gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const built = await adopt(root);
  const file = join(root, 'AGENTS.md');
  await writeFile(file, `${await readFile(file, 'utf8')}\n## My own notes\n`);
  assert.equal((await buildRow(root, { ...CONTEXT, expectedSha: built.sha })).region, 'current');
});

test('a region from an older simt-dev IS reported as a version mismatch', async () => {
  const root = await gitRepo('behind', {
    'simt-dev.json': JSON.stringify({ id: 'behind', gates: { preCommit: [], prePush: [] } }),
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
    'simt-dev.json': JSON.stringify({
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
    'simt-dev.json': JSON.stringify({ id: 'omits', stack: [], gates: { preCommit: [], prePush: [] } }),
    'AGENTS.md': '# mine\n',
  });
  const row = await buildRow(root, CONTEXT);
  assert.ok(row.problems.some((p) => /detected python but the manifest omits it/.test(p)));
});

test('a manifest that agrees with detection produces no stack problem', async () => {
  const root = await gitRepo('agrees', {
    'pyproject.toml': '{}',
    'simt-dev.json': JSON.stringify({
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