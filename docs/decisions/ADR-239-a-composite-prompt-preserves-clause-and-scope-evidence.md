---
simt-affects: ["src/brief/decompose.mjs", "src/brief/constraints.mjs", "src/brief/anchors.mjs", "src/brief/plan-graph.mjs"]
simt-supersedes: []
---
# ADR-239 — A composite prompt preserves clause and scope evidence

Status: accepted · 2026-11-22

## Context

Classifying an entire prompt gives one file list and one intent. A single
explicit path can crowd out the other requested changes.

## Rulings

1. **Split with visible structure and imperative boundaries.** Use Markdown
   and a bounded vocabulary of actions. Preserve quoted text, code, paths,
   and the original offsets of each clause.

2. **Inherit scope and bound the number of tasks.** Carry shared preamble and
   section headings to their clauses. When a prompt has more than 12 tasks,
   group adjacent clauses and retain every clause ID and span.

3. **Apply scope at the clause that names it.** Bind positive anchors,
   exclusions and conditions locally. Only an explicit global path option
   can restrict all clauses to the same file scope.

## Consequences

- Later packing can show which clauses received evidence and which were
  grouped for the budget.
- The existing single-task packet remains the baseline under ADR-231.
