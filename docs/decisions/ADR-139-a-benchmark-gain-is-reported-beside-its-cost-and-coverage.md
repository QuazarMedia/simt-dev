---
simt-affects: ["packages/bench/src/accounting.mjs", "packages/bench/src/report.mjs", "packages/bench/src/render.mjs", "test/work-metrics.test.mjs"]
simt-supersedes: []
---
# ADR-139 — a benchmark gain is reported beside its cost and its coverage

Status: accepted · 2026-11-02

Plan 0004 W04 asks for a benchmark that detects real gains without hiding code regressions
or shifting work to people. The report already carried R, Q, cost, cost per outcome and a
paired comparison with a verdict. What it could not say was how much of the work was
evidence-backed, how much of the cost was human review, how much of the remote verification
was a mock, and whether the experiment was large enough to decide anything. A single arm
mean answered all four by omission.

**Decision.**

1. Verified resolution is per stratum, and requires every required outcome predicate, every
   applicable hard constraint, and current evidence. A run that passed its hidden tests and
   failed a gate, a hard constraint or a stale-citation check did not resolve the task.
   Repeats are folded into their task before the mean, and strata are never pooled: a gain
   on source tasks cannot stand in for a loss on knowledge or remote ones.
2. Coverage counts obligations with current admissible evidence over all of them. Unknown,
   unavailable, waived and unrun stay in the denominator and are counted by name, because a
   waived obligation is visible work rather than completed work.
3. Knowledge and remote quality are reported as separate rubric dimensions. A hard failure
   nulls the descriptive score instead of being averaged away, and a run whose only remote
   evidence is a local mock has no remote score at all — the mock is reported as what it is.
4. Cost is reported by component: model billing, tool billing, remote billing, wall time,
   retries, remote seconds and human review minutes. Seconds, retries and minutes stay in
   their own units; dollars total only when every dollar component was reported, and a
   missing component stays missing rather than becoming zero.
5. Cost per verified outcome remains undefined when nothing resolves — never zero.
6. The sample plan is computed from the pilot's own standard deviation against the declared
   effect, and a stratum below thirty tasks or below three repetitions is labelled a canary.
7. A new default becomes eligible only on a non-inferior verdict, with no regressions, no
   stratum loss and no underpowered stratum. Inconclusive evidence cannot enable a default,
   and the refusal lists its reasons rather than returning a bare false.

**Consequences.** A report is larger, and its reader can now see what a smaller one hid.
The accounting is pure and deterministic, so a pull request diffs the same numbers on any
machine. This decision does not change what any gate runs, and it grants no new default.
