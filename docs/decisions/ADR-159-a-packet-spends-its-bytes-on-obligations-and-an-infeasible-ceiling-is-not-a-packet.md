---
simt-affects: ["src/brief/proof.mjs", "test/work-brief.test.mjs"]
simt-supersedes: []
---

# ADR-159 — a packet's bytes are spent on obligations, and an infeasible ceiling is not a packet

Status: accepted · 2026-11-03

## Context

A brief was assembled by relevance: the files the index ranked, the decisions that matched,
the lessons in scope. That is the right answer to "what does this repository know about this
task" and the wrong answer to "what must I read to satisfy what this task owes". Two packets
of the same size can differ completely in what they prove, so byte count was never the metric
— and the packing kernel, which cuts by section value and insertion order, had no way to know
which line was evidence for which obligation.

Three failures follow from that. A quotation with no revision is unverifiable and reads the
same as one with it. A redundant but authoritative page can win a slot by being linked. And a
ceiling too small for the mandatory safety line produced a packet that met the ceiling by
dropping the line.

## Rulings

1. **A unit names the obligations it is evidence for, and selection is marginal coverage per
   byte**, with authority as a bounded multiplier. Gain is computed against what is already
   covered, so a unit that closes nothing is redundant whatever its authority.

2. **Mandatory text is a floor, never a candidate.** Safety and identity units are selected
   before any scoring, and are never cut. If they alone exceed the ceiling the result is
   `overBudget: true, complete: false` with the reason stated; the packet does not claim a
   ceiling it did not meet and does not drop the line to meet it.

3. **No citation, no evidence.** A unit without a revision ref, a digest and an anchor is
   rejected with `no-citation`. It cannot be selected, and an obligation only it covered is
   reported as omitted. A mandatory unit that fails this makes the packet incomplete.

4. **Completeness is coverage, not stopping.** `complete` requires every required obligation
   covered, every mandatory unit kept, and the stable part within the ceiling. A packet that
   ran out of budget is `complete: false`, and the uncovered obligations are named.

5. **Time-varying observations are a suffix.** Dynamic units render under a `DYNAMIC` heading
   and never enter `stable`. Two reads of an unchanged tree therefore produce identical
   stable bytes, which is what makes a packet diff meaningful.

6. **The ceiling is the measured one.** `PROMPT_CAP_BYTES` (2048, defined with the packing
   kernel) is a hard maximum, not a default: a caller may lower its budget and may not raise
   it past a number that was measured.

7. **Coverage is reported so a comparison is not a byte count.** The result carries
   `coverage.required`, `coverage.covered` and `coverage.fraction`, and the selection order,
   so a bench can compare what two packets prove at the same cost.

## Consequences

- The module reuses the kernel's ceiling constant and stays pure: no filesystem, no clock, no
  environment, so the whole selection is replayable.
- `buildProofPacket` sits beside `buildPacket` rather than replacing it. The existing brief
  keeps its section-value packing for callers that want the repository's knowledge; a
  proof-bearing packet is what a task with obligations asks for.
- Selection is greedy, not optimal. Optimal coverage under a byte ceiling is a knapsack, and a
  deterministic greedy pass is what the determinism rule allows; `order` and `cut` make the
  choice inspectable rather than making it optimal.
