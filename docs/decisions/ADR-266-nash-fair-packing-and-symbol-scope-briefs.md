---
simt-affects: ["src/brief/submodular.mjs", "src/brief/scopes.mjs", "src/brief/session.mjs", "src/brief/render.mjs", "src/brief/assemble.mjs", "src/brief/multi.mjs", "src/brief/proof.mjs", "src/commands/brief.mjs", "src/mcp/tools-facts.mjs"]
simt-supersedes: []
---
# ADR-266 — Opt-in Nash packing, symbol-scope spans, and session anti-redundancy

Status: accepted · 2026-11-27

## Context

Composite prompts balancing multiple subtasks and facets can starve secondary
facets under strict linear pricing, large files waste agent reads when only
one function is relevant, and multi-turn agent loops waste packet bytes when
re-emitting unchanged turn-1 files (`ADR-095`, `ADR-240`).

## Rulings

1. **Offer Nash Social Welfare packing behind `--nash` (`nash: true`).**
   Maximizing weighted `log(0.05 + cov_k)` plus facet `sqrt` coverage under
   `bytes^0.75` sub-linear pricing with progressive line compression improves
   tight-budget facet completeness. It stays opt-in (`--nash`) because linear
   submodular packing retains higher minimum subtask coverage at 2,048 bytes.
2. **Emit bound symbol-scope line spans (`path:L1-L2 sym`) for large files.**
   When `--scopes` or `--retrieval v3` is active, files exceeding 200 lines
   surface exact symbol line spans (`<= 95` bytes per line) resolved against
   the live worktree overlay (`ADR-237`), with zero byte overhead on smaller files.
3. **Support deterministic session anti-redundancy via `--seen`.**
   Passing `--seen <paths|ledger>` down-weights unchanged previously delivered
   items to `0.20x` utility and immediately resets any file modified on disk
   (SHA-256 revision mismatch) back to `1.00x`. CLI callers may persist
   `.simt/session-brief.json`; MCP tools (`brief`, `skills_brief`) keep
   `recordSeen: false` to preserve their read-only contract (`ADR-035`).

## Consequences

- Agents can open exact line ranges in large files and run multi-turn brief
  loops without repeating unchanged context, while MCP remains strictly read-only.
