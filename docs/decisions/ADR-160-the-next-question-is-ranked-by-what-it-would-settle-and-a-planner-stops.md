---
simt-affects: ["src/verify/next.mjs", "test/verify-next.test.mjs"]
simt-supersedes: []
---

# ADR-160 — the next question is ranked by what it would settle, and a planner stops

Status: accepted · 2026-11-03

## Context

An unresolved obligation produces a recognisable failure of behaviour: the reader browses.
They re-read the source they already have, or dump an entire target, because every action looks
equally likely to close the gap. The cost is not only time; a full dump also makes the next
decision harder, because it returns everything and discriminates nothing.

Two smaller failures make a planner worse than none. A probability invented to make a ranking
look quantitative cannot be checked and will be believed; and a planner that keeps returning
options after every one has been excluded is a loop with a friendly name.

## Rulings

1. **Constraints are applied before ranking.** Network, actor and budget remove a capability
   from consideration and the result says which constraint did it. A forbidden read is not a
   low-ranked option.

2. **Rank by expected coverage and discrimination over latency and cost.** Expected coverage is
   the share of the unmet obligations a capability claims to discharge; discrimination is how
   well the check separates pass from fail (a targeted read is high, a full dump low); both are
   divided by the estimated latency and cost.

3. **A rate appears only with its denominator.** Measured history is used when it exists, and
   then the offer carries `basis: 'measured'`, the rate and its `attempts`. Without history the
   offer carries `basis: 'ordinal'` and `probability: null`. There is no default probability,
   no prior, and no rounding that makes an estimate look measured.

4. **Unknown cost is labelled, not guessed.** A capability that does not state its cost is
   priced at the neutral middle for ranking and reports `costBasis: 'unknown'`; a reader can
   see that the ordering rested on an estimate.

5. **Every offer is a suggestion.** `status: 'suggested'`, `executed: false`,
   `requiresInvocation: true`, and the module opens nothing. A remote read happens when a
   caller invokes it, never because a planner ranked it first.

6. **A stop is a result, not a failure to produce one.** When no admissible capability covers
   an unmet obligation, the plan carries a stop naming the obligation and whether what is
   missing is a `capability` or a `decision`, with `retry: false`. Nothing here loops: a second
   identical call returns the same plan.

7. **Settled obligations are not part of the question.** `pass`, `waived` and `not-applicable`
   are excluded from the unmet set, so the planner cannot ask for proof of something already
   settled by evidence or by a reviewed decision.

## Consequences

- The planner consumes the obligation states from ADR-158 and adds no new judgement about
  whether an obligation holds: it only asks what would settle one that does not.
- `history` is a parameter rather than a store. The module reads no ledger, so a caller can
  replay a plan against a recorded history and diff the ranking.
- A capability whose declared predicate kinds cannot discharge the obligation is excluded as
  `does-not-discharge`, which keeps a formatter run out of the answer to an entailment
  question.
