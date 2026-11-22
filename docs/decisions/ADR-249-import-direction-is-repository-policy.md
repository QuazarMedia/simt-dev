---
simt-affects: ["src/kernel/graph-checks.mjs", "src/kernel/checks.mjs", "src/manifest/architecture.mjs"]
simt-supersedes: [{ adr: "ADR-090", ruling: 3, kind: "narrowed" }]
---
# ADR-249 — Import direction is repository policy

Status: accepted · 2026-11-22 · D34

## Context

An import edge supplies a dependency. The receiving repository owns the
decision about whether that dependency is allowed.

## Rulings

1. **Require a selected marker and a valid declaration.** A rule item marked
   `simt-check: import-direction` activates the `architecture` policy in
   `simt.json`. Without a declaration, its checker reports a nonblocking
   finding. Projection keeps the rule item's prose.

2. **Enforce layer relationships and explicit denials.** Each layer lists
   the other layers it may import directly. A layer may import itself.
   Unclassified targets are governed by explicit `forbid` entries. A denial
   checks direct imports by default and follows the import graph when
   `transitive` is true.

3. **Report the shortest observed witness.** Use tracked and live worktree
   paths. Include the originating import specifier and line when the
   extractor can identify them.

## Consequences

A forbidden dependency fails `simt check`. The finding identifies the
dependency to remove and the repository declaration that owns the direction.
