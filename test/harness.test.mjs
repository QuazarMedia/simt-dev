// `simt-dev harness detect` - which harnesses a repository is set up for.
//
// The claim under test is narrow and deliberate: a directory that exists implies a
// harness is in use, and nothing more. The command does not claim what that harness
// reads, because the tool cannot answer that without a vendor document - and a guess
// here would be the reader's problem the first time it was wrong.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-harness-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

/** A repository with the given configuration directories present. */
async function repoWith(...dirs) {
  const root = await scratch();
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  return root;
}

test('a directory with a channel and one without are reported as different facts', async () => {
  const root = await repoWith('.cursor', '.gemini');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const { repo } = JSON.parse(out.out);

  const rows = Object.fromEntries(repo.rows.map((r) => [r.dir, r]));
  // `.cursor` is a surface in this release, and it projects a rule file.
  assert.equal(rows['.cursor'].surface, 'cursor');
  assert.equal(rows['.cursor'].channel, true);
  // `.gemini` is present and this release has no row for it. It is reported as present
  // with no channel, never as "supported" and never as an error.
  assert.equal(rows['.gemini'].surface, null);
  assert.equal(rows['.gemini'].channel, false);
  // A channel row carries the document it was verified against, so a reader can check
  // the claim instead of trusting it.
  assert.ok(rows['.cursor'].verified, 'a channel with no provenance is the defect this file exists for');
  assert.equal(rows['.gemini'].verified, null);
});

test('the text says the same as the json', async () => {
  const root = await repoWith('.claude', '.cursor', '.gemini');
  const text = await run(['harness', 'detect', '--root', root]);
  const json = JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out);

  assert.equal(text.code, 0);
  for (const row of json.repo.rows) {
    assert.match(text.out, new RegExp(row.dir.replace('.', '\\.')), `${row.dir} is missing from the text output`);
  }
  // The one claim the text makes that a number alone cannot: presence is not coverage.
  assert.match(text.out, /not as unsupported/);
  assert.match(text.out, /\(reads AGENTS\.md\)|some readers read AGENTS\.md/);
});

test('a .dsh directory is the DeepSeek harness, covered by AGENTS.md', async () => {
  const root = await repoWith('.dsh');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const row = JSON.parse(out.out).repo.rows.find((r) => r.dir === '.dsh');
  assert.ok(row, 'a .dsh directory is the harness home shape');
  assert.equal(row.surface, null, 'there is no per-rule file to project');
  assert.equal(row.channel, false);
  assert.equal(row.readsAgentsMd, 'all');
  assert.match(row.verified, /read 2026-10-14/);

  const text = await run(['harness', 'detect', '--root', root]);
  assert.match(text.out, /\.dsh\s+DeepSeek harness\s+AGENTS\.md/);
  assert.doesNotMatch(text.out, /no rule channel in this release/);
});

test('a repository with no harness configuration is an answer, not a failure', async () => {
  // A reader running this on a fresh repository must get "none found" and a zero exit.
  // A non-zero exit here would be read as "your repo is wrong", which is the one thing
  // a directory scan can never establish.
  const root = await repoWith();
  const out = await run(['harness', 'detect', '--root', root]);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /no harness configuration/i);
  assert.equal(JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out).repo.rows.length, 0);
});

test('--user adds the home block, and only when asked', async () => {
  const root = await repoWith('.cursor');
  const withoutKey = JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out);
  assert.ok(!('user' in withoutKey), 'home is the reader\'s, not the repository\'s; it is opt-in');

  const withKey = JSON.parse((await run(['harness', 'detect', '--root', root, '--user', '--json'])).out);
  assert.ok('user' in withKey);
  // The contents of the real home are the machine's, not the fixture's, so only the
  // shape is asserted. What the scan found there is whatever the developer installed.
  assert.ok(Array.isArray(withKey.user.rows));
});

test('a subcommand that does not exist is a usage failure, not a default', async () => {
  const root = await repoWith('.cursor');
  const out = await run(['harness', 'nonsense', '--root', root]);
  assert.notEqual(out.code, 0);
  assert.equal(out.code, 2);
});
