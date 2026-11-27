---
simt-affects: ["src/index/retrieval-mode.mjs", "src/commands/map.mjs", "src/commands/brief.mjs", "src/commands/repoindex.mjs", "src/commands/impact.mjs", "src/commands/why.mjs", "src/commands/knowledge.mjs", "src/brief/assemble.mjs", "src/brief/multi.mjs", "src/brief/local-work.mjs", "src/knowledge/query.mjs", "src/agenthooks/prompt.mjs", "src/mcp/tools-facts.mjs", "src/mcp/tools-read.mjs"]
simt-supersedes: []
---
# ADR-267 — Retrieval v3 opt-in and zero-rebuild rollback

Status: accepted · 2026-11-27

## Context

Paired evaluation across 210 tasks and 10,000/50,000-file benchmarks showed
that the retrieval v3 signal stack (`commit_fts`, `concept_map`, QPP fusion,
construct SDM, HITS walks, and large-file symbol scopes) strictly improves
retrieval quality over v2 on mined lexical commits, error-literal queries, and
zero-overlap symptoms with zero 10,000-file latency regression (`85.88 ms`
`map-v3` p50 vs `86.30 ms` `map-v2`). However, 50,000-file warm query hydration
(`299.5 ms` `map-v3`, `521.0 ms` `brief-v3`) and stretch recall targets do
not yet clear every Track B default promotion gate under `ADR-252`.

## Rulings

1. **Ship `--retrieval v3` across CLI, MCP, and manifest opt-in (`brief.retrieval`).**
   `retrievalMode()` accepts `"v1"`, `"v2"`, and `"v3"`. Selecting `"v3"`
   activates `commitIr`, `conceptMap`, `qppFusion`, `sdm`, `hitsWalk`, and
   `scopeSpans` across `simt map`, `simt brief`, `simt knowledge rank`, and
   prompt delivery, while `simt index`, `simt impact`, and `simt why` retain
   v2/v7 precision and fielded indexing.
2. **Keep `v2` as the default (`ADR-256`) until 50,000-file warm hydration clears.**
   Under `ADR-252` evidence gating, `retrievalMode()` continues to default to
   `"v2"` until warm 50,000-file `map`/`brief` query hydration and stretch
   lexical targets pass paired qualification.
3. **Preserve zero-rebuild rollback across `v1`, `v2`, and `v3` on the same v7 cache.**
   Switching `--retrieval v1`, `--retrieval v2`, or `--retrieval v3` — or
   changing `"brief": { "retrieval": "v1" | "v2" | "v3" }` in `simt.json` —
   takes effect immediately on the existing SQLite cache without deleting or
   rebuilding it (`ADR-115`).

## Consequences

- Consumers can adopt v3 intelligence immediately via `--retrieval v3` or
  `"brief": { "retrieval": "v3" }` and switch freely between `v1`, `v2`, and
  `v3` on one index.
