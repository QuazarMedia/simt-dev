// simt compare - workspace discovery and matrix rows.
//
// The fixture repos here are synthetic and minimal, because the properties worth
// testing are properties of the ALGORITHM: how a `.git` file is classified, what
// happens when a manifest is broken, which conditions produce a problem line. A
// test that copies a real repo would pass for the wrong reason whenever the real
// repo happens to be healthy.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { plan } from '../src/projection/project.mjs';

import { classify, discover, ownerFromGitdir, parseGitdirPointer, slugMatchesDir } from '../src/compare/discover.mjs';
import { buildRow, buildRows, resolveConcurrency, summarise } from '../src/compare/row.mjs';
import { mapCapped } from '../src/compare/parallel.mjs';
import { readHooksState } from '../src/compare/hooksstate.mjs';
import { classifyGateCommand, classifyRuleViolations, clearLearningCache, learnAcrossEstate, renderAdrDraft, renderLearningLines } from '../src/compare/learn.mjs';
import { GATES } from '../src/hooks/gates.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, cmd, tempDir, keepTemp } from './fixture.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');

const exec = promisify(execFile);

/** Run a command for its --json payload. */
async function json(args) {
  const { stdout } = await exec(process.execPath, [BIN, ...args, '--json'], { maxBuffer: 16 << 20 });
  return JSON.parse(stdout);
}

/**
 * The same, for a command that is expected to fail.
 *
 * `json` rejects on a non-zero exit, which is right for every other caller here and
 * useless for the one question this file has to ask: what does the gate say about a
 * repository whose gate is red. A helper that cannot read a failing command's output
 * is a helper that can only ever compare two green things.
 */
async function failingJson(args) {
  try {
    const { stdout } = await exec(process.execPath, [BIN, ...args, '--json'], { maxBuffer: 16 << 20 });
    return { code: 0, payload: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code ?? 1, payload: JSON.parse(error.stdout) };
  }
}

/**
 * A git repo with a real HEAD, because every command under test shells out to git.
 * `into` places it inside an existing workspace, which is what the discovery tests
 * need - each repo must be a sibling of the others, not in its own temp root.
 */
async function gitRepo(name, files = {}, into = null) {
  const parent = into ?? (await mkdtemp(join(tmpdir(), 'simt-compare-')));
  const root = join(parent, name);
  keepTemp(root);
  await mkdir(root, { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  if (Object.keys(files).length > 0) {
    await exec('git', ['add', '-A'], { cwd: root });
    await git(['commit', '-qm', 'seed'], { cwd: root });
  }
  return root;
}

/** Rebuild a minimal row so summarise() can be compared against the JSON shape. */
function rowsOf(payload) {
  return payload.rows.map((r) => ({
    adoption: r.adoption,
    region: r.region,
    pinnedSha: r.pinnedSha,
    hooksRouted: r.hooksRouted,
    foreignHooks: r.foreignHooks,
    problems: r.problems,
  }));
}

async function scratch() {
  const root = await tempDir('simt-compare-ws-');
  keepTemp(root);
  return root;
}

/**
 * Put a real generated region in place, the way a repo that has run
 * `simt init && simt sync` would look. Returns the SHA it was stamped with, so a
 * test can assert on a mismatch against a specific version rather than whatever
 * HEAD happens to be.
 */
async function adopt(root) {
  const { targets } = await plan(root);
  await writeFile(targets[0].path, targets[0].text);
  return { sha: targets[0].sha };
}

const CONTEXT = {
  expectedSha: 'aaaaaaa',
  gates: new Set(Object.keys(GATES)),
  gateKinds: new Map(Object.entries(GATES).map(([n, g]) => [n, g.kind])),
};

// --- discovery -------------------------------------------------------------

test('R36: classifyGateCommand and classifyRuleViolations map commands and hook denials deterministically', () => {
  assert.deepEqual(classifyGateCommand('npm run --silent lint'), { gate: 'lint', adr: 'ADR-004' });
  assert.deepEqual(classifyGateCommand('node --test test/unit.test.mjs'), { gate: 'test', adr: 'ADR-003' });
  assert.deepEqual(classifyGateCommand('cargo test --workspace'), { gate: 'test', adr: 'ADR-003' });
  assert.deepEqual(
    classifyGateCommand('scripts/check-mem.sh', { gates: { commands: { memory: 'scripts/check-mem.sh' } } }),
    { gate: 'memory', adr: 'ADR-003' },
  );

  const pushHit = classifyRuleViolations({
    kind: 'hook-denial',
    errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
    keywords: ['push'],
  });
  assert.deepEqual(pushHit, [{ rule: 'push', adr: 'ADR-001', kind: 'policy' }]);

  const reviewHit = classifyRuleViolations({
    kind: 'review-block',
    errorLine: 'BLOCK: refactored outside the blast radius (ADR-002)',
    keywords: ['blast'],
  });
  assert.deepEqual(reviewHit, [{ rule: 'ADR-002', adr: 'ADR-002', kind: 'adr' }]);
});

test('R36: compare aggregates ledgers, hook denials, and zero-value rules across a workspace into byte-identical ADR drafts', async () => {
  const ws = await scratch();
  const repoA = await gitRepo('alpha', { 'README.md': 'a\n' }, ws);
  const repoB = await gitRepo('beta', { 'README.md': 'b\n' }, ws);

  await mkdir(join(repoA, '.simt', 'bench', 'runs'), { recursive: true });
  await mkdir(join(repoB, '.simt', 'bench', 'runs'), { recursive: true });

  // Ledger entries for alpha and beta: test fails repeatedly and is slow, lint is fast and passes.
  const alphaLedger = [
    {
      v: 1,
      ts: '2026-10-19T10:00:00Z',
      tree: '1111111111111111111111111111111111111111',
      cmd: 'npm run --silent test',
      exit: 1,
      ms: 2400,
      outputDigest: 'sha256-aaa',
      summary: '0 pass, 1 fail',
      errorLine: 'not ok 1 - suite failed',
      signature: 'sha256-111',
    },
    {
      v: 1,
      ts: '2026-10-19T10:01:00Z',
      tree: '2222222222222222222222222222222222222222',
      cmd: 'npm run --silent lint',
      exit: 0,
      ms: 120,
      outputDigest: 'sha256-bbb',
      summary: 'exit 0',
    },
  ];
  const betaLedger = [
    {
      v: 1,
      ts: '2026-10-19T11:00:00Z',
      tree: '3333333333333333333333333333333333333333',
      cmd: 'npm run --silent test',
      exit: 1,
      ms: 3100,
      outputDigest: 'sha256-ccc',
      summary: '0 pass, 2 fail',
      errorLine: 'not ok 1 - suite failed',
      signature: 'sha256-111',
    },
    {
      v: 1,
      ts: '2026-10-19T11:05:00Z',
      tree: '4444444444444444444444444444444444444444',
      cmd: 'npm run --silent typecheck',
      exit: 0,
      ms: 1850,
      outputDigest: 'sha256-ddd',
      summary: 'exit 0',
    },
  ];

  await writeFile(join(repoA, '.simt', 'ledger.jsonl'), `${alphaLedger.map((x) => JSON.stringify(x)).join('\n')}\n`);
  await writeFile(join(repoB, '.simt', 'ledger.jsonl'), `${betaLedger.map((x) => JSON.stringify(x)).join('\n')}\n`);

  // Hook denials and review-block candidates across alpha and beta.
  const alphaLessons = [
    {
      v: 1,
      id: 'c-0001',
      ts: '2026-10-19T10:02:00Z',
      kind: 'hook-denial',
      signature: 'sha256-push',
      errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
      summary: 'Push needs explicit approval (ADR-001); ask the user.',
      cmd: 'git push origin main',
      paths: [],
      keywords: ['push'],
      evidence: ['git push origin main'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
    {
      v: 1,
      id: 'c-0002',
      ts: '2026-10-19T10:03:00Z',
      kind: 'hook-denial',
      signature: 'sha256-rewrite',
      errorLine: 'Never amend, rebase, reset --hard, force-push or --no-verify unless asked (ADR-017).',
      summary: 'Never amend, rebase, reset --hard, force-push or --no-verify unless asked (ADR-017).',
      cmd: 'git commit --no-verify -m x',
      paths: [],
      keywords: ['rewrite'],
      evidence: ['git commit --no-verify -m x'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
  ];
  const betaLessons = [
    {
      v: 1,
      id: 'c-0001',
      ts: '2026-10-19T11:02:00Z',
      kind: 'hook-denial',
      signature: 'sha256-push',
      errorLine: 'Push needs explicit approval (ADR-001); ask the user.',
      summary: 'Push needs explicit approval (ADR-001); ask the user.',
      cmd: 'git push',
      paths: [],
      keywords: ['push'],
      evidence: ['git push'],
      fixDiff: '',
      status: 'candidate',
      promotedTo: null,
    },
  ];

  await writeFile(join(repoA, '.simt', 'lessons.jsonl'), `${alphaLessons.map((x) => JSON.stringify(x)).join('\n')}\n`);
  await writeFile(join(repoB, '.simt', 'lessons.jsonl'), `${betaLessons.map((x) => JSON.stringify(x)).join('\n')}\n`);

  // Ablation run records in alpha showing `core:style` has dR = 0 and dC > 0 (`current` costs more than `no-core-style`).
  const benchRecords = [
    {
      task: 't-01',
      arm: 'no-core-style',
      rep: 1,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      resolved: true,
      gatesPassed: true,
      costUsd: 0.01,
      usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 200 },
    },
    {
      task: 't-01',
      arm: 'current',
      rep: 1,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      resolved: true,
      gatesPassed: true,
      costUsd: 0.04,
      usage: { input: 4000, cacheRead: 0, cacheWrite: 0, output: 200 },
    },
  ];
  await writeFile(join(repoA, '.simt', 'bench', 'runs', 'r-01.json'), `${JSON.stringify(benchRecords[0])}\n`);
  await writeFile(join(repoA, '.simt', 'bench', 'runs', 'r-02.json'), `${JSON.stringify(benchRecords[1])}\n`);

  // Run `compare` twice (both JSON and text) and assert byte-identical output and expected rankings.
  const firstJson = await exec(process.execPath, [BIN, 'compare', '--root', ws, '--json'], { maxBuffer: 16 << 20 });
  const secondJson = await exec(process.execPath, [BIN, 'compare', '--root', ws, '--json'], { maxBuffer: 16 << 20 });
  assert.equal(firstJson.stdout, secondJson.stdout, 'compare --json must be byte-identical across runs on the same ledgers');

  const firstText = await exec(process.execPath, [BIN, 'compare', '--root', ws], { maxBuffer: 16 << 20 });
  const secondText = await exec(process.execPath, [BIN, 'compare', '--root', ws], { maxBuffer: 16 << 20 });
  assert.equal(firstText.stdout, secondText.stdout, 'compare text report must be byte-identical across runs on the same ledgers');

  const payload = JSON.parse(firstJson.stdout);
  const { learning } = payload;
  assert.ok(learning, 'compare --json must include learning block');
  assert.equal(learning.reposWithLedgers, 2);
  assert.equal(learning.reposWithDenials, 2);
  assert.equal(learning.totalLedgerRuns, 4);
  assert.equal(learning.totalHookDenials, 3);

  // Most-violated rules: push (2 across alpha, beta) then rewrite (1 in alpha).
  assert.equal(learning.mostViolatedRules.length, 2);
  assert.equal(learning.mostViolatedRules[0].rule, 'push');
  assert.equal(learning.mostViolatedRules[0].adr, 'ADR-001');
  assert.equal(learning.mostViolatedRules[0].count, 2);
  assert.deepEqual(learning.mostViolatedRules[0].repos, ['alpha', 'beta']);
  assert.equal(learning.mostViolatedRules[1].rule, 'rewrite');
  assert.equal(learning.mostViolatedRules[1].count, 1);

  // Most-failing gates: test (2/2 failed).
  assert.equal(learning.mostFailingGates.length, 1);
  assert.equal(learning.mostFailingGates[0].gate, 'test');
  assert.equal(learning.mostFailingGates[0].failures, 2);
  assert.equal(learning.mostFailingGates[0].runs, 2);
  assert.equal(learning.mostFailingGates[0].failRate, 1);

  // Slowest gates: test (p95 3100ms), typecheck (p95 1850ms), lint (p95 120ms).
  assert.deepEqual(
    learning.slowestGates.map((g) => g.gate),
    ['test', 'typecheck', 'lint'],
  );

  // Rules with no measured value: core:style (dR = 0, dC > 0).
  assert.equal(learning.noValueRules.length, 1);
  assert.equal(learning.noValueRules[0].sectionId, 'core:style');
  assert.equal(learning.noValueRules[0].dR, 0);
  assert.ok(learning.noValueRules[0].dC > 0);

  // ADR drafts generated for violated rules, failing gate, slow gate (typecheck >= 1000ms), and no-value rule.
  const categories = learning.adrDrafts.map((d) => `${d.category}:${d.target}`);
  assert.deepEqual(categories, [
    'violated-rule:push',
    'violated-rule:rewrite',
    'failing-gate:test',
    'slow-gate:typecheck',
    'no-value-rule:core:style',
  ]);
  for (const draft of learning.adrDrafts) {
    assert.match(draft.markdown, /^---\nsimt-affects:/);
    assert.match(draft.markdown, /Status: draft/);
    assert.match(draft.markdown, /## Rulings/);
  }

  // Text output includes the learning summary and draft lines.
  assert.match(firstText.stdout, /learning\s+4 ledger run\(s\) across 2 repo\(s\), 3 hook denial\(s\) across 2 repo\(s\), 5 ADR draft\(s\)/);
  assert.match(firstText.stdout, /violated\s+push \(ADR-001\)\s+count=2\s+repos=alpha,beta/);
  assert.match(firstText.stdout, /failing\s+test \(ADR-003\)\s+failures=2\/2 \(100%\)/);
  assert.match(firstText.stdout, /novalue\s+core:style\s+dR=0/);
  assert.match(firstText.stdout, /draft\s+ADR-DRAFT-001\s+\[violated-rule\]/);

  // Direct call with reversed repo order produces the exact same structure and markdown.
  const learnForward = await learnAcrossEstate([repoA, repoB]);
  const learnReverse = await learnAcrossEstate([repoB, repoA]);
  assert.deepEqual(learnForward, learnReverse);
  assert.ok(renderAdrDraft({ draftId: 'ADR-DRAFT-001', category: 'test', title: 'T', context: 'C', rulings: ['R'] }).includes('Status: draft'));
  assert.ok(renderLearningLines(learnForward, { force: true }).some((l) => l.includes('Status: draft')));
});

// Q50: the ablation file must be found at the writer's machine-local path and at the
// legacy `.simt/bench/ablation.json` (the old fallback `.simt/ablation.json` was never
// written), and the no-value ADR drafts must cite section ids, not rule paths that only
// resolve in simt-dev.
test('Q50: compare reads ablation from the local and legacy bench paths, and no-value drafts cite section ids', async () => {
  const ws = await scratch();
  const repoLegacy = await gitRepo('legacy', { 'README.md': 'l\n' }, ws);
  const repoLocal = await gitRepo('local', { 'README.md': 'm\n' }, ws);

  // Pre-Q19 location: the writer's path before the move to machine-local state.
  await mkdir(join(repoLegacy, '.simt', 'bench'), { recursive: true });
  await writeFile(
    join(repoLegacy, '.simt', 'bench', 'ablation.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sections: [{ sectionId: 'core:legacy-section', dR: 0, dC: 0.03, measured: true, deletionCandidate: true, tasks: 8 }],
      },
      null,
      2,
    )}\n`,
  );

  // Current writer location.
  await mkdir(join(repoLocal, '.simt', 'local', 'bench'), { recursive: true });
  await writeFile(
    join(repoLocal, '.simt', 'local', 'bench', 'ablation.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sections: [
          { sectionId: 'process:intake-questions', dR: -0.01, dC: 0.01, measured: true, deletionCandidate: true, tasks: 6 },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const out = await exec(process.execPath, [BIN, 'compare', '--root', ws, '--json'], { maxBuffer: 16 << 20 });
  const { learning } = JSON.parse(out.stdout);

  // One section per path: the legacy file must be read, not skipped for `.simt/ablation.json`.
  assert.deepEqual(learning.noValueRules.map((s) => s.sectionId).sort(), [
    'core:legacy-section',
    'process:intake-questions',
  ]);

  const noValueDrafts = learning.adrDrafts.filter((d) => d.category === 'no-value-rule');
  assert.equal(noValueDrafts.length, 2);
  const byTarget = new Map(noValueDrafts.map((d) => [d.target, d]));
  assert.match(byTarget.get('core:legacy-section').markdown, /simt-affects: \["core:legacy-section"\]/);
  assert.match(byTarget.get('process:intake-questions').markdown, /simt-affects: \["process:intake-questions"\]/);
  for (const draft of noValueDrafts) {
    assert.doesNotMatch(draft.markdown, /rules\//, 'no-value drafts must cite section ids, not simt-dev rule paths');
  }
});
