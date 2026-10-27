// `simt explain <CODE>` (plan 0003 R46): what a check finding means.
//
// The table is data, so the test that matters is coverage, not prose: it scans
// the modules `check` reads findings from and fails when a status it can emit
// has no entry. A new finding that ships without documentation is a red gate,
// the same way a new command without help is. The behaviour underneath —
// case-insensitivity, the alias, the JSON envelope, the usage errors — is pinned
// through the real binary, because that is the only way to catch a flag the
// dispatcher never routes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPLAIN_CODES } from '../src/explain.mjs';
import { EXPLAIN_ALIASES, listExplainCodes } from '../src/commands/explain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 32 << 20,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// Every module `check` reads findings from. Not all of src/: the same words
// appear in other commands wearing other meanings (`compare` reports drift, the
// marker parser returns an internal ok), and a repo-wide scan would demand
// entries for statuses `check` never emits.
const CHECK_PIPELINE = [
  // checkCommand, gateCwdFindings, frozenFindings.
  'src/commands/sync.mjs',
  // checkTarget(s): the per-file current/drift and every region finding.
  'src/projection/project.mjs',
  // unrunnableGates, the drifted generated fields.
  'src/projection/manifest.mjs',
  // The region parse: malformed reaches check, the ok is internal.
  'src/projection/markers.mjs',
  // Absent/unmanaged/unreadable targets.
  'src/projection/targets.mjs',
  'src/projection/shared.mjs',
  // resolvePacks: every pack-* finding check reports.
  'src/packs.mjs',
  // `pack lint` shares this module, but its bench findings are not check findings.
  'src/packs/manage.mjs',
  // lintDecisions.
  'src/memory/decide.mjs',
  // Declared checkers: file-lines, forbid-regex, forbidden-path, required-file.
  'src/kernel/checks.mjs',
  // The kernel-mode cut.
  'src/kernel/budget.mjs',
  // The base-config findings.
  'src/tsconfig.mjs',
];

// Statuses the scan meets that are not check findings, and why each is exempt.
// `ok` is the marker parser's internal "the region parsed", mapped to
// current/drift downstream. The pack-bench trio are `pack lint` findings from
// the module `pack lint` shares with check — reported there, never here.
const NOT_CHECK_FINDINGS = new Set([
  'ok',
  'pack-bench-invalid',
  'pack-bench-stale',
  'pack-bench-unmeasured',
]);

function emittedStatuses(text) {
  // One logical line: gateCwdFindings builds its status across three lines.
  const flat = text.replace(/\s+/g, ' ');
  const found = new Set();
  for (const m of flat.matchAll(/status:\s*'([a-z0-9-]+)'/g)) found.add(m[1]);
  for (const m of flat.matchAll(/status:[^'"]*\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g)) {
    found.add(m[1]);
    found.add(m[2]);
  }
  return found;
}

test('every status the check pipeline can emit has an explanation', async () => {
  const emitted = new Set();
  for (const file of CHECK_PIPELINE) {
    const text = await readFile(resolve(HERE, '..', file), 'utf8');
    for (const code of emittedStatuses(text)) emitted.add(code);
  }
  const unexplained = [...emitted].filter((c) => !NOT_CHECK_FINDINGS.has(c) && !(c in EXPLAIN_CODES));
  assert.deepEqual(
    unexplained.sort(),
    [],
    `check can emit statuses with no \`explain\` entry: ${unexplained.sort().join(', ')}`,
  );
});

test('every entry carries what, why, fix and example', () => {
  for (const [code, row] of Object.entries(EXPLAIN_CODES)) {
    for (const field of ['what', 'why', 'fix', 'example']) {
      assert.equal(typeof row[field], 'string', `${code} has no ${field}`);
      assert.ok(row[field].length > 0, `${code} has an empty ${field}`);
    }
  }
});

test('the code list is the table, sorted', () => {
  assert.deepEqual(listExplainCodes(), Object.keys(EXPLAIN_CODES).sort());
});

test('text output names the code and the four fields', async () => {
  const { code, stdout } = await run(['explain', 'DRIFT']);
  assert.equal(code, 0);
  const lines = stdout.split('\n');
  assert.equal(lines[0], 'code     drift');
  assert.ok(stdout.includes('Why: '), 'no Why line');
  assert.ok(stdout.includes('Fix: '), 'no Fix line');
  assert.ok(stdout.includes('Example: '), 'no Example line');
});

test('lookup is case-insensitive and folds underscores', async () => {
  for (const spelling of ['drift', 'Drift', 'BEYOND_READ_LIMIT']) {
    const { code, stdout } = await run(['explain', spelling]);
    assert.equal(code, 0, `${spelling} exited ${code}`);
    assert.match(stdout.split('\n')[0], /^code\s+[a-z0-9-]+$/);
  }
  const folded = await run(['explain', 'BEYOND_READ_LIMIT']);
  assert.match(folded.stdout.split('\n')[0], /beyond-read-limit/);
});

test('the drifted alias resolves to drift', async () => {
  assert.ok('drifted' in EXPLAIN_ALIASES);
  const { code, stdout } = await run(['explain', 'drifted']);
  assert.equal(code, 0);
  assert.match(stdout.split('\n')[0], /drift/);
});

test('an unknown code is a usage error that lists the known codes', async () => {
  const { code, stdout, stderr } = await run(['explain', 'NOPE']);
  assert.notEqual(code, 0);
  assert.match(`${stdout}${stderr}`, /unknown finding code `NOPE`/);
  assert.match(`${stdout}${stderr}`, /one of:.*drift/);
});

test('a missing code is a usage error', async () => {
  const { code, stdout, stderr } = await run(['explain']);
  assert.notEqual(code, 0);
  assert.match(`${stdout}${stderr}`, /needs a code/i);
});

test('--json answers in the shared envelope', async () => {
  const { code, stdout } = await run(['explain', 'unmanaged', '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'explain');
  assert.equal(payload.code, 'unmanaged');
  for (const field of ['what', 'why', 'fix', 'example']) {
    assert.equal(typeof payload[field], 'string', `JSON payload has no ${field}`);
  }
});

test('every code round-trips through the binary', async () => {
  for (const entry of listExplainCodes()) {
    const { code, stdout } = await run(['explain', entry]);
    assert.equal(code, 0, `${entry} exited ${code}`);
    assert.equal(stdout.split('\n')[0], `code     ${entry}`);
  }
});
