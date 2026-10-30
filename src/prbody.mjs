// The `simt pr-body` engine (plan 0003 R55).
//
// A pull request body assembled from what the tool already knows, rather than
// what its author remembers to write: the evidence block from the ledger (R17),
// the decision records the diff touches, the gate state from the last check,
// and the residual risk in ADR-008's verdict vocabulary. Read-only throughout:
// it names the tree, reads the ledger, reads the check cache and diffs names,
// and writes nothing, so it needs no preview, no `--yes` and no journal entry.
//
// The base defaults to the branch's upstream fork point (`origin/main`, then
// `main`), and `--base` names anything else. When no base resolves, the body
// falls back to the working-tree diff against HEAD: a report that refused
// without a base would be useless on a repository with a single branch.

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readLedger, treeId } from './ledger/index.mjs';
import { readCheckCache } from './status.mjs';
import { readManifest } from './projection/manifest.mjs';
import { splitFrontmatter } from './memory/decide.mjs';
import { decisionsDir } from './decisions/dir.mjs';

const exec = promisify(execFile);

/**
 * The ref the body diffs against: the override when given, else the first
 * candidate that shares history with HEAD. Returns the ref, or null when the
 * repository has a single branch and the body should diff the worktree.
 */
async function resolveBase(root, override = null) {
  if (override !== null && override !== undefined && String(override) !== '') {
    try {
      await exec('git', ['rev-parse', '--verify', '--quiet', `${override}^{commit}`], { cwd: root });
      return { base: String(override), error: null };
    } catch {
      return { base: null, error: `unknown base ${override}` };
    }
  }
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      await exec('git', ['merge-base', 'HEAD', candidate], { cwd: root });
      return { base: candidate, error: null };
    } catch {
      // Not present or shares no history; the next candidate may.
    }
  }
  return { base: null, error: null };
}

/**
 * Every path the pull request would carry: the branch range when there is a
 * base, plus whatever the worktree adds on top. Sorted, deduplicated, and
 * without `.simt/` state: the ledger and the check cache prove the body, they
 * are not its content.
 */
async function changedPaths(root, base) {
  const paths = new Set();
  const add = (stdout) => {
    for (const line of String(stdout ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '' && !trimmed.startsWith('.simt/')) paths.add(trimmed);
    }
  };
  if (base !== null) {
    try {
      const { stdout } = await exec('git', ['diff', '--name-only', `${base}...HEAD`], {
        cwd: root,
        maxBuffer: 16 << 20,
      });
      add(stdout);
    } catch {
      // An unborn HEAD or an unreadable range contributes nothing; the worktree
      // reads below still answer.
    }
  }
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    try {
      const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 16 << 20 });
      add(stdout);
    } catch {
      // Not a repository, or no commit yet: the body reports the absence.
    }
  }
  return [...paths].sort();
}

/**
 * The decision records the diff touches: one entry per `docs/decisions/*.md`
 * in the changed paths, carrying the id from the filename and the title and
 * status from the file itself. Sorted by id; a file that will not parse is
 * reported with what it has rather than dropping the row.
 */
async function changedDecisions(root, paths) {
  // Q55: the prefix is the repository's own decisions directory, not a literal.
  const relDir = await decisionsDir(root);
  const absDir = join(root, relDir);
  const names = paths.filter((p) => p.startsWith(`${relDir}/`) && p.toLowerCase().endsWith('.md'));
  try {
    await readdir(absDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const id = /^ADR-\d{3,}/i.exec(name.slice(relDir.length + 1))?.[0].toUpperCase() ?? name;
    let title = id;
    let status = 'unknown';
    try {
      const text = await readFile(join(root, name), 'utf8');
      const { body } = splitFrontmatter(text);
      const heading = /^#\s+(.*)$/m.exec(body)?.[1] ?? id;
      title = heading.replace(/^ADR-\d{3,}\s*[—–-]\s*/i, '').trim() || id;
      status = /^Status:\s*(.+)$/im.exec(body)?.[1].trim() ?? 'unknown';
    } catch {
      // An unreadable record is still a changed decision; the body says so
      // rather than silently omitting a file the diff names.
    }
    out.push({ path: name, id, title, status });
  }
  return out;
}

/**
 * Assemble the whole body. Never throws for a missing ledger, cache or base:
 * each absence is a line in the report, because a PR body whose evidence is
 * missing is precisely the case the residual-risk section exists to say out loud.
 */
export async function buildPrBody(root, { base = null } = {}) {
  const resolved = await resolveBase(root, base);
  if (resolved.error !== null) return { error: resolved.error };

  let tree = null;
  let treeError = null;
  try {
    tree = await treeId(root);
  } catch (error) {
    treeError = String(error.message ?? error);
  }

  let entries = [];
  let ledgerErrors = [];
  try {
    const ledger = await readLedger(root);
    entries = tree === null ? [] : ledger.entries.filter((e) => e.tree === tree);
    ledgerErrors = ledger.errors;
  } catch (error) {
    ledgerErrors = [String(error.message ?? error)];
  }

  const cache = await readCheckCache(root).catch(() => null);
  const { manifest } = await readManifest(root).catch(() => ({ manifest: null }));
  const declared = [
    ...(manifest?.gates?.preCommit ?? []),
    ...(manifest?.gates?.prePush ?? []),
  ];
  const evidenceMode = manifest?.gates?.evidence;

  const paths = await changedPaths(root, resolved.base);
  const decisions = await changedDecisions(root, paths);

  const passing = entries.filter((e) => e.exit === 0);
  const unreviewed = [];
  if (tree === null) unreviewed.push(`the tree could not be named (${treeError ?? 'not a git repository'})`);
  else if (passing.length === 0) unreviewed.push('no passing run is recorded for this tree');
  if (cache === null) unreviewed.push('gate state unmeasured (no check has run)');
  for (const error of ledgerErrors) unreviewed.push(`ledger unreadable: ${error}`);

  // ADR-008's vocabulary, exactly: BLOCK for a known failure, APPROVE WITH
  // RESIDUAL RISK when the review budget ran out before something was read,
  // APPROVE only when everything was. The constraint travels with the verdict:
  // a residual-risk body never converts a known failure into an approval.
  const blocking = cache?.blocking ?? 0;
  const verdict = blocking > 0 ? 'BLOCK' : unreviewed.length > 0 ? 'APPROVE WITH RESIDUAL RISK' : 'APPROVE';

  return {
    error: null,
    base: resolved.base,
    tree,
    evidence: { entries, errors: ledgerErrors },
    decisions,
    paths,
    gates: {
      declared,
      evidenceMode: evidenceMode ?? null,
      run: cache === null ? null : { gatesRun: cache.gatesRun, gatesTotal: cache.gatesTotal },
      rulesOk: cache?.rulesOk ?? null,
      hooksOk: cache?.hooksOk ?? null,
      blocking,
      warnings: cache?.warnings ?? 0,
      cached: cache !== null,
    },
    verdict,
    unreviewed,
  };
}

/**
 * The markdown body: four sections in a fixed order — evidence, changed
 * decisions, gates, residual risk — so a snapshot can pin it byte for byte.
 */
export function renderPrBody(report) {
  const lines = [];
  lines.push('## Evidence');
  lines.push('');
  if (report.tree === null) {
    lines.push('No tree recorded: run this inside a git repository.');
  } else if (report.evidence.entries.length === 0) {
    lines.push(`tree ${report.tree}`);
    lines.push('No run is recorded for this tree.');
  } else {
    lines.push(`tree ${report.tree}`);
    lines.push('');
    for (const e of report.evidence.entries) {
      lines.push(`- ${e.exit === 0 ? 'pass' : 'fail'} \`${e.cmd}\` (exit ${e.exit}, ${e.summary})`);
    }
  }
  for (const error of report.evidence.errors) lines.push(`- ledger error: ${error}`);
  lines.push('');
  lines.push('## Changed decisions');
  lines.push('');
  if (report.decisions.length === 0) {
    lines.push(`None${report.base === null ? ' (worktree diff against HEAD)' : ` (range ${report.base}...HEAD, plus worktree)`}.`);
  } else {
    for (const d of report.decisions) lines.push(`- ${d.id} — ${d.title} (${d.status})`);
  }
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  if (report.gates.cached) {
    const g = report.gates;
    lines.push(`- rules: ${g.rulesOk ? 'ok' : 'failing'}, hooks: ${g.hooksOk ? 'ok' : 'failing'}`);
    lines.push(`- gates run: ${g.run.gatesRun}/${g.run.gatesTotal}, blocking: ${g.blocking}, warnings: ${g.warnings}`);
    if (g.declared.length > 0) lines.push(`- declared: ${g.declared.join(', ')}`);
  } else {
    lines.push('No check has run: gate state unmeasured.');
  }
  lines.push('');
  lines.push('## Residual risk (ADR-008)');
  lines.push('');
  lines.push(`Verdict: ${report.verdict}`);
  if (report.unreviewed.length > 0) {
    lines.push('');
    lines.push('Not reviewed:');
    for (const item of report.unreviewed) lines.push(`- ${item}`);
  }
  return `${lines.join('\n')}\n`;
}
