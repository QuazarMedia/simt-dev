---
simt-affects: ["src/text/identifiers.mjs", "src/index/store.mjs", "src/index/persist.mjs", "src/knowledge/rank.mjs"]
---

# ADR-232 — Experimental retrieval shares one identifier and field-weight policy

Status: accepted · 2026-11-22

## Context

Single-column FTS gives a definition, a signature and an incidental comment
the same field weight. Keeping a compound identifier whole helps an exact
lookup but prevents ordinary queries for its parts from matching it.

## Rulings

1. **Use symmetric identifier tokens.** Normalize compatibility variants and
   diacritics on both index and query input while preserving Japanese voicing.
   Emit the joined identifier and its constituent words. CJK bigrams
   complement the existing trigram index.

2. **Keep exact tokens available.** Emit light plural variants alongside the
   original token so an inflection heuristic cannot erase an exact match.

3. **Use field-weighted FTS5 for experimental retrieval.** Weight path, symbol
   name, qualified name, signature, heading and body as distinct fields. The
   in-memory scorer uses the same formula and weights so live edits can be
   evaluated under the same policy. Keep migration and sidecar safety under
   ADR-115.

4. **Qualify default behavior with paired evidence.** The fielded scorer and
   its shared knowledge-retrieval vocabulary can be measured independently.
   Default promotion requires the retrieval evidence in ADR-241.

## Consequences

- Query and index callers share one normalization pipeline.
- Exact, subword and phrase retrieval can be measured separately.
