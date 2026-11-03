---
simt-affects: ["src/memory/graduation.mjs", "test/work-graduation.test.mjs"]
simt-supersedes: []
---

# ADR-181 — graduation needs three validated independent runs, and equivalence is semantic rather than transport

Status: accepted · 2026-11-03

## Context

Turning exploration into a recipe, and a recipe into code, is where one success becomes a claim of
generality:

- a single trace graduated to a helper because it happened to work once;
- a common subsequence was presented as the procedure when it was the accident of one run;
- environment-local ids were carried into a portable recipe;
- a helper was compared to the reference by transport trace rather than by result;
- a single tenant's trace became a "portable skill" by deleting its hostname.

## Rulings

1. **Three validated independent runs are the minimum to propose.** Fewer yields
   `insufficient-evidence` with the count and the reason; the minimum itself is evidence to review
   rather than proof of generality.

2. **Only validated, independent runs count.** A dependent run is excluded, whichever harness
   produced it.

3. **A proposal states its common steps, its branches and its parameters.** The common subsequence
   is what the runs share in order; the branches are what only some runs needed; environment-local
   values (numeric ids, UUIDs, example hosts) are parameters rather than constants.

4. **Promotion needs a held-out variant and a failure path.** `promotionReady` requires both, and
   keeps `humanReview: true`: a PR owns the code and the recipe change.

5. **Equivalence is semantic.** `differentialReplay` compares postconditions and frame conditions,
   and reports `transportIdentical: false` — a helper may take a different route and still be
   right, and may take the same route and still be wrong.

6. **Portability needs more than one environment.** A single environment cannot establish
   portability whatever the hostname is called; the parameters are what carry the coupling.

## Consequences

- Proposals are values, so two runs of the analysis can be diffed and a reviewer can see exactly
  which traces supported which claim.
- Nothing here promotes anything: it proposes, and the reviewed change is where a helper is born.
