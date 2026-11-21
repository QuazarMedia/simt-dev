// Plan 0006 WK02: one scope, previewed before it is written.
//
// The failures this pins are the four ways a setup command goes wrong:
//
//   * the preview wrote, so the diff no longer described what the apply did;
//   * the second apply edited again, so re-running was not safe;
//   * the undo could not restore the manifest, because the write was not journaled;
//   * the setup rewrote the repository's own keys while adding its scope.
//
// Both repository shapes are exercised: a handbook of one Markdown tree, and a mixed tree of
// documents, recipes, a check and a source file. Neither fixture gains a runner, a gate or a
// dependency - a document repository that adopts a package manager has adopted the wrong
// thing.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { git, simt, tempDir } from './fixture.mjs';

const SHAPES = [
  { name: 'handbook', scope: 'handbook', path: 'handbook', kind: 'document' },
  { name: 'mixed', scope: 'docs', path: 'docs', kind: 'document' },
];

async function write(root, rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** One repository in each shape, with no manifest at all. */
async function shape(name) {
  const root = await tempDir(`simt-setup-${name}-`);
  await git(['init', '-q', root]);
  if (name === 'handbook') {
    await write(root, 'handbook/intro.md', '# introduction\n');
    await write(root, 'handbook/rates/de.md', '# rates\n');
  } else {
    await write(root, 'docs/guide.md', '# guide\n');
    await write(root, 'docs/sources/rate.md', '# source\n');
    await write(root, 'recipes/create.md', '# create\n\n@mutates\n@not_idempotent\n');
    await write(root, 'checks/structure.mjs', 'export const check = () => true;\n');
    await write(root, 'src/app.mjs', 'export const app = () => 1;\n');
  }
  return root;
}

/** Every byte in the tree except git's own storage and this tool's local state. */
function snapshot(root, dir = '') {
  const files = {};
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (rel === '.git' || rel === '.simt' || rel === 'node_modules') continue;
    if (entry.isDirectory()) Object.assign(files, snapshot(root, rel));
    else files[rel] = readFileSync(join(root, rel), 'utf8');
  }
  return files;
}

async function json(root, args) {
  const run = await simt([...args, '--root', root, '--json']);
  assert.equal(run.code, 0, `${args.join(' ')} failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('the preview writes nothing, and the apply writes exactly the bytes it showed', async () => {
  for (const fixture of SHAPES) {
    const root = await shape(fixture.name);
    const before = snapshot(root);
    const flags = ['work', 'setup', '--scope', fixture.scope, '--path', fixture.path, '--kind', fixture.kind];

    const preview = await json(root, flags);
    assert.equal(preview.changed, true, `${fixture.name}: nothing was proposed`);
    assert.equal(preview.written, false);
    assert.deepEqual(snapshot(root), before, `${fixture.name}: the preview changed the tree`);
    assert.equal(existsSync(join(root, 'simt.json')), false, `${fixture.name}: the preview wrote a manifest`);

    const applied = await json(root, [...flags, '--yes']);
    assert.equal(applied.written, true, `${fixture.name}: the apply wrote nothing`);
    assert.equal(readFileSync(join(root, 'simt.json'), 'utf8'), applied.next, `${fixture.name}: the apply did not write what it previewed`);
    assert.deepEqual(JSON.parse(applied.next), {
      work: { version: 2, scopes: [{ id: fixture.scope, paths: [fixture.path], kind: fixture.kind }] },
    });

    // Neither shape gains a runner, a gate or a dependency.
    assert.equal(existsSync(join(root, 'package.json')), false, `${fixture.name}: adoption fabricated a package runner`);
    assert.equal(existsSync(join(root, 'pyproject.toml')), false, `${fixture.name}: adoption fabricated a Python project`);

    const again = await json(root, [...flags, '--yes']);
    assert.equal(again.changed, false, `${fixture.name}: the second apply proposed a second edit`);
    assert.equal(again.written, false);
    assert.equal(readFileSync(join(root, 'simt.json'), 'utf8'), applied.next, `${fixture.name}: the second apply moved the file`);
  }
});

test('undo restores the manifest the setup replaced, and removes the one it created', async () => {
  const created = await shape('handbook');
  const flags = ['work', 'setup', '--scope', 'handbook', '--path', 'handbook', '--kind', 'document'];
  const ignorePath = join(created, '.gitignore');
  const originalIgnore = 'owned-local-file\n';
  writeFileSync(ignorePath, originalIgnore);
  const preview = await json(created, [...flags, '--diff']);
  assert.equal(preview.addsLocalIgnore, true);
  assert.match(JSON.stringify(preview), /\.gitignore/);
  assert.equal(readFileSync(ignorePath, 'utf8'), originalIgnore);
  await json(created, [...flags, '--yes']);
  assert.equal(existsSync(join(created, 'simt.json')), true);
  assert.match(readFileSync(ignorePath, 'utf8'), /\.simt\/local\//);
  const undone = await simt(['undo', '--root', created, '--yes']);
  assert.equal(undone.code, 0, undone.stderr);
  assert.equal(existsSync(join(created, 'simt.json')), false, 'undo left the manifest the setup created');
  assert.equal(readFileSync(ignorePath, 'utf8'), originalIgnore);

  const handwritten = {
    $comment: 'kept as written',
    id: 'fixture',
    limits: { coverage: null },
    notes: ['mine'],
    gates: { test: 'node --test' },
  };
  writeFileSync(join(created, 'simt.json'), `${JSON.stringify(handwritten, null, 2)}\n`);
  const before = readFileSync(join(created, 'simt.json'), 'utf8');
  await json(created, [...flags, '--yes']);
  assert.notEqual(readFileSync(join(created, 'simt.json'), 'utf8'), before);
  const restored = await simt(['undo', '--root', created, '--yes']);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(readFileSync(join(created, 'simt.json'), 'utf8'), before, 'undo did not restore the pre-run bytes');
});

test('a scope that also carries ignore and targets is already declared, not a different declaration', async () => {
  const root = await shape('mixed');
  const declared = `${JSON.stringify({ work: { version: 2, scopes: [{ id: 'docs', paths: ['./docs/'], kind: 'document', ignore: ['drafts'], targets: [] }] } }, null, 2)}\n`;
  writeFileSync(join(root, 'simt.json'), declared);

  const preview = await json(root, ['work', 'setup', '--scope', 'docs', '--path', 'docs', '--kind', 'document']);
  assert.equal(preview.changed, false, 'a declared scope looked like a scope to add');
  assert.equal(preview.written, false);
  assert.equal(preview.remedy, null, 'a no-op offers an apply line');
  assert.equal(readFileSync(join(root, 'simt.json'), 'utf8'), declared, 'the preview rewrote a manifest it had nothing to add to');
});

test('undo restores a legacy-named manifest the setup retired', async () => {
  const root = await shape('handbook');
  const legacy = `${JSON.stringify({ $comment: 'kept under the old name', id: 'fixture' }, null, 2)}\n`;
  writeFileSync(join(root, 'simt-dev.json'), legacy);
  const flags = ['work', 'setup', '--scope', 'handbook', '--path', 'handbook', '--kind', 'document'];

  const preview = await json(root, flags);
  assert.equal(preview.retired, 'simt-dev.json', 'the preview did not say it retires the old name');
  assert.equal(existsSync(join(root, 'simt.json')), false, 'the preview moved the manifest');
  assert.equal(readFileSync(join(root, 'simt-dev.json'), 'utf8'), legacy);

  const applied = await json(root, [...flags, '--yes']);
  assert.equal(applied.retired, 'simt-dev.json');
  assert.equal(existsSync(join(root, 'simt-dev.json')), false, 'the legacy name survived the apply');
  const next = JSON.parse(readFileSync(join(root, 'simt.json'), 'utf8'));
  assert.equal(next.$comment, 'kept under the old name');
  assert.deepEqual(next.work.scopes.map((scope) => scope.id), ['handbook']);

  const undone = await simt(['undo', '--root', root, '--yes']);
  assert.equal(undone.code, 0, undone.stderr);
  assert.equal(readFileSync(join(root, 'simt-dev.json'), 'utf8'), legacy, 'undo lost the manifest it renamed');
  assert.equal(existsSync(join(root, 'simt.json')), false, 'undo left the renamed manifest behind');
});

test('a setup adds its scope and leaves every key the repository wrote exactly where it was', async () => {
  const root = await shape('mixed');
  const handwritten = {
    $comment: 'this repository keeps its keys',
    id: 'fixture',
    limits: { coverage: 80, fileLines: { warn: 400, error: 1000 } },
    gates: { preCommit: ['lint'], commands: { lint: 'node lint.mjs' } },
    notes: ['a key this tool does not know'],
    work: { version: 1, scopes: [{ id: 'elsewhere', paths: ['docs/sources'] }] },
  };
  writeFileSync(join(root, 'simt.json'), `${JSON.stringify(handwritten, null, 2)}\n`);

  const applied = await json(root, ['work', 'setup', '--scope', 'guide', '--path', './docs/', '--kind', 'document', '--validator', 'node checks/structure.mjs', '--yes']);
  assert.equal(applied.written, true);
  const next = JSON.parse(readFileSync(join(root, 'simt.json'), 'utf8'));
  for (const key of ['$comment', 'id', 'limits', 'gates', 'notes']) assert.deepEqual(next[key], handwritten[key], `${key} was rewritten`);
  // The declared version is the repository's, not this build's: version 1 carries every
  // field this scope used, so bumping it would claim a change that did not happen.
  assert.equal(next.work.version, 1);
  assert.deepEqual(next.work.scopes, [
    { id: 'elsewhere', paths: ['docs/sources'] },
    { id: 'guide', paths: ['docs'], kind: 'document', validators: ['node checks/structure.mjs'] },
  ]);
  // The scope claims a normalized path, and the older scope's own spelling is untouched.
  assert.equal(next.work.scopes[0].paths[0], 'docs/sources');
});

test('a setup refuses what it cannot do, and changes nothing when it refuses', async () => {
  const root = await shape('mixed');
  const before = snapshot(root);

  const missingScope = await simt(['work', 'setup', '--root', root]);
  assert.notEqual(missingScope.code, 0);
  assert.match(missingScope.stderr, /needs a scope id/);
  assert.match(missingScope.stderr, /--scope <id> --path <dir>/);

  const outside = await simt(['work', 'setup', '--scope', 'x', '--path', '../elsewhere', '--root', root]);
  assert.notEqual(outside.code, 0);
  assert.match(outside.stderr, /not a repository-relative path/);

  const badKind = await simt(['work', 'setup', '--scope', 'x', '--path', 'docs', '--kind', 'nonsense', '--root', root]);
  assert.notEqual(badKind.code, 0);
  assert.match(badKind.stderr, /kind must be one of/);
  assert.match(badKind.stderr, /document/);

  writeFileSync(
    join(root, 'simt.json'),
    `${JSON.stringify({ work: { version: 2, scopes: [{ id: 'docs', paths: ['docs'], kind: 'document' }] } }, null, 2)}\n`,
  );
  const declared = readFileSync(join(root, 'simt.json'), 'utf8');
  const conflict = await simt(['work', 'setup', '--scope', 'docs', '--path', 'recipes', '--kind', 'recipe', '--root', root, '--yes']);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /already declared with a different path/);
  assert.equal(readFileSync(join(root, 'simt.json'), 'utf8'), declared, 'a refused setup wrote the manifest');

  writeFileSync(join(root, 'simt.json'), `${JSON.stringify({ work: { version: 7 } }, null, 2)}\n`);
  const invalid = await simt(['work', 'setup', '--scope', 'x', '--path', 'docs', '--root', root, '--yes']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /simt\.json's work declaration is invalid: work\.version must be one of 1, 2, 3, not 7/);

  writeFileSync(join(root, 'simt.json'), '{ not json\n');
  const unreadable = await simt(['work', 'setup', '--scope', 'x', '--path', 'docs', '--root', root, '--yes']);
  assert.notEqual(unreadable.code, 0);
  assert.match(unreadable.stderr, /simt\.json: unparseable/);
});

test('the kind is proposed from the sample, and a flag overrides the proposal', async () => {
  const root = await shape('mixed');
  const proposed = await json(root, ['work', 'setup', '--scope', 'docs', '--path', 'docs']);
  assert.equal(proposed.scope.kind, 'document', 'a directory of Markdown was not proposed as documents');

  const overridden = await json(root, ['work', 'setup', '--scope', 'checks', '--path', 'checks', '--kind', 'source']);
  assert.equal(overridden.scope.kind, 'source');
});

test('the inspection points at the setup command, and the setup makes the inspection stop asking', async () => {
  const root = await shape('handbook');
  const before = await json(root, ['work', 'inspect']);
  assert.equal(before.work.declared, false);
  assert.match(before.next.remedy, /simt work setup --scope handbook --path handbook --kind document/);

  const recommended = before.next.remedy.replace(/^run: simt /, '').split(' ');
  const applied = await json(root, [...recommended, '--yes']);
  assert.equal(applied.written, true, 'the remedy the inspection printed did not work');

  const after = await json(root, ['work', 'inspect']);
  assert.equal(after.work.declared, true);
  assert.equal(after.work.ok, true);
  assert.notEqual(after.next?.step, before.next.step, 'the inspection asks for the same thing after it was done');
});
