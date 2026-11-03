// What a capability claim is actually backed by (ADR-142).
//
// The table lives here because two surfaces need it: the adversarial probes in
// `packages/bench/` and the capability cards in `src/work/`. A second copy would let one of
// them learn a level the other does not know, which is exactly the drift the levels exist
// to prevent.
//
// A claim never upgrades itself, and evidence without a subject proves nothing.

/** What a capability's evidence can prove, weakest first. */
export const ASSURANCE_LEVELS = Object.freeze(['declared', 'observed', 'mediated', 'externally-enforced']);

const RANK = new Map(ASSURANCE_LEVELS.map((level, index) => [level, index]));

/**
 * The level a set of evidence items supports, or null when there is none.
 *
 * `declared` is a floor, not a rung: an item of that kind can only ever establish that
 * someone said so. Evidence that failed, or that names no subject, is ignored - a record
 * of a mediation that did not happen is not evidence of mediation.
 */
export function assuranceLevel(evidence = []) {
  let level = null;
  for (const item of evidence) {
    if (item === null || typeof item !== 'object' || !RANK.has(item.kind)) continue;
    if (item.kind === 'declared') {
      level ??= 'declared';
      continue;
    }
    if (item.passed === false || typeof item.subject !== 'string' || item.subject === '') continue;
    if (level === null || RANK.get(item.kind) > RANK.get(level)) level = item.kind;
  }
  return level;
}
