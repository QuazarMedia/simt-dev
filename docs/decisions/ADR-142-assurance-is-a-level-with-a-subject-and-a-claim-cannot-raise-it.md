---
simt-affects: ["packages/bench/src/work-probes.mjs", "test/work-probes.test.mjs"]
simt-supersedes: []
---
# ADR-142 — assurance is a level with a subject, and a claim cannot raise it

Status: accepted · 2026-11-02

## Context

Every capability report so far could say what a tool *claimed*. Nothing distinguished a tool
that says it can write an object from one whose writes are observed afterwards, from one
whose writes go through a policy boundary, from one where the backend itself refuses a
duplicate. Reported as the same word, those are four different products, and the weakest one
inherits the credibility of the strongest.

The adversarial probes make the same point from the other side: a rejection is only evidence
if the effect did not land, and a route with no boundary is not a slow pass but an
unprotected one.

## Rulings

1. **Assurance is one of four ordered levels**: `declared`, `observed`, `mediated`,
   `externally-enforced`. A report names the level and the evidence that supports it, never
   the level alone.

2. **Evidence has a subject.** An item that names no subject, or whose own record says it
   did not pass, contributes nothing. With no contributing item, the level is null - not
   `declared`.

3. **A claim cannot raise its own level.** `declared` is reachable only from an explicit
   capability statement, and no amount of repeating it reaches `observed`. Raising a level
   requires an item of that kind with a subject.

4. **The probe oracle reads effects, not verdicts.** A `rejected` intent that still produced
   an effect is a forbidden effect and a failure; an `allowed` intent that produced an
   unasked-for effect fails the same check.

5. **No boundary is labelled, not scored.** An attempt against an unmediated route reports
   `unprotected`; it never satisfies a rejection oracle and it cannot be averaged into a
   success rate.

## Consequences

- Capability cards and reports gain a field with a floor of `declared`, so an unbacked
  claim is visibly unbacked rather than merely unspecified.
- The adversarial catalogue is data: a new attack is an entry with its own verdict and
  effect count, and adding one does not edit the runner (ADR-013).
- This is finite test evidence on synthetic fixtures. It is not a claim that arbitrary
  agents cannot bypass a control; the unprotected verdict exists to say so.
