---
simt-affects: ["src/verify/closure.mjs", "test/work-closure.test.mjs"]
simt-supersedes: []
---

# ADR-166 — completion is unanimous, and its semantics are part of the output

Status: accepted · 2026-11-03

## Context

A closure report is the sentence a reader quotes without re-checking. Four failures made that
sentence unreliable:

- a required eight-check closure reported 6/8 as progress, and progress was repeated as "done";
- an obligation whose live verifier could not be reached was recorded as passed because the
  local half passed, which is a claim about a target nobody contacted;
- a remote-only task was closed by attaching an invented code diff, because the format assumed
  a code change existed;
- a new completion rule shipped inside the field old consumers were already reading.

## Rulings

1. **Completion is unanimous over the required set.** Every required obligation must be `pass`.
   `coverage` reports required/passed/total, and any shortfall is `BLOCK` with the unresolved
   ids named. There is no "mostly complete": 6/8 is a blocked state.

2. **The worst record wins.** When several records describe one obligation, the state is the
   worst of them, by a fixed precedence: a single `unavailable` or `fail` defeats any number of
   passes. Unavailable evidence is never relabelled as a pass.

3. **A waiver and a non-applicable obligation are not passes.** A waived obligation is owed and
   excused; a non-applicable one does not bear on this subject. Neither counts towards
   completion, and both are visible in the checks list.

4. **A remote-only closure carries its contract and receipts, and no diff.** With no changed
   paths, completion requires a reviewed contract commit; the report sets `codeDiff: null` and
   says so, rather than inventing a diff to satisfy a shape built for code.

5. **A local closure may document an external block without claiming it.** With `scope: source`,
   an external obligation that is unresolved is listed in `blocked.external` with the document
   that records it, and the source closure can still complete. A closure that claims the remote
   scope (`remote`, `both`) is blocked by the same obligation.

6. **An opted-in contract needs an outcome digest or a receipt set.** A local SHA-and-test
   closure stays valid without one; a contract that opted in does not, because the contract is
   what said the outcome would be recorded.

7. **The semantics are versioned in the output.** `simt.closure/1` keeps exactly the fields its
   consumers parse — `complete`, `checks.passed`, `checks.total`, `sha` — and carries no
   `verdict`. `simt.closure/2` adds the verdict, the completion kind, the coverage, the checks
   and the unresolved list. An unknown version is an error, not a guess.

## Consequences

- The report is a value with no clock and no filesystem, so a closure can be replayed against a
  recorded evidence set and diffed.
- `src/commands/evidence.mjs` is unchanged: `simt verify status` is the surface that will render
  this report, and it can adopt v2 without moving what existing consumers read.
- The v1 shape is a compatibility promise, not a deprecated branch: both versions are computed
  from the same resolution, so they cannot disagree about whether something passed.
