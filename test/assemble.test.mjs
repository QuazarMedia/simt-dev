// The assembled packet (review 0003 Q92).
//
// `brief/assemble.mjs` is what three doors share: the command, the MCP tool and the
// prompt-submit hook. Until now it was only ever observed through one of them - `simt brief`
// in a child process - so the two things that make a delivered packet different from a
// requested one were untested: a delivery may not build an index (`build: false` reports
// `cold`), and it may not start somebody else's server (`federate: false`).
//
// These call `assembleBrief` directly. The fixture is a real repository with a real index,
// because the packet is a function of the tree and a packet about a tree that does not exist
// would prove nothing.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { git, tempDir } from './fixture.mjs';

/** A repository with one source file, one test that imports it, and a test script. */
async function repo() {
  const root = await tempDir('assemble-');
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test', lint: 'node -e 0' } }, null, 2)}\n`,
  );
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await writeFile(
    join(root, 'test', 'keep.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\n\ntest('keep', () => assert.equal(keep(1), 1));\n",
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('a delivered packet on a cold index reports cold instead of waiting on a walk', async () => {
  const root = await repo();
  // No index has been built here, and `build: false` is what a prompt submit passes: the
  // first prompt in a fresh clone reports a cold index rather than spending the budget.
  const cold = await assembleBrief({ root, task: 'fix the keep helper', build: false });
  assert.deepEqual(cold, { cold: true });
});

test('a task that names a file produces its kind, its file, its test and its command', async () => {
  const root = await repo();
  const packet = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs' });
  assert.equal(packet.kind, 'bugfix');
  assert.match(packet.basis, /the task matches/);
  assert.ok(packet.sections.FILES.some((line) => line.includes('src/keep.mjs')), JSON.stringify(packet.sections.FILES));
  assert.ok(packet.sections.TESTS.some((line) => line.includes('test/keep.test.mjs')), JSON.stringify(packet.sections.TESTS));
  assert.ok(packet.sections.COMMANDS.some((line) => line.includes('npm run test')), JSON.stringify(packet.sections.COMMANDS));
});

test('two assemblies of the same tree are the same bytes', async () => {
  const root = await repo();
  const first = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs' });
  const second = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs' });
  assert.equal(first.packed.text, second.packed.text);
  assert.deepEqual(first.packed.cut, second.packed.cut);
});

test('--paths is the scope, and an unnamed packet takes it from the dirty tree', async () => {
  const root = await repo();
  const named = await assembleBrief({ root, task: 'touch what was named', paths: 'src/keep.mjs' });
  assert.deepEqual(named.scope, ['src/keep.mjs']);
  assert.ok(named.sections.TASK.some((line) => line.includes('scope src/keep.mjs')), JSON.stringify(named.sections.TASK));
  // Where the scope came from is a `why` on the item, not a second line in the packet: the
  // rendered line is what a reader acts on, and the reason is for `--explain`.
  assert.deepEqual(whyOf(named, 'scope'), ['named with --paths']);

  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value + 1;\n}\n');
  const dirty = await assembleBrief({ root, task: 'touch what is dirty' });
  // The whole path, not `rc/keep.mjs`: an unstaged modification's status line begins with a
  // space, and the helper that reads it took the first character of the path with it (Q92).
  assert.deepEqual(dirty.scope, ['src/keep.mjs']);
  assert.deepEqual(whyOf(dirty, 'scope'), ['taken from the files git reports as modified']);
});

/** The recorded reason for the TASK line that starts with `prefix`. */
function whyOf(packet, prefix) {
  return packet.items.find((item) => item.section === 'TASK' && item.text.startsWith(prefix))?.why;
}

test('a task and a scope are different questions, and only one of them has an answer', async () => {
  const root = await repo();
  // Neither given: the packet describes the working tree and says so, because an unasked
  // question has no answer to be short of.
  const neither = await assembleBrief({ root });
  assert.ok(neither.sections.CAUTIONS.some((line) => line.includes('no task was given')));

  // No task but a named scope: the reader asked about these files, so the caution would be
  // a claim about the packet rather than about the question.
  const scoped = await assembleBrief({ root, paths: 'src/keep.mjs' });
  assert.ok(!(scoped.sections.CAUTIONS ?? []).some((line) => line.includes('no task was given')));
});

test('a budget of zero is the whole packet, and no delivery may ask for it', async () => {
  const root = await repo();
  const whole = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs', budget: 0 });
  assert.deepEqual(whole.packed.cut, []);
  assert.ok(whole.packed.text.includes('src/keep.mjs'));

  const trimmed = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs', budget: 300 });
  assert.ok(Buffer.byteLength(trimmed.packed.text) <= 300 || trimmed.packed.floorHeld);
});

test('an index that predates the tree warns instead of quoting yesterday', async () => {
  const root = await repo();
  await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs' });
  // A commit the build did not see: `build: false` is the delivery's setting, so the packet
  // has to say the index is old rather than quote a file list from before the change.
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value + 1;\n}\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'a commit the index did not see']);
  const after = await assembleBrief({ root, task: 'fix the keep helper in src/keep.mjs', build: false });
  assert.ok(
    (after.sections.CAUTIONS ?? []).some((line) => line.includes('the index predates the current tree')),
    JSON.stringify(after.sections.CAUTIONS),
  );
});
