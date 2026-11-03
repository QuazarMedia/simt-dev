---
simt-affects: ["src/knowledge/debt.mjs", "test/knowledge-debt.test.mjs"]
simt-supersedes: []
---

# ADR-184 — knowledge debt is a sum of named components, and a frequency nobody measured is not a probability

Status: accepted · 2026-11-03

## Context

Maintenance effort is finite, so the ranking of what to refresh is a decision with consequences.
The failures behind this record:

- a cosmetic orphan outranked a stale source that obligations depend on;
- a score whose components nobody could see, so a rank change could not be explained;
- a probability invented for a frequency nobody had measured;
- confidential queries leaking through an estate aggregate;
- a cold-start report presented as if usage had been observed.

## Rulings

1. **The score is a sum of named components over the refresh effort.** Affected obligations, the
   criticality class (low 1, normal 2, high 4, critical 8) and recorded query frequency, capped,
   divided by effort. `score` returns the components beside the total, so a rank is explainable.

2. **Weights are declared and changing one is a reviewable change.** `DEFAULT_WEIGHTS` is a
   constant; `weightSensitivity` reports which items moved and names the weight that moved them.

3. **No probability is invented.** A frequency is counted and capped; the report carries no
   likelihood and no estimate of how often a claim is true.

4. **A confidential item is excluded from the estate aggregate.** It is counted for its owner and
   never contributes to a cross-repo total; the excluded count is reported so the difference is
   visible.

5. **Cold start is labelled.** An item with no recorded queries is marked cold and its rank rests
   on obligations and criticality alone, with the reason stated.

6. **Ties break by id.** Two runs of the same input produce the same order.

## Consequences

- The report is local: it proposes an order, and it creates no tickets and sends no notifications.
- Before a ranking becomes a default recommendation, an ablation must show better verified
  outcomes per unit of effort; this module produces the comparison, not the decision.
