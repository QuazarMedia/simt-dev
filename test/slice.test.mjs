// R53: `simt slice start` / `simt slice finish`.
//
// The slice's acceptance is one sentence — the row edit and the commit are verified
// on a fixture plan — so that is the spine of this file: a real git repository with a
// real tracker, `start` giving it a worktree and branch, `finish` closing the loop
// with a Conventional subject and the evidence row.
//
// The two design contracts beyond the acceptance live here too, because both are the
// kind of thing that silently rots:
//
//   The tracker belongs to the MAIN checkout. `finish` runs in the worktree where the
//   code is, but the row is edited in the checkout that owns the plan — otherwise
//   every merge of a finished slice conflicts on the exact line that records it.
//
//   Gates run before the commit, through the same dispatcher the hook uses. A command
//   that commits for the reader must not be the one path where a declared gate never
//   fires, so a failing gate must leave the branch exactly where it was.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 16 << 20 });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** git's stdout, trimmed. The fixture helper resolves the whole exec result. */
async function g(args) {
  const { stdout } = await git(args);
  return stdout.trim();
}

const PLAN = `# plan

## 3. Tracker

| ID | Slice | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- |
| A1 | wire the gate | — | Queued | |

### A1 — wire the gate

**Accept.** the gate holds
`;

/**
 * A git repository with a one-row tracker, committed. The identity is written into
 * the fixture's own config rather than passed per command, because `slice finish`
 * runs `git commit` as itself — the tool must use the repository's configured
 * author, and a fixture that only works when the runner has an identity is a fixture
 * that fails on CI for a reason that has nothing to do with the code under test.
 */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-slice-'));
  made.push(root);
  await mkdir(join(root, 'docs', 'plans'), { recursive: true });
  await writeFile(join(root, 'docs', 'plans', '0001.md'), PLAN);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  await git(['init', '-q', root]);
  await git(['-C', root, 'config', 'user.email', 'tests@simt.invalid']);
  await git(['-C', root, 'config', 'user.name', 'simt-dev tests']);
  await git(['-C', root, 'config', 'commit.gpgsign', 'false']);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

const wtOf = (root) => join(root, '.simt', 'worktrees', 'a1');
const planOf = (root) => join(root, 'docs', 'plans', '0001.md');

test('slice without an id, and a slice the tracker does not carry, are usage errors', async () => {
  const root = await repo();

  const noId = cli(['slice', 'start', '--root', root]);
  assert.equal(noId.code, 2);
  assert.match(noId.stderr, /slice start needs a slice id/);
  assert.match(noId.stderr, /plan next/);

  const noSlice = cli(['slice', 'finish', 'ZZZ', '--root', root]);
  assert.equal(noSlice.code, 2);
  assert.match(noSlice.stderr, /no tracked slice named ZZZ/);

  assert.equal(existsSync(join(root, '.simt', 'worktrees')), false, 'a refusal must create nothing');
  assert.equal(await g(['-C', root, 'status', '--porcelain']), '');
});

test('start is a preview until --yes, and the preview names the branch, worktree and row', async () => {
  const root = await repo();
  const preview = cli(['slice', 'start', 'A1', '--root', root]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /branch\s+slice\/a1/);
  assert.match(preview.stdout, /\.simt\/worktrees\/a1/);
  assert.match(preview.stdout, /state\s+Queued -> In progress/);
  assert.match(preview.stdout, /run: simt slice start A1 --yes/);

  assert.equal(existsSync(wtOf(root)), false, 'the preview created a worktree');
  assert.match(await readFile(planOf(root), 'utf8'), /\| Queued \|/, 'the preview edited the row');
  assert.equal(await g(['-C', root, 'status', '--porcelain']), '');
});

test('start creates the worktree and branch, preloads the brief, and sets the row In progress', async () => {
  const root = await repo();
  const head = await g(['-C', root, 'rev-parse', 'HEAD']);

  const started = cli(['slice', 'start', 'A1', '--root', root, '--yes']);
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

  const wt = wtOf(root);
  assert.ok(existsSync(wt), 'the worktree exists');
  assert.equal(await g(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']), 'slice/a1');
  assert.equal(await g(['-C', wt, 'rev-parse', 'HEAD']), head, 'the branch starts at the row it belongs to');

  const brief = await readFile(join(wt, '.simt', 'brief.md'), 'utf8');
  assert.match(brief, /A1: wire the gate/, 'the brief names the slice it was preloaded for');

  const plan = await readFile(planOf(root), 'utf8');
  assert.match(plan, /\| A1 \| wire the gate \| — \| In progress \|/);
  assert.match(started.stdout, /state\s+Queued -> In progress/);
});

test('finish without --yes previews the subject and commits nothing', async () => {
  const root = await repo();
  const before = await g(['-C', root, 'rev-parse', 'HEAD']);

  const preview = cli(['slice', 'finish', 'A1', '--root', root, '--test', 'node --test']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /subject\s+feat\(a1\): wire the gate/);
  assert.match(preview.stdout, /state\s+Queued -> Complete/);
  assert.match(preview.stdout, /run: simt slice finish A1 --test "node --test" --yes/);

  assert.equal(await g(['-C', root, 'rev-parse', 'HEAD']), before);
  assert.match(await readFile(planOf(root), 'utf8'), /\| Queued \|/, 'the preview edited the row');
});

test('finish refuses when nothing is staged', async () => {
  const root = await repo();
  const before = await g(['-C', root, 'rev-parse', 'HEAD']);

  const refused = cli(['slice', 'finish', 'A1', '--root', root, '--yes']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /nothing staged/);
  assert.match(refused.stderr, /stage what the slice changed/);

  assert.equal(await g(['-C', root, 'rev-parse', 'HEAD']), before);
  assert.match(await readFile(planOf(root), 'utf8'), /\| Queued \|/);
});

test('finish commits with a Conventional subject from the title and records SHA and test on the row', async () => {
  const root = await repo();
  const started = cli(['slice', 'start', 'A1', '--root', root, '--yes']);
  assert.equal(started.code, 0, started.stderr);

  const wt = wtOf(root);
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, 'src', 'gate.js'), 'export const gate = true;\n');
  await git(['-C', wt, 'add', 'src/gate.js']);

  const finished = cli([
    'slice', 'finish', 'A1',
    '--root', wt,
    '--test', 'node --test test/gate.test.mjs',
    '--yes',
  ]);
  assert.equal(finished.code, 0, `${finished.stdout}\n${finished.stderr}`);

  const sha = await g(['-C', wt, 'rev-parse', 'HEAD']);
  assert.equal(await g(['-C', wt, 'log', '-1', '--format=%s']), 'feat(a1): wire the gate');
  assert.ok(finished.stdout.includes(sha), `the report does not name the commit:\n${finished.stdout}`);
  assert.match(finished.stdout, /PASSED/);
  assert.match(finished.stdout, /record\s+docs\/plans\/0001\.md line \d+/);
  assert.match(finished.stderr, /declares no gates/, 'a repository with no manifest still hears why no gate ran');

  // The row is edited in the checkout that owns the tracker: the branch carries the
  // code, and only the code — otherwise every merge conflicts on the evidence line.
  const mainPlan = await readFile(planOf(root), 'utf8');
  assert.match(mainPlan, /\| Complete \|/);
  assert.ok(mainPlan.includes(sha), 'the row records the commit SHA');
  assert.ok(mainPlan.includes('node --test test/gate.test.mjs'), 'the row records the test command');
  const wtPlan = await readFile(planOf(wt), 'utf8');
  assert.ok(!wtPlan.includes(sha), 'the worktree copy of the tracker was left alone');
});

test('a failing declared gate blocks finish: no commit, no row edit', async () => {
  const root = await repo({
    'simt.json': `${JSON.stringify({ gates: { preCommit: ['test'], commands: { test: 'false' } } }, null, 2)}\n`,
  });
  await writeFile(join(root, 'hello.txt'), 'hi\n');
  await git(['-C', root, 'add', 'hello.txt']);
  const before = await g(['-C', root, 'rev-parse', 'HEAD']);

  const blocked = cli(['slice', 'finish', 'A1', '--root', root, '--yes']);
  assert.equal(blocked.code, 1, `${blocked.stdout}\n${blocked.stderr}`);
  assert.match(blocked.stdout, /FAILED\s+test/);
  assert.match(blocked.stdout, /BLOCKED  at least one gate failed/);

  assert.equal(await g(['-C', root, 'rev-parse', 'HEAD']), before, 'the gates failed, so nothing was committed');
  assert.match(await readFile(planOf(root), 'utf8'), /\| Queued \|/, 'a blocked finish records nothing');
});

test('finish rejects a --type that is not a Conventional Commits type', async () => {
  const root = await repo();
  const bad = cli(['slice', 'finish', 'A1', '--root', root, '--type', 'Bad type']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /is not a Conventional Commits type/);

  const good = cli(['slice', 'finish', 'A1', '--root', root, '--type', 'fix']);
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /subject\s+fix\(a1\): wire the gate/);
});

test('start answers --json as one document carrying the branch, brief and row', async () => {
  const root = await repo();
  const started = cli(['slice', 'start', 'A1', '--root', root, '--yes', '--json']);
  assert.equal(started.code, 0, started.stderr);
  const lines = started.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'one document, exactly one line');
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'slice start');
  assert.equal(payload.branch, 'slice/a1');
  assert.equal(payload.worktree, '.simt/worktrees/a1');
  assert.ok(payload.brief.bytes > 0, 'the preloaded brief has bytes');
  assert.deepEqual(payload.state, { from: 'Queued', to: 'In progress', changed: true });
});
