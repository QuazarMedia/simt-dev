// Deterministic lesson candidate ledger and promotion to `docs/lessons/NNNN-<slug>.md` (plan 0003 R32).
//
// Four deterministic candidate sources write to `.simt/lessons.jsonl`:
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
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { postDeliveryJson } from '../agenthooks/render.mjs';
import { lessonPaths } from '../index/govern.mjs';
import { recordCreatedFile } from '../journal.mjs';
import { redactText } from '../secrets.mjs';
import { localRel, readStateFile } from '../state.mjs';
import { splitFrontmatter } from './decide.mjs';

const exec = promisify(execFile);

export const LESSONS_FILE = localRel('lessons.jsonl');
const LESSONS_FILE_LEGACY = '.simt/lessons.jsonl';
const LEDGER_REL = localRel('ledger.jsonl');
const LEDGER_REL_LEGACY = '.simt/ledger.jsonl';
export const LESSONS_DIR = 'docs/lessons';
export const LESSON_KEYS = new Set(['simt-trigger', 'simt-evidence', 'simt-expires']);

/**
 * A stored `fixDiff` is evidence, not an archive: the diff that proved the fix,
 * capped so one generated-file revert cannot bloat every read of the ledger.
 * Truncation keeps the head (the hunk headers that name the files) and says so.
 */
const FIX_DIFF_BUDGET = 20000;

/**
 * The default expiry is relative to the promotion, not a date in the source:
 * a fixed date rots (every lesson written today expires on someone else's
 * schedule) and a missing one lives forever because nothing reads the field.
 * Half a year is long enough to recur and short enough to re-earn.
 */
const EXPIRY_DAYS = 180;

export function defaultExpires(from = new Date()) {
  const at = new Date(from);
  at.setUTCDate(at.getUTCDate() + EXPIRY_DAYS);
  return at.toISOString().slice(0, 10);
}

/**
 * Whether a `simt-expires` value has passed. Unparseable values are NOT expired:
 * a malformed date is a data error the reader should see, and hiding the lesson
 * would turn it into a silent one (review 0003 Q36).
 *
 * @param {string|null|undefined} expires
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isExpired(expires, now = new Date()) {
  if (expires === null || expires === undefined || String(expires).trim() === '') return false;
  const at = new Date(String(expires).trim());
  if (Number.isNaN(at.getTime())) return false;
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  return at.getTime() < today.getTime();
}

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
 * Read all candidate records from `.simt/lessons.jsonl`.
 *
 * @param {string} root
 * @returns {Promise<{candidates: Array<object>, errors: string[]}>}
 */
export async function readLessonCandidates(root) {
  // The pre-move path is a fallback for one release (review 0003 Q19).
  let text;
  try {
    ({ text } = await readStateFile(root, LESSONS_FILE, [LESSONS_FILE_LEGACY]));
  } catch (error) {
    throw error;
  }
  if (text === null) return { candidates: [], errors: [] };
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

/**
 * Append one record with `O_APPEND`: the ledger is written by concurrent
 * processes (gates, hooks, the CLI), and a read-modify-write loses one of two
 * simultaneous appends. The position is the kernel's, not a length read earlier.
 *
 * @param {string} root
 * @param {object} record
 */
async function appendCandidateLine(root, record) {
  const full = join(root, LESSONS_FILE);
  await mkdir(dirname(full), { recursive: true });
  const handle = await open(full, 'a');
  try {
    await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The candidate id is a content hash, not a counter. Ids were `c-${length+1}`:
 * two processes appending concurrently computed the same next index, and a
 * hand-edited or truncated file renumbered everything after it. The hash covers
 * the fields that make a candidate distinct, so the same candidate always maps
 * to the same id and two different ones never share it (review 0003 Q36).
 *
 * @param {{kind: string, signature: string, evidence: string[], cmd: string|null}} parts
 * @returns {string}
 */
export function lessonIdFor({ kind, signature, evidence = [], cmd = null }) {
  const digest = createHash('sha256')
    .update([kind, signature, ...evidence, cmd ?? ''].join('\n'), 'utf8')
    .digest('hex');
  return `l-${digest.slice(0, 12)}`;
}

/**
 * Truncate an unbounded diff to the evidence budget, keeping the head: the hunk
 * headers that name the files are the part a reader acts on.
 *
 * @param {string} diff
 * @returns {string}
 */
function capFixDiff(diff) {
  const text = String(diff ?? '');
  if (text.length <= FIX_DIFF_BUDGET) return text;
  return `${text.slice(0, FIX_DIFF_BUDGET)}\n… (truncated to ${FIX_DIFF_BUDGET} chars)`;
}

function sameEvidence(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Append one deterministic candidate to the lessons ledger, deduplicating by
 * `(kind, signature, evidence)`.
 *
 * The stored text is redacted before anything else: candidates keep the raw
 * commands that failed, and a command can carry a token. Redaction runs before
 * the signature is hashed so the same failure redacts to the same signature
 * (review 0003 Q36).
 *
 * @param {string} root
 * @param {object} candidate
 * @returns {Promise<object>}
 */
export async function appendLessonCandidate(root, candidate) {
  const { candidates } = await readLessonCandidates(root);
  const kind = String(candidate.kind ?? 'fail-then-fix');
  // Redact first: the signature must be a function of the stored bytes, not of
  // a secret nobody can reproduce (and must never be stored).
  const errorLine = redactText(
    normaliseErrorLine(candidate.errorLine ?? firstErrorLine(candidate.output ?? candidate.summary ?? '')),
  );
  const signature = candidate.signature ?? errorSignature(errorLine);
  const evidence = Array.isArray(candidate.evidence)
    ? candidate.evidence.map((e) => redactText(String(e)).trim()).filter(Boolean)
    : [];
  const cmd = candidate.cmd === null || candidate.cmd === undefined ? null : redactText(String(candidate.cmd));

  const existing = candidates.find(
    (c) =>
      c.kind === kind &&
      c.signature === signature &&
      (sameEvidence(c.evidence ?? [], evidence) || (c.cmd && cmd && c.cmd === cmd && c.evidence?.[0] === evidence[0])),
  );
  if (existing) return existing;

  const paths = Array.isArray(candidate.paths)
    ? [...new Set(candidate.paths.map(String).filter(Boolean))].sort()
    : [];
  const keywords = Array.isArray(candidate.keywords) && candidate.keywords.length > 0
    ? [...new Set(candidate.keywords.map(String).filter(Boolean))]
    : extractKeywords(`${errorLine} ${cmd ?? ''}`, paths);

  const record = {
    v: 1,
    id: candidate.id ?? lessonIdFor({ kind, signature, evidence, cmd }),
    ts: candidate.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    kind,
    signature,
    errorLine,
    summary: redactText(String(candidate.summary ?? (errorLine || `${kind} candidate`))).trim(),
    cmd,
    paths,
    keywords,
    evidence,
    fixDiff: capFixDiff(redactText(candidate.fixDiff ?? '')),
    status: candidate.status ?? 'candidate',
    promotedTo: candidate.promotedTo ?? null,
  };

  await appendCandidateLine(root, record);
  return record;
}

async function diffBetweenTrees(root, fromRef, toRef) {
  if (!fromRef || !toRef || fromRef === toRef) {
    return { paths: [], diff: '' };
  }
  try {
    const [namesOut, diffOut] = await Promise.all([
      exec('git', ['diff', '--name-only', fromRef, toRef, '--', '.', ':(exclude).simt'], {
        cwd: root,
        maxBuffer: 8 << 20,
      }),
      exec('git', ['diff', '--unified=3', fromRef, toRef, '--', '.', ':(exclude).simt'], {
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
 * Scan `.simt/ledger.jsonl` for any fail-then-fix sequences in the session and
 * ensure each is recorded in `.simt/lessons.jsonl`.
 *
 * @param {string} root
 * @param {Array<object>} [entries]
 * @returns {Promise<Array<object>>}
 */
export async function captureFromLedger(root, entries = null) {
  let list = entries;
  if (!Array.isArray(list)) {
    try {
      const { text } = await readStateFile(root, LEDGER_REL, [LEDGER_REL_LEGACY]);
      list = (text ?? '')
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
 * Capture reverted commits from git history into `.simt/lessons.jsonl`.
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
 * Record an ADR-008 `BLOCK` review finding in `.simt/lessons.jsonl`.
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
 * Record an agent-time hook denial (R15) in `.simt/lessons.jsonl`.
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
  // No `**` fallback: a trigger with no paths is a promotion the caller
  // refused, not a lesson about everything. `promoteLesson` rejects those;
  // this renders exactly the paths it was given (review 0003 Q36).
  const paths =
    Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : (Array.isArray(candidate.paths) ? candidate.paths : []);
  const keywords =
    Array.isArray(options.keywords) && options.keywords.length > 0
      ? options.keywords
      : Array.isArray(candidate.keywords) && candidate.keywords.length > 0
        ? candidate.keywords
        : extractKeywords(candidate.errorLine ?? candidate.summary ?? '', paths);
  const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const expires = options.expires ?? defaultExpires();
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
export function parseLessonFile(id, text, now = new Date()) {
  const { front: rawFront, body: rawBody } = splitFrontmatter(text);
  const front = rawFront ?? '';
  const body = rawBody.trim();

  const paths = lessonPaths(text);
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
  const expired = isExpired(expires, now);

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
    expired,
  };
}

/**
 * List the promoted lessons in `docs/lessons/*.md` that are still in force.
 *
 * `simt-expires` is read here, once, so every consumer — recall, `why`, the
 * hook, the bench, `lessons list` — agrees on what has expired. Nothing was
 * reading the field, so expired lessons kept firing indefinitely (review 0003
 * Q36). Pass `includeExpired` to see the retired ones with `expired: true`.
 *
 * @param {string} root
 * @param {{includeExpired?: boolean, now?: Date}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function listPromotedLessons(root, { includeExpired = false, now = new Date() } = {}) {
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
    const lesson = parseLessonFile(id, text, now);
    if (!lesson.expired || includeExpired) lessons.push(lesson);
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
 * Promote a lesson candidate from the lessons ledger to `docs/lessons/NNNN-<slug>.md`.
 *
 * Capture is not promotion's business: `promoteLesson` used to scan the ledger
 * first, so a preview (`review` without `--yes`) wrote to the store it was
 * only reading. Capture is an explicit `lessons capture` now (review 0003 Q36).
 *
 * @param {string} root
 * @param {{id?: string, apply?: boolean, paths?: string[], expires?: string, title?: string, journal?: object[]}} [options]
 * @returns {Promise<{ok: boolean, error?: string, candidate?: object, path?: string, markdown?: string, written?: boolean}>}
 */
export async function promoteLesson(root, options = {}) {
  const { candidates } = await readLessonCandidates(root);
  if (candidates.length === 0) {
    return { ok: false, error: `no lesson candidates in ${LESSONS_FILE}; capture some with: lessons capture` };
  }

  let target = null;
  if (options.id) {
    target = candidates.find(
      (c) => c.id === options.id || c.signature === options.id || c.signature.startsWith(options.id),
    );
    if (!target) {
      return { ok: false, error: `no lesson candidate matching "${options.id}"` };
    }
    if (target.status === 'promoted') {
      return { ok: false, error: `lesson candidate ${target.id} is already promoted to ${target.promotedTo}` };
    }
  } else {
    // A promoted candidate is done: falling back to it re-promotes the same
    // lesson under a new number, which is how one candidate became 0001/0002/0003.
    target = candidates.find((c) => c.status !== 'promoted') ?? null;
    if (!target) {
      return { ok: false, error: 'nothing to promote: every candidate is already promoted' };
    }
  }

  // No `**` default: a trigger that watches every path fires on every failure,
  // which is the same as firing on none. A pathless candidate needs `--paths`.
  const paths = Array.isArray(options.paths) && options.paths.length > 0
    ? options.paths
    : (Array.isArray(target.paths) ? target.paths : []);
  if (paths.length === 0) {
    return { ok: false, error: `lesson candidate ${target.id} names no paths; pass --paths to say what it governs` };
  }

  const num = await nextLessonNumber(root);
  const slug = slugify(options.title ?? target.errorLine ?? target.summary ?? target.kind);
  const relPath = `${LESSONS_DIR}/${num}-${slug}.md`;
  const markdown = renderLessonMarkdown(target, { ...options, paths, expires: options.expires ?? defaultExpires() });

  // The `--diff` before-side, read before anything is written so the diff is true
  // in preview and in apply alike (R50). Always a creation in practice — the
  // number is fresh — but a hand-placed file at the same path would be
  // overwritten, and a diff that claimed a creation there would lie about it.
  let before = null;
  try {
    before = await readFile(join(root, relPath), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (options.apply) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, markdown, 'utf8');
    if (Array.isArray(options.journal)) recordCreatedFile(root, options.journal, join(root, relPath), markdown);
    target.status = 'promoted';
    target.promotedTo = relPath;
    await writeLessonCandidates(root, candidates);
  }

  return {
    ok: true,
    candidate: target,
    path: relPath,
    markdown,
    before,
    written: Boolean(options.apply),
  };
}

/**
 * Format a promoted lesson as a single paragraph for after-tool hook injection (plan 0003 R33).
 *
 * @param {object} lesson
 * @returns {string}
 */
export function formatLessonParagraph(lesson) {
  const id = String(lesson?.id ?? 'lesson').trim();
  const title = String(lesson?.title ?? id).replace(/\s+/g, ' ').trim();
  const body = String(lesson?.paragraph ?? '').replace(/\s+/g, ' ').trim();
  if (!body || body === title) {
    return `Lesson ${id}: ${title}`;
  }
  return `Lesson ${id} (${title}): ${body}`;
}

function hashLine(line) {
  const norm = normaliseErrorLine(line);
  return `sha256-${createHash('sha256').update(norm, 'utf8').digest('hex')}`;
}

function firstDefinedNumber(values) {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function extractFailureSignals(payloadOrOutput) {
  if (typeof payloadOrOutput === 'string') {
    const trimmed = payloadOrOutput.trim();
    if (!trimmed) return { failed: false, reason: 'empty tool output', signatures: [] };
    const sigs = new Set([errorSignature(trimmed)]);
    for (const line of trimmed.split(/\r?\n/)) {
      const norm = normaliseErrorLine(line);
      if (norm) sigs.add(hashLine(norm));
    }
    return { failed: true, signatures: [...sigs] };
  }

  if (!payloadOrOutput || typeof payloadOrOutput !== 'object') {
    return { failed: false, reason: 'empty tool output', signatures: [] };
  }

  const p = payloadOrOutput;
  const resp =
    p.tool_response ?? p.tool_output ?? p.tool_result ?? p.toolResponse ?? null;
  const respObj = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp : {};

  const exitCode = firstDefinedNumber([
    p.exit_code,
    p.exitCode,
    p.exit,
    p.status,
    respObj.exit_code,
    respObj.exitCode,
    respObj.exit,
    respObj.status,
    respObj.code,
  ]);
  const isError =
    p.is_error ?? p.isError ?? respObj.is_error ?? respObj.isError ?? undefined;

  if (exitCode === 0 && isError !== true) {
    return { failed: false, reason: 'the tool call exited 0', signatures: [] };
  }
  if (isError === false && exitCode === undefined) {
    return { failed: false, reason: 'the tool call reported no error', signatures: [] };
  }

  const sigs = new Set();
  for (const rawSig of [p.signature, respObj.signature]) {
    if (typeof rawSig === 'string' && rawSig.startsWith('sha256-')) {
      sigs.add(rawSig.trim());
    }
  }

  for (const errLine of [p.errorLine, respObj.errorLine]) {
    if (typeof errLine === 'string' && errLine.trim()) {
      sigs.add(hashLine(errLine));
      sigs.add(errorSignature(errLine));
    }
  }

  const textParts = [];
  if (typeof resp === 'string') textParts.push(resp);
  for (const field of [
    respObj.stderr,
    respObj.stdout,
    respObj.output,
    respObj.error,
    respObj.text,
    typeof respObj.content === 'string'
      ? respObj.content
      : Array.isArray(respObj.content)
        ? respObj.content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n')
        : '',
    p.stderr,
    p.stdout,
    p.output,
    p.error,
    p.summary,
  ]) {
    if (typeof field === 'string' && field.trim()) textParts.push(field);
  }

  if (typeof p.summary === 'string') {
    const inner =
      /^\d+\s+fail\s+\((.+)\)$/.exec(p.summary.trim())?.[1] ??
      /^exit\s+-?\d+\s+\((.+)\)$/.exec(p.summary.trim())?.[1];
    if (inner) {
      sigs.add(hashLine(inner));
      sigs.add(errorSignature(inner));
    }
  }

  const combined = textParts.join('\n').trim();
  if (combined) {
    sigs.add(errorSignature(combined));
    for (const line of combined.split(/\r?\n/)) {
      const norm = normaliseErrorLine(line);
      if (norm) sigs.add(hashLine(norm));
    }
  }

  if (sigs.size === 0) {
    return { failed: false, reason: 'the payload carries no failing tool output', signatures: [] };
  }

  return { failed: true, signatures: [...sigs] };
}

/**
 * Match a failing tool output or replayed failure payload against promoted lessons by error signature.
 *
 * @param {Array<object>} lessons
 * @param {string|object} payloadOrOutput
 * @returns {{lesson: object, paragraph: string, signature: string}|null}
 */
export function matchLessonByOutput(lessons, payloadOrOutput) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const signals = extractFailureSignals(payloadOrOutput);
  if (!signals.failed || signals.signatures.length === 0) return null;

  const sigSet = new Set(signals.signatures);
  for (const lesson of lessons) {
    if (lesson?.signature && sigSet.has(lesson.signature)) {
      return {
        lesson,
        paragraph: formatLessonParagraph(lesson),
        signature: lesson.signature,
      };
    }
  }
  return null;
}

/**
 * Recall and inject a matching lesson as one paragraph when an after-tool hook (`post-tool-use`)
 * sees failing output whose signature matches a promoted lesson in `docs/lessons/*.md` (plan 0003 R33).
 *
 * @param {object} row harness adapter row from `src/agenthooks/render.mjs`
 * @param {object} payload hook stdin JSON payload
 * @param {{root?: string}} [options]
 * @returns {Promise<{json?: object, root?: string, lesson?: object, paragraph?: string, signature?: string, skipped?: string}>}
 */
export async function deliverLessonRecall(row, payload, options = {}) {
  const root = row?.root?.(payload) ?? payload?.root ?? options.root ?? process.cwd();
  const signals = extractFailureSignals(payload);
  if (!signals.failed) {
    return { skipped: signals.reason ?? 'no failing tool output' };
  }

  const lessons = await listPromotedLessons(root);
  if (lessons.length === 0) {
    return { skipped: 'no promoted lessons in docs/lessons' };
  }

  const matched = matchLessonByOutput(lessons, payload);
  if (!matched) {
    return { skipped: 'no lesson matches the failure signature' };
  }

  const json = postDeliveryJson(row, matched.paragraph);
  if (json === null) {
    return { skipped: `${row?.id ?? 'harness'} has no post-tool event that can inject` };
  }

  return {
    json,
    root,
    lesson: matched.lesson,
    paragraph: matched.paragraph,
    signature: matched.signature,
  };
}
