---
simt-affects: ["docs/decisions/ADR-091-the-map-ranks-files-a-task-mentions.md", "docs/research/0003-intelligence-amplifier-research-plan.md", "docs/research/0004-knowledge-and-remote-work-intelligence-plan.md", "test/work-compat.test.mjs", "docs/decisions-index.md"]
simt-supersedes: []
---
# ADR-225 — A recall figure names the tree it measured

Status: accepted · 2026-11-21

## Context

The record carried two recall@10 figures for the same 20 mined tasks and no way to tell
which was current. ADR-091 and plan 0004 read the R22 cell, `recall@10 55.6% (bar 60%)`;
plan 0003's R28 note claimed hybrid retrieval raised the figure from 54.3% to 61.3% on
SQLite FTS5 and 60.3% on JSONL. The R22 row and the R28 note could not both be the shipped
map's figure.

This checkout's vault holds no gold patches (`simt map --recall` reports `no gold patches`,
20 of 20 missing), so the measurement was re-derived from the task descriptors. Each
descriptor names the mined task's `base` and `sourceCommit`; the gold paths are that diff's
destination side minus its `test/` files, and the reconstruction is accepted only when its
count equals the descriptor's own `gold.files`. All 20 matched.

Measured with each tree's own code:

| Tree | Ranking | recall@10 | Notes |
| --- | --- | --- | --- |
| `9c9bb795` (R22) | PageRank only | 55.6% | reproduces ADR-091 |
| `3976c0eb`, `29c8759f` (R28) | PageRank only | 54.3% | the note's "before" |
| `3976c0eb`, `29c8759f` (R28) | + FTS5 BM25 + RRF | **62.1%** | clears the 60% bar |
| `3976c0eb` (JSONL forced) | + JSONL BM25 + RRF | 61.1% | backend since retired |
| `HEAD` (1,032 files) | + FTS5 BM25 + RRF | 49.1% | same corpus, later tree |

`61.3%` and `60.3%` do not reproduce at either R28 commit: both commits give 62.1% on
SQLite and 61.1% on JSONL. The `HEAD` figure is not a counter-claim. The corpus is fixed at
tasks mined 2026-10-09..14, and the tree has since grown from 365 files to 1,032, with 10 of
162 gold paths removed. A recall figure that does not name its tree would make every later
file addition look like a retrieval regression.

## Rulings

1. **The shipped map's published figure is 62.1%**, the hybrid FTS5 ranking measured on the
   20 mined tasks at the commit that shipped it (`3976c0eb`). The bar is 60%. `61.3%` is
   withdrawn: it reproduces at no R28 commit. `55.6%` is R22's PageRank-only figure; it is
   stated only as the value before R28, and ADR-091's status names this record so the
   figure is not read as current.

2. **A recall figure names the tree it measured.** A later tree is a different measurement.
   Where a record cites a drifted figure, it states the file count and the gold paths that
   no longer exist; it never substitutes the drift for the shipped result.

3. **A reconstruction validates its denominator before it is quoted.** With the vault
   absent, gold paths may be recovered from `base..sourceCommit`, but only if the count
   equals each descriptor's `gold.files`. A reconstruction that does not match is not
   evidence.

## Consequences

ADR-091 leaves its accepted body untouched; its status names this record. Plan 0003's R22
row and R22/R28 notes, plan 0004's audit and the compat audit test state 62.1%, with 55.6%
only as the before value. `simt map --recall` on this checkout still reports unmeasured,
because the vault is absent; a reader who reconstructs the corpus on today's tree gets
49.1%, and ruling 2 says what that is.

## Rejected

- **Restating 49.1% as the current figure.** Rejected: it measures a later tree against a
  fixed corpus. The retrieval change shipped at 62.1%; today's tree is a different
  measurement, and the record says so rather than letting repository growth read as a
  regression.
- **Keeping 61.3% because it is close.** Rejected: two R28 commits measure 62.1%, and a
  figure that cannot be reproduced is a claim, not a measurement.
- **Editing ADR-091's body.** Rejected: its consequence records the measurement it took,
  and rewriting it in place would erase what the record said when it was accepted. Its
  status names this record, which carries the update.
