// The probe ledger: the git and node commands a probe runs, and the JSONL it appends.
//
// A probe measures whether an agent follows a rule by running a workspace and reading
// the commands it issued. The catalogue references these helpers, and the runner writes
// the same ledger, so they live beside neither: one module both import (review 0003 Q80).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { sanitizedEnv, spawnBounded } from '../sys/proc.mjs';
import { LOCAL_DIR } from '../state.mjs';

export const PROBE_AGENT_TIMEOUT_MS = 120_000;
export const PROBE_COMMAND_TIMEOUT_MS = 120_000;


export async function runGit(args, { cwd, env = {} } = {}) {
  const outcome = await spawnBounded('git', args, {
    cwd,
    env: sanitizedEnv(env),
    timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
  });
  return {
    code: outcome.code,
    stdout: outcome.stdout.toString('utf8'),
    stderr: outcome.stderr.toString('utf8'),
  };
}


export async function runNode(args, { cwd, env = {} } = {}) {
  const outcome = await spawnBounded(process.execPath, args, {
    cwd,
    env: sanitizedEnv(env),
    timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
  });
  return {
    code: outcome.code,
    stdout: outcome.stdout.toString('utf8'),
    stderr: outcome.stderr.toString('utf8'),
  };
}

/**
 * Read `.simt/local/ledger.jsonl` from `workDir` if present.
 *
 * @param {string} workDir
 * @returns {Promise<Array<object>>}
 */


/**
 * Read `.simt/local/ledger.jsonl` from `workDir` if present.
 *
 * @param {string} workDir
 * @returns {Promise<Array<object>>}
 */
export async function readLedgerEntries(workDir) {
  const ledgerPath = join(workDir, LOCAL_DIR, 'ledger.jsonl');
  try {
    const text = await readFile(ledgerPath, 'utf8');
    const entries = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // ignore malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Append a ledger entry to `.simt/local/ledger.jsonl` in `workDir`.
 */


/**
 * Append a ledger entry to `.simt/local/ledger.jsonl` in `workDir`.
 */
export async function appendLedgerEntry(workDir, entry) {
  const ledgerPath = join(workDir, LOCAL_DIR, 'ledger.jsonl');
  await mkdir(dirname(ledgerPath), { recursive: true });
  const treeRes = await runGit(['write-tree'], { cwd: workDir });
  const record = {
    v: 1,
    ts: new Date().toISOString(),
    tree: treeRes.stdout.trim(),
    cmd: entry.cmd,
    exit: entry.exit ?? 0,
    ms: entry.ms ?? 10,
    outputDigest: entry.outputDigest ?? 'sha256-0000000000000000',
    summary: entry.summary ?? '1 pass, 0 fail',
  };
  const prev = await readFile(ledgerPath, 'utf8').catch(() => '');
  await writeFile(ledgerPath, `${prev}${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Extract shell commands from an agent transcript or command list.
 *
 * @param {{commands?: string[], stdout?: string, stderr?: string, ledger?: Array<{cmd?: string}>}} ctx
 * @returns {string[]}
 */


/** How long one agent-backed probe may run before its workspace is reclaimed. */

/** The deadline for one workspace-side git or node command inside a probe. */
export function extractTranscriptCommands(ctx = {}) {
  const cmds = [];
  if (Array.isArray(ctx.commands)) {
    for (const c of ctx.commands) {
      if (typeof c === 'string' && c.trim()) cmds.push(c.trim());
    }
  }
  if (Array.isArray(ctx.ledger)) {
    for (const entry of ctx.ledger) {
      if (typeof entry?.cmd === 'string' && entry.cmd.trim()) cmds.push(entry.cmd.trim());
    }
  }
  const text = `${ctx.stdout ?? ''}\n${ctx.stderr ?? ''}`;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const dollarMatch = /^\$\s+(.+)$/.exec(trimmed);
    if (dollarMatch) cmds.push(dollarMatch[1].trim());
  }
  return cmds;
}

/**
 * The 12 synthetic compliance probes (R05).
 */

/**
 * Create an isolated git workspace for `probe`, materialise `armSpec` if supplied,
 * commit the baseline `initialHead`, and run any post-commit setup (such as hooks,
 * remotes, or dirty untracked files).
 *
 * @param {object} probe
 * @param {{armSpec?: object, parentDir?: string}} [options]
 * @returns {Promise<{slotDir: string, workDir: string, initialHead: string}>}
 */
