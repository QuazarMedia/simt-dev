---
simt-affects: ["src/actions/observe.mjs", "test/action-observe.test.mjs"]
simt-supersedes: []
---

# ADR-172 — a pass is a stable read-back naming target, incarnation and revision

Status: accepted · 2026-11-03

## Context

The mutation response is not the result, and every shortcut that treats it as one has already
shipped somewhere:

- an HTTP 202 was read as success, closing a task whose job never finished;
- a job that reported success had the wrong object content;
- an eventually consistent target was read once and called stable;
- a timeout was reported as passed because the desired object had looked right earlier;
- an unrelated object changed while the desired one was correct, and nobody noticed;
- two channels behind one cache were presented as independent.

## Rulings

1. **An accepted request is not a result.** A job that has not reached a terminal state yields
   `incomplete`; a job that failed yields `fail`; an unreadable job state yields `unknown`.

2. **Postconditions are read back from the object, not inferred from a response.** A job that
   succeeded with the wrong content fails.

3. **Frame conditions are checked over the same observation.** An unrelated field that changed
   fails the run even when the intended result is correct.

4. **A pass names target, incarnation and revision.** An observation without an incarnation or a
   revision is `unknown`, because it cannot be current evidence about anything.

5. **Stability is declared and required.** `stabilityWindow`, `stableReads` and `requiredReads`
   are inputs; a read before the window or below the required count is `incomplete`.

6. **A timeout is `unknown`, never a pass.** The outcome remains unknown, and the report says so
   rather than filling the gap.

7. **Correlation is labelled.** Two channels sharing a backing store are `correlated`, and a pass
   over them says it is not independent confirmation. A single channel is correlated with itself.

## Consequences

- Verification is a value over supplied observations, so a run can be replayed against a fixture
  and a reviewer can see exactly which reading supported which verdict.
- Independent postconditions remain a separate obligation: this module reports assurance, it does
  not manufacture a second channel.
