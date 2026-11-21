---
simt-affects: ["src/commands/work.mjs", "src/coordination/handoff.mjs", "src/coordination/local-handoff.mjs", "src/verify/local-run.mjs"]
simt-supersedes: []
---
# ADR-220 — Local handoffs bind task evidence to a Git worktree family

Status: accepted · 2026-11-21

## Context

Local editorial work may move to another worktree even though the task has
no remote target. The new worktree must be able to check prior observations.

## Rulings

1. A scope and tracker id create a bounded local capsule. The Git common
   directory identifies the project family. The capsule includes hashes of
   the original worktree, the task's intent, obligations and receipts.
2. Resume checks the current tracker, allowed artifacts, dependencies and
   lease. It consults the issuing worktree's ledger and revalidates proof
   against the current inputs by obligation.
3. A missing origin, changed input or unavailable receipt reopens the
   affected obligation. A missing task scope or invalid lease stops resume.

## Consequences

- The local capsule carries no task body, source excerpt or file paths.
- Explicit documents and remote target capsules keep the existing contract.
