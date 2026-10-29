// Plan 0003 R52 — one ignore list renders every reader's dialect.
//
// The tracker's acceptance is "ignore files in parity": after the run, the
// four outputs must encode the SAME set of entries, because four copies of one
// fact that can disagree is exactly the failure the single list exists to end.
// The rest of the rows guard the writer contracts this tool already has —
// dry-run by default, journaled on write (R49), `--diff` (R50), one JSON
// document (the S51 contract) — and the one place it must refuse: a Claude
// settings file that is not parseable JSON is never "repaired" by a renderer.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { denyEntries, parseIgnoreList, renderClaudeSettings, renderTextIgnore } from '../src/ignore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');

const made = [];
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-ignore-'));
  made.push(root);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return root;
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

const LIST = '.env\nsecrets/**\n*.pem\n# a comment, not an entry\n\n';

/** The four outputs' own idea of the entries, each read back its own way. */
async function readParity(root) {
  const textFiles = {};
  for (const path of ['.cursorignore', '.aiderignore', '.geminiignore']) {
    textFiles[path] = parseIgnoreList(await readFile(join(root, path), 'utf8'));
  }
  const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
  const denied = (settings.permissions?.deny ?? []).map((entry) =>
    entry.startsWith('Read(') && entry.endsWith(')') ? entry.slice(5, -1) : `\u0000not-a-read:${entry}`,
  );
  return { textFiles, denied };
}

// --- parity (the acceptance) -------------------------------------------------

test('the four outputs encode the same entries from one list', async () => {
  const root = await scratch({ '.simtignore': LIST });
  const { code, stderr } = await run(['ignore', '--root', root, '--yes']);
  assert.equal(code, 0, stderr);

  const expected = ['.env', 'secrets/**', '*.pem'];
  const { textFiles, denied } = await readParity(root);
  for (const [path, entries] of Object.entries(textFiles)) {
    assert.deepEqual(entries, expected, `${path} is out of parity`);
  }
  assert.deepEqual(denied, expected, '.claude/settings.json denies are out of parity');
  // The three generated files are byte-identical, not merely equal after parse:
  // a divergence in formatting would be a divergence a reader can stumble on.
  const bytes = await Promise.all(
    ['.cursorignore', '.aiderignore', '.geminiignore'].map((p) => readFile(join(root, p), 'utf8')),
  );
  assert.equal(bytes[1], bytes[0]);
  assert.equal(bytes[2], bytes[0]);
});

test('the engine itself renders parity for a fresh and a populated settings file', () => {
  const entries = parseIgnoreList(LIST);
  assert.deepEqual(renderTextIgnore(entries), '.env\nsecrets/**\n*.pem\n');
  const fresh = renderClaudeSettings(null, entries);
  assert.equal(fresh.ok, true);
  assert.deepEqual(JSON.parse(fresh.text).permissions.deny, denyEntries(entries));

  const existing = JSON.stringify({ model: 'opus', permissions: { deny: ['Read(./keep/**)'] } }, null, 2);
  const merged = renderClaudeSettings(existing, entries);
  assert.equal(merged.ok, true);
  const settings = JSON.parse(merged.text);
  assert.equal(settings.model, 'opus', 'a key we do not own was dropped');
  assert.deepEqual(settings.permissions.deny, ['Read(./keep/**)', ...denyEntries(entries)]);
});

// --- the writer's contracts --------------------------------------------------

test('dry-run is the default and writes none of the four', async () => {
  const root = await scratch({ '.simtignore': LIST });
  const { code, stderr } = await run(['ignore', '--root', root]);
  assert.equal(code, 0);
  assert.match(stderr, /dry-run {2}nothing written/);
  for (const path of ['.cursorignore', '.aiderignore', '.geminiignore', '.claude/settings.json']) {
    assert.ok(!existsSync(join(root, path)), `${path} must not exist after a dry run`);
  }
});

test('--diff prints the plan as unified diffs without changing what runs', async () => {
  const root = await scratch({ '.simtignore': LIST });
  const { code, stdout } = await run(['ignore', '--root', root, '--diff']);
  assert.equal(code, 0);
  assert.match(stdout, /\+\+\+ b\/\.cursorignore/);
  assert.match(stdout, /^\+\.env$/m);
  assert.ok(!existsSync(join(root, '.cursorignore')), '--diff does not write');
});

test('a second run reports every target unchanged and writes nothing new', async () => {
  const root = await scratch({ '.simtignore': LIST });
  await run(['ignore', '--root', root, '--yes']);
  const before = await readdir(join(root, '.simt', 'local', 'journal'));

  const second = await run(['ignore', '--root', root, '--yes', '--json']);
  assert.equal(second.code, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.written, false);
  assert.equal(payload.action ?? 'unchanged', 'unchanged');
  for (const file of payload.files) assert.equal(file.action, 'unchanged', JSON.stringify(payload.files));

  const after = await readdir(join(root, '.simt', 'local', 'journal'));
  assert.equal(after.length, before.length, 'an unchanged run journals nothing');
});

test('the write is journaled as one set, and the payload is one versioned document', async () => {
  const root = await scratch({ '.simtignore': LIST });
  const { code, stdout, stderr } = await run(['ignore', '--root', root, '--yes', '--json']);
  assert.equal(code, 0, stderr);

  const trimmed = stdout.trim();
  assert.equal(trimmed.split('\n').length, 1, 'the document is one line');
  const payload = JSON.parse(trimmed);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.command, 'ignore');
  assert.equal(payload.written, true);
  assert.equal(payload.entries, 3);
  assert.equal(payload.files.length, 4);

  const journal = await readdir(join(root, '.simt', 'local', 'journal'));
  assert.ok(journal.length >= 1, 'the write left an undo set (R49)');
  const set = JSON.parse(await readFile(join(root, '.simt', 'local', 'journal', journal[0]), 'utf8'));
  assert.equal(set.command, 'ignore');
  assert.equal(set.entries.length, 4, 'all four writes are in the set');
  for (const entry of set.entries) assert.ok(entry.beforeDigest !== undefined, 'entries carry digests');
});

// --- refusals ----------------------------------------------------------------

test('no list is an error that names the file, not four empty renders', async () => {
  const root = await scratch({});
  const { code, stderr } = await run(['ignore', '--root', root]);
  assert.notEqual(code, 0);
  assert.match(stderr, /\.simtignore/);
  for (const path of ['.cursorignore', '.aiderignore', '.geminiignore']) {
    assert.ok(!existsSync(join(root, path)), `${path} must not be created from a missing list`);
  }
});

test('a list that parses to nothing is refused', async () => {
  const root = await scratch({ '.simtignore': '# only a comment\n\n' });
  const { code, stderr } = await run(['ignore', '--root', root, '--yes']);
  assert.notEqual(code, 0);
  assert.match(stderr, /zero entries/);
  assert.ok(!existsSync(join(root, '.cursorignore')));
});

test('an unparseable Claude settings file is refused, and nothing is written at all', async () => {
  const broken = '{ "permissions": { "deny": [ oops } ] }';
  const root = await scratch({ '.simtignore': LIST, '.claude/settings.json': broken });
  const { code, stderr } = await run(['ignore', '--root', root, '--yes']);
  assert.notEqual(code, 0);
  assert.match(stderr, /settings\.json/);
  assert.equal(await readFile(join(root, '.claude', 'settings.json'), 'utf8'), broken, 'the file was touched');
  // The whole run refuses, not just the one target: three generated files
  // agreeing with a list whose fourth render failed would leave the set split.
  for (const path of ['.cursorignore', '.aiderignore', '.geminiignore']) {
    assert.ok(!existsSync(join(root, path)), `${path} was written by a refused run`);
  }
});