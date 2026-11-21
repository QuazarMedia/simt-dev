---
simt-affects: ["src/commands/knowledge.mjs", "src/knowledge/catalogue.mjs", "src/work/config.mjs"]
simt-supersedes: []
---
# ADR-221 — Offline knowledge exchange checks local scope and provenance

Status: accepted · 2026-11-21

## Context

A repository can reuse an existing search catalogue if each location can be
checked against locally permitted evidence. Exchanging provenance requires an
explicit share decision.

## Rulings

1. A version 1 catalogue names its repository and Git revision. A candidate
   supplies id, path, anchor, permission and the source's committed revision.
   Candidates supply aliases; local extraction still supplies citations.
2. Catalogue links remain proposals or unknown edges. External observations
   carry their own digest, reference, observation date and expiry.
3. Scoped export admits committed citations from declared share paths.
   Ignored, denied and private tracker paths cannot enter it.
4. Scoped import checks canonical bundle digests and local source digests.
   Imports are read-only, with duplicates reported once.

## Consequences

- A stale or missing catalogue leaves ordinary lexical search available.
- Explicit document and read-only MCP forms remain available.
