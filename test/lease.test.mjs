// R54: file leases for parallel agents — the claim, and the refusal behind it.
//
// The acceptance is one phrase, "two-session fixture", so the spine of this file is
// exactly that: session alpha claims a path, session beta's edit is refused with the
// claim named, alpha's own edit passes, and an expired claim refuses nobody. Around
// it sit the edges that decide whether the mechanism can be trusted rather than merely
// demonstrated — a session that cannot prove ownership, a claim file that stopped
// parsing, a path outside the repository — because each of those is a way a
// coordination mechanism silently stops coordinating.
//
// The hook runs through the shipped binary with a payload on stdin and `SIMT_SESSION`
// in the environment, not through a stub of `decide`: the property under test is the
// one a harness actually observes — exit code, dialect JSON, and the message an author
// reads while being stopped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_ENV } from '../src/agenthooks/policy.mjs';
import { LEASE_FILE } from '../src/lease.mjs';
import { CLI } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt.mjs');
const made = [];

test.after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** One repository-shaped directory with a file worth claiming. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-lease-'));
  made.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

function cli(args, { input = '', env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { code: result.status ?? 1, stdout, stderr, text: `${stdout}${stderr}` };
}

/** Claude's documented PreToolUse payload for a write, the shape factsFrom reads. */
const editPayload = (file, root) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: root });

const edit = (root, file, options) => cli(['agent-hook', 'pre-tool-use', '--harness', 'claude'], { input: editPayload(file, root), ...options });

const leasePath = (root) => join(root, LEASE_FILE);
const readClaims = async (root) => JSON.parse(await readFile(leasePath(root), 'utf8'));

test('a claim is written by name and TTL, previewed until --yes, and listable by anyone', async () => {
  const root = await repo();

  const preview = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /would    lease src\/keep\.mjs until \d{4}-/);
  assert.match(preview.stdout, /run: simt lease "src\/keep\.mjs" --session alpha --yes/);
  assert.equal(existsSync(leasePath(root)), false, 'the preview wrote a claim');

  const taken = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root, '--yes']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.match(taken.stdout, /LEASED   src\/keep\.mjs  until \d{4}-/);
  const claims = await readClaims(root);
  assert.equal(claims.schemaVersion, 1);
  assert.equal(claims.leases.length, 1);
  assert.equal(claims.leases[0].session, 'alpha');
  assert.ok(claims.leases[0].expiresAt > Date.now(), 'the expiry is in the future');

  const listed = cli(['lease', '--root', root]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /LEASED   src\/keep\.mjs  alpha  until \d{4}-/);
});

test('claiming without a session, with a bad TTL, or outside the repository is a usage error', async () => {
  const root = await repo();

  const noSession = cli(['lease', 'src/keep.mjs', '--root', root, '--yes'], { env: { [SESSION_ENV]: '' } });
  assert.equal(noSession.code, 2);
  assert.match(noSession.stderr, /needs a session/);
  assert.match(noSession.stderr, new RegExp(`${CLI} lease <paths> --session <id>`));

  const badTtl = cli(['lease', 'src/keep.mjs', '--session', 'a', '--ttl', '0', '--root', root, '--yes']);
  assert.equal(badTtl.code, 2);
  assert.match(badTtl.stderr, /--ttl must be a positive number of seconds/);

  const outside = cli(['lease', '../elsewhere.txt', '--session', 'a', '--root', root, '--yes']);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /not a path inside the repository/);

  const listWithSession = cli(['lease', '--session', 'a', '--root', root]);
  assert.equal(listWithSession.code, 2);
  assert.match(listWithSession.stderr, /takes neither --session nor --ttl/);

  assert.equal(existsSync(leasePath(root)), false, 'every refusal wrote nothing');
});

test('another session cannot take a held path, and the refusal names the holder', async () => {
  const root = await repo();
  const first = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root, '--yes']);
  assert.equal(first.code, 0, first.stderr);

  const stolen = cli(['lease', 'src/keep.mjs', '--session', 'beta', '--root', root, '--yes']);
  assert.equal(stolen.code, 1, stolen.text);
  assert.match(stolen.stderr, /src\/keep\.mjs is leased by alpha until \d{4}-/);
  assert.match(stolen.stderr, /wait for the TTL or ask the holder/);
  assert.equal((await readClaims(root)).leases[0].session, 'alpha', 'the refusal rewrote the claim');

  // The holder is not locked out of its own claim: a refresh is the whole reason a
  // session re-runs the command.
  const refreshed = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root, '--yes', '--ttl', '7200']);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  const claims = await readClaims(root);
  assert.equal(claims.leases.length, 1);
  assert.equal(claims.leases[0].session, 'alpha');
  assert.ok(claims.leases[0].expiresAt > Date.now() + 3600 * 1000, 'the TTL moved to the new value');
});

test('two sessions: beta\'s edit is refused with the claim, alpha\'s own edit passes', async () => {
  const root = await repo();
  const claim = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root, '--yes']);
  assert.equal(claim.code, 0, claim.stderr);

  const beta = edit(root, 'src/keep.mjs', { env: { [SESSION_ENV]: 'beta' } });
  assert.equal(beta.code, 2, `beta was not blocked: ${beta.text}`);
  const json = JSON.parse(beta.stdout);
  assert.equal(json.hookSpecificOutput.permissionDecision, 'deny', `beta answered ${beta.stdout}`);
  assert.match(beta.text, /ADR-101/, 'the refusal did not name the record that settled it');
  assert.match(beta.text, /src\/keep\.mjs held by alpha until \d{4}-/, 'the refusal did not say who holds it');
  assert.match(beta.text, /override: SIMT_ALLOW=lease/, 'the refusal did not name its override');

  const alpha = edit(root, 'src/keep.mjs', { env: { [SESSION_ENV]: 'alpha' } });
  assert.equal(alpha.code, 0, `alpha was blocked by its own claim: ${alpha.text}`);
  assert.equal(alpha.stdout, '', `alpha got a decision document for its own file: ${alpha.stdout}`);

  // A session that cannot name itself is not the holder, so it is refused: an unproven
  // identity is the exact case a lease exists to stop.
  const nameless = edit(root, 'src/keep.mjs', { env: { [SESSION_ENV]: '' } });
  assert.equal(nameless.code, 2, `an unidentified session walked through: ${nameless.text}`);

  const noClaimYet = await repo();
  const stranger = edit(noClaimYet, 'src/keep.mjs', { env: { [SESSION_ENV]: 'beta' } });
  assert.equal(stranger.code, 0, `a repository with no claims blocked an edit: ${stranger.text}`);
});

test('an expired claim refuses nobody: expiry is read when the hook runs', async () => {
  const root = await repo();
  await mkdir(dirname(leasePath(root)), { recursive: true });
  await writeFile(
    leasePath(root),
    `${JSON.stringify({
      schemaVersion: 1,
      leases: [{ path: 'src/keep.mjs', session: 'alpha', expiresAt: Date.now() - 1000 }],
    }, null, 2)}\n`,
  );

  const beta = edit(root, 'src/keep.mjs', { env: { [SESSION_ENV]: 'beta' } });
  assert.equal(beta.code, 0, `an expired claim still blocked beta: ${beta.text}`);
  assert.equal(beta.stdout, '');

  const listed = cli(['lease', '--root', root]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /\(no active leases\)/, 'the list still shows an expired claim');
});

test('a claim file that will not parse fails closed for edits, and the command will not overwrite it', async () => {
  const root = await repo({ [LEASE_FILE]: '{ not json' });

  const beta = edit(root, 'src/keep.mjs', { env: { [SESSION_ENV]: 'beta' } });
  assert.equal(beta.code, 2, `an unreadable claim file let an edit through: ${beta.text}`);
  assert.match(beta.text, /is not valid JSON/, 'the refusal did not explain the broken file');
  assert.match(beta.text, /fix or remove/);

  // Only edits: a lease file says nothing about whether `ls` may run.
  const shell = cli(['agent-hook', 'pre-tool-use', '--harness', 'claude'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root }),
    env: { [SESSION_ENV]: 'beta' },
  });
  assert.equal(shell.code, 0, `a broken claim file blocked a shell command: ${shell.text}`);

  const take = cli(['lease', 'src/keep.mjs', '--session', 'alpha', '--root', root, '--yes']);
  assert.equal(take.code, 1, `the command wrote over unreadable claims: ${take.text}`);
  assert.match(take.stderr, /not valid JSON/);
  assert.equal(await readFile(leasePath(root), 'utf8'), '{ not json', 'the refusal rewrote the file');
});