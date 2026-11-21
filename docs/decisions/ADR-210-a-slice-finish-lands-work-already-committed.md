---
simt-affects: ["src/commands/slice.mjs", "test/slice.test.mjs", "src/commands/spec.mjs", "rules/mdc/slice-commit.mdc", "AGENTS.md", "docs/commands/slice.md"]
simt-supersedes: []
---
# ADR-210 — a slice finish lands work already committed

Status: accepted · 2026-11-21 · filed with the clean-worktree finish

## Context

ADR-209 made `finish` the one command that closes a slice, but it assumed the slice's work
was still staged. A caller who committed in the worktree — as the `slice-commit` procedure
tells them to — then found `finish` refusing with "nothing staged to commit". The same
state appears after a merge failure ADR-209 describes: the slice commit and the tracker row
exist, and the branch is ahead of main with nothing staged.

The refusal left no command for that state. Merging by hand would land the branch but skip
the tracker evidence, the worktree removal and the branch deletion that `finish` owns, so
the sequence ADR-209 removed came back for exactly the callers who followed the rule.

## Ruling

1. **A clean worktree whose HEAD is ahead of main is landable.** `finish` reads the
   worktree's own HEAD commit instead of creating one, records that SHA, and lets the merge
   and cleanup proceed as in ADR-209. It does not make an empty commit: the work already
   has a commit, and a second one would claim it twice.

2. **The existing commit's subject is reported.** The output and the JSON `commit.subject`
   name the subject on the branch, not the subject this invocation would have generated.
   A reader can find the commit the slice actually contains.

3. **Staged work is unchanged.** When the worktree has staged files, `finish` still creates
   the slice commit with the generated Conventional subject. Only the nothing-staged case
   reads an existing commit.

4. **Uncommitted tracked work still refuses.** A modification, deletion or staged change
   that is not in a commit blocks the finish, naming the paths; merging it under the slice
   would attribute work the slice did not commit. Untracked files do not block, and the
   unforced cleanup keeps the worktree and names it, as ADR-209 rules.

5. **Gates still run on the tree that will land.** They run in the worktree as before; for
   an already-committed slice that tree is the commit's tree. A gate failure leaves the
   existing commit in place and reports the failure rather than pretending the slice has
   no commit.

6. **Nothing ahead is still a refusal.** A clean worktree with no commits ahead of main has
   no work to land; `finish` says so and names the commit step.

7. **The workflow rule follows.** `slice-commit` says finish commits staged work or lands
   the commit already on its branch, so the rule and the command describe the same state.

## Consequences

- A caller who commits in the worktree can still close the slice with the one command
  ADR-209 established.
- A failed merge is recoverable by rerunning `finish` after resolving it: the existing
  commit is read, not committed again.
- The tracker evidence points at the commit the caller made, so its message may differ
  from the generated subject; the record reports the real one.
- A worktree with only untracked files and no new commit still refuses, because there is
  nothing on the branch to merge.

## Alternatives

- **Make an empty commit when nothing is staged.** It would satisfy the old code path, but
  it records a commit with no change and leaves two commits for one piece of work.
- **Tell the caller to merge by hand.** That is the sequence ADR-209 removed, and it skips
  the row, worktree and branch handling that make the command worth having.
- **Require the caller to unstage and restage the committed work.** It asks them to move a
  commit back into the index, which is exactly the state the command should understand.
