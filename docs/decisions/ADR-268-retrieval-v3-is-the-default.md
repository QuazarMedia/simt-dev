---
simt-affects: ["src/index/retrieval-mode.mjs", "src/commands/map.mjs", "src/commands/brief.mjs", "src/commands/impact.mjs", "src/brief/assemble.mjs", "src/brief/multi.mjs", "src/brief/drilldown.mjs", "src/agenthooks/prompt.mjs", "src/mcp/tools-facts.mjs"]
simt-supersedes: [{ adr: "ADR-256", ruling: 1, kind: "superseded" }, { adr: "ADR-267", ruling: 2, kind: "superseded" }]
---
# ADR-268 — Retrieval v3 is the default

Status: accepted · 2026-11-27

## Context

`ADR-267` introduced retrieval v3 behind `--retrieval v3` on top of the v7
SQLite cache while retaining v2 (`ADR-256`) as the default. The paired
benchmark across 210 tasks and 10,000-file latency runs showed that v3 clears
every v2 quality metric (`lexical` Recall@10 `+1.8 pts`, `MRR` `+2.5 pts`,
`nDCG@10` `+4.8 pts`, `error-literal` `1.0000`, `zero-overlap-symptom` `1.0000`)
with identical 10,000-file p50 latency (`85.88 ms` vs `86.30 ms`). By explicit
repository decision, retrieval v3 becomes the out-of-the-box default while
preserving zero-rebuild rollback to `v2` and `v1`.

## Rulings

1. **Retrieval v3 is the default across ranking, indexing, and brief delivery.**
   `retrievalMode()` defaults to `"v3"`. `simt map`, `simt brief`,
   `simt knowledge rank`, `simt impact`, `simt why`, `simt index`, and opted-in
   prompt delivery (`simt.json` `"brief": {}`) run retrieval v3 by default,
   enabling `commit_fts`, `concept_map`, QPP fusion, construct SDM, HITS
   directional walks, and large-file symbol scopes (`>200` lines). This
   supersedes `ADR-256` ruling 1 and `ADR-267` ruling 2.
2. **Preserve zero-rebuild rollback to `v2` and `v1` on the same v7 cache.**
   Passing `--retrieval v2` or `--retrieval v1` — or setting
   `"brief": { "retrieval": "v2" | "v1" }` in `simt.json` — takes effect
   immediately on the existing SQLite cache without deleting or rebuilding it
   (`ADR-115`, `ADR-267` ruling 3).
3. **Keep `--nash` and `--seen` explicit opt-ins.**
   Nash Social Welfare packing (`--nash`) and session anti-redundancy
   (`--seen` / `brief.seen`) remain opt-in flags on `simt brief`, MCP `brief`,
   and prompt configuration (`ADR-266`).

## Consequences

- Consumers receive retrieval v3 by default without extra flags, and any
  repository can switch back to `v2` or `v1` immediately on the same cache.
