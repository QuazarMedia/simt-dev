---
simt-affects: ["src/bench/calibration.mjs", "test/work-calibration.test.mjs"]
simt-supersedes: []
---

# ADR-183 — a bar declared after the numbers is not a bar, and a hard constraint outranks an average

Status: accepted · 2026-11-03

## Context

Calibration turns a judge's agreement with experts into a decision about how much it may do
alone. Every shortcut that produced a false sense of safety:

- the false-accept ceiling was chosen after the measurements were seen;
- an underpowered or distribution-shifted scope was enabled because the overall average looked
  good;
- a hard privacy, security or effect constraint was relaxed by an improved average;
- the judge's prompt, model or rubric changed without the calibration noticing.

## Rulings

1. **The bar is preregistered.** Scope, capability, false-accept ceiling, minimum sample size and
   the judge identity, recorded before measurement. No preregistration is `blocked`, with the
   reason that a bar declared after the numbers is not a bar.

2. **The decision is per scope and capability.** A bar registered for `rates` does not authorise
   `billing`; a mismatch is `blocked`.

3. **Underpowered scopes stay review-required.** Both the overall sample count and the scope's own
   count must reach the registered minimum.

4. **The comparison uses a lower confidence bound.** `lowerBound` is Wilson's, so a small perfect
   sample cannot clear a strict ceiling: five correct samples bound the correct rate near 0.65.

5. **A changed judge invalidates the measurement.** The prompt, model and rubric are digested; a
   mismatch is `review-required` with that reason.

6. **A hard constraint is checked last and cannot be outvoted.** With any declared privacy,
   security or effect constraint the answer is `review-required` whatever the numbers say.

7. **Models propose advice; the repository decides.** The module returns a recommendation with its
   reason and bound, and never enables anything itself.

## Consequences

- The calibration report separates authority uncertainty from model confidence by construction: it
  reports counts, a false-accept rate and disagreement, and leaves the decision to the declared bar.
- The module reads no clock and no filesystem, so a decision can be replayed against recorded
  labels.
