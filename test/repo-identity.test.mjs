// A repo-local identity overrides the one the repository declares (review 0003 Q91).
//
// `.git/config` is the one place a commit's author can be changed without a trace in
// the tracked tree: a `[user]` block there wins over the `git.config` include and over
// the machine's identity. 34 commits in this repository shipped as `t <t@t.t>` that
// way, and every check stayed green, because nothing asked what the config said.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { localIdentityOverrides } from '../src/identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);

test('this repository does not shadow the identity its git.config declares', async () => {
  const overrides = await localIdentityOverrides(ROOT);
  assert.deepEqual(
    overrides,
    [],
    `a repo-local identity overrides git.config: ${overrides.map((o) => `${o.key}=${o.value}`).join(' ')}`,
  );
});

test('a repo-local identity is detected, not assumed absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-identity-'));
  await exec('git', ['init', '-q', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'someone@example.invalid']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Someone']);
  const found = await localIdentityOverrides(dir);
  assert.deepEqual(found.map((o) => o.key).sort(), ['user.email', 'user.name']);
});
