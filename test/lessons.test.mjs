// Lessons ledger and promotion to `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { adapter } from '../src/agenthooks/render.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { lessonPaths } from '../src/index/govern.mjs';
import { readLedger, recordRun, treeId } from '../src/ledger/index.mjs';
import {
  LESSONS_DIR,
  LESSONS_FILE,
  appendLessonCandidate,
  captureFromLedger,
  captureRevertedCommits,
  deliverLessonRecall,
  errorSignature,
  firstErrorLine,
  formatLessonParagraph,
  listPromotedLessons,
  matchLessonByOutput,
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

function runHookCli(args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

test('R33: replaying a recorded failure into agent-hook post-tool-use injects the matching lesson as one paragraph', async () => {
  const root = await makeRepo();
  const failingOutput = [
    'TAP version 13',
    'not ok 1 - Error: restage failed on deleted file in src/hooks/dispatcher.mjs',
    '  ---',
    '  duration_ms: 3.1',
    '  ...',
    '1..1',
  ].join('\n');

  // 1. Record failing run, fix, and passing run in the ledger
  await recordRun(root, {
    cmd: 'npm test',
    exit: 1,
    ms: 14,
    output: failingOutput,
  });
  await writeFile(join(root, 'src', 'hooks', 'dispatcher.mjs'), 'export const restage = true;\n', 'utf8');
  await recordRun(root, {
    cmd: 'npm test',
    exit: 0,
    ms: 11,
    output: 'TAP version 13\nok 1 - restage passes\n1..1\n',
  });

  // 2. Promote the captured lesson to docs/lessons/0001-*.md
  const promoted = await promoteLesson(root, { apply: true });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.written, true);

  // 3. Replay the recorded failing ledger line from .simt/ledger.jsonl directly into post-tool-use
  const { entries } = await readLedger(root);
  const recordedFailure = entries.find((e) => e.exit !== 0);
  assert.ok(recordedFailure, 'expected recorded failing ledger entry');

  const replayed = runHookCli(
    ['agent-hook', 'post-tool-use', '--harness', 'claude', '--root', root],
    JSON.stringify(recordedFailure),
  );
  assert.equal(replayed.code, 0, replayed.stderr);
  const replayedJson = JSON.parse(replayed.stdout);
  assert.equal(replayedJson.hookSpecificOutput.hookEventName, 'PostToolUse');
  const injected = replayedJson.hookSpecificOutput.additionalContext;
  assert.ok(injected.startsWith('Lesson 0001-'), injected);
  assert.ok(injected.includes('src/hooks/dispatcher.mjs'), injected);
  assert.equal(injected.includes('\n\n'), false, 'injected lesson must be a single paragraph');

  // 4. Replay as Claude Code and Codex PostToolUse payloads with raw failing output
  for (const harness of ['claude', 'codex']) {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout: failingOutput,
        stderr: '',
        exit_code: 1,
      },
      cwd: root,
    });
    const res = runHookCli(['agent-hook', 'post-tool-use', '--harness', harness], payload);
    assert.equal(res.code, 0, res.stderr);
    const json = JSON.parse(res.stdout);
    assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.equal(json.hookSpecificOutput.additionalContext, injected);
  }

  // 5. Passing tool output or unmatched failure signature injects nothing
  const passingRes = runHookCli(
    ['agent-hook', 'post-tool-use', '--harness', 'claude'],
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: failingOutput, exit_code: 0 },
      cwd: root,
    }),
  );
  assert.equal(passingRes.code, 0);
  assert.equal(passingRes.stdout, '');

  const unmatchedRes = runHookCli(
    ['agent-hook', 'post-tool-use', '--harness', 'claude'],
    JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { stdout: 'Error: completely unrelated failure', exit_code: 1 },
      cwd: root,
    }),
  );
  assert.equal(unmatchedRes.code, 0);
  assert.equal(unmatchedRes.stdout, '');

  // Direct unit checks for formatLessonParagraph, matchLessonByOutput, deliverLessonRecall
  const lessons = await listPromotedLessons(root);
  const directMatch = matchLessonByOutput(lessons, failingOutput);
  assert.ok(directMatch);
  assert.equal(directMatch.paragraph, formatLessonParagraph(lessons[0]));
  const directDeliver = await deliverLessonRecall(adapter('claude'), recordedFailure, { root });
  assert.equal(directDeliver.paragraph, injected);
});

test('R33: the brief includes lessons whose triggers match the task paths', async () => {
  const root = await makeRepo();
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'utf8',
  );
  await mkdir(join(root, 'docs', 'lessons'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'lessons', '0001-dispatcher-restage.md'),
    [
      '---',
      `simt-trigger: { paths: ["src/hooks/**"], signature: "${errorSignature('Error: restage failed')}", keywords: ["restage"] }`,
      'simt-evidence: ["1111111", "2222222"]',
      'simt-expires: 2027-04-01',
      '---',
      '',
      '# Guard restage on deleted files',
      '',
      'Filter deleted paths out of the restage list in `src/hooks/dispatcher.mjs` before calling `git add`.',
      '',
    ].join('\n'),
    'utf8',
  );
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'add lesson'], root);

  // 1. Task naming the file ranks src/hooks/dispatcher.mjs and includes the lesson in LESSONS
  const byTaskRes = await exec('node', [
    BIN,
    'brief',
    'fix restage in src/hooks/dispatcher.mjs',
    '--root',
    root,
    '--json',
  ]);
  const byTask = JSON.parse(byTaskRes.stdout);
  assert.ok(Array.isArray(byTask.sections.LESSONS), 'expected LESSONS section in brief');
  assert.ok(
    byTask.sections.LESSONS.some(
      (line) =>
        line.includes('0001-dispatcher-restage') &&
        line.includes('Filter deleted paths out of the restage list'),
    ),
    JSON.stringify(byTask.sections.LESSONS),
  );

  // 2. Explicit --paths scope matches the lesson trigger even when task text is generic
  const byPathsRes = await exec('node', [
    BIN,
    'brief',
    'update module',
    '--paths',
    'src/hooks/dispatcher.mjs',
    '--root',
    root,
    '--json',
  ]);
  const byPaths = JSON.parse(byPathsRes.stdout);
  assert.ok(Array.isArray(byPaths.sections.LESSONS), 'expected LESSONS section when --paths matches trigger');
  assert.ok(
    byPaths.sections.LESSONS.some((line) => line.includes('0001-dispatcher-restage')),
    JSON.stringify(byPaths.sections.LESSONS),
  );
});

test('R33: bench shows fewer turns on recurring failure modes when the lesson is recalled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-lesson-bench-'));
  const vaultRoot = await mkdtemp(join(tmpdir(), 'simt-lesson-vault-'));
  tempDirs.push(root, vaultRoot);

  await git(['init', '-q', root]);
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'lesson-bench', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'utf8',
  );
  await mkdir(join(root, 'src', 'hooks'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'src', 'hooks', 'dispatcher.mjs'),
    'export function restage(paths) {\n  return paths;\n}\n',
    'utf8',
  );
  await writeFile(
    join(root, 'test', 'dispatcher.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { restage } from '../src/hooks/dispatcher.mjs';",
      '',
      "test('restage baseline', () => {",
      "  assert.deepEqual(restage(['a.mjs']), ['a.mjs']);",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'base'], root);
  const baseSha = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

  // Commit the fix + test so `bench mine` creates the task and vault patches
  await writeFile(
    join(root, 'src', 'hooks', 'dispatcher.mjs'),
    'export function restage(paths) {\n  return paths.filter(Boolean);\n}\n',
    'utf8',
  );
  await writeFile(
    join(root, 'test', 'dispatcher.test.mjs'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { restage } from '../src/hooks/dispatcher.mjs';",
      '',
      "test('restage baseline', () => {",
      "  assert.deepEqual(restage(['a.mjs']), ['a.mjs']);",
      '});',
      '',
      "test('restage filters deleted entries', () => {",
      "  assert.deepEqual(restage(['a.mjs', null, '']), ['a.mjs']);",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'fix(hooks): filter deleted entries in restage'], root);

  const testEnv = {
    ...process.env,
    SIMT_DEV_VAULT_DIR: vaultRoot,
  };
  const minedRes = await exec('node', [BIN, 'bench', 'mine', '--root', root, '--yes', '--json'], {
    env: testEnv,
  });
  const minedPayload = JSON.parse(minedRes.stdout);
  assert.equal(minedPayload.ok, true);
  assert.equal(minedPayload.tasks.length, 1);
  const taskId = minedPayload.tasks[0].id;

  // Promote a lesson for this recurring failure mode in root/docs/lessons/
  const recurringError = 'Error: restage failed on deleted path in src/hooks/dispatcher.mjs';
  await mkdir(join(root, 'docs', 'lessons'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'lessons', '0001-restage-deleted.md'),
    [
      '---',
      `simt-trigger: { paths: ["src/hooks/**"], signature: "${errorSignature(recurringError)}", keywords: ["restage", "dispatcher"] }`,
      `simt-evidence: ["${baseSha}"]`,
      'simt-expires: 2027-04-01',
      '---',
      '',
      '# Filter deleted entries in restage',
      '',
      'Filter null and deleted entries via `paths.filter(Boolean)` in `src/hooks/dispatcher.mjs`.',
      '',
    ].join('\n'),
    'utf8',
  );

  // Create synthetic agent bin that checks whether the lesson is available via brief or post-tool-use hook recall:
  // - With the recalled lesson (brief arm), it applies the exact fix on turn 1 (1 turn, 1 tool call).
  // - Without the lesson (bare arm), its first attempt triggers the recurring failure, and it fixes on turn 3 (3 turns, 3 tool calls).
  const binDir = await mkdtemp(join(tmpdir(), 'simt-lesson-bin-'));
  tempDirs.push(binDir);
  const claudeStub = join(binDir, 'claude');
  await writeFile(
    claudeStub,
    [
      '#!/usr/bin/env node',
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const simtBin = ${JSON.stringify(BIN)};`,
      `const recurringError = ${JSON.stringify(recurringError)};`,
      "const hasBriefLesson = existsSync('.simt/brief.md') && readFileSync('.simt/brief.md', 'utf8').includes('0001-restage-deleted');",
      'let hookRecalled = false;',
      "if (existsSync('docs/lessons/0001-restage-deleted.md')) {",
      "  const hook = spawnSync(process.execPath, [simtBin, 'agent-hook', 'post-tool-use', '--harness', 'claude'], {",
      "    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stderr: recurringError, exit_code: 1 }, cwd: process.cwd() }),",
      "    encoding: 'utf8',",
      '  });',
      "  hookRecalled = (hook.stdout || '').includes('0001-restage-deleted');",
      '}',
      "writeFileSync('src/hooks/dispatcher.mjs', 'export function restage(paths) {\\n  return paths.filter(Boolean);\\n}\\n');",
      'const turns = (hasBriefLesson || hookRecalled) ? 1 : 3;',
      'const inputTokens = (hasBriefLesson || hookRecalled) ? 400 : 1200;',
      'console.log(JSON.stringify({ num_turns: turns, tool_calls: turns, usage: { input_tokens: inputTokens, output_tokens: 100 * turns, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));',
    ].join('\n'),
    'utf8',
  );
  await chmod(claudeStub, 0o755);

  const benchRes = await exec(
    'node',
    [
      BIN,
      'bench',
      'run',
      '--root',
      root,
      '--arm',
      'bare,brief',
      '--harness',
      'claude',
      '--reps',
      '1',
      '--task',
      taskId,
      '--yes',
      '--json',
    ],
    {
      env: {
        ...testEnv,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    },
  );
  const res = JSON.parse(benchRes.stdout);
  assert.equal(res.runs.length, 2);
  const bareRun = res.runs.find((r) => r.arm === 'bare');
  const briefRun = res.runs.find((r) => r.arm === 'brief');
  assert.ok(bareRun && briefRun);
  assert.equal(bareRun.resolved, true);
  assert.equal(briefRun.resolved, true);
  assert.ok(
    briefRun.usage.turns < bareRun.usage.turns,
    `expected fewer turns with lesson recall (${briefRun.usage.turns} vs ${bareRun.usage.turns})`,
  );
});
