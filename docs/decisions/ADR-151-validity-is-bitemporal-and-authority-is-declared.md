---
simt-affects: ["src/knowledge/validity.mjs", "test/knowledge-validity.test.mjs"]
simt-supersedes: []
---
# ADR-151 — validity is bitemporal, authority is declared, and an unplaceable claim blocks the answer

Status: accepted · 2026-11-03

## Context

A correction published this year changes what a document should say about 2021, and the same
question asked before the correction was published had a different correct answer. One date
cannot carry both facts, so a retriever that stores "the claim" and answers from it is wrong
in one of the two directions depending on which date it kept. The visible symptom is a
document that quietly rewrites history; the checkable one is that the historical answer
cannot be reproduced.

The second defect is quieter. Two sources in force at once, with nothing saying which
governs, is a question for a reviewer. A tool that answers it by publication date has
invented a policy — "newest wins" — that nobody adopted, and it makes the conflict disappear
from the report instead of appearing in it.

## Rulings

1. **Two intervals, never one.** A claim carries an effective interval `[validFrom, validTo)`
   and a recording interval `[recordedFrom, recordedTo)`. A query takes both `asOf` and
   `knownAt`; either may be different from today, and neither defaults to a clock reading.

2. **`validFrom` is required; an open start is not "always true".** A claim with no effective
   start is `unknown`, not applicable: its history was not recorded, and the answer cannot
   pretend it had none.

3. **Authority is a declared partial order with explicit supersession.** `supersedes` removes
   a claim from the running before ranking; `authority` ranks with `outranks` pairs. The
   maximal set is the answer, so a partial order that ranks one pair and leaves two other
   claims untouched yields a conflict, not a coin toss on listing order.

4. **A conflict set is a result, not a pick.** Two in-force claims with nothing ranking them
   report `conflict` and name both. Recency never breaks a tie, and neither does source URL.

5. **An unplaceable claim blocks a settled answer.** Any claim matching the question that
   cannot be placed — no applicability, no recording date, no effective start, or a declared
   scope the claim does not state — makes the result `unknown`, with the otherwise-resolved
   claims reported as `tentative`. A different scope value is merely inapplicable.

6. **The query is a question.** `subject` and `predicate` are required, and a claim about
   something else is not a competing answer. Without it, "give me the claim" is exactly the
   latest-wins query this ruling forbids.

7. **No function reads a clock.** `asOf`, `knownAt` and any observation time are arguments,
   so a projected byte string does not change between two runs of the same snapshot.

## Consequences

- `readApplicability` validates a record where it is written; `applicableClaims` tolerates a
  hand-written record that validation would reject, and reports it as `unknown` with the
  reason instead of throwing mid-query.
- Days are the only accepted date form. A timestamp would make the answer depend on a
  timezone the repository never declared.
- Operational freshness is a separate, explicit observation clock (plan 0004 W15); it never
  enters this module or a byte-stable projection.
