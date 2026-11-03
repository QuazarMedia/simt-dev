---
simt-affects: ["src/verify/contracts.mjs", "test/verify-contracts.test.mjs"]
simt-supersedes: []
---

# ADR-158 — a runner's success is not an outcome, and a waiver is not a pass

Status: accepted · 2026-11-03

## Context

The command exited zero, so the work is done. That sentence has been wrong in four ways in
this estate: an HTTP 200 whose postcondition failed; a formatter run reported as proof that a
requirement is entailed; a unit test with a mocked dependency reported as proof that a live
predicate holds; and a waiver — a reviewed decision not to require the evidence — counted as
the evidence itself.

Each failure has the same shape: the thing that was observed is not the thing that was
claimed, and one word (`pass`) carried both. Nothing about the exit code is wrong; the wrong
part is treating it as an answer.

## Rulings

1. **The contract names the predicate; the observation reports what happened.** An obligation
   carries subject, predicate, applicability, severity, verifier, required assurance and the
   dependency revisions the evidence must be produced at. A result is one of `pass`, `fail`,
   `unknown`, `unavailable`, `not-run`, `not-applicable`, `waived`, and only `pass` counts
   towards completion.

2. **Transport success is never a result.** `pass` requires an evaluated postcondition. A
   command that succeeded without evaluating it is `unknown`; an evaluated failure is `fail`
   even when the transport succeeded, and the reason says so.

3. **A verifier can only settle the predicates it can reach.** A `formatter` cannot settle an
   `entailment`; a `unit-test` cannot settle a live predicate, and a claimed `live` assurance
   is capped at the ceiling its verifier kind can reach (`simulated` for a unit test). An
   observation never upgrades its own assurance.

4. **Applicability is a finding that needs evidence.** `not-applicable` requires predicate
   evidence; without it the state is `unknown`, because "it does not apply" asserted by the
   same observation that would otherwise have to prove it is not a finding.

5. **A waiver is reported and never counted.** It needs a reviewer, a date and a reason; an
   unreviewed waiver is `unknown`. A waived mandatory obligation leaves the contract
   incomplete, visibly.

6. **Completion is unanimous, not statistical.** Every applicable mandatory obligation must be
   `pass` at its required assurance on its pinned revisions. An advisory failure is reported
   and does not block.

7. **A malformed contract blocks with a remedy.** A missing verifier, an unknown severity, a
   duplicated id or an unpinned dependency is an error naming what to change, not a lenient
   evaluation. An observation naming no obligation is an error too: it proves nothing.

8. **Result states are not review verdicts.** The report carries `review: 'not-a-review-verdict'`
   and never emits APPROVE or BLOCK. ADR-008 verdicts are a human judgement of a diff; no
   arrangement of observations produces one.

## Consequences

- Verification assurance (`simulated`, `executed`, `live`) is a separate axis from the
  capability assurance levels of ADR-142 (`declared`, `observed`, `mediated`,
  `externally-enforced`). The first says how close a check came to the predicate; the second
  says what backs a claim about enforcement. Sharing one table would let a mediation record
  raise a test's fidelity.
- The module evaluates records and reads nothing: no runner is started, no clock is consulted,
  so a contract can be replayed against a recorded set of observations.
- `evaluateObligations` keeps every row, including the ones that did not apply, so a reader can
  see what was considered rather than only what failed.
