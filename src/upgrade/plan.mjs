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

  // A repo that never adopted is not behind; it is absent. `simt init` is the command
  // for it, and calling this a failure would make the exit code describe the estate's
  // migration progress rather than this run's correctness.
  if (!manifestExists) {
    return { ...base, state: 'not-adopted', action: 'skip', detail: 'no simt-dev.json', remedy: 'simt init' };
  }
  if (manifestError) {
    return {
      ...base,
      state: 'broken-manifest',
      action: 'skip',
      detail: `simt-dev.json is unparseable (${manifestError})`,
      remedy: 'fix the JSON, or run: simt init',
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
      remedy: `fix the markers at ${malformed.file}:${malformed.line}, then: simt sync`,
    };
  }
  if (primary === null) {
    return {
      ...base,
      state: 'no-region',
      action: 'skip',
      detail: 'no generated file could be planned for this repo',
      remedy: 'run: simt check',
    };
  }
  // A manifest with no region is a repo mid-adoption or one that lost its region.
  // `check` already reports it as unmanaged; `upgrade` writing a region into it would
  // turn a repair into a side effect of a version bump.
  if (list.every((t) => t.action === 'added' && !t.previousBytes)) {
    return {
      ...base,
      state: 'no-region',
      action: 'skip',
      detail: 'simt-dev.json exists but AGENTS.md has no generated region',
      remedy: 'run: simt sync',
    };
  }

  // Every target counts: a repo whose AGENTS.md is current but whose `.mdc` rules are
  // stale is behind, and restamping only the first of its files would leave `check` red
  // immediately after a successful `upgrade`.
  const regionBehind = list.some((t) => t.action !== 'unchanged');
  const pinBehind = base.pinnedSha !== sha;
  if (!regionBehind && !pinBehind) {
    return { ...base, state: 'current', action: 'unchanged', detail: 'already at this simt-dev' };
  }

  // Why it moved is worth stating, and the two causes are different problems even though
  // one command fixes both: content drift means the RULES changed, a pin-only move means
  // the region was already correct and only its stamp was stale. The transition itself is
  // printed on its own `pin` line, so `detail` names the cause without repeating it.
  return {
    ...base,
    state: 'behind',
    action: 'updated',
    detail: pinBehind
      ? regionBehind
        ? 'pin moved and region restamped (the rules changed)'
        : 'pin moved; the region was already current'
      : 'region restamped; the pin was already current (the rules changed)',
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