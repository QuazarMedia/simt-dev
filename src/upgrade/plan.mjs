import { MANIFEST_COMMENT } from '../projection/manifest.mjs';
// Classify one repository's upgrade state. Pure: no filesystem, no git.
//
// The line this module draws is narrow on purpose. `upgrade` moves a PIN. It does not
// adopt a repo, repair a broken one, or decide that a repo should have a region it never
// had. Each of those is a different command with a different review, and a command that
// silently performs them during an "upgrade" is a command nobody can predict.
//
// So there are exactly two outcomes that write: `updated` and `unchanged`. Everything
// else is a skip with its own remedy, and the skip is reported rather than tolerated -
// a repo silently left behind is the exact failure `compare` exists to surface, and it
// must not be one this command creates.

/**
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.path
 * @param {object|null} input.manifest parsed simt-dev.json, or null
 * @param {boolean} input.manifestExists
 * @param {string|null} input.manifestError parse failure, when there is one
 * @param {object[]} input.targets every planned target from `plan(root).targets`: the
 *   AGENTS.md region first, then the generated `.mdc` rules
 * @param {string} input.sha the SHA this simt-dev stamps into regions
 */
export function planUpgrade({ name, path, manifest, manifestExists, manifestError, targets, sha }) {
  const list = Array.isArray(targets) ? targets : [];
  const primary = list[0] ?? null;
  const base = { name, path, sha, pinnedSha: manifest?.projection?.simtDevSha ?? null };

  // A repo that never adopted is not behind; it is absent. `simt-dev init` is the command
  // for it, and calling this a failure would make the exit code describe the estate's
  // migration progress rather than this run's correctness.
  if (!manifestExists) {
    return { ...base, state: 'not-adopted', action: 'skip', detail: 'no simt-dev.json', remedy: 'simt-dev init' };
  }
  if (manifestError) {
    return {
      ...base,
      state: 'broken-manifest',
      action: 'skip',
      detail: `simt-dev.json is unparseable (${manifestError})`,
      remedy: 'fix the JSON, or run: simt-dev init',
    };
  }
  // Only a hand-owned file's malformed region is a fault. A managed `.mdc` rule is a
  // generated file, so a malformed region there is repaired by replacement and nothing
  // hand-written is lost — `plan` reports its action as `updated`, not `malformed`, and
  // the write fixes it. AGENTS.md holds hand-written prose around its region, so
  // overwriting it could destroy work: that is the fault, and the whole repo is left
  // alone so no file is half-migrated.
  const malformed = list.find((t) => t.action === 'malformed');
  if (malformed) {
    return {
      ...base,
      state: 'malformed-region',
      action: 'skip',
      detail: `${malformed.file} region is malformed (${malformed.reason})`,
      remedy: `fix the markers at ${malformed.file}:${malformed.line}, then: simt-dev sync --yes`,
    };
  }
  if (primary === null) {
    return {
      ...base,
      state: 'no-region',
      action: 'skip',
      detail: 'no generated file could be planned for this repo',
      remedy: 'run: simt-dev check',
    };
  }
  // A manifest with no region is a repo mid-adoption or one that never adopted, and
  // `upgrade` writing a region into it turns adoption into a side effect of a version
  // bump. The question is whether the region exists, and `parse` has always answered it —
//  reading `previousBytes` instead gets a repository whose AGENTS.md is hand-written prose
//  wrong, which is the shape this guard was written for and the one it let through. A
//  byte count cannot tell "no region" from "small file", and a hand-written AGENTS.md is
//  never small.
//
// Keyed on the PRIMARY target alone, and that is not a simplification. The estate builds
// this state by adopting and then replacing AGENTS.md with prose, which leaves the
// baselines' regions in place: a guard asking whether *every* target lost its region sees
// two regions, decides the repo is adopted, and writes one — which is the defect. It is
// also the rule `compare` already applies (ADR-016 ruling on display versus gate: the row's
// `region` field is the primary document's), so the two commands now agree on which
// repository counts as adopted.
  if (primary.region === 'absent') {
    return {
      ...base,
      state: 'no-region',
      action: 'skip',
      detail: 'simt-dev.json exists but AGENTS.md has no generated region',
      // `sync --yes`, not `init --yes`. The remedy is a command that does the thing the
      // skip refused to do and nothing else: `sync` writes regions and leaves the rest of
      // the repository alone, while `init` re-runs adoption. `compare` already names
      // `sync --yes` for this state, and two commands must not answer the same question
      // with different instructions.
      remedy: 'run: simt-dev sync --yes',
    };
  }

  // Every target counts: a repo whose AGENTS.md is current but whose `.mdc` rules are
  // stale is behind, and restamping only the first of its files would leave `check` red
  // immediately after a successful `upgrade`.
  const regionBehind = list.some((t) => t.action !== 'unchanged');
  // "Behind" is not "the rules changed", and the difference is what the message below
  // has to state. A target is `updated` for two unrelated reasons: its region BODY moved,
  // which is a change to the rules, or its seam moved, which is this tool's own formatting
  // around a body that was already correct (ADR-037). Both read as `updated`, so reading
  // the cause off `action` reports a formatting repair as a change of policy — and this
  // command's whole purpose is to say why a repository is behind, so a false cause here
  // sends the reader to diff the rules when the rules did not move.
  //
  // The comparison is body to body rather than byte to byte, because the region header
  // carries the stamp: a stamp-only move is what `pinBehind` already reports separately,
  // and folding it in here would make every pin bump claim the rules changed.
  const rulesChanged = list.some((t) => {
    if (t.action === 'unchanged' || t.action === 'added') return t.action === 'added';
    const before = (t.previousBody ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
    const after = (t.body ?? '').replace(/^\n+/, '').replace(/\n+$/, '');
    return before !== after;
  });
  const pinBehind = base.pinnedSha !== sha;
  // A generated field of the manifest can alone be stale. `$comment` is written by
  // simt-dev and describes this file's provenance, so an adopted repo whose regions
  // and pin are all current can still be carrying an older version's wording -
  // and because `sync` does not own the manifest, nothing else would ever correct
  // it. Counting it here is what gives staleness a path back to being correct: a
  // field nobody checks is a field nobody fixes.
  const manifestBehind =
    manifest?.$comment !== undefined && manifest.$comment !== MANIFEST_COMMENT.$comment;
  if (!regionBehind && !pinBehind && !manifestBehind) {
    return { ...base, state: 'current', action: 'unchanged', detail: 'already at this simt-dev' };
  }

  // Why it moved is worth stating, and the causes are different problems even though
  // one command fixes all of them: content drift means the RULES changed, a seam repair
  // means they did not and only the formatting around them was wrong, a pin-only move
  // means the region was already correct and only its stamp was stale, and a
  // generated-field move means nothing about the repo changed and this tool's own
  // wording did. The transition itself is printed on its own `pin` line, so `detail`
  // names the cause without repeating it.
  return {
    ...base,
    state: 'behind',
    action: 'updated',
    detail: pinBehind
      ? regionBehind
        ? rulesChanged
          ? 'pin moved and region restamped (the rules changed)'
          : 'pin moved and region repaired; the rules were already correct'
        : 'pin moved; the region was already current'
      : regionBehind
        ? rulesChanged
          ? 'region restamped; the pin was already current (the rules changed)'
          : 'region repaired; the pin and the rules were already current'
        : 'manifest metadata refreshed; the rules and the pin were already current',
  };
}

/**
 * States that mean something is WRONG, as opposed to states that mean something is
 * merely ABSENT. Only these fail the run.
 *
 * The distinction is the same one `compare` makes, and it is load-bearing: on day one of
 * a migration most repos have no manifest at all. A command that exits non-zero for them
 * would report a workspace that looks broken and is merely early, and people would stop
 * reading its exit code.
 */
export const FAULT_STATES = new Set(['broken-manifest', 'malformed-region', 'no-region']);

/** @returns {{repos:number, updated:number, unchanged:number, skipped:number, faults:number, skippedStates:string[]}} */
export function summariseUpgrade(plans) {
  const skipped = plans.filter((p) => p.action === 'skip');
  return {
    repos: plans.length,
    updated: plans.filter((p) => p.action === 'updated').length,
    unchanged: plans.filter((p) => p.action === 'unchanged').length,
    skipped: skipped.length,
    faults: skipped.filter((p) => FAULT_STATES.has(p.state)).length,
    skippedStates: [...new Set(skipped.map((p) => p.state))].sort(),
  };
}