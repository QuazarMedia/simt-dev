// The per-developer git identity: what gets written, from where, and what is refused.
//
// Four cases, and the three refusals are the ones that matter. An adopting command
// that writes somebody's name is a small thing to get wrong and an awkward thing to
// notice afterwards, so each refusal is asserted rather than described.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import test, { after } from 'node:test';

import { initCommand } from '../src/commands/init.mjs';
import {
  IDENTITY_FILE,
  configuredIdentity,
  ignoreIdentity,
  includeOwnIdentity,
  includesOwnIdentity,
  lastCommitAuthor,
  renderIdentityFile,
  resolveIdentity,
} from '../src/identity.mjs';

const exec = promisify(execFile);
const temps = [];

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

async function capture(fn) {
  let output = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try { await fn(); } finally { process.stdout.write = write; }
  return { output };
}

async function repo({ commits = 1, name = 'Last Person', email = 'last@example.com' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-identity-'));
  temps.push(root);
  await exec('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'package.json'), '{"name":"t"}\n');
  if (commits > 0) {
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-qm', 'init'], { cwd: root });
  }
  return root;
}

// ---------------------------------------------------------------- module

test('identity: the last commit author is a fact, not a configured value', async () => {
  // The distinction matters because the configured value at that moment IS what the
  // file is about to be written from. Reading it would be circular.
  const root = await repo({ name: 'Commit Person', email: 'commit@example.com' });
  await exec('git', ['config', '--local', 'user.name', 'Configured Person'], { cwd: root });
  await exec('git', ['config', '--local', 'user.email', 'configured@example.com'], { cwd: root });
  assert.deepEqual(await lastCommitAuthor(root), { name: 'Commit Person', email: 'commit@example.com' });
});

test('identity: a name containing angle brackets still yields the address', async () => {
  const root = await repo({ name: 'A <weird> Name', email: 'a@b.test' });
  const author = await lastCommitAuthor(root);
  assert.equal(author.email, 'a@b.test');
  assert.ok(author.name.includes('weird'), `name was split wrongly: ${author.name}`);
});

test('identity: a repository with no commits has no last author, and does not fail', async () => {
  const root = await repo({ commits: 0 });
  assert.deepEqual(await lastCommitAuthor(root), { name: null, email: null });
});

test('identity: only the keys that were found are written', async () => {
  // A placeholder is an identity git would use, so a partial identity stays partial.
  assert.equal(renderIdentityFile({ name: 'A', email: null }), '[user]\n\tname = A\n');
  assert.equal(renderIdentityFile({ name: null, email: 'a@b.test' }), '[user]\n\temail = a@b.test\n');
  assert.equal(renderIdentityFile({ name: null, email: null }), '[user]\n');
});

test('identity: gitignore is not appended twice', async () => {
  const root = await repo();
  assert.equal(await ignoreIdentity(root), true, 'first call adds the entry');
  assert.equal(await ignoreIdentity(root), false, 'second call is a no-op');
  const text = await readFile(join(root, '.gitignore'), 'utf8');
  assert.equal(text.split('\n').filter((l) => l.trim() === IDENTITY_FILE).length, 1);
});

test('identity: the include is this repository\'s own, not a sibling\'s', async () => {
  const root = await repo();
  await exec('git', ['config', '--local', '--add', 'include.path', '../../elsewhere/git.config'], { cwd: root });
  assert.equal(await includesOwnIdentity(root), false);
  await includeOwnIdentity(root);
  assert.equal(await includesOwnIdentity(root), true);
  const values = (await exec('git', ['config', '--local', '--get-all', 'include.path'], { cwd: root })).stdout
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  assert.deepEqual(values, [`../${IDENTITY_FILE}`], 'the link to another repository is replaced, not appended to');
});

// ---------------------------------------------------------------- init

test('init: writes an identity from the last commit, and git uses it', async () => {
  const root = await repo({ name: 'Commit Person', email: 'commit@example.com' });
  await initCommand([], { root, yes: true });
  const written = await readFile(join(root, IDENTITY_FILE), 'utf8');
  assert.match(written, /name = Commit Person/);
  assert.match(written, /email = commit@example\.com/);
  const { stdout } = await exec('git', ['config', 'user.email'], { cwd: root });
  assert.equal(stdout.trim(), 'commit@example.com', 'git resolves to the file that was written');
});

test('init: an existing identity file is left exactly as it is', async () => {
  const root = await repo();
  const existing = '[user]\n\tname = Someone Else\n';
  await writeFile(join(root, IDENTITY_FILE), existing);
  await initCommand([], { root, yes: true });
  assert.equal(await readFile(join(root, IDENTITY_FILE), 'utf8'), existing);
});

test('init: no identity anywhere writes no file and invents nothing', async () => {
  const root = await repo({ commits: 0 });
  // No commits and nothing configured, so there is no answer to derive. The refusal
  // is the behaviour under test: a placeholder in this file would be an identity git
  // uses on the next commit, invented by an adopting command.
  //
  // The environment has to be scrubbed for this to mean anything. A developer with a
  // global user.email set - which is most of them - would otherwise make the identity
  // resolvable and this test would pass for the wrong reason, on this machine only.
  // That is ADR-031: a result that depends on the author's environment rather than on
  // the code.
  const saved = { ...process.env };
  const empty = await mkdtemp(join(tmpdir(), 'simt-nohome-'));
  temps.push(empty);
  process.env.HOME = empty;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  try {
    const { output } = await capture(() => initCommand([], { root, yes: true }));
    assert.match(output, /skip\s+git\.config/);
    assert.match(output, /does not invent one/);
    await assert.rejects(() => readFile(join(root, IDENTITY_FILE), 'utf8'));
  } finally {
    process.env = saved;
  }
});

test('init: the identity file is gitignored when created', async () => {
  const root = await repo();
  await initCommand([], { root, yes: true });
  const ignored = await exec('git', ['check-ignore', '-q', IDENTITY_FILE], { cwd: root }).then(() => true, () => false);
  assert.equal(ignored, true, 'a per-developer identity must not be committable by accident');
});

test('init: the plan names where the identity came from', async () => {
  const root = await repo({ name: 'Commit Person', email: 'commit@example.com' });
  const { output } = await capture(() => initCommand([], { root }));
  assert.match(output, /created\s+git\.config/);
  assert.match(output, /from this repository's last commit/);
});

test('identity: a repository that never configured an identity resolves to null', async () => {
  const root = await repo({ commits: 0 });
  // Not asserted through the environment being scrubbed - that is the suite's own
  // lesson about inherited state. Asserted on the shape of the answer instead.
  const configured = await configuredIdentity(root);
  assert.ok('name' in configured && 'email' in configured);
  const resolved = await resolveIdentity(root);
  assert.equal(resolved.exists, false);
  assert.ok(resolved.from === null || resolved.from === 'configured');
});