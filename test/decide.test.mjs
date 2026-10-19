// Decision assistant (plan 0003 R34): `simt decide` scaffolds an ADR with the
// next free number, Status: line, rulings skeleton, and structured `simt-affects`
// + `simt-supersedes` frontmatter; `rules why` and `why` read frontmatter first;
// lint fails on partial supersession stated only in prose.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  diffAffectedPaths,
  lintDecision,
  lintDecisions,
  nextDecisionNumber,
  parseDecisionFrontmatter,
  parseSupersedesSpec,
  scaffoldDecision,
} from '../src/memory/decide.mjs';
import { byId, DECISIONS_DIR, loadDecisions, parseDecision } from '../src/decisions/index.mjs';
import { affectsTokens } from '../src/index/govern.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

function git(args, options = {}) {
  return exec(
    'git',
    [
      '-c',
      'user.name=simt-dev tests',
      '-c',
      'user.email=tests@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { maxBuffer: 16 << 20, ...options },
  );
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('R34: nextDecisionNumber and diffAffectedPaths compute next free ADR and diff paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simt-decide-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(['init', '-q', '.'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha.mjs'), 'export const a = 1;\n');
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-001-initial.md'),
    [
      '# ADR-001 — Initial decision',
      '',
      'Status: accepted · 2026-10-19',
      '',
      '## Rulings',
      '',
      '1. **First ruling.** Every initial decision must have a clear first ruling that is over forty chars.',
      '',
      '2. **Second ruling.** Every initial decision must also have a clear second ruling that is over forty chars.',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });

  // Modify src/alpha.mjs and stage src/beta.mjs so diffAffectedPaths sees both.
  await writeFile(join(root, 'src', 'alpha.mjs'), 'export const a = 2;\n');
  await writeFile(join(root, 'src', 'beta.mjs'), 'export const b = 1;\n');
  await git(['add', 'src/beta.mjs'], { cwd: root });

  const next = await nextDecisionNumber(join(root, 'docs', 'decisions'));
  assert.deepEqual(next, { number: 2, id: 'ADR-002' });

  const pkgNext = await nextDecisionNumber(DECISIONS_DIR);
  assert.ok(pkgNext.number >= 97, `expected next ADR in package >= 97, got ${pkgNext.number}`);

  const affected = await diffAffectedPaths(root);
  assert.deepEqual(affected, ['src/alpha.mjs', 'src/beta.mjs']);
});

test('R34: scaffoldDecision and simt decide generate an ADR that parses with full supersession data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'simt-decide-scaffold-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await git(['init', '-q', '.'], { cwd: root });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await writeFile(join(root, 'src', 'engine.mjs'), 'export const v = 1;\n');
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-001-base-policy.md'),
    [
      '# ADR-001 — Base policy',
      '',
      'Status: accepted · 2026-10-10',
      '',
      '## Rulings',
      '',
      '1. **Keep the first rule.** The first rule remains in force across every consumer repository.',
      '',
      '2. **Keep the second rule.** The second rule used to require manual status prose edits in place.',
      '',
      '3. **Keep the third rule.** The third rule covers fallback behaviour when no manifest exists.',
      '',
    ].join('\n'),
  );
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  // Edit src/engine.mjs so simt-affects picks it up from the diff.
  await writeFile(join(root, 'src', 'engine.mjs'), 'export const v = 2;\n');

  // Preview without --yes writes nothing.
  const preview = await runCli([
    'decide',
    'Structured supersession frontmatter',
    '--supersedes',
    'ADR-001:2',
    '--supersedes',
    'ADR-001:3:narrowed',
    '--root',
    root,
  ]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /ADR-002/);
  assert.match(preview.stdout, /simt-affects: \["src\/engine\.mjs"\]/);
  assert.match(
    preview.stdout,
    /simt-supersedes: \[\{ adr: "ADR-001", ruling: 2 \}, \{ adr: "ADR-001", ruling: 3, kind: "narrowed" \}\]/,
  );
  assert.match(preview.stdout, /would write/);

  // Apply with --yes writes docs/decisions/ADR-002-structured-supersession-frontmatter.md.
  const applied = await runCli([
    'decide',
    'Structured supersession frontmatter',
    '--supersedes',
    'ADR-001:2',
    '--supersedes',
    'ADR-001:3:narrowed',
    '--root',
    root,
    '--yes',
    '--json',
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  const payload = JSON.parse(applied.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, 'ADR-002');
  assert.equal(payload.written, true);
  assert.deepEqual(payload.affects, ['src/engine.mjs']);
  assert.deepEqual(payload.supersedes, [
    { adr: 'ADR-001', ruling: 2, kind: 'superseded' },
    { adr: 'ADR-001', ruling: 3, kind: 'narrowed' },
  ]);

  const generatedText = await readFile(join(root, payload.path), 'utf8');
  const singleParsed = parseDecision(payload.file, generatedText);
  assert.equal(singleParsed.ok, true);
  assert.equal(singleParsed.decision.id, 'ADR-002');
  assert.equal(singleParsed.decision.accepted, true);
  assert.deepEqual(singleParsed.decision.affects, ['src/engine.mjs']);
  assert.deepEqual(singleParsed.decision.supersedesRulings, [
    { adr: 'ADR-001', ruling: 2, kind: 'superseded' },
    { adr: 'ADR-001', ruling: 3, kind: 'narrowed' },
  ]);
  assert.deepEqual(singleParsed.decision.summary.rulingNumbers, [1, 2]);
  assert.equal(singleParsed.decision.summary.rulingCount, 2);

  // Load both decisions: ADR-001's partial supersession is populated from ADR-002's
  // frontmatter without editing ADR-001's Status line in place.
  const { ok, decisions, errors } = await loadDecisions({ dir: join(root, 'docs', 'decisions') });
  assert.equal(ok, true, errors.join(', '));
  const index = byId(decisions);
  const adr1 = index.get('ADR-001');
  assert.deepEqual(adr1.partial, [
    { ruling: 3, kind: 'narrowed', by: 'ADR-002' },
    { ruling: 2, kind: 'superseded', by: 'ADR-002' },
  ]);
  assert.match(adr1.summary.ruled[1], /\(superseded by ADR-002\)$/);

  // `simt rules why ADR-001 --root <root>` reads the frontmatter supersession and
  // reports both the annotated ruling and the partial line.
  const why1 = await runCli(['rules', 'why', 'ADR-001', '--root', root]);
  assert.equal(why1.code, 0, why1.stderr);
  assert.match(why1.stdout, /ruling 2 superseded by ADR-002/);
  assert.match(why1.stdout, /ruling 3 narrowed by ADR-002/);
  assert.match(why1.stdout, /\(superseded by ADR-002\)/);

  // `simt rules why ADR-002 --root <root>` shows what ADR-002 supersedes.
  const why2 = await runCli(['rules', 'why', 'ADR-002', '--root', root]);
  assert.equal(why2.code, 0, why2.stderr);
  assert.match(why2.stdout, /supersedes\s+ADR-001 ruling 2 \(superseded\); ADR-001 ruling 3 \(narrowed\)/);

  // `affectsTokens` and `simt why src/engine.mjs` read `simt-affects:` frontmatter first.
  assert.deepEqual(affectsTokens(generatedText), ['src/engine.mjs']);
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'add adr-002'], { cwd: root });
  const govWhy = await runCli(['why', 'src/engine.mjs', '--root', root]);
  assert.equal(govWhy.code, 0, govWhy.stderr);
  assert.match(govWhy.stdout, /decision\s+ADR-002\s+Structured supersession frontmatter/);
});

test('R34: lint fails on partial supersession stated only in prose and passes when declared in frontmatter', async (t) => {
  // 1. Scaffolded ADR with structured frontmatter passes lint.
  const root = await mkdtemp(join(tmpdir(), 'simt-decide-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scaffolded = await scaffoldDecision(root, {
    title: 'Replace ruling two',
    affects: ['src/decisions/index.mjs'],
    supersedes: [{ adr: 'ADR-023', ruling: 2, kind: 'superseded' }],
    write: true,
  });
  assert.equal(scaffolded.ok, true);
  const cleanLint = lintDecision(scaffolded.text, { file: scaffolded.file });
  assert.equal(cleanLint.ok, true);
  assert.deepEqual(cleanLint.findings, []);

  // 2. Passive partial supersession in Status prose without frontmatter fails lint.
  const passiveProseOnly = [
    '# ADR-098 — Legacy style partial supersession',
    '',
    'Status: accepted · 2026-10-19 · ruling 2 superseded by ADR-099',
    '',
    '## Rulings',
    '',
    '1. **First ruling.** The first ruling stands in every repository.',
    '',
    '2. **Second ruling.** The second ruling was overturned in prose only.',
    '',
  ].join('\n');
  const passiveRes = lintDecision(passiveProseOnly, { file: 'ADR-098-legacy.md' });
  assert.equal(passiveRes.ok, false);
  assert.equal(passiveRes.findings.length, 1);
  assert.equal(passiveRes.findings[0].status, 'prose-partial-supersession');
  assert.match(passiveRes.findings[0].detail, /ADR-099 ruling 2/);

  // 3. Active partial supersession in Status prose without matching frontmatter fails lint.
  const activeProseOnly = [
    '---',
    'simt-affects: ["src/decisions/index.mjs"]',
    'simt-supersedes: []',
    '---',
    '# ADR-099 — Active prose partial supersession',
    '',
    'Status: accepted · 2026-10-19 · supersedes ADR-023 ruling 2',
    '',
    '## Rulings',
    '',
    '1. **First ruling.** States partial supersession in Status prose but left simt-supersedes empty.',
    '',
  ].join('\n');
  const activeRes = lintDecision(activeProseOnly, { file: 'ADR-099-active.md' });
  assert.equal(activeRes.ok, false);
  assert.equal(activeRes.findings.length, 1);
  assert.equal(activeRes.findings[0].status, 'prose-partial-supersession');
  assert.match(activeRes.findings[0].detail, /ADR-023 ruling 2/);

  // 4. Writing the prose-only ADR to disk makes `lintDecisions` and `simt decide --check` fail.
  await writeFile(join(root, 'docs', 'decisions', 'ADR-099-active.md'), activeProseOnly);
  const dirLint = await lintDecisions(join(root, 'docs', 'decisions'));
  assert.equal(dirLint.ok, false);
  assert.equal(dirLint.findings.length, 1);

  const cliCheck = await runCli(['decide', '--check', '--root', root, '--json']);
  assert.equal(cliCheck.code, 1);
  const checkPayload = JSON.parse(cliCheck.stdout);
  assert.equal(checkPayload.ok, false);
  assert.equal(checkPayload.findings[0].status, 'prose-partial-supersession');
});

test('R34: parseDecisionFrontmatter and parseSupersedesSpec support multi-line YAML and validate inputs', () => {
  const multiLine = [
    '---',
    'simt-affects:',
    '  - "src/a.mjs"',
    '  - src/b.mjs',
    'simt-supersedes:',
    '  - adr: ADR-023',
    '    ruling: 2',
    '    kind: narrowed',
    '  - { adr: "ADR-011", ruling: null }',
    '---',
    '# ADR-100 — Multi-line frontmatter',
  ].join('\n');

  const fm = parseDecisionFrontmatter(multiLine);
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.errors.length, 0);
  assert.deepEqual(fm.affects, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(fm.supersedes, [
    { adr: 'ADR-023', ruling: 2, kind: 'narrowed' },
    { adr: 'ADR-011', ruling: null, kind: 'superseded' },
  ]);

  const badSpec = parseSupersedesSpec(['not-an-adr']);
  assert.equal(badSpec.errors.length, 1);
});
