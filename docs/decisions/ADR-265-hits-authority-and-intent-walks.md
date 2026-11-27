---
simt-affects: ["src/index/hits.mjs", "src/index/directional.mjs", "src/index/map-v2.mjs"]
simt-supersedes: []
---
# ADR-265 — Precomputed HITS hub and authority scores with intent walks

Status: accepted · 2026-11-27

## Context

Purely undirected degree centrality conflates thin barrel re-export files with
core implementation authorities, and uniform hop propagation leaks across
unrelated top-level directories in large repositories (`ADR-238`).

## Rulings

1. **Precompute deterministic HITS Hub and Authority scores at index time.**
   `hits_scores` stores quantized (`1e-6`) Hub and Authority scores over the
   weighted import and symbol reference graph with deterministic alphabetical
   tie-breaking and bounded iteration.
2. **Parameterize directional walks by query intent and directory cohesion.**
   Under `retrieval v3`, bugfix and debug intents favor high-Authority targets
   over barrel hubs, wiring and feature intents lift Hub entrypoints, and
   secondary directory propagation stays bounded within cohesive directories.

## Consequences

- Structural expansion avoids barrel-file distraction during defect triage
  without adding graph traversal cost on the query path.
