// A repository with one of each governor (R25, ADR-093).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, capture } from './fixture.mjs';
import { tracked, whyCommand } from '../src/commands/why.mjs';

const tick = String.fromCharCode(96);
const bt = (value) => tick + value + tick;

test('a fixture repository lists every governor and reports an unresolved token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-why-'));
  await git(['init'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await mkdir(join(root, 'docs', 'lessons'), { recursive: true });
  await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
  // An extension no gate owns, so the answer is genuinely empty rather than "the format
  // gate covers .md".
  await writeFile(join(root, 'docs', 'notes.zzz'), 'nothing governs this file\n');
  await writeFile(join(root, 'docs', 'decisions', 'ADR-001-keep.md'), [
    '# ADR-001 — Keep the file',
    '',
    'Status: **accepted**',
    'Affects: ' + bt('src/keep.mjs') + ', ' + bt('simt-dev no-such') + ',',
    bt('missing.mjs'),
    '',
  ].join('\n'));
  await writeFile(join(root, 'docs', 'lessons', '0001-keep.md'), '---\nsimt-trigger: { paths: ["src/keep.mjs"] }\n---\n\n# Keep\n');
  // A local profile: the repository's own rule, which is also the id `repoContext` loads,
  // so `why rule:toy` can be answered without the package's catalogue.
  await writeFile(join(root, '.simt', 'profiles', 'toy.md'), '---\nsimt-id: toy\nsimt-title: Toy\nsimt-scope: ["src/keep.mjs"]\n---\n\n# Toy\n');
  // The repository tier of ADR-202, which is where an adopted repository keeps it.
  await writeFile(join(root, '.simt', 'skills.graph.json'), JSON.stringify({
    version: 1,
    skills: [{ name: 'keep', summary: 'Keep a file', paths: ['src/keep.mjs'] }],
  }));
  await writeFile(join(root, 'simt.json'), JSON.stringify({ gates: { commands: { memory: 'node src/keep.mjs' } } }));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'keep'], { cwd: root });

  const listed = await capture(() => whyCommand(['src/keep.mjs'], { root }, []));
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /decision {2}ADR-001 {2}Keep the file/);
  assert.match(listed.stdout, /rule {6}toy {2}Toy/);
  assert.match(listed.stdout, /skill {5}keep {2}Keep a file/);
  assert.match(listed.stdout, /gate {6}memory /);
  assert.match(listed.stdout, /lesson {4}0001-keep {2}Keep/);

  const open = await capture(() => whyCommand([], { root }, []));
  assert.match(open.stdout, /UNRESOLVED-AFFECTS {2}simt-dev no-such {2}ADR-001/);
  assert.match(open.stdout, /UNRESOLVED-AFFECTS {2}missing\.mjs {2}ADR-001/);

  const missing = await capture(() => whyCommand(['src/absent.mjs'], { root }, []));
  assert.equal(missing.code, 2);

  // A prefix names its own kind and still needs the corpus: without it every rule was
  // reported unknown, which is how both prefixes shipped.
  const prefixedRule = await capture(() => whyCommand(['rule:toy'], { root }, []));
  assert.match(prefixedRule.stdout, /toy - Toy/);

  // The reader's spelling, not git's: absolute, `./`, and a bare name from the directory
  // the file is in. All three are the same tracked file.
  const absolute = await capture(() => whyCommand([join(root, 'src', 'keep.mjs')], { root }, []));
  assert.equal(absolute.code, 0, absolute.stderr);
  assert.match(absolute.stdout, /decision {2}ADR-001/);

  const here = process.cwd();
  process.chdir(join(root, 'src'));
  try {
    const fromBelow = await capture(() => whyCommand(['keep.mjs'], { root }, []));
    assert.equal(fromBelow.code, 0, fromBelow.stderr);
    assert.match(fromBelow.stdout, /decision {2}ADR-001/);
  } finally {
    process.chdir(here);
  }

  const directory = await capture(() => whyCommand([join(root, 'src')], { root }, []));
  assert.equal(directory.code, 2, 'a directory is not silently treated as a file');
  assert.match(directory.stderr, /src is a directory/);

  // An ungoverned file says what was looked for, so `none` cannot read as a no-op.
  const ungoverned = await capture(() => whyCommand([join(root, 'docs', 'notes.zzz')], { root }, []));
  assert.equal(ungoverned.code, 0, ungoverned.stderr);
  assert.match(ungoverned.stdout, /^none {5}nothing recorded names docs\/notes\.zzz/);
  assert.match(ungoverned.stdout, /note {5}looked for a decision/);

  await rm(root, { recursive: true, force: true });

  const bare = await mkdtemp(join(tmpdir(), 'idx-why-'));
  const refused = await capture(() => whyCommand(['src/keep.mjs'], { root: bare }, []));
  assert.equal(refused.code, 5);
  await rm(bare, { recursive: true, force: true });
});

test('a decision answers with no git repository and no tracked files', async () => {
  // `why ADR-NNN` used to list the tree first, so it failed with "run this inside a git
  // repository" even though the decisions ship with the package. The subject's shape
  // settles the question before the listing does.
  const root = await mkdtemp(join(tmpdir(), 'idx-why-'));
  try {
    await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
    await writeFile(join(root, 'docs', 'decisions', 'ADR-009-a-note.md'), '# ADR-009 — A note\n\nStatus: accepted\n');
    const decided = await capture(() => whyCommand(['ADR-009'], { root }, []));
    assert.equal(decided.code, 0, decided.stderr);
    assert.match(decided.stdout, /ADR-009/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('why resolves a non-ASCII path instead of calling it missing (Q39)', async () => {
  // Without `-z`, `git ls-files` C-quotes the path and the reader's real
  // filename matches nothing, so why reported "not in the tree".
  const root = await mkdtemp(join(tmpdir(), 'idx-why-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 1;\n');
    await git(['init'], { cwd: root });
    await git(['add', '-A'], { cwd: root });
    await git(['commit', '-m', 'uni'], { cwd: root });
    const { files } = await tracked(root);
    assert.ok(files.includes('src/ünï.mjs'), 'tracked() names the raw path');
    const listed = await capture(() => whyCommand(['src/ünï.mjs'], { root }, []));
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.includes('not in the tree'), false, 'the path resolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

