---
simt-affects: ["src/index/directional.mjs", "src/index/map.mjs", "src/commands/map.mjs"]
simt-supersedes: []
---
# ADR-238 — Experimental graph retrieval follows directional evidence

Status: accepted · 2026-11-22

## Context

An undirected import walk can rank common utilities ahead of the callers
where a named behavior is used. Symbol binding supplies the direction and
kind of each relationship.

## Rulings

1. **Expand from lexical anchors using typed edges.** A caller receives more
   activation than a callee. Containment and inheritance retain their own
   weights, and co-change contributes in proportion to its measured strength.

2. **Bound diffusion and retain its evidence.** Discount high-degree seeds
   unless they are exact anchors. Inhibit high-degree destinations, keep at
   most 24 candidates per hop and stop after two hops. Each candidate records
   the contributing path with the greatest weight.

3. **Qualify directional scores as experimental.** Promotion depends on the
   paired retrieval evidence required by ADR-231.

## Consequences

- The experimental ranker can explain where each graph score came from.
- The default graph ranking remains available during qualification.
