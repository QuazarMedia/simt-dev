---
simt-affects: ["src/ledger/index.mjs", "src/hooks/dispatcher.mjs", "test/ledger-evidence.test.mjs"]
simt-supersedes: [{ adr: "ADR-120", ruling: 1 }]
---

# ADR-197 — gate evidence names the tree it ran on, and nothing else stands in for it

Status: **accepted** · 2026-11-19

## Context

Review 0005 (PR04) observed four ways a ledger line proved less than it appeared to:

- `hasTestEvidence` returned true for a staged tree that differed from the recorded
  executed working tree, because the skip query accepted `indexTree` as well as the
  executed tree.
- Execution records computed the tree from the ledger destination — the caller's
  checkout — even when the gate ran in a detached worktree at a pushed revision.
- A timed-out child that trapped the signal and exited 0 reached the pass path and
  wrote a green line.
- A later run of the same gate with a different command did not cancel the earlier
  pass.

Together they let a skip be earned by a run that was not about the tree being pushed,
of a command this repository no longer runs, or that never finished.

## Rulings

1. **Evidence names its subject.** A ledger line records the tree the gate executed in
   (`subjectTree`), the revision when one is known (`revision`), the command and gate,
   the outcome (`passed`, `failed`, `timeout` or `cancelled`), the toolchain identity
   that ran it, and the gate cwd when it differs from the root. Where the line is
   stored is not part of the subject: a pre-push line lives in the caller's ledger and
   is about the pushed revision's tree.
2. **A question names the tree it is about, and the query matches that tree only.** A
   pre-push skip is about the tree the gate executed in, so it matches `subjectTree` and
   never `indexTree`: a pass recorded on a working tree whose index carried different
   bytes proves nothing about the staged tree. A commit message's claim is about the
   index the commit records, so it asks for `basis: 'index'` and matches the `indexTree`
   each run recorded. The two bases are named, not inferred.
3. **A timed-out run is never a pass.** A run past its bound is recorded with
   `outcome: 'timeout'` and a nonzero exit even when its process exited 0, and the
   evidence query ignores it.
4. **A later run of the same gate identity cancels an earlier pass** when it failed,
   timed out, or used a different command. A green run of the command the repository no
   longer declares is not evidence for the one it declares now.
5. **Legacy lines keep their reading.** A line written before `subjectTree` existed is
   matched by its `tree`, which was always the worktree tree, so an existing ledger does
   not go red on upgrade.
6. **ADR-120's skip keeps its place, with the corrected basis.** Ruling 1 of ADR-120 is
   superseded only in what "the tree being pushed" means: for a push it is that
   revision's tree, and for a manual run it remains `HEAD^{tree}`. Everything else in
   ADR-120 — the skip is evidence-driven, reported, and fail-closed — stands.

## Consequences

- `recordRun` gains `subject`, `revision`, `toolchain`, `cwd` and `outcome`; every field
  is optional, so existing callers keep their behaviour and their tree.
- The dispatcher records the tree it executed in (`root`) and the revision it was given,
  not the tree the ledger lives in.
- The pre-push skip reads the pushed revision's tree, so two revisions of one push are
  evaluated on their own evidence.
- Old ledger lines remain historical records; no migration rewrites them, and none is
  needed because the query treats their `tree` as the subject.

## Rejected

- **Bumping the ledger version to mark the new fields.** The added fields are additive
  and the reader already distinguishes lines by what they carry; a version bump would
  make every older line "legacy" for no gain.
- **Matching both `subjectTree` and `indexTree` and preferring one.** That is the defect
  itself: an index tree is a tree no gate ran on, and accepting it turns a pass into
  evidence about bytes it never saw.
