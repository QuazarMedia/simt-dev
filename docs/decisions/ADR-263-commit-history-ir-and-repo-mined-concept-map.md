---
simt-affects: ["src/index/commit-ir.mjs", "src/index/concept-map.mjs", "src/index/cochange.mjs", "src/index/persist.mjs", "src/index/store.mjs", "src/index/graph-read.mjs", "src/index/prf.mjs"]
simt-supersedes: []
---
# ADR-263 — Commit-history IR and repo-mined bilingual concept map

Status: accepted · 2026-11-27

## Context

Lexical file ranking misses symptom queries phrased in business or user prose
when those words appear only in commit messages, comments, docstrings, or
decision records and never in source identifiers. Existing co-change mining
already reads bounded commit history (`COCHANGE_WINDOW = 500`) and discards
the commit messages.

## Rulings

1. **Index schema v7 stores bounded commit-history FTS (`commit_fts`).** Up to
   500 untangled commits (excluding sprawling commits above the source/test
   caps) are indexed in `commit_fts` with `512 B` body caps, recency decay
   (half-life 100 commits), and `maxp + sum-top-2` file scoring.
2. **Mine bilingual concept pairs strictly from the receiving repository
   (`concept_map`).** Positive Pointwise Mutual Information (`PPMI >= 1.5`,
   `support >= 2`, common code-term ratio cap) pairs prose tokens from
   comments, docstrings, commits, and governance documents with exported
   identifier and path tokens from the same files or commits. No external
   dictionary or embedding model is shipped (`ADR-012`).
3. **Gate concept expansion to prevent drift on confident queries.** Concept
   expansion is disabled whenever the query carries an exact anchor, scope
   prefix, direct lexical match, or high Normalized Query Clarity (`NQC >= 0.75`),
   expands at most 3 code terms per prose term, and normalizes total expansion
   weight to `<= 0.35` inside query interpolation (`ADR-234`).
4. **Preserve `ADR-115` sidecar and cold-index safety.** Cold or un-migrated v5/v6
   readers degrade smoothly to empty commit/concept results without writing.

## Consequences

- Cross-vocabulary symptoms documented in commits, comments, or decisions
  surface the implementing files deterministically under `simt map --retrieval v3`
  and `simt brief --retrieval v3`, with witnesses emitted under `--explain`.
