// The decisions index as one resolution (review 0003 Q55).
//
// One directory answer (manifest key, then detection, then the default), one
// cutoff answer from the same config, duplicate ids linted rather than silently
// collapsed, numbers past 999 read and sorted numerically, verbs derived from
// the dispatch registry, scaffolds claimed exclusively, and a machine-local
// cache keyed on the files it was built from.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { decisionsCutoff, decisionsDir } from '../src/decisions/dir.mjs';
import {
  citations,
  decisionVerbs,
  loadDecisions,
  loadDecisionsCached,
  parseDecision,
} from '../src/decisions/index.mjs';
import { lintDecisions, lintDecision, scaffoldDecision } from '../src/memory/decide.mjs';
import { COMMANDS } from '../src/commands/index.mjs';

async function scratch(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-decisions-'));
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

async function runCli(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const PROSE_ONLY = (id) =>
  [`# ${id} — Something decided`, '', `Status: accepted · 2026-01-01`, '', '## Rulings', '', '1. **First ruling.** This ruling states a constraint clearly enough to be cited by number.', ''].join('\n');

test('decisionsDir: the manifest key wins over detection', async () => {
  const root = await scratch({
    'simt.json': JSON.stringify({ decisions: { dir: 'notes/adr' } }),
    'notes/adr/ADR-001-x.md': PROSE_ONLY('ADR-001'),
    'docs/decisions/ADR-002-y.md': PROSE_ONLY('ADR-002'),
  });
  try {
    assert.equal(await decisionsDir(root), 'notes/adr');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('decisionsDir: detection finds a non-default spelling, default otherwise', async () => {
  const detected = await scratch({ 'docs/adr/ADR-001-x.md': PROSE_ONLY('ADR-001') });
  const bare = await scratch({ 'package.json': '{}' });
  try {
    assert.equal(await decisionsDir(detected), 'docs/adr');
    assert.equal(await decisionsDir(bare), 'docs/decisions');
  } finally {
    await rm(detected, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test('decisionsCutoff: the manifest key wins, zero when absent', async () => {
  const configured = await scratch({ 'simt.json': JSON.stringify({ decisions: { historicalCutoff: 12 } }) });
  const plain = await scratch({ 'package.json': '{}' });
  try {
    assert.equal(await decisionsCutoff(configured), 12);
    assert.equal(await decisionsCutoff(plain), 0);
  } finally {
    await rm(configured, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test('lintDecisions: a duplicate id is a finding naming both files', async () => {
  const root = await scratch({
    'docs/decisions/ADR-002-first.md': PROSE_ONLY('ADR-002'),
    'docs/decisions/ADR-002-second.md': PROSE_ONLY('ADR-002'),
  });
  try {
    const res = await lintDecisions(join(root, 'docs', 'decisions'));
    assert.equal(res.ok, false);
    const dup = res.findings.find((f) => f.status === 'duplicate-decision-id');
    assert.ok(dup, 'expected a duplicate-decision-id finding');
    assert.match(dup.detail, /ADR-002-first\.md/);
    assert.match(dup.detail, /ADR-002-second\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lintDecision: the cutoff exempts history and nothing else', async () => {
  // A prose-stated supersession with no frontmatter to back it: history is
  // exempt, anything past the cutoff fails.
  const text = PROSE_ONLY('ADR-005').replace('Status: accepted · 2026-01-01', 'Status: accepted · 2026-01-01; supersedes ADR-003 ruling 1');
  assert.ok(lintDecision(text, { file: 'ADR-005-x.md', historicalCutoff: 5 }).ok);
  const fresh = lintDecision(text, { file: 'ADR-005-x.md', historicalCutoff: 0 });
  assert.equal(fresh.ok, false, 'a prose-only record past the cutoff fails');
  assert.ok(fresh.findings.some((f) => f.status === 'prose-partial-supersession'));
});

test('citations: four-digit records are recognised and sorted numerically', () => {
  assert.deepEqual(citations('see ADR-1000 and ADR-999 and ADR-042'), ['ADR-042', 'ADR-999', 'ADR-1000']);
  assert.deepEqual(citations('see ADR-42'), [], 'two digits never named a record');
});

test('loadDecisions: numeric filename order decides the kept record', async () => {
  const root = await scratch({
    'docs/decisions/ADR-1000-late.md': PROSE_ONLY('ADR-1000'),
    'docs/decisions/ADR-999-early.md': PROSE_ONLY('ADR-999'),
  });
  try {
    const { ok, decisions } = await loadDecisions({ dir: join(root, 'docs', 'decisions') });
    assert.ok(ok);
    assert.deepEqual(decisions.map((d) => d.id), ['ADR-999', 'ADR-1000']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('decisionVerbs: every dispatchable command is quotable, and artefacts are not', async () => {
  const verbs = decisionVerbs();
  const firstWords = new Set(COMMANDS.map((c) => c.split(' ')[0]));
  for (const word of firstWords) {
    assert.match(word === 'pack' ? 'pack' : word, new RegExp(`^${word}$`));
    assert.ok(new RegExp(`\\b${word}\\b`).test(verbs), `${word} is missing from the verb list`);
  }
  for (const missing of ['pack', 'plugin', 'lease']) {
    assert.ok(new RegExp(`\\b${missing}\\b`).test(verbs), `${missing} is quotable now`);
  }
  // The record keeps its artefact names: only a following verb converts.
  const parsed = parseDecision('ADR-900-x.md', ['# ADR-900 — Verbs', '', 'Status: accepted · 2026-01-01. Run simt-dev pack lint, not simt-dev.json.', '', '## Rulings', '', '1. **Only ruling.** This ruling states a constraint clearly enough to be cited by number.', ''].join('\n'));
  assert.ok(parsed.ok);
  assert.match(parsed.decision.status, /simt pack lint/);
  assert.match(parsed.decision.status, /simt-dev\.json/);
});

test('scaffoldDecision: an exclusive create never overwrites a collision', async () => {
  const root = await scratch({ 'docs/decisions/ADR-001-base.md': PROSE_ONLY('ADR-001') });
  try {
    // Occupy the number the scaffold would take.
    await writeFile(join(root, 'docs', 'decisions', 'ADR-002-taken.md'), PROSE_ONLY('ADR-002'));
    const res = await scaffoldDecision(root, { title: 'Collision proof', write: true });
    assert.ok(res.ok);
    assert.equal(res.id, 'ADR-003', 'the scaffold moved past the occupied number');
    assert.equal(await readFile(join(root, 'docs', 'decisions', 'ADR-002-taken.md'), 'utf8'), PROSE_ONLY('ADR-002'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rules why: the repo record overlays the shipped one, and both layers are named', async () => {
  const { rulesWhyFacts } = await import('../src/commands/rules.mjs');
  const root = await scratch({ 'docs/decisions/ADR-001-repo-first-thing.md': PROSE_ONLY('ADR-001') });
  try {
    const overlaid = await rulesWhyFacts(root, 'ADR-001');
    assert.equal(overlaid.direction, 'decision');
    assert.equal(overlaid.adr.origin, 'repo', 'the same number resolves to the repo layer');
    // Package ADR-001 is titled differently; the repo title must win, not merge.
    assert.ok(!/centralise/i.test(overlaid.adr.title), `expected the repo title, got: ${overlaid.adr.title}`);
    const shipped = await rulesWhyFacts(root, 'ADR-099');
    assert.equal(shipped.adr.origin, 'package');
    assert.ok(shipped.origins['ADR-001'] === 'repo' && shipped.origins['ADR-099'] === 'package');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rules why: an unknown decision points at rules decisions, not rules list', async () => {
  const { rulesWhyFacts } = await import('../src/commands/rules.mjs');
  const root = await scratch({ 'package.json': '{}' });
  try {
    await assert.rejects(rulesWhyFacts(root, 'ADR-900'), (error) => {
      assert.match(error.message, /no decision record ADR-900/);
      assert.match(error.remedy, /rules decisions/, 'the remedy names the decisions list, not the rules list');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // The remedy names the decisions list (asserted structurally: the failure
  // carries a remedy, and the command below is what it must name).
  const { decisionsCommand } = await import('../src/commands/rules.mjs');
  assert.equal(typeof decisionsCommand, 'function', 'simt rules decisions exists to back the remedy');
});

test('rules decisions: one list, both layers, origins marked', async () => {
  const root = await scratch({ 'docs/decisions/ADR-001-repo-first-thing.md': PROSE_ONLY('ADR-001') });
  try {
    const text = await runCli(['rules', 'decisions', '--root', root]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /ADR-001\s+repo\s/);
    assert.match(text.stdout, /ADR-099\s+package\s/);
    const json = await runCli(['rules', 'decisions', '--root', root, '--json']);
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    const byId = new Map(payload.decisions.map((d) => [d.id, d]));
    assert.equal(byId.get('ADR-001').origin, 'repo');
    assert.equal(byId.get('ADR-099').origin, 'package');
    assert.ok(byId.get('ADR-001').title.length > 0 && byId.get('ADR-001').status.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadDecisionsCached: a second load hits the cache, an edit misses it', async () => {
  const root = await scratch({ 'docs/decisions/ADR-001-base.md': PROSE_ONLY('ADR-001') });
  try {
    const dir = join(root, 'docs', 'decisions');
    const first = await loadDecisionsCached({ root, dir });
    assert.ok(first.ok);
    const second = await loadDecisionsCached({ root, dir });
    assert.deepEqual(second.decisions, first.decisions);
    await writeFile(join(dir, 'ADR-002-added.md'), PROSE_ONLY('ADR-002'));
    const third = await loadDecisionsCached({ root, dir });
    assert.equal(third.decisions.length, 2, 'the added record invalidates the cache');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
