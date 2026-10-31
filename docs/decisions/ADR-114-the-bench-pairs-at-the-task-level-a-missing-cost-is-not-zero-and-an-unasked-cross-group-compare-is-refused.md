---
simt-affects: ["src/bench/report.mjs", "src/bench/run.mjs", "src/bench/ablate.mjs", "src/bench/variants.mjs", "src/advice/advice.mjs", "src/commands/bench.mjs", "test/bench.test.mjs"]
simt-supersedes: []
---

# ADR-114 — the bench pairs at the task level, a missing cost is not zero, and an unasked cross-group compare is refused

Status: **accepted** · 2026-10-31

## Context

Review 0003 (Q46) verified three failures in the bench statistics and read a fourth
in the code:

- One task with ten reps produced `pairedRuns 10, mcnemar p 0.00195` — the run-level
  pairing treated reps of a task as independent tasks, inflating significance by an
  order of magnitude.
- A claude run with usage but no prices table reported `C $0.0000 | CPI $0.0000` — a
  missing cost read as a zero cost, the cheapest outcome measurable.
- `gold` and `noop` harness runs of the same arm name pooled into one 50 % row — the
  harness that produced each run was invisible.
- Ablation tested ~N sections at α 0.05 each with no multiplicity correction, and the
  bootstrap CPI confidence intervals silently dropped the resamples whose cost was
  undefined.

Plan 0004 §1 fixes the shape of the answer: repeats of a task are not independent
tasks; the cost per verified outcome is undefined when none resolve, never zero; and
non-inferiority is judged by a one-sided 95 % lower bound of ΔR above −2 percentage
points, with inconclusive evidence reported when the interval is too wide to decide.

## Ruling

1. **Pairing is at the task level only.** `compareArms` collapses each arm to
   task means and pairs on shared tasks. The exact two-sided sign test on task-mean R
   replaces McNemar (the sign of a task-mean difference does not assume the 0/1
   contingency McNemar requires); the Wilcoxon signed-rank test runs on task-mean C.
   `pairedRuns` survives as a descriptive count (Σ min reps) and is never used in a
   statistic.
2. **An unknown cost is null, never zero.** `computeRunCost` returns `{ usd, source }`
   with `source` ∈ `priced | reported | missing`; `usd` is null when no prices table
   applies and the harness reported no cost. A task's C is null if any rep's cost is
   missing, an arm's C likewise, and the arm's C confidence interval is null rather
   than narrowed to the resamples that happened to price out. `CPI` is total cost
   divided by resolved outcomes and is null when the cost is incomplete or nothing
   resolved — never zero, never a favourable finite score.
3. **A report row is a (harness, model, arm, experiment) group.** Pooling across
   harnesses is gone. A `--compare` whose arm name matches more than one group is
   refused as ambiguous, and a compare that crosses harness, model or experiment is
   refused unless the caller passes `crossGroup` (CLI `--cross-group`).
4. **Multiplicity is controlled with Holm step-down.** The family is the set of
   comparisons tested in one run — the ablation sections, and per slot the
   variant-versus-baseline comparisons — and the adjusted p-values feed the canary
   escalation decision.
5. **The verdict is a non-inferiority verdict.** With `n < 5` paired tasks the
   verdict is `insufficient-tasks` — the smallest two-sided sign-test p-value at
   n = 4 is 0.125, so fewer tasks cannot reject at α = 0.05 and the sample is said
   to be too small, not that the p-value was high. Otherwise: `non-inferior` when
   the one-sided 95 % lower bound of ΔR is above −2 pp, `inferior` when the two-sided
   bound is entirely below 0, `inconclusive` when the interval is too wide to decide.
6. **v1 records keep reading.** A numeric `costUsd` is a reported cost; a null one is
   missing. No migration, no new schema version.

## Consequences

- `mcnemarTest` stays exported and is exercised by its unit test; `compareArms` no
  longer returns an `mcnemar` key, so its only live caller inside the tool is the
  sign test.
- `simt bench report` markdown gains Harness and Model columns, a `Sign` row, and
  non-inferiority and verdict lines; the `--cross-group` flag exists only to override
  refusal.
- `simt bench ablate` and `simt bench variants` escalate on Holm-adjusted p-values,
  and a section entry carries `rTest` instead of `mcnemar`.
- Advice skips un-costed runs when grounding a cost floor, and variant ranking treats
  an unknown cost as worst — it cannot be ranked cheaper than anything.
