---
simt-affects: ["packages/bench/src/accounting.mjs", "packages/bench/src/report.mjs", "packages/bench/src/render.mjs", "test/work-metrics.test.mjs"]
simt-supersedes: []
---
# ADR-139 — a benchmark gain is reported beside its cost and its coverage

Status: accepted · 2026-11-02

## Context

Plan 0004 W04 asks for a benchmark that detects real gains without hiding code regressions
or shifting work to people. The report already carried R, Q, cost, cost per outcome and a
paired comparison with a verdict. What it could not say was how much of the work was
evidence-backed, how much of the cost was human review, how much of the remote verification
was a mock, and whether the experiment was large enough to decide anything. A single arm
mean answered all four by omission, and the omission always flattered the arm.

## Rulings

1. **Verified resolution is per stratum, and every predicate is required.** A run resolves
   only when it passed its hidden tests, every declared gate, every applicable hard
   constraint, and any evidence requirement with current evidence. A run that passed its
   tests and carried a stale citation did not resolve the task.

2. **Repeats fold into their task before any mean, and strata are never pooled.** The unit
   of the interval is the task. A gain on source tasks cannot stand in for a loss on
   knowledge or remote ones, which is the whole reason the strata exist.

3. **Coverage counts obligations with current admissible evidence, over all of them.**
   Unknown, unavailable, waived and unrun stay in the denominator and are counted by name: a
   waived obligation is visible work, not completed work. No obligations is not full
   coverage, so it reports as undefined rather than as one.

4. **Knowledge and remote quality are separate dimensions, and a hard failure is not
   averaged.** A hard failure nulls the descriptive score and is reported beside the
   dimensions that were graded. A run whose only remote evidence is a local mock has no
   remote score; the mock is reported as a mock.

5. **Cost is by component, and a missing component stays missing.** Model billing, tool
   billing, remote billing, wall time, retries, remote seconds and human review minutes are
   reported separately. Seconds, retries and minutes keep their units and are never priced
   here; dollars total only when every dollar component was reported. Cost per verified
   outcome stays undefined when nothing resolves, never zero.

6. **The sample plan comes from the pilot, and a canary is not evidence.** The required task
   count is the plan formula against the declared effect and the pilot's own deviation. A
   zero-variance pilot is unsized rather than sized at zero. Thirty tasks at three
   repetitions is the canary size and is labelled as one.

7. **A default needs non-inferior, powered, regression-free evidence, and the refusal lists
   its reasons.** Inconclusive, inferior, underpowered, regressed or stratum-losing evidence
   cannot enable a new default. The reasons are returned so the refusal is actionable, and
   this record grants no default itself.

## Consequences

- A report is larger and its markdown gains a strata table and a disclosure sentence naming
  tasks, repetitions, exclusions, timeouts, coverage and which strata are still canaries.
- The accounting is pure and deterministic, so a pull request diffs the same numbers on any
  machine, and a report over a corpus with no measurements reports nulls rather than zeroes.
- Nothing about what a gate runs changes; no default is enabled by this record.

## Rejected

- **One weighted score over the dimensions.** It is the aggregation the plan forbids, and it
  makes a hard failure arithmetically survivable.
- **Pricing human review minutes in dollars here.** Conversion needs a declared rate, and a
  rate invented by the tool would be the invented dollar value the plan rules out.
- **Pooling strata into one interval when a stratum is small.** The pooled interval is
  narrower, which is exactly the pressure that made pooling attractive.
