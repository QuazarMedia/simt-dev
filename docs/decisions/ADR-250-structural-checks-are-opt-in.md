---
simt-affects: ["src/kernel/graph-invariants.mjs", "src/kernel/checks.mjs", "src/manifest/architecture.mjs", "src/commands/sync.mjs"]
simt-supersedes: []
---
# ADR-250 — Structural checks are opt-in

Status: accepted · 2026-11-22 · D35

## Context

The import graph can detect loops and missing local dependencies. Export
reachability and dependency budgets depend on the repository's public surface
and its tolerance for coupling.

## Rulings

1. **Require repository configuration.** Under `limits.graph` in
   `simt.json`, enable cycle checks with `cycles: true` and unresolved
   relative imports with `brokenImports: true`. These findings fail
   `simt check`. The cycle checker accepts `cycles.exclude` path globs.
   It emits a shortest witness from the lexicographically first member of
   each remaining cyclic component.

2. **Treat export and hub findings as advisory.** `deadExports: true`
   requires explicit `entrypoints` globs or package export targets and
   per-language binding coverage of at least 90 percent. An export with
   no observed cross-file binding is a review item. `maxFanIn` and
   `maxFanOut` count resolved internal import edges and warn when exceeded.

## Consequences

A receiving repository can check new dependency loops while keeping
existing paths in its own exclusion list. Removing a graph setting
returns that check to its default disabled state.
