---
simt-affects: ["src/memory/discovery.mjs", "test/work-memory.test.mjs"]
simt-supersedes: []
---

# ADR-180 — authority is a property of how a candidate was established, never of how often it was repeated

Status: accepted · 2026-11-03

## Context

Memory learned from failed commands, so a good discovery only became recallable after something
broke. Widening it to discoveries brought four failures with it:

- a repeated false assertion gained authority by repetition;
- expired or target-specific facts leaked into generic packets;
- an unverified fix, or a compensation that failed, was offered as a known successful remedy;
- a discovery was never recalled because the only recall path began with a failure.

## Rulings

1. **Five candidate kinds.** `discovery`, `contradiction`, `repair`, `correction`,
   `unknown-outcome`, each with support and contradicting references, scope, observation time,
   expiry and target capability class.

2. **Authority is derived, never accumulated.** A verified candidate is a `lesson`; an unverified
   repair is a `warning`; an `unknown-outcome` is always a `candidate`. Repetition is not an input
   to that function, so two identical assertions produce one entry with `count: 2` and the same
   authority.

3. **Deduplication keys on the normalised proposition and the scope.** The same sentence in two
   tenants does not merge, because the scope is what made it true.

4. **A warning is shown as a warning.** `recallable` refuses a candidate, refuses an expired entry,
   and refuses an entry scoped to another target; a warning is usable with its own label, because
   an unverified repair is still information.

5. **A packet names its exclusions.** `packetEntries` returns the usable entries and the excluded
   ones with reasons, so a reader can see what was withheld rather than assuming nothing was.

## Consequences

- A verified discovery is recallable without a failing command.
- Promotion into the reviewed lesson workflow is unchanged: this module decides what a candidate
  may be used for, not whether it is promoted.
