// Skill compiler, progressive-disclosure split plans, and per-skill trigger report (R30).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BODY_BYTE_BUDGET,
  BODY_LINE_BUDGET,
  BODY_TOKEN_BUDGET,
  BYTES_PER_TOKEN,
  buildConformingDescription,
  compileSkill,
  evaluateSkillTriggers,
  extractOpenedSkills,
  matchSkillsForPaths,
  planSkillSplit,
  proposeSkillDescription,
} from '../src/graph/compile.mjs';
import { loadRegistry } from '../src/graph/load.mjs';
import { checkSkill } from '../src/graph/spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt.mjs');
const exec = promisify(execFile);
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix = 'simt-compile-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('constants match the Agent Skills specification budgets (S44 / R30)', () => {
  assert.equal(BODY_TOKEN_BUDGET, 5000);
  assert.equal(BYTES_PER_TOKEN, 4);
  assert.equal(BODY_BYTE_BUDGET, 20000);
  assert.equal(BODY_LINE_BUDGET, 500);
});

test('compileSkill normalises frontmatter to Agent Skills standard and splits bodies over 5k tokens into references', () => {
  const shortDesc = buildConformingDescription(
    { name: 'd1-safe-change', summary: 'Safe D1 schema changes', paths: ['migrations/**'], keywords: ['d1', 'sql'] },
    'Too short',
  );
  assert.ok(shortDesc.length >= 30 && shortDesc.length <= 1024);
  assert.match(shortDesc, /Use when touching migrations\/\*\*/);

  const sectionBody = (title, idx) =>
    `## ${title}\n\n${Array.from({ length: 80 }, (_, line) => `Paragraph ${idx}.${line}: detailed reference guidance for ${title} with concrete steps and constraints.`).join('\n')}\n`;

  const largeRaw = [
    '---',
    'name: d1-safe-change',
    'description: Short.',
    'custom-vendor-field: keep-in-metadata',
    '---',
    '',
    '# D1 Safe Change',
    '',
    'Overview of safe D1 migrations.',
    '',
    sectionBody('Quick Start Checklist', 1),
    sectionBody('Rollout Verification', 2),
    sectionBody('Rollback Procedure', 3),
    sectionBody('Foreign Key Pitfalls', 4),
    sectionBody('Index Backfill Strategy', 5),
  ].join('\n');

  assert.ok(Buffer.byteLength(largeRaw, 'utf8') > BODY_BYTE_BUDGET, 'fixture must exceed 20 KB / 5k tokens');

  const compiled = compileSkill(
    {
      name: 'd1-safe-change',
      summary: 'Safe D1 schema changes and migration rollouts',
      paths: ['migrations/**', 'src/db/**'],
      keywords: ['d1', 'migration', 'schema'],
      capabilities: ['persistence'],
      bytes: Buffer.byteLength(largeRaw, 'utf8'),
    },
    largeRaw,
  );

  assert.equal(compiled.splitPlan.flagged, true);
  assert.ok(compiled.mainTokens <= BODY_TOKEN_BUDGET, `compiled SKILL.md must be <= 5000 tokens, got ${compiled.mainTokens}`);
  assert.ok(compiled.references.length >= 3, `expected reference split files, got ${compiled.references.length}`);
  assert.match(compiled.mainText, /## References/);
  assert.match(compiled.mainText, /custom-vendor-field: "keep-in-metadata"/);

  const check = checkSkill({
    directoryName: 'd1-safe-change',
    fileName: 'SKILL.md',
    text: compiled.mainText,
    at: 'd1-safe-change',
  });
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.warnings, []);
});

test('every registry skill over 5k tokens is flagged with a deterministic split plan', async () => {
  const { registry } = await loadRegistry();
  const over5k = registry.skills.filter((s) => Math.ceil(s.bytes / BYTES_PER_TOKEN) > BODY_TOKEN_BUDGET);
  // Derived, not hardcoded: a fixed count is a second place to update every time a
  // node is added or removed, and the loop below is the invariant this test owns.
  assert.ok(over5k.length > 0, 'the registry must have at least one skill over the body budget');

  for (const skill of over5k) {
    const plan = planSkillSplit(skill, null);
    assert.equal(plan.flagged, true, `${skill.name} (${skill.bytes} B) must be flagged`);
    assert.ok(plan.mainTokens <= BODY_TOKEN_BUDGET);
    assert.ok(plan.references.length >= 1, `${skill.name} must have at least 1 planned reference file`);
  }

  const under5k = registry.skills.find((s) => Math.ceil(s.bytes / BYTES_PER_TOKEN) <= BODY_TOKEN_BUDGET);
  assert.ok(under5k);
  assert.equal(planSkillSplit(under5k, null).flagged, false);
});

test('extractOpenedSkills, matchSkillsForPaths, and evaluateSkillTriggers compute per-skill recall and precision', () => {
  const registry = {
    skills: [
      {
        name: 'd1-safe-change',
        summary: 'Safe D1 migrations',
        bytes: 3534,
        paths: ['migrations/**', 'wrangler.jsonc'],
        keywords: ['d1'],
        capabilities: ['persistence'],
      },
      {
        name: 'cloudflare',
        summary: 'Cloudflare platform reference',
        bytes: 384869,
        paths: ['wrangler.jsonc', 'wrangler.toml'],
        keywords: ['workers'],
        capabilities: ['platform'],
      },
      {
        name: 'slice-commit',
        summary: 'Commit a completed slice',
        bytes: 5048,
        paths: ['docs/plans/**'],
        keywords: ['commit'],
        capabilities: ['commit'],
      },
    ],
  };

  assert.deepEqual(matchSkillsForPaths(registry.skills, ['migrations/0001_init.sql']), ['d1-safe-change']);
  assert.deepEqual(matchSkillsForPaths(registry.skills, ['wrangler.jsonc']), ['cloudflare', 'd1-safe-change']);

  const transcript = [
    JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '.agents/skills/d1-safe-change/SKILL.md' },
    }),
    '$ simt skills show slice-commit',
    JSON.stringify({
      type: 'mcp_tool_call',
      name: 'skills_show',
      arguments: { name: 'cloudflare' },
    }),
  ].join('\n');

  assert.deepEqual(
    extractOpenedSkills(transcript, ['d1-safe-change', 'cloudflare', 'slice-commit']),
    ['cloudflare', 'd1-safe-change', 'slice-commit'],
  );

  const runs = [
    {
      task: 't-1',
      arm: 'current',
      goldFiles: ['migrations/0001_init.sql'],
      transcript: 'Read .agents/skills/d1-safe-change/SKILL.md and ran simt skills show slice-commit',
    },
    {
      task: 't-2',
      arm: 'current',
      goldFiles: ['migrations/0002_idx.sql', 'wrangler.jsonc'],
      transcript: 'Read .agents/skills/d1-safe-change/SKILL.md',
    },
  ];

  const report = evaluateSkillTriggers(registry, runs);
  assert.equal(report.runCount, 2);
  assert.equal(report.flaggedCount, 1);

  const byName = new Map(report.skills.map((s) => [s.name, s]));
  // d1-safe-change: expected in t-1 and t-2 (2), opened in t-1 and t-2 (2) -> recall=1.0, precision=1.0
  assert.equal(byName.get('d1-safe-change').expected, 2);
  assert.equal(byName.get('d1-safe-change').opened, 2);
  assert.equal(byName.get('d1-safe-change').recall, 1);
  assert.equal(byName.get('d1-safe-change').precision, 1);
  assert.equal(byName.get('d1-safe-change').flagged, false);

  // cloudflare: expected in t-2 (1), opened in neither (0) -> recall=0.0, precision=null, flagged=true
  assert.equal(byName.get('cloudflare').expected, 1);
  assert.equal(byName.get('cloudflare').opened, 0);
  assert.equal(byName.get('cloudflare').recall, 0);
  assert.equal(byName.get('cloudflare').precision, null);
  assert.equal(byName.get('cloudflare').flagged, true);
  assert.ok(byName.get('cloudflare').splitPlan.references.length > 0);

  // slice-commit: expected in neither (0), opened in t-1 (1) -> recall=null, precision=0.0
  assert.equal(byName.get('slice-commit').expected, 0);
  assert.equal(byName.get('slice-commit').opened, 1);
  assert.equal(byName.get('slice-commit').recall, null);
  assert.equal(byName.get('slice-commit').precision, 0);
});

test('proposeSkillDescription records model, promptHash and digest provenance without touching registry', async () => {
  const skill = {
    name: 'd1-safe-change',
    summary: 'Apply safe D1 schema migrations',
    paths: ['migrations/**'],
    keywords: ['d1', 'migration'],
    capabilities: ['persistence'],
  };

  const proposal = await proposeSkillDescription(skill, {
    currentDescription: 'Apply safe D1 schema migrations.',
    triggerStats: { expected: 4, opened: 2, recall: 0.5, precision: 1.0 },
    proposer: async ({ prompt }) => {
      assert.match(prompt, /recall=0\.5/);
      return {
        model: 'local-qwen-coder',
        description:
          'Apply safe Cloudflare D1 schema migrations and verify rollbacks. Use when touching migrations/** or working with d1, migration.',
      };
    },
  });

  assert.equal(proposal.status, 'proposal');
  assert.equal(proposal.skill, 'd1-safe-change');
  assert.equal(proposal.provenance.model, 'local-qwen-coder');
  assert.match(proposal.provenance.promptHash, /^sha256-[0-9a-f]{16}$/);
  assert.match(proposal.provenance.digest, /^sha256-[0-9a-f]{16}$/);
  assert.match(proposal.proposedDescription, /Use when touching migrations\/\*\*/);
});

test('CLI `simt skills compile` reports triggers + split plans, and writes compiled artifacts only with --yes', async () => {
  const root = await scratch();
  const runsDir = join(root, '.simt', 'local', 'bench', 'runs', 'claude-current-r1');
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    join(runsDir, 't-01.json'),
    JSON.stringify({
      schemaVersion: 1,
      task: 't-01',
      arm: 'current',
      harness: 'claude',
      model: 'sonnet',
      rep: 1,
      resolved: true,
      gatesPassed: true,
      usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 50, turns: 2, toolCalls: 1 },
      costUsd: 0.01,
      diff: { files: 1, outsideBlastRadius: 0 },
      skills: { expected: ['cloudflare', 'wrangler'], opened: ['wrangler'] },
      probe: null,
    }),
    'utf8',
  );

  const reportRes = await runCli(['skills', 'compile', '--root', root, '--json']);
  assert.equal(reportRes.code, 0, reportRes.stderr);
  const payload = JSON.parse(reportRes.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.runCount, 1);
  const { registry } = await loadRegistry();
  const expectedFlagged = registry.skills.filter(
    (s) => Math.ceil(s.bytes / BYTES_PER_TOKEN) > BODY_TOKEN_BUDGET,
  ).length;
  assert.equal(payload.flaggedCount, expectedFlagged);
  const wr = payload.skills.find((s) => s.name === 'wrangler');
  assert.equal(wr.recall, 1);
  assert.equal(wr.precision, 1);
  const cf = payload.skills.find((s) => s.name === 'cloudflare');
  assert.equal(cf.recall, 0);
  assert.equal(cf.flagged, true);

  // Preview mode writes nothing without --yes
  const previewRes = await runCli(['skills', 'compile', 'cloudflare', '--root', root]);
  assert.equal(previewRes.code, 0, previewRes.stderr);
  assert.match(previewRes.stdout, /flagged/);
  assert.equal(existsSync(join(root, '.simt', 'local', 'compiled')), false);

  // Apply mode writes SKILL.md and proposal JSON
  const applyRes = await runCli(['skills', 'compile', 'cloudflare', '--root', root, '--yes', '--json']);
  assert.equal(applyRes.code, 0, applyRes.stderr);
  const appliedPayload = JSON.parse(applyRes.stdout);
  assert.equal(appliedPayload.written, true);
  assert.equal(existsSync(join(root, '.simt', 'local', 'compiled', 'skills', 'cloudflare', 'SKILL.md')), true);
  assert.equal(existsSync(join(root, '.simt', 'local', 'proposals', 'skills', 'cloudflare.json')), true);
});
