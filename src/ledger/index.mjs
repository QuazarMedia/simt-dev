// The evidence ledger (ADR-087).
//
// A passing command is evidence about one tree and no other. The tree is taken with a
// private index, because `git add -A` on the real index would stage work the author had
// left unstaged. Editing any file afterwards produces a different tree, so the old line
// no longer proves anything about what is on disk now.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  LESSONS_FILE,
  errorSignature,
  firstErrorLine,
  normaliseErrorLine,
  recordFailThenFix,
} from '../memory/lessons.mjs';

const exec = promisify(execFile);

const LEDGER_FILE = '.simt/ledger.jsonl';

/** Phrases that claim a run happened. `unverified` and `not verified` are removed
 *  first, because both contain the word and neither is a claim. Trailers
 *  (Signed-off-by and friends) are ignored, because they describe the commit,
 *  not the run (review 0003 Q18). */
const CLAIM =
  /\btests?\s+pass(?:ed|ing)?\b|\btest\s+suite\s+(?:is\s+)?green\b|\bsuite\s+is\s+green\b|\bnpm\s+test\s+pass(?:es|ed)?\b|\bverified\b/i;
const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|fixes|closes)\s*:/i;

/**
 * The tree of everything in the worktree, without staging any of it.
 *
 * @param {string} root
 * @returns {Promise<string>} the write-tree id
 */
export async function treeId(root) {
  const dir = await mkdtemp(join(tmpdir(), 'tree-index-'));
  const index = join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // The ledger is a record of the tree, so it cannot be part of the tree it names.
    // `git add -A` would take it once the file exists, and the line would prove a
    // tree that stopped existing when the line was written.
    await exec(
      'git',
      ['add', '-A', '--', '.', `:(exclude)${LEDGER_FILE}`, `:(exclude)${LESSONS_FILE}`],
      { cwd: root, env },
    );
    const { stdout } = await exec('git', ['write-tree'], { cwd: root, env });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Append one run. The output itself is not stored: the digest is enough to notice a
 * change, and a ledger that kept logs would keep whatever the command printed.
 */
/** The staged tree (`git write-tree` on the real index): what a commit-msg
 *  check must match, because the commit records the index, not the worktree.
 *  Null when git cannot answer; the caller then falls back to the worktree tree. */
export async function indexTreeId(root) {
  try {
    const { stdout } = await exec('git', ['write-tree'], { cwd: root });
    const tree = String(stdout ?? '').trim();
    return /^[0-9a-f]{40}$/.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

export async function recordRun(root, { cmd, exit, ms, output, gate = null, kind = null }) {
  const { entries: prior } = await readLedger(root).catch(() => ({ entries: [] }));
  const worktreeTree = await treeId(root);
  const indexTree = await indexTreeId(root);
  const line = {
    v: 2,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tree: worktreeTree,
    worktreeTree,
    ...(indexTree !== null ? { indexTree } : {}),
    ...(typeof gate === 'string' ? { gate } : {}),
    ...(typeof kind === 'string' ? { kind } : {}),
    cmd,
    exit,
    ms,
    outputDigest: `sha256-${createHash('sha256').update(output).digest('hex')}`,
    summary: summarise(output, exit),
    ...(exit !== 0
      ? {
          errorLine: normaliseErrorLine(firstErrorLine(output)),
          signature: errorSignature(output),
        }
      : {}),
  };
  await mkdir(join(root, '.simt'), { recursive: true });
  await appendFile(join(root, LEDGER_FILE), `${JSON.stringify(line)}\n`);

  if (exit === 0 && typeof cmd === 'string') {
    let pendingFail = null;
    for (const entry of prior) {
      if (entry.cmd !== cmd) continue;
      if (entry.exit !== 0) {
        if (!pendingFail) pendingFail = entry;
      } else {
        pendingFail = null;
      }
    }
    if (pendingFail) {
      await recordFailThenFix(root, { failEntry: pendingFail, passEntry: line }).catch(() => {});
    }
  }

  return line;
}

/** Every well-formed line. A line that does not parse is returned as an error so a
 *  damaged ledger cannot look empty. */
export async function readLedger(root) {
  let text;
  try {
    text = await readFile(join(root, LEDGER_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], errors: [] };
    throw error;
  }
  const entries = [];
  const errors = [];
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    try {
      const line = JSON.parse(raw);
      if (typeof line.tree !== 'string' || typeof line.exit !== 'number') {
        errors.push(`line ${i + 1} has no tree or exit`);
        continue;
      }
      entries.push(line);
    } catch (error) {
      errors.push(`line ${i + 1} does not parse (${error.message})`);
    }
  }
  return { entries, errors };
}

/** Whether the entry counts as a test-kind run (review 0003 Q18). v1 lines
 *  carry no kind, so a command naming test counts; v2 lines use the recorded kind. */
export function isTestKind(entry) {
  if (typeof entry?.kind === 'string') return entry.kind === 'test';
  return typeof entry?.cmd === 'string' && /\btest\b/i.test(entry.cmd);
}

/** A passing test-kind entry for `tree` with no later failure of the same
 *  command on the same tree. v1 lines (no `kind`) keep today's reading: any
 *  passing entry for the tree counts, so old ledgers do not go red. */
export function hasTestEvidence(entries, tree) {
  const scoped = entries.filter((e) => e.tree === tree || e.worktreeTree === tree || e.indexTree === tree);
  for (let i = 0; i < scoped.length; i += 1) {
    const candidate = scoped[i];
    if (candidate.exit !== 0) continue;
    const legacy = candidate.v !== 2 || candidate.kind === undefined || candidate.kind === null;
    if (!legacy && !isTestKind(candidate)) continue;
    const laterFailure = scoped
      .slice(i + 1)
      .some((later) => later.cmd === candidate.cmd && later.exit !== 0);
    if (!laterFailure) return true;
  }
  return false;
}

export function claimsVerification(message) {
  const lines = String(message).split('\n').filter((line) => !TRAILER.test(line.trim()));
  const text = lines
    .join('\n')
    .replace(/\bunverified\b/gi, ' ')
    .replace(/\bnot\s+verified\b/gi, ' ');
  return CLAIM.test(text);
}

/** `block` fails the commit. Anything unset is a warning. A third spelling is an
 *  error, because a typo for `block` must not quietly warn. */
export function evidenceMode(manifest) {
  const value = manifest?.gates?.evidence;
  if (value === undefined || value === 'warn') return 'warn';
  if (value === 'block') return 'block';
  return null;
}

function summarise(output, exit) {
  const pass = /(\d+)\s+pass\b/.exec(output) ?? /\bpass\s+(\d+)/.exec(output);
  const fail = /(\d+)\s+fail\b/.exec(output) ?? /\bfail\s+(\d+)/.exec(output);
  if (pass || fail) return `${pass?.[1] ?? 0} pass, ${fail?.[1] ?? 0} fail`;
  return `exit ${exit}`;
}
