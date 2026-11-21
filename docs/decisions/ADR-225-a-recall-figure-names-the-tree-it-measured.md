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
| `HEAD` (1,033 files) | + FTS5 BM25 + RRF | 49.1% | later code, later tree |

`61.3%` and `60.3%` do not reproduce at either R28 commit: both commits give 62.1% on
SQLite and 61.1% on JSONL. The corpus is fixed at tasks mined 2026-10-09..14, and the tree has
since grown from 365 files to 1,033, with 10 of 162 gold paths removed.

A control on 2026-11-21 separates the two changes that a later figure mixes. The same vault
and tasks were measured in four cells, each code tree indexing the stated file set; "present"
counts only gold paths that file set still contains, so a removed file is not read as a miss.

| Code | File set | Files | recall@10 | Present-gold |
| --- | --- | --- | --- | --- |
| `3976c0eb` | `3976c0eb` | 365 | **62.1%** | 62.1% |
| `3976c0eb` | `c4edfb6` | 1,033 | 50.8% | 53.2% |
| `c4edfb6` | `3976c0eb` | 365 | 58.0% | 58.0% |
| `c4edfb6` | `c4edfb6` | 1,033 | 49.1% | 51.3% |

Comparing the two code trees is a regression, not drift: on the shipped tree, today's code
loses 4.1 points while the file set and all 162 gold paths are unchanged. `b18acbaf` accounts for 3.9 of
them — a task that spells one path had every other path's resolver score zeroed — `5349db59`
recovers 1.0, and 1.2 enters with the q73–q80 wave before `b50f5b87`. The file set is the
larger share: the shipped code falls 11.3 points on today's tree, 8.8 counting only surviving
gold.

## Rulings

1. **The shipped map's published figure is 62.1%** — the hybrid FTS5 ranking measured on the
   20 mined tasks at the commit that shipped it (`3976c0eb`), against that tree. The bar is
   60%. It is a statement about that commit, not about the code today: on the same 365-file
   set, current code measures 58.0%, below the bar. `61.3%` is withdrawn; it reproduces at no
   R28 commit. `55.6%` is R22's PageRank-only figure, stated only as the value before R28.

2. **A recall figure names the tree and the code it measured.** The same code on a later tree
   is a file-set measurement; the same tree with later code is a ranking regression. Neither
   is the shipped result, and a later figure is not called drift until both controls exist. A
   regression below the bar is recorded as one, not explained away as growth.

3. **A reconstruction validates its denominator before it is quoted.** With the vault
   absent, gold paths may be recovered from `base..sourceCommit`, but only if the count
   equals each descriptor's `gold.files`. A reconstruction that does not match is not
   evidence.

## Consequences

The shipped result stays 62.1% at `3976c0eb`; on that same tree, current code measures 58.0%,
a 4.1-point regression this record reports and does not repair. Plan 0003's R22 row and R28
note, plan 0004's audit and the compat audit test name 62.1% as the shipped measurement, with
plan 0004's audit and ADR-091's status pointing here for the control. `simt map --recall` on
this checkout still reports unmeasured, because the vault is absent; the control was
reconstructed from descriptors whose counts matched `gold.files` for all 20 tasks.

## Rejected

- **Restating 49.1% as the current figure.** Rejected: it mixes a 4.1-point code regression
  with file-set growth and reports neither. The control reports both.
- **Calling the whole drop drift.** Rejected: with the same 365 files, today's code loses 4.1
  points, so the fall is not all growth. The control reports the code and file-set effects
  separately.
- **Keeping 61.3% because it is close.** Rejected: two R28 commits measure 62.1%, and a
  figure that cannot be reproduced is a claim, not a measurement.
- **Editing ADR-091's body.** Rejected: its consequence records the measurement it took,
  and rewriting it in place would erase what the record said when it was accepted. Its
  status names this record, which carries the update.
