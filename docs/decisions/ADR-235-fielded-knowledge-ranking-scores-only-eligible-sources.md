---
simt-affects: ["src/knowledge/rank.mjs", "src/knowledge/query.mjs", "src/brief/local-work.mjs"]
---

# ADR-235 — Fielded knowledge ranking scores only eligible sources

Status: accepted · 2026-11-22

## Context

Equal term coverage treats a frequent boilerplate word like a rare legal or
technical term. It also gives the same score to a phrase and to its terms
scattered through a section.

## Rulings

1. **Build the scoring cohort after eligibility checks.** Only allowed,
   in-scope units contribute to document frequency, normalization or ranking.
   The fielded report includes exclusion reasons with redacted identifiers.

2. **Normalize field and phrase evidence together.** Use distinct weights
   for labels, headings, claims and body. Preserve the authority, evidence
   and penalty terms of ADR-156 and the per-source diversity of ADR-223.

3. **Enable fielded knowledge scoring explicitly.** A reader can select it
   with `--retrieval v2` on `simt knowledge rank` and scoped `simt brief`.
   Default changes follow the paired qualification in ADR-231.

## Consequences

- File input and repository scope share the same scorer and score audit.
- A scoped brief still cites committed evidence under ADR-218.
