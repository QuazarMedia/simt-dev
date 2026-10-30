// `simt --diff` (plan 0003 R50): every writer prints the plan as unified diffs.
//
// Two halves. The engine is pure — fixed cases pin the GNU shape, the hunk
// merging, the empty-creation rule and the big-file degradation — and the
// commands are driven through the real binary, because only that catches a
// writer whose pairs describe bytes it never writes. The S10 contract table in
// `test/contract.test.mjs` covers the eight rows it owns; this file covers the
// writers it does not: init, upgrade, doctor --fix, pack new, plugin, lessons
// review, plan done and shared install. `ci`'s --diff case lives in
// `test/ci.test.mjs`: reaching it means drifting the checkout's own workflow,
// and that mutation only stays safe inside the one file whose tests run in
// order over it.
//
// The boundary this file also pins: writers of local state (`bench`,
// `skills compile`, the `check` cache) and the network publisher
// (`pack publish`, whose plan is registry steps, not files) carry no file
// plan, so `--diff` shows nothing for them. A diff of a cache write would be
// a promise the bytes matter; they do not.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffField, readBefore, renderDiffs, unifiedDiff } from '../src/diff.mjs';
import { git } from './fixture.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);
const made = [];

async function scratch(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** Run the shipped binary. Never throws: the exit code is the thing under test. */
async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 64 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function runJson(args, env = {}) {
  const result = await run([...args, '--json'], env);
  try {
    return { ...result, payload: JSON.parse(result.stdout) };
  } catch {
    assert.fail(`not one JSON document: ${result.stdout.slice(0, 200)}`);
  }
}

/** A git repo adopted by this checkout, committed clean. */
async function consumer() {
  const root = await scratch('simt-diff-');
  await git(['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'requirements.txt'), 'flask\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });
  const adopted = await run(['init', '--root', root, '--yes']);
  assert.equal(adopted.code, 0, adopted.stderr);
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'adopted'], { cwd: root });
  return root;
}

// --- 1. the engine -----------------------------------------------------------

test('equal sides render nothing, null on both sides included', () => {
  assert.equal(unifiedDiff('a.txt', 'x\n', 'x\n'), '');
  assert.equal(unifiedDiff('a.txt', null, null), '');
  assert.equal(renderDiffs([]), '');
  assert.equal(
    renderDiffs([{ path: 'a.txt', before: 'x\n', after: 'x\n' }]),
    '',
    'an unchanged pair is skipped, not an empty block',
  );
});

test('a creation and a removal name /dev/null on the absent side', () => {
  assert.equal(
    unifiedDiff('n.txt', null, 'a\nb\n'),
    ['diff --git a/n.txt b/n.txt', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'),
  );
  assert.equal(
    unifiedDiff('n.txt', 'a\nb\n', null),
    ['diff --git a/n.txt b/n.txt', '--- a/n.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'),
  );
  // An empty creation has no line changes: the plan already says `created`,
  // and headers with no hunks are noise.
  assert.equal(unifiedDiff('n.txt', null, ''), '');
});

test('a one-line change carries three lines of context each way', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
  const before = `${lines.join('\n')}\n`;
  const after = `${[...lines.slice(0, 7), 'L8!', ...lines.slice(8)].join('\n')}\n`;
  assert.equal(
    unifiedDiff('f.txt', before, after),
    [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -5,6 +5,6 @@',
      ' l5',
      ' l6',
      ' l7',
      '-l8',
      '+L8!',
      ' l9',
      ' l10',
    ].join('\n'),
  );
});

test('a missing trailing newline rewrites the last line, GNU marker included', () => {
  assert.equal(
    unifiedDiff('t.txt', 'a\n', 'a'),
    [
      'diff --git a/t.txt b/t.txt',
      '--- a/t.txt',
      '+++ b/t.txt',
      '@@ -1 +1 @@',
      '-a',
      '+a',
      '\\ No newline at end of file',
    ].join('\n'),
  );
});

test('a pathological pair degrades to one delete-all/insert-all hunk', () => {
  const before = `${Array.from({ length: 6000 }, (_, i) => `old-${i}`).join('\n')}\n`;
  const after = `${Array.from({ length: 6000 }, (_, i) => `new-${i}`).join('\n')}\n`;
  const diff = unifiedDiff('big.txt', before, after);
  const hunks = diff.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0], '@@ -1,6000 +1,6000 @@');
});

test('blocks join with one blank line, in the order given', () => {
  const out = renderDiffs([
    { path: 'a.txt', before: 'x\n', after: 'y\n' },
    { path: 'b.txt', before: null, after: 'z\n' },
  ]);
  const [first, second] = out.split('\n\n');
  assert.match(first, /^diff --git a\/a\.txt/);
  assert.match(second, /^diff --git a\/b\.txt/);
});

test('the JSON field is absent without the flag and a string with it', () => {
  assert.deepEqual(diffField([], {}), {});
  assert.deepEqual(diffField([{ path: 'a', before: null, after: 'x\n' }], {}), {});
  const withFlag = diffField([{ path: 'a', before: null, after: 'x\n' }], { diff: true });
  assert.equal(typeof withFlag.diff, 'string');
  assert.match(withFlag.diff, /diff --git/);
});

test('readBefore reads the bytes, or null when absent', async () => {
  const dir = await scratch('simt-diff-read-');
  await writeFile(join(dir, 'f.txt'), 'bytes\n');
  assert.equal(await readBefore(join(dir, 'f.txt')), 'bytes\n');
  assert.equal(await readBefore(join(dir, 'missing.txt')), null);
});

// --- 2. the writers the S10 table does not own -------------------------------

test('init --diff shows the adoption and writes nothing', async () => {
  const root = await scratch('simt-diff-init-');
  const text = await run(['init', '--root', root, '--diff']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /diff --git a\/simt\.json/);
  assert.match(text.stdout, /diff --git a\/AGENTS\.md/);
  let missing = null;
  try {
    await readFile(join(root, MANIFEST_FILE), 'utf8');
  } catch (error) {
    missing = error.code;
  }
  assert.equal(missing, 'ENOENT', 'init --diff wrote the manifest it only previewed');

  const js = await runJson(['init', '--root', root, '--diff']);
  assert.match(js.payload.diff, /diff --git a\/simt\.json/);
});

test('upgrade --diff shows the pin and the regions, and moves neither', async () => {
  const root = await consumer();
  const file = join(root, MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.projection.simtDevSha = 'a'.repeat(40);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const agents = join(root, 'AGENTS.md');
  const regionText = await readFile(agents, 'utf8');
  await writeFile(agents, regionText.replace('<!-- simt:begin -->', '<!-- simt:begin -->\nSTALE\n'));

  const text = await run(['upgrade', '--root', root, '--diff']);
  assert.match(text.stdout, /diff --git a\/.*AGENTS\.md/);
  assert.match(text.stdout, new RegExp(`diff --git a\\/.*${MANIFEST_FILE}`));
  assert.match(text.stdout, /-STALE/);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.projection.simtDevSha, 'a'.repeat(40), 'upgrade --diff moved the pin it only previewed');
  const regionAfter = await readFile(agents, 'utf8');
  assert.match(regionAfter, /STALE/, 'upgrade --diff repaired the region it only previewed');

  const js = await runJson(['upgrade', '--root', root, '--diff']);
  assert.match(js.payload.diff, /"simtDevSha": "a{40}"/);
});

test('doctor --fix --diff previews the repair, --yes applies the same bytes', async () => {
  const root = await consumer();
  const ignore = join(root, '.gitignore');
  const text0 = await readFile(ignore, 'utf8');
  await writeFile(
    ignore,
    text0
      .split('\n')
      .filter((l) => !l.includes('.simt/local') && !l.includes('.simt/journal') && !l.includes('Write journal'))
      .join('\n'),
  );

  const preview = await run(['doctor', '--root', root, '--fix', '--diff']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /diff --git a\/\.gitignore/);
  assert.match(preview.stdout, /\+?\.simt\/local\//);
  const untouched = await readFile(ignore, 'utf8');
  assert.equal(untouched.includes('.simt/local/journal/') || untouched.includes('.simt/journal/'), false, 'doctor --fix --diff repaired without --yes');

  const applied = await run(['doctor', '--root', root, '--fix', '--yes', '--diff']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /diff --git a\/\.gitignore/);
  const fixed = await readFile(ignore, 'utf8');
  assert.equal(fixed.includes('.simt/local/'), true, 'doctor --fix ignores machine-local state');
});

test('pack new --diff shows the scaffold and scaffolds nothing', async () => {
  const root = await scratch('simt-diff-pack-');
  const text = await run(['pack', 'new', 'mypack', '--source', 'npm:left-pad', '--root', root, '--diff']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /diff --git a\/mypack\/pack\.json/);
  let missing = null;
  try {
    await readFile(join(root, 'mypack', 'pack.json'), 'utf8');
  } catch (error) {
    missing = error.code;
  }
  assert.equal(missing, 'ENOENT', 'pack new --diff scaffolded the directory it only previewed');
});

test('plugin --diff shows the generated files and writes none', async () => {
  const root = await scratch('simt-diff-plugin-');
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'x', files: ['bin'] }, null, 2)}\n`);
  const out = join(root, 'pkg');
  const text = await run(['plugin', 'claude', '--out', out, '--root', root, '--diff']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /diff --git a\/\.claude-plugin\/plugin\.json/);
  let missing = null;
  try {
    await readFile(join(out, '.claude-plugin', 'plugin.json'), 'utf8');
  } catch (error) {
    missing = error.code;
  }
  assert.equal(missing, 'ENOENT', 'plugin --diff wrote the package it only previewed');
});

test('lessons review --diff shows the promoted file and promotes nothing', async () => {
  const root = await consumer();
  await mkdir(join(root, '.simt'), { recursive: true });
  await writeFile(
    join(root, '.simt', 'lessons.jsonl'),
    `${JSON.stringify({ kind: 'fail-then-fix', signature: 'sha256-deadbeef', errorLine: 'Error: boom', summary: 'Error: boom' })}\n`,
  );
  // A pathless candidate is not promotable without `--paths` (review 0003 Q36):
  // a trigger that watches every path fires on every failure, the same as none.
  const text = await run(['lessons', 'review', '--root', root, '--diff', '--paths', 'src/flaky.mjs']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /diff --git a\/docs\/lessons\//);
  const names = await readFile(join(root, '.simt', 'lessons.jsonl'), 'utf8');
  assert.equal(names.includes('"status":"promoted"'), false, 'lessons review --diff promoted the candidate');

  const js = await runJson(['lessons', 'review', '--root', root, '--diff', '--paths', 'src/flaky.mjs']);
  assert.match(js.payload.diff, /diff --git a\/docs\/lessons\//);
});

test('plan done --diff shows the changed row and changes nothing', async () => {
  const root = await scratch('simt-diff-plan-');
  await mkdir(join(root, 'docs', 'reviews'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'reviews', '0002-review.md'),
    [
      '# review',
      '',
      '## 3. Tracker',
      '',
      '| ID | Slice | Depends on | State | SHA / evidence |',
      '| --- | --- | --- | --- | --- |',
      '| S08 | restage | — | Queued | |',
      '',
    ].join('\n'),
  );

  const text = await run(['plan', 'done', 'S08', '--root', root, '--diff']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /diff --git a\/docs\/reviews\/0002-review\.md/);
  assert.match(text.stdout, /-.*\| Queued \|/);
  assert.match(text.stdout, /\+.*\| Complete \|/);
  const untouched = await readFile(join(root, 'docs', 'reviews', '0002-review.md'), 'utf8');
  assert.match(untouched, /\| Queued \|/, 'plan done --diff marked the row it only previewed');

  const js = await runJson(['plan', 'done', 'S08', '--root', root, '--diff']);
  assert.match(js.payload.diff, /diff --git/);
  assert.equal(typeof js.payload.beforeLine, 'string');
  assert.equal(typeof js.payload.afterLine, 'string');
});

test('shared install --diff shows the home copy and writes nothing', async () => {
  const ws = await scratch('simt-diff-shared-ws-');
  const home = await scratch('simt-diff-shared-home-');
  const env = { HOME: home };
  const roots = [];
  for (const name of ['repo-a', 'repo-b']) {
    const root = join(ws, name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`);
    await writeFile(join(root, 'README.md'), `# ${name}\n`);
    await git(['init', '-q', '.'], { cwd: root });
    await git(['add', '-A'], { cwd: root });
    await git(['commit', '-qm', 'seed'], { cwd: root });
    const adopted = await run(['init', root, '--yes'], env);
    assert.equal(adopted.code, 0, adopted.stderr);
    const synced = await run(['sync', '--yes', '--root', root], env);
    assert.equal(synced.code, 0, synced.stderr);
    roots.push(root);
  }
  const preview = await run(['shared', 'install', '--root', ws, '--diff'], env);
  assert.match(preview.stdout, /diff --git/, 'shared install --diff printed no unified diff');
  assert.match(preview.stdout, /nothing written; re-run with: simt shared install --yes/);
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.shared ?? null, null, 'shared install --diff declared in a manifest');
  }
  let missing = null;
  try {
    await readFile(join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  } catch (error) {
    missing = error.code;
  }
  assert.equal(missing, 'ENOENT', 'shared install --diff wrote the home copy it only previewed');
});
