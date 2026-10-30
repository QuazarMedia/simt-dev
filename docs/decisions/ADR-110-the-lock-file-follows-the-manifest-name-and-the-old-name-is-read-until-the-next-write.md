---
simt-affects: ["src/name.mjs", "src/projection/lock.mjs", "src/kernel/variants.mjs", "src/commands/sync.mjs", "src/commands/help.mjs", "src/bench/variants.mjs", "test/lock.test.mjs", "test/variants.test.mjs"]
simt-supersedes: [{ adr: "ADR-086", ruling: 3, kind: "superseded" }]
---

# ADR-110 — the lock is `simt.lock.json`, and the old name is read until the next write

Status: **accepted** · 2026-10-30 · supersedes ADR-086 ruling 3's file name

## Context

The lock followed the command's old name: `simt-dev.lock.json`. The command
is `simt`, the manifest is `simt.json`, and the lock was the one remaining
file that still carried the pre-rename spelling.

A rename cannot be a bare move. A lock written by a pre-rename run may hold
`variants` winners that nothing else records — the bench evidence for a
locked rule text — so a reader that only knows the new name would silently
unlock those decisions.

## Ruling

1. **The lock is `simt.lock.json`.** The old name is a read-only fallback:
   a reader tries the new name first and falls back to the old one, and a
   write always lands under the new name, which is how a legacy lock
   migrates. The fallback is for absence, not for damage: a permission
   failure on the new name does not fall back, and a file that exists but
   does not parse is reported, not repaired by an older file. This is the
   same read-both/write-new pattern as the manifest rename (ADR-056).
2. **The name lives in one place.** `src/name.mjs` owns both names, the way
   it owns the manifest's. The kernel and the projection each carried a
   private copy — the kernel cannot import the projection, because the
   projection imports the kernel — and two constants for one file is how a
   rename ships half-done.

## Consequences

- A repository whose lock predates the rename keeps its locked variant
  winners: `simt check --frozen` and the projection read them from the old
  file, and the next `simt sync --yes` or `simt bench variants --yes` writes
  them back under the new name.
- ADR-086's ruling 3 stands for what the lock records — an input digest and
  an output digest; the file name it named is superseded.
