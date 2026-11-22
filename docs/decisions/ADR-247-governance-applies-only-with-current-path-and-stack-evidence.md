---
simt-affects: ["src/index/govern.mjs", "src/index/governance-store.mjs", "src/commands/why.mjs"]
simt-supersedes: [{ adr: "ADR-093", ruling: 2 }, { adr: "ADR-093", ruling: 3 }]
---
# ADR-247 — Governance applies only with current path and stack evidence

Status: accepted · 2026-11-22 · supersedes ADR-093 ruling 2 · supersedes ADR-093 ruling 3

## Context

A broad skill glob can put unrelated platform advice on every source file.
A superseded decision is useful provenance, but it no longer governs a file.

## Rulings

1. **Require relevant and current authority.** Apply the resolver's stack
   and tree-wide-glob checks to skill paths. Put a wholly superseded
   decision in history with its replacement. Keep CODEOWNERS distinct
   from rules and decisions.

2. **Materialize the same facts the cold reader derives.** Index governance
   facts and typed edges in SQLite during `simt index`. Reuse them while the
   file set, stack signals and governance input signatures still match.
   Read the current inputs when the cache is absent or stale.

3. **Keep a way to reproduce the original path report.** `why --retrieval v1`
   selects the legacy report. The default uses the evidence checks above.

## Consequences

Path queries no longer need to parse every decision or rule on a warm
index. The query itself leaves the cache and repository unchanged.
