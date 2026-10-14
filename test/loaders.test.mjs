// The harness loader table, and one reader's view of one repository.
//
// Two claims are under test, and they are separate on purpose.
//
//   1. EVERY ROW IS TRACEABLE. `surfaces.mjs` already established that a `verified`
//      field citing nothing is decoration that misdescribes the artefact. This table
//      makes the same claim about more fields — order, caps, imports, hooks, MCP — and
//      the test asserts each one cites a document, because the alternative is a byte
//      count in a report that nobody can check twice.
//
//   2. EACH READER'S VIEW OF A SAMPLE REPO. Not "the view is plausible" but the specific
//      disagreements this table was built to record: Claude Code skips AGENTS.md when a
//      CLAUDE.md exists, Antigravity ignores nested `.agents/rules/`, Cursor loads only
//      `alwaysApply: true`, and Codex drops the tail of the chain at 32 KiB even when
//      every file is small. A table with provenance that never changes an answer is
//      documentation.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { LOADERS, caps, loader } from '../src/projection/loaders.mjs';
import { viewOf } from '../src/measure/loaderView.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-loaders-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A repository written from a path -> contents map, directories included. */
async function repo(files) {
  const root = await scratch();
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

function run(args) {
  return exec('node', [BIN, ...args], { maxBuffer: 16 << 20 }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (error) => ({ code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') }),
  );
}

// --- provenance ----------------------------------------------------------------

test('every loader row cites the document each claim came from', () => {
  for (const row of LOADERS) {
    assert.ok(row.verified && row.verified.length > 40, `${row.id} has no provenance`);
    assert.match(row.verified, /read 2026-/, `${row.id} does not say when it was read`);
    assert.ok(row.order, `${row.id} states no concatenation order`);
    assert.ok(row.nested, `${row.id} states no nested-directory behaviour`);
    // Every entry, not every row: one entry read from memory and the rest from the
    // vendor is the shape that reads as a verified table and is not one.
    for (const entry of row.start) {
      assert.ok(entry.why && entry.why.length > 20, `${row.id} start entry ${entry.path} cites nothing`);
    }
    for (const extra of row.alsoReads ?? []) {
      assert.ok(extra.why, `${row.id} alsoReads ${extra.what} cites nothing`);
    }
    if (row.cap !== null) {
      assert.ok(row.cap.why, `${row.id} states a cap without saying where it came from`);
      assert.ok(row.cap.why.includes('docs'), `${row.id} cap provenance does not name a document`);
    }
    if (row.cap === null) {
      assert.ok(row.capNote, `${row.id} has no cap and no reason: that is "unchecked", not "none"`);
    }
    if (row.imports) assert.ok(row.imports.why, `${row.id} imports syntax cites nothing`);
    if (row.hooks) assert.ok(row.hooks.verified, `${row.id} hooks path cites nothing`);
    if (row.hooks === null) assert.ok(row.hooksNote, `${row.id} has no hooks path and no note`);
    if (row.mcp) assert.ok(row.mcp.verified, `${row.id} mcp path cites nothing`);
    if (row.skills.length === 0) assert.ok(row.skillsNote, `${row.id} lists no skills and no reason`);
  }
});

test('a cap is stated with the scope it applies to', () => {
  for (const row of LOADERS) {
    for (const c of caps(row)) {
      assert.ok(['chain', 'file', 'tokens'].includes(c.scope), `${row.id} cap scope ${c.scope}`);
      assert.ok(c.appliesTo, `${row.id} cap does not say what it applies to`);
    }
  }
  // The two facts the meter could not see before this table existed, asserted rather
  // than described: a repository can be inside Codex's limit file by file and past it as
  // a chain, and Antigravity truncates one file while Cursor publishes no cap at all.
  assert.equal(loader('codex').cap.scope, 'chain');
  assert.equal(loader('antigravity').cap.scope, 'file');
  assert.equal(loader('cursor').cap, null);
});

test('an unknown reader is a usage error naming the ones that exist', async () => {
  const out = await run(['harness', 'loaders', '--reader', 'nonsense']);
  assert.equal(out.code, 2, out.out);
  assert.match(out.out, /unknown reader/i);
  assert.match(out.out, /codex/);
});

// --- each reader's view --------------------------------------------------------

test('Claude Code reads AGENTS.md only when there is no CLAUDE.md', async () => {
  const withAgents = await repo({ 'AGENTS.md': 'agents\n' });
  const withBoth = await repo({ 'AGENTS.md': 'agents\n', 'CLAUDE.md': 'claude\n' });

  const bare = await viewOf(withAgents, loader('claude'));
  assert.deepEqual(bare.files.map((f) => f.file), ['AGENTS.md']);

  // The documented precedence, and the reason the pointer surface exists: with both
  // files present, the AGENTS.md is not loaded by Claude Code at all.
  const both = await viewOf(withBoth, loader('claude'));
  assert.deepEqual(both.files.map((f) => f.file), ['CLAUDE.md']);
});

test('Codex merges the chain in order and stops at project_doc_max_bytes', async () => {
  // Two files, each inside 32 KiB, whose sum is not. This is the case a per-file check
  // cannot see, and it is why `cap.scope` is `chain`.
  const root = await repo({
    'AGENTS.md': `${'a'.repeat(20_000)}\n`,
    'src/AGENTS.override.md': `${'b'.repeat(20_000)}\n`,
  });
  const view = await viewOf(root, loader('codex'), { cwd: join(root, 'src') });
  assert.equal(view.cap.scope, 'chain');
  assert.ok(view.cap.over, 'a 40 KB chain is over a 32 KiB limit');
  assert.ok(view.droppedBytes > 0, 'the dropped bytes are named');
  assert.deepEqual(
    view.files.map((f) => [f.file, f.beyondCap]),
    [
      ['AGENTS.md', false],
      ['src/AGENTS.override.md', true],
    ],
  );
});

test('Codex takes one file per directory, override first', async () => {
  const root = await repo({ 'AGENTS.md': 'agents\n', 'AGENTS.override.md': 'override\n' });
  const view = await viewOf(root, loader('codex'));
  assert.deepEqual(view.files.map((f) => f.file), ['AGENTS.override.md']);
});

test('Antigravity reads .agents/rules/ flat and ignores nested files', async () => {
  const root = await repo({
    '.agents/rules/always.md': '---\ntrigger: always_on\ndescription: a\n---\nbody\n',
    '.agents/rules/lazy.md': '---\ntrigger: model_decision\ndescription: b\n---\nbody\n',
    '.agents/rules/nested/deep.md': '---\ntrigger: always_on\ndescription: c\n---\nbody\n',
  });
  const view = await viewOf(root, loader('antigravity'));
  assert.deepEqual(
    view.files.map((f) => f.file),
    ['.agents/rules/always.md'],
    'model_decision injects a pointer, and a nested file is not scanned at all',
  );
});

test('Cursor loads an always-apply rule and leaves a scoped one until it matches', async () => {
  const root = await repo({
    '.cursor/rules/eager.mdc': '---\nalwaysApply: true\n---\nbody\n',
    '.cursor/rules/lazy.mdc': '---\nalwaysApply: false\nglobs: "src/**"\n---\nbody\n',
  });
  const view = await viewOf(root, loader('cursor'));
  assert.deepEqual(view.files.map((f) => f.file), ['.cursor/rules/eager.mdc']);
});

test('Copilot loads repository instructions and AGENTS.md at start, and leaves path-specific rules until a file matches', async () => {
  const root = await repo({
    '.github/copilot-instructions.md': 'repo-wide\n',
    '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nscoped\n',
    'AGENTS.md': 'agents\n',
  });
  const view = await viewOf(root, loader('copilot'));
  assert.deepEqual(
    view.files.map((f) => f.file),
    ['AGENTS.md', '.github/copilot-instructions.md'],
  );
});

test('a skill costs its frontmatter, not its body', async () => {
  const root = await repo({
    '.agents/skills/demo/SKILL.md':
      '---\nname: demo\ndescription: does a thing\n---\n' + 'x'.repeat(5_000),
  });
  const view = await viewOf(root, loader('opencode'));
  const skill = view.files.find((f) => f.channel === 'skills');
  assert.ok(skill, 'the skill is measured');
  assert.ok(skill.bytes > 5_000, 'the file is that long');
  assert.ok(skill.countedBytes < 60, `only name and description cost a turn: ${skill.countedBytes} B`);
});

test('the command reports the table and the measurement, and both name their source', async () => {
  const root = await repo({ 'AGENTS.md': 'agents\n' });

  const table = await run(['harness', 'loaders', '--table']);
  assert.equal(table.code, 0, table.out);
  assert.match(table.out, /source {4}Codex AGENTS\.md documentation/);
  assert.match(table.out, /cap {7}32768 B over the merged chain/);
  // Copilot publishes no hooks file. It says so rather than showing an empty cell, which
  // would read as "no hooks exist".
  assert.match(table.out, /hooks {5}none documented — no hooks file is documented for Copilot/);

  const measured = await run(['harness', 'loaders', '--reader', 'codex', '--root', root, '--json']);
  assert.equal(measured.code, 0, measured.out);
  const { rows } = JSON.parse(measured.out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reader, 'codex');
  assert.equal(rows[0].totalBytes, 7);
  assert.ok(rows[0].verified.includes('read 2026-'));
});

test('a skill body is never measured into the start cost, in the command output either', async () => {
  const root = await repo({
    'AGENTS.md': 'agents\n',
    '.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\n' + 'y'.repeat(9_000),
  });
  const out = await run(['harness', 'loaders', '--reader', 'claude', '--root', root, '--json']);
  const { rows } = JSON.parse(out.out);
  const skill = rows[0].files.find((f) => f.channel === 'skills');
  assert.equal(skill.countedBytes, 6);
});