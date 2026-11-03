---
simt-affects: ["test/pilot-knowledge.test.mjs", "test/fixtures/pilot-knowledge.json"]
simt-supersedes: []
---

# ADR-188 — the knowledge pilot is a synthetic fixture over the real modules, and its live half is unrun

Status: accepted · 2026-11-03

## Context

The knowledge pilot has to show that retrieval, conflict handling and document routing agree on a
repository-shaped case. It must not need a live document store, and it must not be written so that
a synthetic case reads as a live result.

## Rulings

1. **The fixture is the whole world.** Three units, two contradicting claims, one document matrix,
   committed beside the test. No network and no document store: the test asserts that the modules
   it exercises import no network module and call no `fetch`.

2. **Lookup keeps the unit that applies and excludes the one that does not.** A unit scoped to
   another jurisdiction is excluded with that reason; a unit with no declared scope is reported
   beside the answer rather than dropped or ranked as if it applied.

3. **A disagreement is reported, not averaged.** Two different rates for one subject and predicate
   produce a finding naming both claims; no single value is presented as the answer.

4. **Document routing honours the matrix and its exclusions.** A mapped page selects its rubrics and
   its excluded rubric is reported as excluded; an unmapped page is `unmapped` with `no-mapping`,
   not silently unreviewed.

5. **The live half stays unrun.** No credential, no opt-in marker and no live assertion; a live
   pilot is a separate authorised act with its own evidence.

## Consequences

- The pilot fails if retrieval, conflict detection or document routing regresses, because it calls
  the real modules rather than describing them.
- The pilot is a consumer-shaped case, not a benchmark: it measures nothing and reports no score.
