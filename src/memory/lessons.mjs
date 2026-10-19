// Deterministic lesson candidate ledger and promotion to `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).
//
// Four deterministic candidate sources write to `.simt-dev/lessons.jsonl`:
//   1. `fail-then-fix`: a gate or test that fails and then passes in one session,
//      recorded as `error signature -> fix diff` (where the signature is the sha256
//      hash of the normalised first error line);
//   2. `revert`: reverted commits (`Revert "..."` / `This reverts commit <sha>`);
//   3. `review-block`: ADR-008 `BLOCK` review findings;
//   4. `hook-denial`: agent-time hook denials (R15).
//
// `simt lessons review` promotes a candidate to `docs/lessons/NNNN-<slug>.md` with the
// Appendix A frontmatter (`simt-trigger`, `simt-evidence`, `simt-expires`).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const LESSONS_FILE = '.simt-dev/lessons.jsonl';
export const LESSONS_DIR = 'docs/lessons';
export const LESSON_KEYS = new Set(['simt-trigger', 'simt-evidence', 'simt-expires']);
const DEFAULT_EXPIRES = '2027-04-01';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'were',
  'have', 'has', 'had', 'not', 'are', 'was', 'but', 'all', 'any', 'can', 'will',
  'error', 'failed', 'fail', 'failure', 'test', 'tests', 'pass', 'passed', 'exit',
]);

/**
 * Strip ANSI escape sequences and collapse whitespace for deterministic hashing.
 *
 * @param {string} line
 * @returns {string}
 */
export function normaliseErrorLine(line) {
  return String(line ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Extract the first error-bearing line from command output.
 *
 * Skips TAP preamble and passing (`ok N`) lines so TAP streams resolve to the first
 * failing (`not ok`) or error line rather than the header.
 *
 * @param {string} output
 * @returns {string}
 */
export function firstErrorLine(output) {
  const clean = String(output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const rawLines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) return '';

  const filtered = rawLines.filter(
    (line) =>
      !/^TAP version \d+$/i.test(line) &&
      !/^1\.\.\d+$/.test(line) &&
      !/^# Subtest:/i.test(line) &&
      !/^---\s*$/.test(line) &&
      !/^\.\.\.\s*$/.test(line) &&
      !/^ok\b/i.test(line),
  );
  const pool = filtered.length > 0 ? filtered : rawLines;

  const explicit = pool.find((line) =>
    /^(?:not ok\b|FAIL\b|ERROR\b|Error:|AssertionError\b|TypeError\b|SyntaxError\b|ReferenceError\b|RangeError\b|✗|×|✖|❌)|\b(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|Error):/i.test(
      line,
    ),
  );
  if (explicit) return normaliseErrorLine(explicit);

  const secondary = pool.find(
    (line) => /\b(?:failed|failure|error|blocked|denied)\b/i.test(line) && !/^\d+\s+pass\b/i.test(line),
  );
  if (secondary) return normaliseErrorLine(secondary);

  return normaliseErrorLine(pool[0]);
}

/**
 * Deterministic `sha256-<hex>` signature of the normalised first error line.
 *
 * @param {string} outputOrLine
 * @returns {string}
 */
export function errorSignature(outputOrLine) {
  const line = normaliseErrorLine(firstErrorLine(outputOrLine));
  return `sha256-${createHash('sha256').update(line, 'utf8').digest('hex')}`;
}

function extractKeywords(text, paths = []) {
  const words = new Set();
  for (const p of paths) {
    const base = String(p)
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '');
    if (base && base.length >= 3 && !STOP_WORDS.has(base.toLowerCase())) {
      words.add(base.toLowerCase());
    }
  }
  const matches = String(text ?? '')
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g);
  for (const token of matches ?? []) {
    if (!STOP_WORDS.has(token) && !/^sha256/.test(token)) {
      words.add(token);
    }
    if (words.size >= 6) break;
  }
  return [...words];
}

function slugify(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/^not ok\s+\d+\s*-?\s*/i, '')
    .replace(/^(?:error|assertionerror|fail|revert|blocked)[:\s-]*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'lesson';
}

/**
 * Read all candidate records from `.simt-dev/lessons.jsonl`.
 *
 * @param {string} root
 * @returns {Promise<{candidates: Array<object>, errors: string[]}>}
 */
export async function readLessonCandidates(root) {
  let text;
  try {
    text = await readFile(join(root, LESSONS_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { candidates: [], errors: [] };
    throw error;
  }
  const candidates = [];
  const errors = [];
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    try {
      const item = JSON.parse(raw);
      if (typeof item.kind !== 'string' || typeof item.signature !== 'string') {
        errors.push(`line ${i + 1} has no kind or signature`);
        continue;
      }
      candidates.push(item);
    } catch (error) {
      errors.push(`line ${i + 1} does not parse (${error.message})`);
    }
  }
  return { candidates, errors };
}

async function writeLessonCandidates(root, candidates) {
  const full = join(root, LESSONS_FILE);
  await mkdir(dirname(full), { recursive: true });
  const body = candidates.map((c) => JSON.stringify(c)).join('\n');
  await writeFile(full, body ? `${body}\n` : '', 'utf8');
}

function sameEvidence(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Append one deterministic candidate to `.simt-dev/lessons.jsonl`, deduplicating by
 * `(kind, signature, evidence)`.
 *
 * @param {string} root
 * @param {object} candidate
 * @returns {Promise<object>}
 */
export async function appendLessonCandidate(root, candidate) {
  const { candidates } = await readLessonCandidates(root);
  const kind = String(candidate.kind ?? 'fail-then-fix');
  const errorLine = normaliseErrorLine(candidate.errorLine ?? firstErrorLine(candidate.output ?? candidate.summary ?? ''));
  const signature = candidate.signature ?? errorSignature(errorLine);
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.map(String).filter(Boolean) : [];

  const existing = candidates.find(
    (c) =>
      c.kind === kind &&
      c.signature === signature &&
      (sameEvidence(c.evidence ?? [], evidence) || (c.cmd && candidate.cmd && c.cmd === candidate.cmd && c.evidence?.[0] === evidence[0])),
  );
  if (existing) return existing;

  const paths = Array.isArray(candidate.paths)
    ? [...new Set(candidate.paths.map(String).filter(Boolean))].sort()
    : [];
  const keywords = Array.isArray(candidate.keywords) && candidate.keywords.length > 0
    ? [...new Set(candidate.keywords.map(String).filter(Boolean))]
    : extractKeywords(`${errorLine} ${candidate.cmd ?? ''}`, paths);

  const nextIndex = candidates.length + 1;
  const record = {
    v: 1,
    id: candidate.id ?? `c-${String(nextIndex).padStart(4, '0')}`,
    ts: candidate.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    kind,
    signature,
    errorLine,
    summary: String(candidate.summary ?? (errorLine || `${kind} candidate`)).trim(),
    cmd: candidate.cmd ?? null,
    paths,
    keywords,
    evidence,
    fixDiff: String(candidate.fixDiff ?? ''),
    status: candidate.status ?? 'candidate',
    promotedTo: candidate.promotedTo ?? null,
  };

  candidates.push(record);
  await writeLessonCandidates(root, candidates);
  return record;
}

async function diffBetweenTrees(root, fromRef, toRef) {
  if (!fromRef || !toRef || fromRef === toRef) {
    return { paths: [], diff: '' };
  }
  try {
    const [namesOut, diffOut] = await Promise.all([
      exec('git', ['diff', '--name-only', fromRef, toRef, '--', '.', ':(exclude).simt-dev'], {
        cwd: root,
        maxBuffer: 8 << 20,
      }),
      exec('git', ['diff', '--unified=3', fromRef, toRef, '--', '.', ':(exclude).simt-dev'], {
        cwd: root,
        maxBuffer: 8 << 20,
      }),
    ]);
    const paths = namesOut.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    return { paths, diff: diffOut.stdout.trim() };
  } catch {
    return { paths: [], diff: '' };
  }
}

/**
 * Record a `fail-then-fix` candidate when a command that failed in the session
 * subsequently passes on a fixed tree.
 *
 * @param {string} root
 * @param {{failEntry: object, passEntry: object, failOutput?: string, fixDiff?: string, paths?: string[]}} params
 * @returns {Promise<object>}
 */
export async function recordFailThenFix(root, { failEntry, passEntry, failOutput, fixDiff, paths }) {
  const rawError = failOutput ?? failEntry?.errorLine ?? failEntry?.summary ?? failEntry?.cmd ?? '';
  const errorLine = normaliseErrorLine(failEntry?.errorLine ?? firstErrorLine(rawError));
  const signature = failEntry?.signature ?? errorSignature(errorLine);
  const failTree = String(failEntry?.tree ?? '');
  const fixTree = String(passEntry?.tree ?? '');

  let resolvedPaths = Array.isArray(paths) ? paths : null;
  let resolvedDiff = typeof fixDiff === 'string' ? fixDiff : null;
  if (resolvedPaths === null || resolvedDiff === null) {
    const treeDiff = await diffBetweenTrees(root, failTree, fixTree);
    resolvedPaths ??= treeDiff.paths;
    resolvedDiff ??= treeDiff.diff;
  }

  return appendLessonCandidate(root, {
    kind: 'fail-then-fix',
    cmd: passEntry?.cmd ?? failEntry?.cmd ?? null,
    signature,
    errorLine,
    summary: errorLine || `${passEntry?.cmd ?? 'gate'} failed then passed`,
    evidence: [failTree, fixTree].filter(Boolean),
    paths: resolvedPaths,
    fixDiff: resolvedDiff,
  });
}

/**
 * Scan `.simt-dev/ledger.jsonl` for any fail-then-fix sequences in the session and
 * ensure each is recorded in `.simt-dev/lessons.jsonl`.
 *
 * @param {string} root
 * @param {Array<object>} [entries]
 * @returns {Promise<Array<object>>}
 */
export async function captureFromLedger(root, entries = null) {
  let list = entries;
  if (!Array.isArray(list)) {
    try {
      const raw = await readFile(join(root, '.simt-dev', 'ledger.jsonl'), 'utf8');
      list = raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    } catch {
      list = [];
    }
  }

  const pendingFailByCmd = new Map();
  const captured = [];

  for (const entry of list) {
    if (!entry || typeof entry.cmd !== 'string' || typeof entry.exit !== 'number') continue;
    if (entry.exit !== 0) {
      // Keep the first failing run in a fail streak so `failTree` points at the broken state
      // and the signature reflects the initial failure before edits fixed it.
      if (!pendingFailByCmd.has(entry.cmd)) {
        pendingFailByCmd.set(entry.cmd, entry);
      }
    } else if (pendingFailByCmd.has(entry.cmd)) {
      const failEntry = pendingFailByCmd.get(entry.cmd);
      pendingFailByCmd.delete(entry.cmd);
      const record = await recordFailThenFix(root, { failEntry, passEntry: entry });
      captured.push(record);
    }
  }
  return captured;
}

/**
 * Capture reverted commits from git history into `.simt-dev/lessons.jsonl`.
 *
 * @param {string} root
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function captureRevertedCommits(root, options = {}) {
  const limit = options.limit ?? 50;
  let stdout = '';
  try {
    const res = await exec(
      'git',
      ['log', '--no-merges', `-n`, String(limit), '--format=%H%x00%s%x00%b%x1e'],
      { cwd: root, maxBuffer: 8 << 20 },
    );
    stdout = res.stdout;
  } catch {
    return [];
  }

  const captured = [];
  const records = stdout
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const raw of records.reverse()) {
    const [sha, subject = '', body = ''] = raw.split('\x00');
    const revertBodyMatch = /This reverts commit ([0-9a-f]{7,40})/i.exec(body);
    const isRevertSubject = /^Revert\s+".+"/i.test(subject.trim());
    if (!revertBodyMatch && !isRevertSubject) continue;

    const failSha = revertBodyMatch ? revertBodyMatch[1] : `${sha}^`;
    const errorLine = normaliseErrorLine(subject);
    const signature = errorSignature(errorLine);

    let paths = [];
    let fixDiff = '';
    try {
      const [namesRes, diffRes] = await Promise.all([
        exec('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd: root, maxBuffer: 8 << 20 }),
        exec('git', ['show', '--format=', '--unified=3', sha], { cwd: root, maxBuffer: 8 << 20 }),
      ]);
      paths = namesRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      fixDiff = diffRes.stdout.trim();
    } catch {
      // ignore diff failure
    }

    const record = await appendLessonCandidate(root, {
      kind: 'revert',
      cmd: 'git revert',
      signature,
      errorLine,
      summary: errorLine,
      evidence: [failSha, sha],
      paths,
      fixDiff,
    });
    captured.push(record);
  }
  return captured;
}

/**
 * Record an ADR-008 `BLOCK` review finding in `.simt-dev/lessons.jsonl`.
 *
 * @param {string} root
 * @param {{summary: string, paths?: string[], evidence?: string[], fixDiff?: string, keywords?: string[]}} finding
 * @returns {Promise<object>}
 */
export async function recordReviewBlock(root, finding) {
  const raw = String(finding?.summary ?? finding?.errorLine ?? 'BLOCK review finding').trim();
  const errorLine = normaliseErrorLine(firstErrorLine(raw));
  const signature = errorSignature(errorLine);
  const inferredPaths = [...raw.matchAll(/\b([\w./-]+\.(?:mjs|js|ts|tsx|py|go|kt|java|rs|md|json))(?::\d+)?/g)].map(
    (m) => m[1],
  );
  const paths = [...new Set([...(finding?.paths ?? []), ...inferredPaths])].sort();

  return appendLessonCandidate(root, {
    kind: 'review-block',
    cmd: 'review',
    signature,
    errorLine,
    summary: errorLine,
    evidence: Array.isArray(finding?.evidence) ? finding.evidence : [],
    paths,
    keywords: finding?.keywords,
    fixDiff: finding?.fixDiff ?? '',
  });
}

/**
 * Record an agent-time hook denial (R15) in `.simt-dev/lessons.jsonl`.
 *
 * @param {string} root
 * @param {{harness?: string, event?: string, policies?: string[], messages?: string[], command?: string, writes?: string[]}} denial
 * @returns {Promise<object>}
 */
export async function recordHookDenial(root, denial) {
  const firstMsg = denial?.messages?.[0] ?? `blocked by ${(denial?.policies ?? []).join(', ') || 'policy'}`;
  const errorLine = normaliseErrorLine(firstMsg);
  const signature = errorSignature(errorLine);
  const paths = Array.isArray(denial?.writes) ? denial.writes.filter(Boolean) : [];
  const policies = Array.isArray(denial?.policies) ? denial.policies.filter(Boolean) : [];
  const keywords = [...new Set([...policies, ...extractKeywords(errorLine, paths)])];
  const evidence = [denial?.command, ...paths].filter(Boolean);

  return appendLessonCandidate(root, {
    kind: 'hook-denial',
    cmd: denial?.command ?? (`agent-hook ${denial?.event ?? 'pre-tool-use'}`),
    signature,
    errorLine,
    summary: errorLine,
    evidence,
    paths,
    keywords,
    fixDiff: '',
  });
}

/**
 * Render a promoted lesson Markdown document with Appendix A frontmatter:
 *
 * ```yaml
 * ---
 * simt-trigger: { paths: ["src/hooks/**"], signature: "sha256-…", keywords: ["restage"] }
 * simt-evidence: ["<sha-fail>", "<sha-fix>"]
 * simt-expires: 2027-04-01
 * ---
 * ```
 *
 * @param {object} candidate
 * @param {{title?: string, paths?: string[], keywords?: string[], expires?: string}} [options]
 * @returns {string}
 */
export function renderLessonMarkdown(candidate, options = {}) {
  const paths =
    Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : Array.isArray(candidate.paths) && candidate.paths.length > 0
        ? candidate.paths
        : ['**'];
  const keywords =
    Array.isArray(options.keywords) && options.keywords.length > 0
      ? options.keywords
      : Array.isArray(candidate.keywords) && candidate.keywords.length > 0
        ? candidate.keywords
        : extractKeywords(candidate.errorLine ?? candidate.summary ?? '', paths);
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const expires = options.expires ?? DEFAULT_EXPIRES;
  const title = String(options.title ?? candidate.summary ?? candidate.errorLine ?? 'Lesson').trim();

  const pathsLiteral = paths.map((p) => JSON.stringify(String(p))).join(', ');
  const keywordsLiteral = keywords.map((k) => JSON.stringify(String(k))).join(', ');
  const evidenceLiteral = evidence.map((e) => JSON.stringify(String(e))).join(', ');

  const lines = [
    '---',
    `simt-trigger: { paths: [${pathsLiteral}], signature: ${JSON.stringify(candidate.signature)}, keywords: [${keywordsLiteral}] }`,
    `simt-evidence: [${evidenceLiteral}]`,
    `simt-expires: ${expires}`,
    '---',
    '',
    `# ${title}`,
    '',
    `When \`${candidate.cmd ?? candidate.kind}\` fails with \`${candidate.errorLine || candidate.signature}\`, apply the recorded fix across ${paths.map((p) => `\`${p}\``).join(', ')}.`,
  ];

  if (candidate.fixDiff) {
    lines.push('', '```diff', candidate.fixDiff.trim(), '```');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse a `docs/lessons/NNNN-<slug>.md` file into structured trigger, evidence,
 * expiry, title and first body paragraph.
 *
 * @param {string} id
 * @param {string} text
 * @returns {object}
 */
export function parseLessonFile(id, text) {
  const raw = String(text ?? '');
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const front = fmMatch ? fmMatch[1] : '';
  const body = fmMatch ? fmMatch[2].trim() : raw.trim();

  const pathsMatch = /paths:\s*\[([^\]]*)\]/.exec(front);
  const paths = pathsMatch
    ? [...pathsMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : [];
  const sigMatch = /signature:\s*['"]?(sha256-[0-9a-f]+)['"]?/i.exec(front);
  const signature = sigMatch ? sigMatch[1] : null;
  const kwMatch = /keywords:\s*\[([^\]]*)\]/.exec(front);
  const keywords = kwMatch
    ? [...kwMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : [];
  const evMatch = /^simt-evidence:\s*\[([^\]]*)\]/m.exec(front);
  const evidence = evMatch
    ? [...evMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : [];
  const expMatch = /^simt-expires:\s*(\S+)/m.exec(front);
  const expires = expMatch ? expMatch[1].trim() : null;

  const titleMatch = /^#\s+(.+)$/m.exec(body);
  const title = titleMatch ? titleMatch[1].trim() : id;
  const paragraphs = body
    .replace(/^#\s+.+$/m, '')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith('```'));
  const paragraph = paragraphs[0] ?? title;

  return {
    id,
    title,
    paragraph,
    paths,
    signature,
    keywords,
    evidence,
    expires,
  };
}

/**
 * List all promoted lessons in `docs/lessons/*.md`.
 *
 * @param {string} root
 * @returns {Promise<Array<object>>}
 */
export async function listPromotedLessons(root) {
  const dir = join(root, LESSONS_DIR);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const lessons = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8');
    const id = name.replace(/\.md$/, '');
    lessons.push(parseLessonFile(id, text));
  }
  return lessons;
}

async function nextLessonNumber(root) {
  const dir = join(root, LESSONS_DIR);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return '0001';
  }
  let max = 0;
  for (const name of names) {
    const match = /^(\d{4})-.*\.md$/.exec(name);
    if (match) {
      const n = Number(match[1]);
      if (n > max) max = n;
    }
  }
  return String(max + 1).padStart(4, '0');
}

/**
 * Promote a lesson candidate from `.simt-dev/lessons.jsonl` to `docs/lessons/NNNN-<slug>.md`.
 *
 * @param {string} root
 * @param {{id?: string, apply?: boolean, paths?: string[], expires?: string, title?: string}} [options]
 * @returns {Promise<{ok: boolean, error?: string, candidate?: object, path?: string, markdown?: string, written?: boolean}>}
 */
export async function promoteLesson(root, options = {}) {
  await captureFromLedger(root);
  const { candidates } = await readLessonCandidates(root);
  if (candidates.length === 0) {
    return { ok: false, error: 'no lesson candidates in .simt-dev/lessons.jsonl' };
  }

  let target = null;
  if (options.id) {
    target = candidates.find(
      (c) => c.id === options.id || c.signature === options.id || c.signature.startsWith(options.id),
    );
    if (!target) {
      return { ok: false, error: `no lesson candidate matching "${options.id}"` };
    }
  } else {
    target = candidates.find((c) => c.status !== 'promoted') ?? candidates[0];
  }

  const num = await nextLessonNumber(root);
  const slug = slugify(options.title ?? target.errorLine ?? target.summary ?? target.kind);
  const relPath = `${LESSONS_DIR}/${num}-${slug}.md`;
  const markdown = renderLessonMarkdown(target, options);

  if (options.apply) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, markdown, 'utf8');
    target.status = 'promoted';
    target.promotedTo = relPath;
    await writeLessonCandidates(root, candidates);
  }

  return {
    ok: true,
    candidate: target,
    path: relPath,
    markdown,
    written: Boolean(options.apply),
  };
}
