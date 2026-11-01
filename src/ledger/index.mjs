// The evidence ledger (ADR-087).
//
// A passing command is evidence about one tree and no other. The tree is taken with a
// private index, because `git add -A` on the real index would stage work the author had
// left unstaged. Editing any file afterwards produces a different tree, so the old line
// no longer proves anything about what is on disk now.

import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  errorSignature,
  firstErrorLine,
  normaliseErrorLine,
  recordFailThenFix,
} from '../memory/lessons.mjs';
import { TREE_EXCLUDES, localRel, readStateFile } from '../state.mjs';
import { appendEvent } from '../state/events.mjs';
import { LEDGER_FILE_LEGACY, LEDGER_FILE_REL } from '../name.mjs';
import { git, gitText } from '../sys/git.mjs';

export const LEDGER_FILE = localRel(LEDGER_FILE_REL);

/** Phrases that claim a run happened. `unverified` and `not verified` are removed
 *  first, because both contain the word and neither is a claim. Trailers
 *  (Signed-off-by and friends) are ignored, because they describe the commit,
 * not the run. */
const CLAIM =
  /\btests?\s+pass(?:ed|ing)?\b|\btest\s+suite\s+(?:is\s+)?green\b|\bsuite\s+is\s+green\b|\bnpm\s+test\s+pass(?:es|ed)?\b|\bverified\b/i;
const TRAILER = /^(signed-off-by|co-authored-by|reviewed-by|acked-by|tested-by|fixes|closes)\s*:/i;

/**
 * Copy the repository's real index into a private one, and answer its path or null.
 *
 * The private index exists so `git add -A` cannot stage the author's work. Building it from
 * nothing meant every path was hashed on every gate run, commit-msg check, `evidence` call
 * and `pr-body`: on a 20k-file tree that is the whole cost of the command . Seeding it
 * from the index git already maintains turns the hash into a no-op for every unchanged
 * path, and the `add -A` afterwards only has the worktree diff left to do.
 *
 * A repository with no index yet (a fresh `git init`) is not an error: there is nothing to
 * copy, and the add builds it from empty exactly as before.
 *
 * @param {string} root
 * @param {string} target the private index file to populate
 * @returns {Promise<string|null>} the source index, or null when there is none
 */
export async function seedIndex(root, target) {
  try {
    const stdout = await gitText(root, ['rev-parse', '--git-path', 'index']);
    const from = resolve(root, stdout ?? '');
    await copyFile(from, target);
    return from;
  } catch {
    return null;
  }
}

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
    // Seed before the add: the add then only hashes what actually changed .
    await seedIndex(root, index);
    // Machine-local state is a record of the tree, so it cannot be part of the
    // tree it names. `git add -A` would take it once the file exists, and the
    // line would prove a tree that stopped existing when the line was written
    //
    // Where .gitignore already keeps a path out of the index, the pathspec
    // would name an ignored path, and `git add` refuses it ("use -f") - and -f
    // would force the very state back into the tree. The excludes therefore
    // carry only the paths git does not already ignore.
    const ignored = await ignoredSet(root, TREE_EXCLUDES);
    const excludes = TREE_EXCLUDES.filter((p) => !ignored.has(p)).map((p) => `:(exclude)${p}`);
    await git(root, ['add', '-A', '--', '.', ...excludes], { env });
    return await gitText(root, ['write-tree'], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The paths git already ignores, so the exclude pathspecs do not name them.
 * A repository with no .gitignore ignores nothing, and every exclude ships
 * exactly as before.
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {Promise<Set<string>>}
 */
async function ignoredSet(root, paths) {
  try {
    const stdout = await git(root, ['check-ignore', ...paths]);
    return new Set(String(stdout).split('\n').filter(Boolean));
  } catch {
    // `check-ignore` exits 1 when nothing is ignored - the common case, not an
    // error. Failing to the full exclude list is the pre-filter behaviour.
    return new Set();
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
    const tree = await gitText(root, ['write-tree']);
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
    command: cmd,
    exit,
    ms,
    wallMs: ms,
    outputDigest: `sha256-${createHash('sha256').update(output).digest('hex')}`,
    summary: summarise(output, exit),
    ...(exit !== 0
      ? {
          errorLine: normaliseErrorLine(firstErrorLine(output)),
          signature: errorSignature(output),
        }
      : {}),
  };
  await mkdir(join(root, '.simt', 'local'), { recursive: true });
  await appendFile(join(root, LEDGER_FILE), `${JSON.stringify(line)}\n`);
  // The same record in the log every other store writes to : a tailing consumer has
  // one file to follow, and a ledger line lost to rotation is still recoverable here.
  await appendEvent(root, {
    kind: 'gate.finished',
    tree: worktreeTree,
    subject: typeof cmd === 'string' ? cmd : null,
    data: { ...(gate === null ? {} : { gate }), ...(kind === null ? {} : { kind }), line },
  });

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

  await rotateLedger(root).catch(() => {});
  return line;
}

/**
 * Read only the end of the ledger.
 *
 * `recordRun` and every evidence check read the whole file, and the file grows without a
 * bound: a repository that runs a suite a hundred times a day pays for a year of lines on
 * every commit . A tail read answers the only question those callers ask - what
 * happened recently on which trees - in bounded time.
 *
 * The first line of the slice is dropped unless the slice starts at byte 0, because a byte
 * offset lands mid-line and half a JSON object is not evidence.
 */
export async function readLedgerTail(root, { entries = 200, bytes = 128 * 1024 } = {}) {
  const path = join(root, LEDGER_FILE);
  let text = '';
  let partial = false;
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - bytes);
    partial = start > 0;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(st.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { entries: [], errors: [], partial: false };
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (partial && lines.length > 0) lines.shift();
  const parsed = [];
  const errors = [];
  for (const raw of lines) {
    try {
      const line = JSON.parse(raw);
      if (typeof line.tree === 'string' && typeof line.exit === 'number') parsed.push(line);
      else errors.push('a line has no tree or exit');
    } catch (error) {
      errors.push(`a line does not parse (${error.message})`);
    }
  }
  return { entries: parsed.slice(-entries), errors, partial };
}

/**
 * Keep the ledger bounded: past `maxLines`, the older half moves to `<ledger>.1`.
 *
 * Rotation rather than deletion because the ledger is evidence: an archived line is still
 * readable, and the event log holds the same record independently . Keeping half
 * rather than `maxLines` means rotation happens every `maxLines/2` appends instead of on
 * every one.
 */
export async function rotateLedger(root, { maxLines = 5000 } = {}) {
  const path = join(root, LEDGER_FILE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { rotated: false };
    throw error;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length <= maxLines) return { rotated: false };
  const keep = Math.max(1, Math.floor(maxLines / 2));
  const archived = lines.slice(0, lines.length - keep);
  const kept = lines.slice(lines.length - keep);
  await writeFile(join(root, `${LEDGER_FILE}.1`), `${archived.join('\n')}\n`, 'utf8');
  await writeFile(path, `${kept.join('\n')}\n`, 'utf8');
  return { rotated: true, archived: archived.length, kept: kept.length };
}

/** Every well-formed line. A line that does not parse is returned as an error so a
 *  damaged ledger cannot look empty. */
export async function readLedger(root) {
  // The pre-move path is a fallback for one release.
  const { text } = await readStateFile(root, LEDGER_FILE, [LEDGER_FILE_LEGACY]);
  if (text === null) return { entries: [], errors: [] };
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

/** Whether the entry counts as a test-kind run. v1 lines
 *  carry no kind, so a command naming test counts; v2 lines use the recorded kind. */
function isTestKind(entry) {
  if (typeof entry?.kind === 'string') return entry.kind === 'test';
  return typeof entry?.cmd === 'string' && /\btest\b/i.test(entry.cmd);
}

/**
 * The surviving passing entry for one gate on one staged tree, or null.
 *
 * A later failure for the same gate on the same tree cancels the pass, the
 * way `hasTestEvidence` cancels a test pass — a gate that passed, then
 * failed, proves nothing about the tree. Entries without an `indexTree`
 * predate the staged-tree record and never match: a pass on an unknown tree
 * is not evidence for this one.
 */
export function passEntryForGate(entries, gate, tree) {
  const scoped = (entries ?? []).filter((e) => e?.gate === gate && e?.indexTree === tree);
  for (let i = 0; i < scoped.length; i += 1) {
    if (scoped[i].exit !== 0) continue;
    const laterFailure = scoped.slice(i + 1).some((later) => later.exit !== 0);
    if (!laterFailure) return scoped[i];
  }
  return null;
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
