---
simt-affects: ["src/index/cochange.mjs", "src/index/store.mjs", "src/index/persist.mjs", "src/commands/impact.mjs", "src/commands/tests.mjs"]
simt-supersedes: []
---
# ADR-242 — Co-change confidence comes from bounded untangled history

Status: accepted · 2026-11-22

## Context

A raw count treats a repository-wide formatting commit as evidence that
every pair of touched files depends on each other.

## Rulings

1. **Skip tangled commits and decay old observations.** Use up to 500
   non-merge commits. Exclude changes above 15 source or 8 test paths,
   weight each remaining commit by its size and use a 100-commit half-life.

2. **Keep directional confidence and support.** Persist conditional
   confidence, lift and support only when at least two commits and at least
   0.25 confidence support a pair. Keep the strongest 12 destinations.

3. **Stamp the history independently of the staged blobs.** Extend the
   cached window when a linear addition is established. Rebuild the bounded
   window after merges or history changes that invalidate that order.

## Consequences

- Readers can use co-change alongside import evidence as its own channel.
- A Git history change can update coupling without re-extracting source files.
