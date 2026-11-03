---
simt-affects: ["src/knowledge/impact.mjs", "src/knowledge/validity.mjs", "src/knowledge/rank.mjs", "test/work-impact.test.mjs"]
simt-supersedes: []
---

# ADR-157 — impact is typed, proposed edges are not dependencies, and a lesson carries its tenant

Status: accepted · 2026-11-03

## Context

An import walk answers "which code depends on this file" and stops where the work stops being
code. A rate source reaches a claim, the requirement document built from it, the design note,
the recipe, the graduated helper, the test and the remote object the recipe affects — none of
which is an import. Reporting only the code half is not conservative; it is a wrong list that
looks finished.

Two further failures make a report untrustworthy rather than merely incomplete. A dependency
extracted by a model looks like a reviewed one, so the impact set silently grows links nobody
approved. And a lesson is advice about a context: one tenant's incident, applied to another,
becomes an instruction nobody authorised.

## Rulings

1. **The walk is over the typed graph, not the import graph.** Claims, artifacts, recipes,
   helpers, tests, remote objects and sources are buckets, because "affected" without a kind
   is not actionable. The code impact walk is unchanged and still answers its own question.
   An object a recipe writes is reached by one forward hop from that recipe, not by the
   dependents walk: the object does not depend on the source, but the recipe's change leaves
   it stale, and an object reached no other way would be missing from every report.

2. **An unreviewed edge is reported beside the set, never inside it.** What is reachable only
   through a `proposed` edge is listed separately; counting it would let a hypothesis widen the
   answer, and dropping it silently would hide a dependency somebody suggested.

3. **Scope is filtered with the same predicate ranking uses.** A conflicting scope is excluded
   with a reason; a missing scope where the question names one is `unknown`. One predicate in
   the validity model serves both, so "applies" cannot mean two things.

4. **Unknowns are part of the answer.** A ref the graph does not hold, an unplaceable node, a
   generation conflict or an output with no receipt are listed, and any of them sets
   `complete: false` and `conservative: true`. Bound exhaustion does the same: a truncated
   walk is "unreported", never "unaffected".

5. **A lesson must belong to the tenant it advises.** A tenant-scoped lesson is excluded from
   a report that names another tenant, and from one that names none. Its text does not appear
   anywhere in the report — an excluded lesson that leaks its body has still been read.

6. **Evidence is counted by lineage, not by copies.** Lessons sharing a lineage collapse to one
   counterexample with `copies` and `corroborating: 1`; three restatements of one assertion are
   one source.

7. **The negative precedent sits beside the positive one.** An exemplar and the applicable
   failures are returned together, so a successful example is never the only thing a reader
   sees.

## Consequences

- `satisfiesScope` moved into `src/knowledge/validity.mjs` and is imported by both ranking
  (W19) and impact (W22); the ranker's local copy is gone, so the two cannot drift.
- The report is a pure function of the graph, the receipts and the lessons; it reads no file
  and no clock, which is what lets a corpus replay it.
- Derivation outputs are bucketed as artifacts and their receipts' unknowns join the same
  frontier, so a stale generated document and a missing receipt are one list a reader can act
  on.
