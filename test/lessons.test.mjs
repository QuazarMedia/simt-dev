// Lessons ledger and promotion to `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runGates } from '../src/hooks/dispatcher.mjs';
import { lessonPaths } from '../src/index/govern.mjs';
import { recordRun, treeId } from '../src/ledger/index.mjs';
import {
  LESSONS_DIR,
  LESSONS_FILE,
  appendLessonCandidate,
  captureFromLedger,
  captureRevertedCommits,
  errorSignature,
  firstErrorLine,
  listPromotedLessons,
  normaliseErrorLine,
  parseLessonFile,
  promoteLesson,
  readLessonCandidates,
  recordFailThenFix,
  recordHookDenial,
  recordReviewBlock,
  renderLessonMarkdown,
} from '../src/memory/lessons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function git(args, cwd) {
  return exec(
    'git',
    ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, maxBuffer: 16 << 20 },
  );
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'simt-lessons-'));
  tempDirs.push(dir);
  await git(['init', '-q', dir]);
  await mkdir(join(dir, 'src', 'hooks'), { recursive: true });
  await writeFile(join(dir, 'src', 'hooks', 'dispatcher.mjs'), 'export const restage = false;\n', 'utf8');
  await git(['add', '-A'], dir);
  await git(['commit', '-qm', 'initial'], dir);
  return dir;
}

test('normaliseErrorLine, firstErrorLine, and errorSignature hash the normalised first error line', () => {
  const rawTap = [
    'TAP version 13',
    '# Subtest: restage',
    'ok 1 - initial check',
    '\x1b[31m  not ok 2 -   restage failed on deleted file  \x1b[0m',
    '  ---',
    '  duration_ms: 4.2',
    '  ...',
    '1..2',
  ].join('\n');

  const first = firstErrorLine(rawTap);
  assert.equal(first, 'not ok 2 - restage failed on deleted file');
  assert.equal(normaliseErrorLine('  Error:   restage   failed \n'), 'Error: restage failed');
  assert.equal(
    errorSignature(rawTap),
    errorSignature('not ok 2 - restage failed on deleted file'),
  );
  assert.match(errorSignature(rawTap), /^sha256-[0-9a-f]{64}$/);
});

test('a fixture session with one fail-then-fix produces exactly one candidate with the right signature', async () => {
  const root = await makeRepo();
  const errorOut = 'Error: restage failed on deleted path in src/hooks/dispatcher.mjs\n  at runGates (src/hooks/dispatcher.mjs:219:5)\n';
  const expectedSig = errorSignature('Error: restage failed on deleted path in src/hooks/dispatcher.mjs');

  const manifestFail = {
    gates: {
      preCommit: ['test'],
      commands: {
        test: `node -e 'console.error(${JSON.stringify(errorOut.trim())}); process.exit(1);'`,
      },
    },
  };

  // 1. Gate fails on broken tree
  const failRes = await runGates('pre-commit', { root, manifest: manifestFail });
  assert.equal(failRes.failed, true);
  const failTree = await treeId(root);

  // No candidate yet after only a failure
  const beforeFix = await readLessonCandidates(root);
  assert.equal(beforeFix.candidates.length, 0);

  // 2. Fix the file in the worktree
  await writeFile(join(root, 'src', 'hooks', 'dispatcher.mjs'), 'export const restage = true;\n', 'utf8');
  const fixTree = await treeId(root);
  assert.notEqual(fixTree, failTree);

  // 3. Same gate command now passes; simulate the same declared gate command passing
  await recordRun(root, {
    cmd: manifestFail.gates.commands.test,
    exit: 0,
    ms: 12,
    output: '1 pass, 0 fail\n',
  });

  // 4. Subsequent green run in the same session does not duplicate the candidate
  await recordRun(root, {
    cmd: manifestFail.gates.commands.test,
    exit: 0,
    ms: 10,
    output: '1 pass, 0 fail\n',
  });

  // Re-scanning the ledger is idempotent
  await captureFromLedger(root);

  const { candidates, errors } = await readLessonCandidates(root);
  assert.deepEqual(errors, []);
  assert.equal(candidates.length, 1, `expected exactly 1 candidate, got ${candidates.length}`);

  const candidate = candidates[0];
  assert.equal(candidate.kind, 'fail-then-fix');
  assert.equal(candidate.signature, expectedSig);
  assert.equal(candidate.errorLine, 'Error: restage failed on deleted path in src/hooks/dispatcher.mjs');
  assert.deepEqual(candidate.evidence, [failTree, fixTree]);
  assert.deepEqual(candidate.paths, ['src/hooks/dispatcher.mjs']);
  assert.match(candidate.fixDiff, /-export const restage = false;/);
  assert.match(candidate.fixDiff, /\+export const restage = true;/);
});

test('captures reverted commits, BLOCK review findings, and hook denials deterministically', async () => {
  const root = await makeRepo();

  // 1. Create and revert a commit
  await writeFile(join(root, 'src', 'hooks', 'dispatcher.mjs'), 'export const broken = 1;\n', 'utf8');
  await git(['add', 'src/hooks/dispatcher.mjs'], root);
  await git(['commit', '-qm', 'feat(hooks): add broken flag'], root);
  const badSha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

  await git(['revert', '--no-edit', 'HEAD'], root);
  const revertSha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

  const reverts = await captureRevertedCommits(root);
  assert.equal(reverts.length, 1);
  assert.equal(reverts[0].kind, 'revert');
  assert.equal(reverts[0].signature, errorSignature('Revert "feat(hooks): add broken flag"'));
  assert.deepEqual(reverts[0].evidence, [badSha, revertSha]);
  assert.deepEqual(reverts[0].paths, ['src/hooks/dispatcher.mjs']);

  // 2. Record a BLOCK review finding (ADR-008)
  const blockCandidate = await recordReviewBlock(root, {
    summary: 'BLOCK: missing restage check in src/hooks/dispatcher.mjs:218',
    evidence: [badSha],
  });
  assert.equal(blockCandidate.kind, 'review-block');
  assert.deepEqual(blockCandidate.paths, ['src/hooks/dispatcher.mjs']);

  // 3. Record a hook denial (R15)
  const denialCandidate = await recordHookDenial(root, {
    harness: 'claude',
    event: 'pre-tool-use',
    policies: ['push'],
    messages: ['Push needs explicit approval (ADR-001); ask the user.'],
    command: 'git push origin main',
  });
  assert.equal(denialCandidate.kind, 'hook-denial');
  assert.ok(denialCandidate.keywords.includes('push'));

  // Direct appendLessonCandidate deduplicates identical candidates
  const dup = await appendLessonCandidate(root, {
    kind: 'hook-denial',
    cmd: 'git push origin main',
    signature: denialCandidate.signature,
    errorLine: denialCandidate.errorLine,
    evidence: denialCandidate.evidence,
  });
  assert.equal(dup.id, denialCandidate.id);

  const { candidates } = await readLessonCandidates(root);
  assert.equal(candidates.length, 3);
});

test('simt lessons review promotes a candidate to docs/lessons/NNNN-<slug>.md with Appendix A frontmatter', async () => {
  const root = await makeRepo();
  const failEntry = {
    tree: '1111111111111111111111111111111111111111',
    cmd: 'npm test',
    exit: 1,
    errorLine: 'Error: restage failed on deleted file',
    signature: errorSignature('Error: restage failed on deleted file'),
  };
  const passEntry = {
    tree: '2222222222222222222222222222222222222222',
    cmd: 'npm test',
    exit: 0,
  };
  await recordFailThenFix(root, {
    failEntry,
    passEntry,
    paths: ['src/hooks/dispatcher.mjs'],
    fixDiff: '--- a/src/hooks/dispatcher.mjs\n+++ b/src/hooks/dispatcher.mjs\n@@ -1 +1 @@\n-old\n+new',
  });

  // Preview mode (without --yes) writes nothing
  const preview = await exec('node', [BIN, 'lessons', 'review', '--root', root, '--json']);
  const previewPayload = JSON.parse(preview.stdout);
  assert.equal(previewPayload.ok, true);
  assert.equal(previewPayload.written, false);
  assert.equal(previewPayload.path, `${LESSONS_DIR}/0001-restage-failed-on-deleted-file.md`);
  assert.equal(existsSync(join(root, previewPayload.path)), false);

  // Apply mode (--yes) writes docs/lessons/0001-<slug>.md
  const applied = await exec('node', [BIN, 'lessons', 'review', '--root', root, '--yes', '--json']);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.ok, true);
  assert.equal(appliedPayload.written, true);
  assert.equal(existsSync(join(root, appliedPayload.path)), true);
  assert.equal(existsSync(join(root, LESSONS_FILE)), true);

  const fileText = await readFile(join(root, appliedPayload.path), 'utf8');
  assert.match(fileText, /^---\nsimt-trigger: \{ paths: \["src\/hooks\/dispatcher\.mjs"\], signature: "sha256-[0-9a-f]{64}", keywords: \[/);
  assert.match(fileText, /\nsimt-evidence: \["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"\]\n/);
  assert.match(fileText, /\nsimt-expires: 2027-04-01\n---\n/);

  // Verify govern.mjs `lessonPaths` and `listPromotedLessons` parse the generated file
  assert.deepEqual(lessonPaths(fileText), ['src/hooks/dispatcher.mjs']);
  const parsed = parseLessonFile('0001-restage-failed-on-deleted-file', fileText);
  assert.equal(parsed.signature, failEntry.signature);
  assert.deepEqual(parsed.evidence, [failEntry.tree, passEntry.tree]);
  assert.equal(parsed.expires, '2027-04-01');

  const promoted = await listPromotedLessons(root);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].id, '0001-restage-failed-on-deleted-file');

  // Verify `simt lessons` (default `lessons list`) reports both candidate and promoted lesson
  const listed = await exec('node', [BIN, 'lessons', '--root', root, '--json']);
  const listedPayload = JSON.parse(listed.stdout);
  assert.equal(listedPayload.ok, true);
  assert.equal(listedPayload.candidateCount, 1);
  assert.equal(listedPayload.promotedCount, 1);
  assert.equal(listedPayload.candidates[0].status, 'promoted');

  // Direct promoteLesson and renderLessonMarkdown helpers
  const md = renderLessonMarkdown(listedPayload.candidates[0], { expires: '2027-06-01' });
  assert.match(md, /simt-expires: 2027-06-01/);
  const directPromote = await promoteLesson(root, { id: 'c-0001', apply: false });
  assert.equal(directPromote.ok, true);
});
