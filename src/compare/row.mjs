// The matrix a `simt-dev compare` row is built from: one repo's adoption state.
//
// The shape of a row answers one question - "would this repo behave correctly if
// an agent followed it today?" - from the four things that can make it not:
//
//   manifest   is the repo in the ecosystem at all?
//   region     does the committed projection match this simt-dev?
//   hooks      would a commit actually be gated?
//   gates      do the declared gates exist, and can they run?
//
// A repo can be adopted and still wrong (drifted region, missing hooks), which is
// the case a hand audit misses: the repo LOOKS done. That is why these are four
// columns and not one status.
//
// Ordering within a row is fixed. Output design (plan 0002 section 6) requires one
// fact per line in a stable field order so two runs diff cleanly; a row that
// reordered its columns would make every comparison between two runs unreadable.

import { checkTargets, PRIMARY_TARGET } from '../projection/project.mjs';
import { manifestDrift, readManifest } from '../projection/manifest.mjs';
import { loadRules, select } from '../projection/rules.mjs';
import { resolvePacks } from '../packs.mjs';
import { knownGates } from '../hooks/resolve.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { readHooksState, wantsShim } from './hooksstate.mjs';
import { CLI } from '../name.mjs';
import { MANIFEST_FILE } from '../name.mjs';

/**
 * @typedef {object} RepoRow
 * @property {string} name        directory name, the thing a human reads
 * @property {string} path
 * @property {'adopted'|'unmanaged'|'broken'} adoption
 * @property {string|null} id     manifest id, when declared
 * @property {string[]} stack
 * @property {string[]} facts
 * @property {string[]} profiles  profile ids that would be selected
 * @property {{path: string, profiles: string[], status: string, detail: string|null}[]} packages
 *   one nested region per workspace package, sorted by path
 * @property {{path: string, profiles: string[], status: string, detail: string|null}[]} packageProblems
 *   the nested regions that are not `current`; empty for an unadopted repository
 * @property {string|null} pinnedSha
 * @property {string|null} recordedSha
 * @property {'current'|'drift'|'unmanaged'|'absent'|'malformed'} region
 * @property {string|null} regionDetail
 * @property {boolean} hooksRouted   core.hooksPath points at the shared dispatcher
 * @property {boolean} hooksComplete every event installed, executable, not stale
 * @property {string[]} gatesDeclared
 * @property {string[]} gateProblems
* @property {{name: string, source: string|null, version: string|null, digest: string|null, ok: boolean}[]} packs
*   the shared rule sets this repo declares, with the digest it has pinned for each
 * @property {string[]} problems     everything wrong, one line each; drives the exit code
 * @property {string[]} notes        worth knowing, but not wrong; does NOT drive the exit code
 */

/**
 * Build one row. Never throws: a repo that cannot be read becomes a row with a
 * problem, because a dashboard that drops unreadable repos reports a smaller
 * estate than exists and the reader has no way to know.
 *
 * @param {string} path
 * @param {{expectedSha: string, gates: Set<string>}} context
 * @returns {Promise<RepoRow>}
 */
/**
 * A nested-region finding in the row's own vocabulary.
 *
 * `checkTargets` speaks in `file` because a finding is printed with the path it names;
 * a row field is read by key, and a reader looking for `packages[].path` should not
 * have to know that the finding underneath calls the same thing `file`. One mapper, so
 * the two arrays cannot drift into different shapes.
 */
function packageEntry(f) {
  return { path: f.file, profiles: f.profiles ?? [], status: f.status, detail: f.detail ?? null };
}

export async function buildRow(path, context) {  const name = path.split('/').filter(Boolean).pop() ?? path;
  const problems = [];
  const notes = [];

  // The manifest first, and on its own. The predicate below reads it, and a
  // destructured binding in the same `Promise.all` array is still in its temporal dead
  // zone when the array is evaluated - so this is the same defect ADR-045 records in
  // this file one level up: a gate reading a field the line above has not set yet.
  const manifest = await readManifest(path);

  const [fp, hooks, findings] = await Promise.all([
    fingerprint(path),
    // The same predicate `hooks install` writes by. Without it this row defaulted to
    // "a shim is wanted for every event", so a repository declaring only `prePush`
    // gates was reported `hooksComplete: false` for the pre-commit shim it has no
    // reason to write - and no number of runs of `hooks install` could clear it,
    // because the command and the dashboard were answering different questions.
    // Four estate repositories were in that state.
    readHooksState(path, { declaresGate: (e) => wantsShim(manifest.manifest, manifest.exists, e) }),
    checkTargets(path),
  ]);

  // The row's `region` stays the AGENTS.md finding, because that is what a reader
  // recognises. The rule files and pointers are summarised beside it, because a repo
  // can have a current AGENTS.md and three stale rule files - which is exactly the
  // state a rule written to four surfaces can drift into.
  const region = findings.find((f) => f.file === PRIMARY_TARGET) ?? { status: 'absent' };
  const ruleFindings = findings.filter((f) => f.surface !== undefined);
  // A nested region is identified by its path, not by a field: `checkTargets` builds
  // those findings from `checkRegion`, which knows nothing about monorepos, and the
  // one thing this row needs from them is "which file, what state".
  const packageFindings = findings
    .filter((f) => f.file !== undefined && f.file.endsWith(`/${PRIMARY_TARGET}`))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  const pointers = findings.filter((f) => f.status?.startsWith('pointer'));

  // Adoption is settled BEFORE any problem is collected. Every gate below asks
  // `row.adoption`, and this block used to run after them - so the stale-rule-file gate
  // below compared against the initialiser's `'unmanaged'` and could never fire. In the
  // estate, with 0 of 3 rule files current, report a problems list that mentioned
  // neither the rule files nor anything the exit code could see. A gate
  // that reads a field the line above has not set yet is not a gate.
  //
  // An absent manifest is not a defect; it is the pre-adoption state, which is the normal
  // condition of most repos on day one of a migration. It is counted and reported, never
  // called a problem.
  const adoption = !manifest.exists ? 'unmanaged' : manifest.error ? 'broken' : 'adopted';

  // The profile ids this repo's signals select. These are the two calls `desiredRegion`
  // makes, on the same inputs it uses, so a dashboard cannot disagree with what `sync`
  // would render. `test/compare.test.mjs` asserts the two agree rather than trusting this
  // comment: the field sat at its initial value for the whole life of this file, and the
  // prose above it was still true.
  const { selected: chosen } = select(await loadRules(path), fp.stack ?? [], fp.facts ?? []);

  // The packs this repo shares with its siblings, with the digest it has pinned.
  // A dashboard that reported `current: 14` while half their rules lived in a
  // directory that was not there described an estate nobody had. The digest is
  // the per-repo answer to "which bytes were these", which is what P4 asks for and
  // what a reviewer comparing two repositories actually wants to see.
  const { packs, findings: packFindings } = await resolvePacks(path);

  const row = {
    name,
    path,
    adoption,
    id: manifest.manifest?.id ?? null,
    stack: fp.stack ?? [],
    declaredStack: manifest.manifest?.stack ?? [],
    facts: fp.facts ?? [],
    profiles: chosen.map((r) => r.id),
    pinnedSha: manifest.manifest?.projection?.simtDevSha ?? null,
    recordedSha: region.recordedSha ?? null,
    region: region.status,
    regionDetail: region.detail ?? null,
    surfaces: manifest.manifest?.surfaces ?? null,
    // One entry per nested region, for the same reason `ruleFiles` is its own object:
    // a monorepo can have a current root region and one stale package region, and a
    // single `region` field cannot say which. Sorted by path, because `checkTargets`
    // returns findings in the order the detector found packages and a dashboard that
    // reorders rows between runs is a dashboard nobody diffs.
    packages: packageFindings.map(packageEntry),
    ruleFiles: {
      total: ruleFindings.filter((f) => f.status !== 'orphaned').length,
      current: ruleFindings.filter((f) => f.status === 'current').length,
      stale: ruleFindings.filter((f) => f.status !== 'current' && f.status !== 'orphaned').map((f) => f.file),
      // Managed rule files this run would not write, counted apart from the rule files.
      // They are a different kind of thing: `sync` cannot repair them and would never
      // write them again, so they are a note with a remedy and not a problem
      // (ADR-021 ruling 6).
      orphaned: ruleFindings.filter((f) => f.status === 'orphaned').map((f) => f.file),
    },
    pointers: pointers.map((p) => ({ file: p.file, state: p.status })),
    // A nested region that is not `current` is a problem for the same reason a stale
    // rule file is: `check` exits 1 on it, and a row that reported the repository as
    // current anyway is ADR-045's defect one level down. Gated on adoption, like every
    // other gate here — an unadopted repo has no root region and therefore no nested
    // findings to report, which is not a second defect for the same missing adoption.
    packageProblems: adoption === 'adopted' ? packageFindings.filter((f) => f.status !== 'current').map(packageEntry) : [],
    packs: packs.map((p) => ({
      name: p.name,
      source: p.source,
      version: p.version,
      digest: p.declared || null,
      ok: p.ok,
    })),
    hooksRouted: hooks.routed,
    hooksComplete: hooks.complete,
    gatesDeclared: declaredGates(manifest.manifest),
    gateProblems: [],
    foreignHooks: [],
    problems,
    notes,
  };

  // A rule file on any surface that is not current is a defect the row would
  // otherwise hide. It names the files, because "something is stale" is not
  // actionable and this command exists to be acted on.
  //
  // Gated on adoption, and that gate is the whole point. A repo that has never been
  // adopted has no rule files at all, and reporting them as "not current" turns the
  // normal mid-migration state into a red estate — the same mistake ADR-018 records
  // for hooks, where an unadopted repo's own hooks are a note rather than a problem.
  if (row.ruleFiles.orphaned.length > 0) {
    notes.push(
      `${row.ruleFiles.orphaned.length} generated rule file(s) repeat text already folded into AGENTS.md (${row.ruleFiles.orphaned.join(', ')}); delete them, or the reader loads the rule twice. simt-dev will not remove a file it wrote.`,
    );
  }

  if (adoption === 'adopted' && row.ruleFiles.stale.length > 0) {
    problems.push(
      `${row.ruleFiles.stale.length} of ${row.ruleFiles.total} rule files are not current (${row.ruleFiles.stale.join(', ')}); run: ${CLI} sync --yes`,
    );
  }

  if (manifest.error) {
    problems.push(`${MANIFEST_FILE} ${manifest.error}`);
  }

  // Stale nested regions, named by path, with the remedy the finding already carries.
  // A monorepo with four packages and one drifted region must not report `current`.
  for (const f of row.packageProblems) {
    problems.push(`${f.path}: ${f.detail ?? 'the package region is not current'}; run: ${CLI} sync --yes`);
  }

  // `pack-unpinned` is a note here for the same reason it is non-blocking in
  // `check`: the rules render, and only the record of which bytes they were is
  // absent. A missing or mismatched pack is a problem, because that row would
  // otherwise report a repository `current` while projecting fewer rules than the
  // manifest declares - the defect ADR-045 was about, reached a different way.
  for (const f of packFindings) {
    if (f.status === 'pack-unpinned') notes.push(`${f.file}: ${f.detail}; ${f.remedy}`);
    else problems.push(`${f.file}: ${f.detail}; ${f.remedy}`);
  }

  // A generated field of the manifest is stale, and `check` refuses on it. This row
  // said the repository was `current` anyway, in all fourteen adopted repositories at
  // once, so a dashboard that reported `current: 14, problems: 0` was describing a
  // green estate on which every gate exited 1.
  //
  // ADR-045 went the other way: `compare` counted a defect it had been hiding. This is
  // the same defect from the far side — a refusal the dashboard does not count — and
  // the acceptance criterion in the review that owns this ("compare reports current:
  // 14") was satisfiable while `check` exited 1 in every row it covered.
  //
  // `drift.remedy` verbatim, for both statuses. The remedy is the repair command, and
  // two commands answering one question with different instructions is ADR-050's
  // subject; if `check` changes its mind, this row changes with it for free.
  if (adoption === 'adopted') {
    const drift = await manifestDrift(path, row.stack, context.expectedSha);
    if (drift) problems.push(`${drift.file}: ${drift.detail}; ${drift.remedy}`);
  }

  // --- region --------------------------------------------------------------
  // Only meaningful for an adopted repo. An unmanaged repo has no manifest, so
  // its `absent` region is a consequence of not having adopted, not a second
  // independent defect - reporting both would double-count one root cause.
  if (adoption === 'adopted') {
    if (region.status === 'drift') {
      // A drift has two causes with different fixes, and the SHA says which. When
      // the recorded SHA matches this simt-dev, the region was hand-edited and
      // `simt-dev sync --yes` is right; when it does not, the repo is simply behind and the
      // same command is also right - but the message must not claim a version
      // mismatch when the versions are identical, because that sends the reader
      // looking for a pin that is already correct.
      const sameSha = region.recordedSha === context.expectedSha;
      problems.push(
        sameSha
          ? `the generated region was hand-edited; restore it with: ${CLI} sync --yes`
          : `projection is ${region.recordedSha ?? '(no sha)'} but this simt-dev is ${context.expectedSha}; run: ${CLI} sync --yes`,
      );
    } else if (region.status === 'malformed') {
      problems.push(`generated region is malformed: ${region.detail}; run: ${CLI} sync --yes`);
    } else if (region.status === 'unmanaged') {
      problems.push(`adopted but AGENTS.md has no generated region; run: ${CLI} sync --yes`);
    } else if (region.status === 'absent') {
      problems.push(`adopted but AGENTS.md does not exist; run: ${CLI} sync --yes`);
    } else if (region.status === 'current' && row.pinnedSha && row.pinnedSha !== context.expectedSha) {
      // The region matches this simt-dev but the manifest pins an older one. The
      // next sync would stamp the newer SHA silently, so the pin is the thing
      // that is stale - and it is the value `simt-dev upgrade` reads.
      problems.push(
        `manifest pins simt-dev ${row.pinnedSha}, this is ${context.expectedSha}; run: ${CLI} upgrade`,
      );
    }
  }

  // --- declared stack vs detected stack ------------------------------------
  // `simt-dev.json` records what the repo claims to be; fingerprint records what
  // the files prove. Selection uses detection, so a stale claim does not change
  // which profile is projected - but it DOES mean the manifest misdescribes the
  // repo, and a reader of the manifest would be misled. Reported rather than
  // silently reconciled: picking a winner would hide the edit that caused it.
  //
  // An empty declared stack counts as a disagreement when detection found
  // something. That is not pedantry: `init` writes the detected stack, so an empty
  // one means either the repo was adopted before the markers existed or someone
  // emptied it by hand, and in both cases the manifest is wrong.
  if (adoption === 'adopted') {
    const declared = new Set(row.declaredStack);
    const detected = new Set(row.stack);
    const extra = row.declaredStack.filter((t) => !detected.has(t));
    const missing = row.stack.filter((t) => !declared.has(t));
    if (extra.length > 0 || missing.length > 0) {
      const parts = [];
      if (extra.length > 0) parts.push(`declares ${extra.join(', ')} but no marker proves it`);
      if (missing.length > 0) parts.push(`detected ${missing.join(', ')} but the manifest omits it`);
      problems.push(`manifest stack disagrees with detection: ${parts.join('; ')}`);
    }
  }

  // --- hooks ---------------------------------------------------------------
  // A repo running its own hooks is a fact about today, independent of whether
  // simt-dev has been adopted. It is a NOTE, not a problem: adopting this repo is
  // the normal mid-migration state, and a dashboard that goes red for it teaches
  // everyone to ignore the dashboard. What it costs is only visible at install
  // time, which is where the takeover guard asks for consent.
  row.foreignHooks = hooks.foreign.map((h) => ({ event: h.event, bytes: h.bytes }));
  for (const h of hooks.foreign) {
    notes.push(`runs its own ${h.event} (${h.bytes} bytes); hooks install will replace it and asks first`);
  }

  if (adoption === 'adopted') {
    if (!hooks.routed) {
      problems.push(
        hooks.current === null
          ? `no core.hooksPath; commits are ungated. run: ${CLI} hooks install --yes`
          : `core.hooksPath is "${hooks.current}", not the shared dispatcher; run: ${CLI} hooks install --yes`,
      );
    } else if (!hooks.complete) {
      for (const h of hooks.problems) problems.push(`hooks: ${h}`);
    }
  }

  // --- gates ---------------------------------------------------------------
  // A declared gate the dispatcher does not know is a hard failure at commit
  // time (step 8 fails closed), so it is a defect here. A command-kind gate with
  // no command declared is the same failure one step later.
  if (adoption === 'adopted') {
    const commands = manifest.manifest?.gates?.commands ?? {};
    const invoked = new Set([...row.gatesDeclared, ...Object.keys(commands)]);
    const unknown = [...invoked].filter((g) => !context.gates.has(g)).sort();
    const uncommanded = [...invoked].filter(
      (g) => context.gates.has(g) && context.gateKinds?.get(g) === 'command' && !commands[g],
    );
    const neverRun = Object.keys(commands)
      .filter((c) => !row.gatesDeclared.includes(c))
      .sort();

    row.gateProblems = [
      ...unknown.map((g) => `gate "${g}" is not a known gate`),
      ...uncommanded.map((g) => `gate "${g}" is a command gate with no declared command`),
      ...neverRun.map((c) => `declared command "${c}" is in no gate list`),
    ];
    problems.push(...row.gateProblems);
  }

  return row;
}

function declaredGates(manifest) {
  if (!manifest) return [];
  return [...(manifest.gates?.preCommit ?? []), ...(manifest.gates?.prePush ?? [])];
}

/**
 * The headline facts about an estate, aggregated over rows.
 *
 * Counts, not verdicts. A single summary line an agent can read before deciding
 * whether it needs the table - and the numbers that make a migration legible
 * ("12 of 16 repos still unmanaged") in a way a per-repo list cannot.
 */
export function summarise(rows, extra = {}) {
  const count = (pred) => rows.filter(pred).length;
  const shas = new Map();
  for (const r of rows) {
    const sha = r.pinnedSha ?? '(none)';
    shas.set(sha, (shas.get(sha) ?? 0) + 1);
  }
  return {
    repos: rows.length,
    adopted: count((r) => r.adoption === 'adopted'),
    unmanaged: count((r) => r.adoption === 'unmanaged'),
    broken: count((r) => r.adoption === 'broken'),
    drifted: count((r) => r.region === 'drift'),
    current: count((r) => r.region === 'current'),
    noRegion: count((r) => r.region === 'unmanaged' || r.region === 'absent'),
    malformed: count((r) => r.region === 'malformed'),
    hooksRouted: count((r) => r.hooksRouted),
    staleRuleFiles: rows.reduce((n, r) => n + (r.ruleFiles?.stale?.length ?? 0), 0),
    // Counted here and not derived from `withProblems`: one monorepo with three drifted
    // packages is one repository with three findings, and a reader asking "how much is
    // stale" wants 3, not 1. `withProblems` still counts the repository once.
    stalePackages: rows.reduce((n, r) => n + (r.packageProblems?.length ?? 0), 0),
    packageRegions: rows.reduce((n, r) => n + (r.packages?.length ?? 0), 0),
    withProblems: count((r) => r.problems.length > 0),
    withOwnHooks: count((r) => (r.foreignHooks ?? []).length > 0),
    shas: [...shas.entries()].sort((a, b) => (a[0] === '(none)' ? 1 : b[0] === '(none)' ? -1 : b[1] - a[1])),
    ...extra,
  };
}

export { knownGates };