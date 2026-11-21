---
simt-affects: ["src/knowledge/query.mjs", "src/knowledge/rank.mjs", "test/work-query.test.mjs"]
simt-supersedes: []
---
# ADR-223 — Scoped retrieval ranks distinct sources

Status: accepted · 2026-11-21

## Context

A long document can fill the result limit with matching sections. In a local
docs and recipes corpus, this hid the recipe even when it had the second
strongest source match. General documents that mentioned all the terms could
also displace a section from the file whose name identified the subject.

## Rulings

1. In a repository scope, lexical coverage gives equal weight to the filename
   stem and the combined section headings and text. The reported lexical score
   includes both. Authority, evidence, penalties and tie breaks follow ADR-156.
2. The scoped ranked list returns the highest-scoring section per path. The
   result limit counts paths. Exact path, anchor and artifact lookup can still
   identify an individual section and uses the same scope and permission
   checks as the ranked list.
3. Explicit input without a label retains the existing section scoring and
   result limits.
