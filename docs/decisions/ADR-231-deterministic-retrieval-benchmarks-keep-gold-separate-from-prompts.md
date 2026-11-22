---
simt-affects: ["packages/bench/src/multitask-corpus.mjs", "test/bench-multitask-corpus.test.mjs"]
---

# ADR-231 — Deterministic retrieval benchmarks keep gold separate from prompts

Status: accepted · 2026-11-22

## Context

The history miner in ADR-076 identifies single-commit tasks. Composite prompts
need additional evidence because strong aggregate recall can conceal a missed
subtask, a lost facet, or unrelated results reached through a dispatcher.

## Rulings

1. **Report retrieval by stratum.** The corpus covers mined lexical queries,
   vocabulary gaps, composite prompts, and structural impact and governance.
   Composite cases balance the supported sizes of 2, 3, 4, 6 and 8 subtasks.

2. **Pass public prompts and private gold independently.** Retrieval arms get
   task descriptors and the repository under test. The grader receives gold
   keyed by task ID. IDs, coverage and gold shape are validated before grading.

3. **Measure omissions and noise explicitly.** Track minimum subtask coverage
   and facet completeness alongside file Recall@10 and reciprocal rank.
   Track the share of impact results reachable only through an unrelated hub.
   Hold default promotion to paired measurements against the recorded baseline.

## Consequences

- The benchmark can report a starved subtask even when mean recall improves.
- Synthetic cases establish expected results for observable graph relationships.
  Mined cases preserve their Git bases for repeatable retrieval comparisons.
