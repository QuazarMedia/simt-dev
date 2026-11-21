---
simt-affects: ["src/commands/work.mjs", "src/coordination/local-tracker.mjs", "src/coordination/workgraph.mjs", "src/work/config.mjs"]
simt-supersedes: []
---
# ADR-219 — Local scheduling preserves the authority of the configured tracker

Status: accepted · 2026-11-21

## Context

A local repository already keeps task state in a plan, a directory of items,
or an exported board. A scheduling proposal must read that state in place.

## Rulings

1. A version 3 scope declares one tracker, its path and its visibility. The
   adapter reads metadata and preserves ticket ids; it performs no lifecycle
   write and starts no work.
2. A task is ready only with its predecessor evidence current. Resource
   conflicts serialize in priority order, with the original id as a tie-break.
3. A public view withholds private trackers before reading them. The shared
   public view omits paths, dependencies and private references.

## Consequences

- An existing explicit task document still uses the same scheduler.
- A stale receipt, duplicate id or ambiguous artifact scope remains visible.
