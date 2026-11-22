---
simt-affects: ["src/index/live.mjs", "src/index/overlay.mjs", "src/index/graph-read.mjs", "src/commands/map.mjs", "src/commands/impact.mjs", "src/commands/gate.mjs", "src/brief/assemble.mjs"]
simt-supersedes: [{ adr: "ADR-108", ruling: 2 }]
---
# ADR-237 — Live graph reads leave the staged cache intact

Status: accepted · 2026-11-22 · supersedes ADR-108 ruling 2

## Context

A staged index cannot see an edit as soon as it is saved. Commands that used a
separate filesystem scan could see it, but each scan reread unrelated sources.

## Rulings

1. **Merge working-tree edits over staged evidence.** Read the staged graph in
   a single snapshot. Re-extract only changed source content, and retain the
   working-tree revision on each replacement. Omit deleted paths. A test
   selection may retain a deleted target for resolving incoming imports.

2. **Keep the overlay in memory.** A command may read missing staged evidence
   from Git objects for its answer. A latency-sensitive caller may decline
   that work and report a cold or stale cache. `simt index` refreshes the
   persistent staged cache.

3. **Apply path policy before reading changed content.** Dirty paths excluded
   by the overlay policy or Git's ignore rules cannot contribute working-tree
   content. Record failed reads alongside the overlay provenance.

## Consequences

- A saved change can appear in a map, brief, impact report or test selection
  before staging. Running those commands leaves the persistent index intact.
- The existing adoption build under ADR-108 ruling 1 still populates the
  staged cache for the first prompt in an adopted repository.
