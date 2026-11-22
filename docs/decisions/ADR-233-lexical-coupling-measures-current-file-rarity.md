---
simt-affects: ["src/index/lexical.mjs", "src/index/lexical-store.mjs"]
---

# ADR-233 — Lexical coupling measures current file rarity

Status: accepted · 2026-11-22

## Context

A binary frequency cutoff changes the score abruptly when another file adopts
a term. Sparse term vectors can also connect files that use the same domain
vocabulary without importing one another.

## Rulings

1. **Count each indexed file once for document frequency.** Text sections of
   a file contribute to its term frequencies. Replacement and deletion
   update aggregate counts in the transaction that writes the index.

2. **Use smoothed inverse document frequency.** Lexical weight is the product
   of smoothed IDF and log-scaled term frequency. Similarity is cosine over up
   to 40 highest-weight terms per file, with stable term-order tie breaks.

3. **Compute the bounded signature from current counts.** Retain sparse
   counts and derive the top terms on read. A global IDF change can reorder
   an unchanged file's signature, so persisting an old top 40 would make
   results depend on edit history.

## Consequences

- An incremental build changes counts for added, changed and removed files.
- A cold rebuild and incremental updates use the same current frequencies.
