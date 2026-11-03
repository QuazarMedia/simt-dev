---
simt-affects: ["src/knowledge/conflicts.mjs", "test/knowledge-conflicts.test.mjs"]
simt-supersedes: []
---
# ADR-153 — a conflict is a difference on four axes, uncertainty is a question, and no finding certifies prose

Status: accepted · 2026-11-03

## Context

A conflict report is only useful if its verdicts are separable. German and French rates,
2023 and 2024 rates, a percentage and a ratio, and two genuinely rival numbers are all pairs
of differing values; reported as one word, a reviewer learns to skim, and the one pair that
matters is indistinguishable from the four that do not.

The opposite failure is a clean report read as a clean document. A machine that compares
declared claims has said nothing about the paragraphs nobody declared, and any tool that
returns "no contradictions" is inviting the reader to conclude something it did not check.
A third failure sits between them: a claim whose scope is unstated against one that names a
jurisdiction. Calling that a contradiction asserts a disagreement about the same population
that nobody established; calling it agreement is worse.

## Rulings

1. **Four axes, fixed order: type, unit, scope, period, then value within a declared
   tolerance.** A pair differing on an earlier axis gets that verdict, because a number and a
   string, or a percentage and a ratio, are not in a position to contradict each other.

2. **A difference in scope or period is not a contradiction.** It is `different-scope` or
   `different-period`: two claims about different populations, or successive claims about one.
   Only a same-scope, overlapping, same-unit, same-type pair with differing values is a
   `contradiction`.

3. **A missing scope or a missing effective start makes the pair `indeterminate`.** It is a
   question for a person, carrying the obligation that would settle it (`scope:establish`,
   `date:establish`), never a finding about the world.

4. **Tolerance is declared, and its default is zero.** A near-miss is agreement only where a
   repository says how near; a tool that invented a tolerance would be deciding how much a
   value may drift.

5. **Every unresolved pair leaves obligations.** `resolve:value` for a contradiction, plus
   `owner:assign` and `outputs:identify` when no declaration names who settles it and what
   depends on it. An ambiguity nobody owns is not resolved by being reported.

6. **No finding certifies prose.** The result states `certifies: false` and reports the
   natural-language detector as `not-installed` with `assessed: 0`. When an entailment critic
   arrives, its precision, recall and unassessed coverage are reported separately from the
   structured verdicts, and never folded into them.

7. **A style or confidence score cannot move a verdict.** Confidence is not evidence about a
   value; a claim carrying a high score is compared exactly like one carrying none.

## Consequences

- `findConflicts` returns every pair, including `same`, so a report can be audited against
  the corpus that produced it rather than only against its conflicts.
- A claim without a subject, predicate, type or value is `skipped` with a reason instead of
  being compared as if it were complete.
- Scope comparison reads the four declared dimensions from the validity model (ADR-151); a
  dimension both claims leave open is not a difference.
