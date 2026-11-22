---
simt-affects: ["src/index/impact.mjs", "src/commands/impact.mjs", "src/index/bind.mjs"]
simt-supersedes: [{ adr: "ADR-096", ruling: 1 }, { adr: "ADR-096", ruling: 2 }]
---
# ADR-243 — Impact follows bound symbols and ranks direct dependents first

Status: accepted · 2026-11-22 · supersedes ADR-096 ruling 1 · supersedes ADR-096 ruling 2

## Context

A file-level walk follows every consumer of a shared module even when the
change concerns a single export. Alphabetical truncation can omit a direct
caller behind unrelated paths served by a large dispatcher.

## Rulings

1. **Resolve an export by name or by path and name.** A file path requests
   file-level reachability. An export requests reverse traversal over bound
   callers, references, imports and re-exports. An unqualified ambiguous
   export requests qualification with `<path>#<name>`.

2. **Rank by directness and graph degree.** A direct dependent takes priority
   over a transitive dependent. When a traversal crosses a file with more than
   32 incoming or outgoing file dependencies, mark the paths reached only
   through such files as hub-mediated. Within a tier, damp propagation by
   incoming degree raised to 0.55, then break ties by hop count and path.
   Keep the 64-result cap per list and count omitted hub-mediated paths.

3. **Report gaps in binding.** If the target cannot be bound or a resolved
   import has unknown symbol usage, use the available file-level edges and
   report the fallback. Report binding coverage with the result.

## Consequences

The experimental `--retrieval v2` path keeps the importer and test lists
and includes the hop tier and score of each listed path. A qualified
`<path>#<name>` target also selects v2. Unqualified calls keep the
file-level report by default pending the paired benchmark.
