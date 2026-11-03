---
simt-affects: ["src/bench/replay.mjs", "test/work-replay.test.mjs"]
simt-supersedes: []
---

# ADR-182 — a metamorphic relation is declared by the contract, and an offline replay is not an acceptance run

Status: accepted · 2026-11-03

## Context

A single gold output cannot show that a procedure generalises, so generality was tested by varying
the world. Each way that went wrong is a ruling here:

- an invariant was inferred from model agreement, which is not an invariant;
- a reordered unrelated event changed the result, or a relevant one failed to change it;
- an under-covered trace was replayed as though it proved something;
- an offline replay was reported as a live acceptance run.

## Rulings

1. **Five declared relations, and nothing else runs.** `rename-invariance`, `unit-preserving`,
   `read-channel-equivalence`, `idempotent-repetition`, `effective-date-divergence`. An
   undeclared relation is reported as a violation rather than applied, so a model's opinion cannot
   become a check by naming itself one.

2. **A trace must be replayable before anything is claimed.** An intent digest, at least one
   observation and an event sequence are required; a trace with none is a plan.

3. **Rename invariance covers renaming and reordering.** A semantic field that changed is a
   violation, which is what distinguishes an unrelated id from a meaningful one.

4. **A unit conversion is checked against the value it expresses,** with the conversion supplied
   by the contract rather than assumed.

5. **Channels must agree.** Two answers that differ are a violation, and neither is treated as the
   answer.

6. **Repetition is only a relation where the contract promises it.** Where it does not, a changed
   result is the finding, not a failure of the replay.

7. **A date-governed difference is allowed only in the fields the date governs.** Everything else
   that moved is a violation even when the dates differ.

8. **Offline replay measures logic robustness only.** `offline()` reports `liveAcceptance: false`,
   and the two are never averaged into one number.

## Consequences

- Every relation has a positive and a violating fixture in the test, so a relation that stops
  discriminating is visible.
- The module is pure over supplied observations, so a replay can be diffed between runs.
