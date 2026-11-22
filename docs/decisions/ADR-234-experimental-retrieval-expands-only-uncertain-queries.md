---
simt-affects: ["src/index/prf.mjs", "src/index/map.mjs"]
---

# ADR-234 — Experimental retrieval expands only uncertain queries

Status: accepted · 2026-11-22

## Context

Task vocabulary can differ from the names of relevant code. Expansion from
the first results can bridge that gap, and it can also follow an incidental
topic in the same repository.

## Rulings

1. **Keep anchored and confident rankings byte-stable.** Skip expansion when
   an exact entity is resolved, when fewer than two results have scores, or
   when the relative margin between the first two results is at least 0.35.

2. **Bound feedback to three sources and six terms.** Skip tests and
   high-degree graph hubs as sources. Use Bo1 or score-weighted RM3-lite and
   keep terms found in at least two and at most 20 percent of indexed files.

3. **Keep original evidence dominant.** Allocate 70 percent of the blend to
   the original query and 30 percent to normalized expansion terms. Expose
   each expansion term and its source files.

## Consequences

- Paired experiments can compare expansion methods and audit each new term.
- The baseline map policy remains available during qualification under
  ADR-231.
