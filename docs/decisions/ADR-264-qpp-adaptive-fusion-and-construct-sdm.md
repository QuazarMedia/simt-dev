---
simt-affects: ["src/index/qpp.mjs", "src/index/constructs.mjs", "src/index/sdm.mjs", "src/index/bm25f.mjs", "src/index/map-v2.mjs", "src/knowledge/rank.mjs"]
simt-supersedes: []
---
# ADR-264 — Post-retrieval QPP adaptive fusion and construct SDM

Status: accepted · 2026-11-27

## Context

Uniform reciprocal-rank fusion suffers a "Fusion Tax" when flat or noisy
secondary channels dilute a high-confidence lexical or anchor signal. Similarly,
pasted multi-token error literals and multi-clause phrases lose specificity
when treated strictly as an unordered bag of words across generic code bodies.

## Rulings

1. **Weight ranker channels per query with post-retrieval QPP (`qpp.mjs`).**
   Normalized Query Clarity (`NQC`) and top-gap specificity scale each channel's
   base weight into `[0.25, 2.0]` (quantized to `1e-6`), using rank+score
   CombMNZ fusion (`0.7 / (k + i + 1) + 0.3 * normScore`). Secondary graph-walk
   channels (`directional`, `pagerank`, `coupling`) are capped at `maxPhi = 1.0`
   so noisy walks never invert a strong primary lexical hit (`ADR-234`, `ADR-235`).
   Per-channel QPP diagnostics (`nqc`, `topGap`, `effectiveWeight`) appear under
   `--explain`.
2. **Extract `invocations` and `string_literals` fields and apply top-32 SDM.**
   Schema v7 FTS indexes deduplicated call sites (`invocations`) and 6–120
   character string literals (`string_literals`) alongside existing BM25F fields.
   Both `simt map --retrieval v3` and `simt knowledge rank --retrieval v3`
   rerank top-32 candidates with ordered bigram and unordered window-8
   Sequential Dependence (`#1` / `#uw8`) scoring while preserving `ADR-232`
   Unicode identifier handling.

## Consequences

- Queries carrying error literals or contiguous phrases rank the exact
  implementing source or decision first without penalizing broad queries.
