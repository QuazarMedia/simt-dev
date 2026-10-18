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

const exec = promisify(execFile);

export const LEDGER_FILE = '.simt-dev/ledger.jsonl';

/** Phrases that claim a run happened. `unverified` and `not verified` are removed
 *  first, because both contain the word and neither is a claim. */
const CLAIM = /\btests?\s+pass(?:ed)?\b|\bverified\b/i;

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
    await exec('git', ['add', '-A', '--', '.', ':(exclude).simt-dev/ledger.jsonl'], { cwd: root, env });
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
export async function recordRun(root, { cmd, exit, ms, output }) {
  const line = {
    v: 1,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tree: await treeId(root),
    cmd,
    exit,
    ms,
    outputDigest: `sha256-${createHash('sha256').update(output).digest('hex')}`,
    summary: summarise(output, exit),
  };
  await mkdir(join(root, '.simt-dev'), { recursive: true });
  await appendFile(join(root, LEDGER_FILE), `${JSON.stringify(line)}\n`);
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

export function claimsVerification(message) {
  const text = String(message).replace(/\bunverified\b/gi, ' ').replace(/\bnot\s+verified\b/gi, ' ');
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
