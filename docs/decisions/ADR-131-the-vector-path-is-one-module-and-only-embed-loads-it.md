---
simt-affects: ["src/index/vectors.mjs", "src/index/map.mjs", "src/commands/map.mjs", "test/map.test.mjs"]
simt-supersedes: []
---
# ADR-131 — The vector path is one module, and only `--embed` loads it

Status: accepted · 2026-11-02

## Context

Review 0003 Q84 found the embeddings code spread across `src/index/store.mjs`,
`src/index/map.mjs` and `src/local/client.mjs`, with the recall branch written twice and a
"+10 points" bar that the review could not find shown met. `loadGraph` in `src/commands/map.mjs`
loaded stored vectors whenever a caller passed `embed`, and `rankByCosine` lived in `map.mjs`
beside the ranking it feeds, so the one part of the map that can open a socket sat in the same
module as the pure ranking function.

## Rulings

1. **The vector path lives in `src/index/vectors.mjs`.** Cosine scoring, the stored-vector
   rank and the query embedding call move there together; `src/index/map.mjs` imports them and
   keeps what is not a vector: the ranking, the recall measurement and the acceptance bar.

2. **Nothing loads the vector path by accident.** `loadGraph(root, { embed: false })` — the
   default every `map`, `brief` and `slice` run takes — reads files, symbols and edges and
   never reads stored vectors or the local endpoint configuration. A caller asking for
   embeddings is the only way that module's socket code is reached.

## Consequences

- `test/map.test.mjs` imports `cosineSimilarity` and `rankByCosine` from the new module, so a
  later move that folds them back into the ranking file fails a named test rather than passing
  because both names still resolve somewhere.
- The acceptance bar (`EMBED_RECALL_GAIN_BAR`) stays in `map.mjs` with `measureRecall`, which
  is the only code that can show it met or unmet. This record changes where vectors live, not
  whether they are on.

## Rejected

- **Deleting the vector path now.** Rejected: the review's verdict is "revisit in W19", and a
  feature that is off by default costs nothing at runtime once nothing loads it. Removing
  working code to settle a placement question is the mistake ADR-129 rejected for `distill`.
- **Re-exporting the three names from `map.mjs` for compatibility.** Rejected: the only
  importers are in this repository, and a compatibility shim would hide exactly the coupling
  this record removes.
