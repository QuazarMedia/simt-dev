// Review 0003 Q81: a bare group is a read, and a superseded flag says what replaced it.
//
// Both are guarantees about behaviour, so both run the binary against a staged repository
// rather than reading the spec: a `writes:` claim is a declaration, and this is the check
// that the declaration holds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GROUP_DEFAULTS } from '../src/commands/spec.mjs';
import { git } from './fixture.mjs';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt.mjs');

/** A repository `init` adopted and committed, so any write shows up in `git status`. */
async function staged() {
  const dir = await mkdtemp(join(tmpdir(), 'simt-defaults-'));
  await exec('git', ['init', '-q', dir]);
  await exec('node', [BIN, 'init', '--yes', '--root', dir], { cwd: dir });
  await git(['-C', dir, 'add', '-A'], { cwd: dir });
  await git(['-C', dir, 'commit', '-q', '-m', 'staged'], { cwd: dir });
  return dir;
}

const statusOf = async (dir) => (await exec('git', ['-C', dir, 'status', '--porcelain'], { cwd: dir })).stdout.trim();

test('every group default is a read: a bare group changes nothing', async () => {
  const dir = await staged();
  try {
    assert.ok(GROUP_DEFAULTS.size > 0, 'no group declares a default');
    const before = await statusOf(dir);
    const offenders = [];
    for (const group of GROUP_DEFAULTS.keys()) {
      await exec('node', [BIN, group, '--json', '--root', dir], { cwd: dir, timeout: 20000 }).catch((error) => error);
      const after = await statusOf(dir);
      if (after !== before) offenders.push(`${group}: ${after.split('\n')[0]}`);
    }
    assert.deepEqual(offenders, [], 'a bare group changed the repository');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a superseded flag still runs, names its replacement, and reports it in JSON', async () => {
  const dir = await staged();
  try {
    const text = await exec('node', [BIN, 'sync', '--check', '--root', dir], { cwd: dir, timeout: 20000 }).catch((error) => error);
    assert.equal(text.code ?? 0, 0, String(text.stderr ?? ''));
    assert.match(String(text.stderr), /--check is deprecated/, 'the superseded flag said nothing');
    const json = await exec('node', [BIN, 'sync', '--check', '--json', '--root', dir], { cwd: dir, timeout: 20000 }).catch((error) => error);
    const doc = JSON.parse(String(json.stdout));
    assert.deepEqual(doc.deprecated, { check: 'sync' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
