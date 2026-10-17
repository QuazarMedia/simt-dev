// The shared half of a workspace's rules, and the user-level files that carry it.
//
// Review 0002 S38 measured seven repositories carrying 90 KB of always-on rules of
// which 64 KB — 72% — was a paragraph an earlier root had already loaded. The fix is not
// a smaller region; it is carrying the repeated half once, in a file every reader in the
// estate loads before they open a repository.
//
// FOUR DECISIONS, each with a cost. All four are settled in ADR-084; they are written out
// here because the code is where the next change will look.
//
//   1. THE SHARED UNIT IS A RULE, NOT A PARAGRAPH. `simt rules show <id>` prints one
//      rule; a rule split across a user file and a region cannot be read by one command,
//      and the review's own accept criterion says every rule stays reachable. The meter's
//      `paragraphs()` is the unit that REPORTS redundancy, not the unit that stores it.
//
//   2. A RULE IS SHAREABLE ONLY IF EVERY ROOT IN THE WORKSPACE SHIPS THE SAME BYTES.
//      Union would put a python rule in front of a java repository; the intersection is
//      the only set that cannot. Bytes, not ids: a rule two roots render differently —
//      inferability having dropped a line in one of them — is not shareable, and comparing
//      the rendered frame is how that is found rather than assumed.
//
//   3. THE IDS LIVE IN EACH REPOSITORY'S MANIFEST, not in the shared file and not in the
//      workspace config. A repository's region must be a pure function of that
//      repository, or `check` in CI — where nobody has installed anything — disagrees
//      with the reader's own session. That also means `sync` never reads `$HOME`, which
//      `harness.mjs`'s comment forbids for anything a projection depends on.
//
//   4. THE TARGET LIST IS THE LOADER TABLE'S, not a second list of paths. Plan 0003 R11
//      named `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`; the
//      table (`src/projection/loaders.mjs`, every row citing a vendor document) records
//      `~/.claude/rules/*.md` and `~/.gemini/config/rules/*.md` instead, and records no
//      user-level file at all for Cursor or Copilot. A path this tool writes to and a
//      reader's harness never loads buys nothing and costs a directory.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CLI } from '../name.mjs';
import { caps, loader } from './loaders.mjs';
import { composeShared, diff as diffRegion, inject, parse } from './markers.mjs';
import { byPriorityThenId, desiredRegion, provenanceDigest } from './rules.mjs';
import { discover } from '../compare/discover.mjs';

/**
 * The filename this tool claims inside a reader's flat user rules directory.
 *
 * `simt` rather than `simt-dev`, for the reason in `src/name.mjs`: a command name appears
 * in text this tool writes and nowhere else, while the on-disk names stay locked. Naming
 * the file for the command that wrote it is what lets a reader who finds it in their home
 * directory tell which tool put it there.
 */
const SHARED_BASENAME = 'simt.md';

/**
 * A path from the loader table, under the reader's home directory.
 *
 * The table spells these two ways — `~/.config/opencode/AGENTS.md` and the bare
 * `.claude/rules` directory — so both are joined onto `homedir()` rather than one being
 * special-cased. A relative path left alone would resolve against the process's working
 * directory, which is a repository, and a user-level file written there is a file in
 * nobody's home directory at all.
 */
function inHome(path) {
  if (process.env.CODEX_HOME !== undefined && process.env.CODEX_HOME !== '' && path.startsWith('~/.codex/')) {
    return join(process.env.CODEX_HOME, path.slice('~/.codex/'.length));
  }
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : join(homedir(), path);
}

/**
 * Is this the file the reader's harness reads in preference to the ones below it?
 *
 * A fact about the reader's machine rather than about the table, which is why it is asked
 * here and nowhere else: Codex reads `AGENTS.override.md` when it is non-empty and
 * `AGENTS.md` otherwise, and writing an override where the reader has none would shadow
 * the global file they do have — silently, and for every repository in the estate.
 */
async function nonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * The smallest byte cap that applies to the file this tool would write.
 *
 * Token budgets are deliberately not compared against bytes: Antigravity's 20,000-token
 * cap for global plus always-on rules is a real limit the table records, and 20,000
 * compared against a byte count would be a number with no meaning.
 */
function fileCap(row) {
  return (
    caps(row)
      .filter((c) => c.appliesTo === 'a single file' || c.appliesTo === 'the merged chain')
      .sort((a, b) => a.bytes - b.bytes)[0] ?? null
  );
}

/**
 * Where a surface's rules can be carried once per reader, or `null` when they cannot be.
 *
 * Read from the loader table rather than written here, because that is the one place a
 * path comes with the document that says a harness loads it. Two answers are deliberate:
 *
 *   - a surface with no `scope: 'user'` row (Cursor, Copilot) yields `null`. Those
 *     harnesses keep user rules in their own settings, which is not a file this tool can
 *     project, so `shared` prints the block for a reader to paste instead of writing
 *     somewhere that would do nothing.
 *   - the `pointer` surfaces (`claude-md`, `gemini-md`) have no loader row at all, so they
 *     yield `null` too. The plan named `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`;
 *     the table records no such user-level file for either harness, and a guessed path is
 *     worse than a printed block — the file would be written, and never read.
 *
 * Where a harness records more than one global file, the one that is already there wins:
 * which of them is read is a fact about the reader's machine, and the fallback is written
 * only when none of them exists.
 *
 * @param {string[]} surfaces the surface ids selected across the workspace
 * @returns {Promise<{surface: string, label: string, path: string|null, why: string,
 *   cap: {bytes: number, appliesTo: string, why: string}|null}[]>}
 */
export async function sharedTargets(surfaces) {
  const out = [];
  for (const id of [...surfaces].sort()) {
    const row = loader(id);
    if (row === null) {
      out.push({
        surface: id,
        label: id,
        path: null,
        cap: null,
        why: `no user-level instruction file is recorded for ${id}; its user rules are configured in the app, not in a file`,
      });
      continue;
    }
    const users = row.start.filter((s) => s.scope === 'user' && s.atStart === true);
    const flat = users.find((u) => u.tree === 'flat');
    if (flat !== undefined) {
      out.push({
        surface: id,
        label: row.label,
        // A flat tree names a directory and a glob; the filename inside it is this tool's
        // to choose, which is why this path is the only one in the module that is not in
        // the table verbatim. Nothing to choose between here: the reader's own files in
        // that directory load alongside ours rather than instead of them.
        path: join(inHome(flat.dir ?? flat.path), SHARED_BASENAME),
        why: flat.why,
        cap: fileCap(row),
      });
      continue;
    }
    const singles = users
      .filter((u) => u.tree === 'single')
      .map((u) => ({ ...u, path: inHome(u.path) }));
    const present = [];
    for (const candidate of singles) {
      if (await nonEmptyFile(candidate.path)) present.push(candidate);
    }
    const chosen = present[0] ?? singles[singles.length - 1];
    if (chosen === undefined) {
      out.push({
        surface: id,
        label: id,
        path: null,
        cap: fileCap(row),
        why: `${row.label} keeps user rules in its own settings, not in a file this tool can write`,
      });
      continue;
    }
    const alternates = singles.filter((u) => u.path !== chosen.path).map((u) => u.path);
    out.push({
      surface: id,
      label: row.label,
      path: chosen.path,
      why:
        alternates.length === 0 || chosen === singles[0]
          ? chosen.why
          : `${chosen.why}; written here rather than ${alternates.join(' or ')} because it is the one ${row.label} reads on this machine`,
      cap: fileCap(row),
    });
  }
  return out;
}

/**
 * What every root in a workspace would carry, as `{id: rule}` per root.
 *
 * Each root is asked the question it already answers for `sync`, and nothing is read out
 * of a sibling's tree beyond its own projection: the only reason this module exists is to
 * compare roots, and it does that by asking each one rather than by reconstructing what
 * each one would say.
 *
 * @returns {Promise<{path: string, desired: object, shareable: Map<string, object>}[]>}
 */
export async function sharedCandidates(roots, flags) {
  const rows = [];
  for (const path of roots) {
    const desired = await desiredRegion(path, flags ?? {});
    rows.push({ path, desired, shareable: new Map(desired.shareable.map((r) => [r.id, r])) });
  }
  return rows;
}

/**
 * The rules every root carries with identical bytes, plus the ones that nearly qualify.
 *
 * `divergent` is not a diagnostic nobody reads: a rule two roots carry differently is
 * almost always inferability having dropped a line in one of them, and the answer is to
 * leave it in both regions rather than to teach this module which root was right. The two
 * reasons are kept apart because they are different facts: a rule one root does not carry
 * at all, and a rule two roots render differently, need different words in the report —
 * "differs across 1 repositories" describes neither.
 *
 * @param {{shareable: Map<string, object>}[]} rows
 * @returns {{shared: object[], divergent: {id: string, roots: string[], reason: 'bytes'|'coverage'}[]}}
 */
export function intersect(rows) {
  if (rows.length === 0) return { shared: [], divergent: [] };
  // The union of every root's ids, not the first root's: a rule only beta selects would
  // otherwise never be named, and the report would leave a reader guessing whether it
  // moved or stayed.
  const ids = [...new Set(rows.flatMap((row) => [...row.shareable.keys()]))].sort();
  const shared = [];
  const divergent = [];
  for (const id of ids) {
    const carriers = rows.filter((row) => row.shareable.has(id));
    const rule = carriers[0].shareable.get(id);
    const same = carriers.every((row) => row.shareable.get(id).rendered === rule.rendered);
    if (carriers.length === rows.length && same) {
      // Sorted in the order a region already keeps its rules, so the shared file and a
      // region's index are read in the same order and neither is sorted twice.
      shared.push({ id, ...rule });
      continue;
    }
    divergent.push({
      id,
      roots: carriers.map((row) => row.path),
      reason: carriers.length === rows.length ? 'bytes' : 'coverage',
    });
  }
  return { shared: shared.sort((a, b) => byPriorityThenId(a, b)), divergent };
}

/**
 * The document the user-level file carries.
 *
 * One lead paragraph, and it is the paragraph a reader needs: these rules are here rather
 * than in a repository, which is why a rule they expect in AGENTS.md is not in it. Below
 * the lead the frames are byte-identical to what the regions used to carry, which is what
 * lets a reader — or `check` — compare one copy against the other rather than against a
 * reconstruction of it.
 */
export function sharedBody(rules) {
  const lead =
    'The rules every repository in this workspace shares, carried once here rather than in each ' +
    "repository. A repository's own region carries what is left and names anything here it does " +
    `not carry. Read one of these from any repository in the workspace with: ${CLI} rules show <id>`;
  return rules.length === 0 ? lead : `${lead}\n\n${rules.map((r) => r.rendered).join('\n\n')}`;
}

/** The provenance a copy is stamped with. Same digest `sync` stamps, so one sha answers
 *  both questions: a copy of the user file written by a different release of these rules
 *  is stale, and there is nothing else in the comparison that would notice. */
export async function sharedMeta(rules) {
  return { sha: await provenanceDigest(), sources: rules.map((r) => r.source) };
}

/**
 * Is the copy in the reader's home the bytes this workspace would write today?
 *
 * `diff` rather than a string compare, because the file may carry the reader's own prose
 * above the region and a region that matches is current whether or not the bytes around it
 * do. A whole-file comparison would report a stale copy for a file this tool only partly
 * owns, and the reader would be told to run a command that changes nothing.
 *
 * @returns {Promise<{state: 'current'|'stale'|'absent'|'unreadable', action?: string,
 *   region?: string, reason?: string}>}
 */
export async function sharedState(path, rules, meta) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: error.message };
  }
  // A file with no region at all is absent, not stale: the reader has never installed one,
  // and the remedy for that is the same command with a different sentence.
  if (parse(text).status === 'absent') return { state: 'absent' };
  const probe = diffRegion(text, sharedBody(rules), meta, { compose: composeShared });
  return {
    state: probe.action === 'unchanged' ? 'current' : 'stale',
    action: probe.action,
    region: probe.region,
    reason: probe.action === 'malformed' ? probe.reason : undefined,
  };
}

/**
 * The write, with the file's current bytes as an argument.
 *
 * `inject` rather than `writeFile` for the reason the whole module exists in one line: the
 * user-level AGENTS.md is the most likely file in a reader's home directory to contain
 * something they wrote themselves. Only the bytes between the markers are ours.
 */
function injectShared(before, rules, meta) {
  return inject(before, sharedBody(rules), meta, { compose: composeShared });
}

/**
 * Write one user-level copy, creating the directory when the table named one.
 *
 * Idempotent: the same bytes come back `unchanged` and nothing is written, which is what
 * lets `install` be run on every machine in an estate without anyone diffing their home
 * directories afterwards.
 *
 * @returns {Promise<{path: string, action: string, created: boolean}>}
 */
export async function writeSharedFile(path, rules, meta) {
  let before = '';
  try {
    before = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const injected = injectShared(before, rules, meta);
  if (injected.action === 'unchanged') return { path, action: 'unchanged', created: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, injected.text);
  return { path, action: injected.action, created: before === '' };
}

/**
 * Are the rules this repository handed over actually in the reader's copy?
 *
 * A subset check rather than equality, and the difference matters: the file carries the
 * union of what every repository in the workspace declared, so a file with extra rules is
 * current for this repository while an exact comparison would call it stale and send the
 * reader to reinstall it on every sibling. What must hold is the direction that costs
 * something — every rule THIS repository stopped carrying is still there, byte for byte.
 *
 * @returns {Promise<{state: 'current'|'stale'|'absent'|'unreadable', missing: string[],
 *   checked: number, reason?: string}>}
 */
export async function sharedCoverage(path, rules) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', missing: [], checked: 0 };
    return { state: 'unreadable', missing: [], checked: 0, reason: error.message };
  }
  const parsed = parse(text);
  if (parsed.status === 'absent') return { state: 'absent', missing: [], checked: 0 };
  if (parsed.status === 'malformed') {
    // Reported as unreadable rather than as missing: the rules may be in there, but a file
    // with two regions cannot be checked, and "run shared install" would not fix it.
    return { state: 'unreadable', missing: [], checked: 0, reason: parsed.reason };
  }
  const missing = rules.filter((r) => !parsed.body.includes(r.rendered)).map((r) => r.id);
  return {
    state: missing.length === 0 ? 'current' : 'stale',
    missing,
    checked: rules.length,
    bytes: Buffer.byteLength(parsed.body),
  };
}

/**
 * The bytes the reader pays once for the whole workspace (ADR-084).
 *
 * Counted ONCE per file and counted at all, which is the whole reason this exists: a
 * report that measured seven regions and ignored the file the rules moved into would
 * show a 72% saving that the reader's context never saw. The accept criterion for R11 is
 * a number, and a number that leaves out the copy is not the reader's number.
 *
 * The whole file is counted, not the span between the markers, because the prose a reader
 * keeps around the region is also always-on for that reader — and because the alternative
 * needs a second definition of "generated bytes" to agree with `measureRoot`'s.
 *
 * @param {{surfaces: string[], desired?: object}[]} rows as `measureRoot` returns them
 * @returns {Promise<{bytes: number, files: {path: string, bytes: number, rules: number}[]}>}
 */
export async function sharedTotals(rows) {
  const surfaces = [...new Set(rows.flatMap((row) => row.surfaces ?? []))];
  const files = [];
  for (const t of await sharedTargets(surfaces)) {
    if (t.path === null) continue;
    let text;
    try {
      text = await readFile(t.path, 'utf8');
    } catch (error) {
      // ENOENT is the normal state of a reader who has not installed a workspace copy, and
      // reporting it as a fault would make `tokens` fail over something it is measuring.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const parsed = parse(text);
    files.push({
      path: t.path,
      bytes: Buffer.byteLength(text),
      rules: parsed.status === 'ok' ? countFrames(parsed.body) : 0,
    });
  }
  return { bytes: files.reduce((n, f) => n + f.bytes, 0), files };
}

/** One shared rule in a file: `## Stack: <id>`, `## Core` or `## Process: <id>`. */
function countFrames(body) {
  return body.split('\n').filter((line) => /^## (Stack: |Core$|Process: )/.test(line)).length;
}

/**
 * Every repository under `root`, in `discover`'s order.
 *
 * Not re-sorted here, deliberately: that order decides which root owns a shared paragraph
 * in `tokens --repos`, and ADR-084's accept criterion is measured in that number.
 *
 * @returns {Promise<{roots: string[], error: string|null}>}
 */
export async function sharedRoots(root) {
  const found = await discover(root);
  return { roots: found.repos, error: found.error ?? null };
}