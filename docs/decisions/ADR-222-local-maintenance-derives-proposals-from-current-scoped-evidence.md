---
simt-affects: ["src/commands/knowledge.mjs", "src/commands/work.mjs", "src/work/maintenance.mjs"]
simt-supersedes: []
---
# ADR-222 — Local maintenance derives proposals from current scoped evidence

Status: accepted · 2026-11-21

## Context

A local maintainer needs to see what should be reviewed after a source or a
receipt changes. The tracker remains the authority for existing tickets.

## Rulings

1. Scoped debt ranks broken citations, linked newer observations, missing
   derivation receipts and stale or pending checks. It records the command
   that reopens the evidence and bounds the result.
2. Scoped graduation groups current passing receipts by check. Independent
   runs have distinct receipt digests and disjoint observed artifact sets.
3. A graduation proposal still requires held-out and failure-path checks
   and human review. Neither report writes policy, knowledge or tasks.

## Consequences

- Local candidates and source receipts supply evidence without exporting the
  raw logs or task bodies. Existing explicit forms remain valid.
