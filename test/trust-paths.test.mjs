// Filesystem and config trust boundaries (ADR-205).
//
// Every case here is inert: a temporary directory, a link, a manifest and a parser that
// records that it ran. Nothing touches the network, a real repository or the operator's
// home. The point is to pin the four claims the slice makes - containment is canonical,
// the repository's own code is opt-in, an unreadable policy is closed, and a retry is the
// same answer - where a reviewer can read them.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  journaledRemoveFile,
  journaledWriteFile,
  recordCreatedFile,
} from '../src/journal.mjs';
import { reindex } from '../src/index/store.mjs';
import { federationAccess } from '../src/federation/config.mjs';
import { locateSource } from '../src/resolve/source.mjs';
import { executionAllowed, trustPolicy } from '../src/trust/policy.mjs';
import { within } from '../src/trust/paths.mjs';

const exec = promisify(execFile);
const git = (root, ...args) => exec('git', ['-C', root, ...args]);

async function scratch() {
  return mkdtemp(join(tmpdir(), 'simt-trust-'));
}

test('trust: a link inside the repository that points outside it is outside', async () => {
  const root = await scratch();
  const outside = await scratch();
  try {
    await symlink(outside, join(root, 'escape'));
    assert.equal(existsSync(join(root, 'escape')), true);
    assert.deepEqual(await within(root, join(root, 'escape', 'x.txt')), {
      ok: false,
      reason: 'it resolves outside the repository (a link can point out)',
    });
    assert.equal(within(root, join(root, 'escape')).ok, false);

    // And a path that is inside by spelling, written through the link.
    const acc = [];
    await assert.rejects(
      () => journaledWriteFile(root, acc, join(root, 'escape', 'x.txt'), 'bytes\n'),
      /journal refuses a write outside the repository: .*x\.txt .*resolves outside/,
    );
    assert.equal(existsSync(join(outside, 'x.txt')), false, 'the write landed outside the repository');
    assert.deepEqual(acc, [], 'a refused write was recorded as an effect');

    // The synchronous recorder answers the same way.
    assert.throws(() => recordCreatedFile(root, [], join(root, 'escape', 'y.txt'), 'bytes\n'), /outside the repository/);

    // A link that stays inside is inside: the check is about the resolved path, not
    // about links being suspicious.
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'inside'));
    await journaledWriteFile(root, [], join(root, 'inside', 'a.txt'), 'bytes\n');
    assert.equal(await readFile(join(root, 'real', 'a.txt'), 'utf8'), 'bytes\n');

    // A child whose NAME starts with two dots is not a parent reference.
    await mkdir(join(root, '..cache'));
    assert.equal(within(root, join(root, '..cache', 'a.txt')).ok, true);

    // A removal outside is refused the same way a write is.
    await assert.rejects(() => journaledRemoveFile(root, [], join(outside, 'gone.txt')), /removal outside the repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('trust: a retry gives the same refusal, and unblocking the path makes it succeed', async () => {
  const root = await scratch();
  const outside = await scratch();
  try {
    await symlink(outside, join(root, 'escape'));
    const path = join(root, 'escape', 'retry.txt');
    await assert.rejects(() => journaledWriteFile(root, [], path, 'one\n'), /outside the repository/);
    await assert.rejects(() => journaledWriteFile(root, [], path, 'one\n'), /outside the repository/);
    assert.equal(existsSync(join(outside, 'retry.txt')), false);

    // The remedy a refusal implies: replace the escape with a directory in the repo.
    await rm(join(root, 'escape'));
    await mkdir(join(root, 'escape'));
    const acc = [];
    await journaledWriteFile(root, acc, path, 'one\n');
    assert.equal(await readFile(path, 'utf8'), 'one\n');
    assert.equal(acc.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('trust: a parser runs only when the manifest opts in twice', async () => {
  const root = await scratch();
  try {
    await git(root, 'init', '-q');
    await writeFile(join(root, '.gitignore'), '.simt/\nran.txt\n');
    await writeFile(join(root, 'package.json'), '{ "name": "trust-fixture", "version": "0.0.0" }\n');
    // The parser records that it was loaded, which is the thing opt-in is about.
    await writeFile(
      join(root, 'parser.mjs'),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'writeFileSync(join(import.meta.dirname, "ran.txt"), "ran\\n");',
        'export function extract(filePath, text) {',
        '  return { symbols: [{ name: "opted-in", kind: "const", line: 1, exported: true }], imports: [] };',
        '}',
        '',
      ].join('\n'),
    );
    await writeFile(join(root, 'a.mjs'), 'export const a = 1;\n');
    await git(root, 'add', '-A');
    await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init');

    // 1. Named but not trusted: refused, and the module is never imported.
    await writeFile(join(root, 'simt.json'), `${JSON.stringify({ index: { parsers: './parser.mjs' } })}\n`);
    const refused = await reindex(root);
    assert.equal(refused.parsers, 'refused');
    assert.equal(existsSync(join(root, 'ran.txt')), false, 'an untrusted parser was executed');

    // 2. A malformed policy is a finding, not permission.
    await writeFile(join(root, 'simt.json'), `${JSON.stringify({ index: { parsers: './parser.mjs' }, trust: [] })}\n`);
    const malformed = await reindex(root);
    assert.equal(malformed.parsers, 'refused');
    assert.equal(existsSync(join(root, 'ran.txt')), false);

    // 3. Opted in by specifier: loaded, and the marker proves it ran.
    await writeFile(
      join(root, 'simt.json'),
      `${JSON.stringify({ index: { parsers: './parser.mjs' }, trust: { execute: ['./parser.mjs'] } })}\n`,
    );
    const loaded = await reindex(root);
    assert.equal(loaded.parsers, 'loaded');
    assert.equal(existsSync(join(root, 'ran.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trust: the policy is data, and every shape but the one it reads is closed', () => {
  assert.deepEqual(trustPolicy(null), { execute: [], findings: [] });
  assert.deepEqual(trustPolicy({}), { execute: [], findings: [] });
  // Compared literally, so stray spaces stay part of the value rather than becoming
  // permission for the trimmed spelling `index.parsers` does not name.
  assert.deepEqual(trustPolicy({ trust: { execute: [' a '] } }), { execute: [' a '], findings: [] });
  assert.equal(executionAllowed({ execute: [' a '], findings: [] }, 'a').allowed, false);
  assert.match(trustPolicy({ trust: { execute: 'a' } }).findings[0], /list of module specifiers/);
  assert.match(trustPolicy({ trust: { execute: [''] } }).findings[0], /list of module specifiers/);
  assert.match(trustPolicy({ trust: { allow: [] } }).findings[0], /not a recognised trust key/);
  assert.equal(trustPolicy({ trust: [] }).findings.length, 1);

  assert.deepEqual(executionAllowed({ execute: [], findings: [] }, 'p'), {
    allowed: false,
    reason: 'p is not in trust.execute, so it was not loaded; add it there to opt into running it',
  });
  assert.equal(executionAllowed({ execute: ['p'], findings: [] }, 'p').allowed, true);
  assert.equal(executionAllowed({ execute: ['p'], findings: ['bad'] }, 'p').allowed, false);
});

test('trust: a registry path that escapes its workspace is refused, not measured', async () => {
  const root = await scratch();
  const outside = await scratch();
  try {
    await writeFile(join(outside, 'SKILL.md'), 'outside body\n');
    await writeFile(join(root, 'SKILL.md'), 'inside body\n');
    await symlink(join(outside, 'SKILL.md'), join(root, 'linked.md'));

    const source = { repo: 'r', path: '../', bytes: 13 };
    const found = await locateSource(source, { root });
    assert.equal(found.path, null, 'a path above the repository was accepted');
    assert.match(found.reason, /outside the workspace or repository/);

    const linked = await locateSource({ repo: 'r', path: 'linked.md', bytes: 13 }, { root });
    assert.equal(linked.path, null, 'a link out of the repository was accepted');
    assert.match(linked.reason, /outside the workspace or repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('trust: federation grounds are canonical, and the user allowlist still decides', async () => {
  const cwd = await scratch();
  const outside = await scratch();
  try {
    await symlink(outside, join(cwd, 'escape'));
    const configPath = '/home/u/.config/simt-dev/config.json';
    const allowed = { federation: { servers: ['serena'] } };

    assert.equal(
      federationAccess({ root: cwd, cwd, workspaceRoot: null, serverNames: ['serena'], userConfig: allowed, configPath }),
      null,
    );
    const escaped = federationAccess({
      root: join(cwd, 'escape'),
      cwd,
      workspaceRoot: null,
      serverNames: ['serena'],
      userConfig: allowed,
      configPath,
    });
    assert.match(escaped.message, /refuses a root outside the server workspace/);

    const notListed = federationAccess({
      root: cwd,
      cwd,
      workspaceRoot: null,
      serverNames: ['serena'],
      userConfig: {},
      configPath,
    });
    assert.match(notListed.message, /not named in the user config/);
    assert.match(notListed.remedy, /federation\.servers/);

    // The cross-repo allowlist is a user decision: `allow: true` names every server the
    // repository declared, and a named list names only those.
    assert.equal(
      federationAccess({ root: cwd, cwd, workspaceRoot: null, serverNames: ['serena'], userConfig: { federation: { allow: true } }, configPath }),
      null,
    );
    assert.match(
      federationAccess({ root: cwd, cwd, workspaceRoot: null, serverNames: ['other'], userConfig: allowed, configPath }).message,
      /not named in the user config/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
