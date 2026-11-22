---
simt-affects: ["src/brief/submodular.mjs", "src/brief/render.mjs", "src/brief/packet.mjs", "src/brief/proof.mjs"]
simt-supersedes: []
---
# ADR-240 — A composite packet rewards diminishing evidence returns

Status: accepted · 2026-11-22

## Context

Cutting an entire low-priority section before shortening the busiest section
can remove every test or decision from a multi-task packet.

## Rulings

1. **Value coverage by task and facet.** Sum logarithmically saturated
   relevance across task and facet pairs. For a repeat of the same evidence
   within a pair, count the strongest contribution. A separate duplicate
   penalty could make adding valid evidence reduce utility.

2. **Keep the mandatory floor and account for bytes.** Select optional items
   by marginal utility per byte. Compare lazy density selection with a
   regularized density arm that checks the best feasible singleton at each
   prefix. Resolve ties by section, subtask and item identifier.

3. **Report an infeasible floor.** If mandatory bytes exceed the supplied
   budget, keep the floor and report the overage to the caller. The caller
   can render shorter forms or ask for a larger budget.

## Consequences

- Explanations can report the marginal gain and byte cost of selected items.
- Composite packets can balance files, tests and other evidence within the
  existing budget. The single-task waterfall remains the baseline.
