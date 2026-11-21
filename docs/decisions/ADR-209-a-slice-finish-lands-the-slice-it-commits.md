---
simt-affects: ["src/commands/slice.mjs", "src/commands/spec.mjs", "test/slice.test.mjs", "rules/mdc/slice-commit.mdc", "AGENTS.md", "docs/commands/slice.md"]
simt-supersedes: []
---
# ADR-209 — a slice finish lands the slice it commits

Status: accepted · 2026-11-21 · filed while folding worktree cleanup into the slice commands

## Context

`simt slice start` already did the first half of the worktree lifecycle: it created the
worktree, its branch and its brief. `simt slice finish` did not do the second half. It ran
the gates, committed on the slice branch and recorded the SHA in the main checkout's
tracker, then printed that the row was "edited, not staged: commit it with the merge".
Merging the branch, committing the row, removing the worktree and deleting the branch were
four manual git commands every caller had to remember and every prompt had to restate.

Two facts decide the shape of the fix. A worktree cannot remove itself: `git worktree
remove` deletes the directory a shell is standing in, and the shell's prompt then points at
a path that no longer exists. And a merge needs a checkout where the slice branch is not
checked out: the branch lives in its worktree, so the merge belongs to the main checkout.

The tracker row has a third fact attached. `start` flips the row to in-progress and leaves
that edit uncommitted in the main checkout, so by the time `finish` runs the main checkout
is already dirty with the one file the finish is about to record again.

## Ruling

1. **`finish` runs from the main checkout.** Applying from inside the slice worktree is
   refused before the gates run, with the `cd` and the exact command. The commit still
   happens on the slice branch, in the worktree; only the command's working checkout is
   constrained, because only the main checkout can merge and remove.

2. **The main checkout may be dirty only with the tracker row.** `start`'s row edit is
   expected and rides in the merge. Any other modification refuses before anything is
   committed, naming the files: a merge that carried them would attribute unrelated work
   to the slice.

3. **The merge carries the row.** After the gates and the commit, `finish` records the SHA
   in the tracker, merges the branch with `--no-ff --no-commit`, stages the row, and
   commits with git's prepared merge message. Staging the row before the merge is refused
   by git ("local changes would be overwritten"), so the merge lands first and the row is
   staged into the prepared commit — one merge commit, not a merge plus a tracker commit.

4. **A conflict aborts the merge.** The slice commit and its row are already true, so the
   refusal names the SHA, the row and the one merge command. The main checkout is left as
   the caller had it rather than in a conflicted state.

5. **Cleanup is unforced and reported.** `finish` removes the worktree without `--force`
   and deletes the branch with `-d`, which refuses an unmerged branch. A worktree holding
   untracked files is kept, its branch with it, and both are named in the output; the tool
   does not turn finishing a slice into deleting work the slice did not commit.

6. **Prompt slices get the same landing.** They have a record instead of a row, so the
   merge commits the slice's files alone; there is no tracker file to stage.

7. **The workflow rule follows the command.** `slice-commit` now says finish from the main
   checkout and treats a kept worktree as a reportable failure, replacing the instruction
   to remove the worktree by hand.

## Consequences

- One command now closes a slice: commit, row, merge, worktree removal and branch deletion.
- A caller standing in the worktree gets a refusal that names the main checkout instead of
  a command that commits and strands the branch.
- The tracker row is committed with the merge, so the "edited, not staged" line and its
  manual follow-up are gone.
- A main checkout with unrelated work blocks the finish before the commit; the caller's
  remedy is to commit or stash, not to finish from the worktree.
- Repositories whose `pre-commit` gate or hook expects a single-parent commit see a merge
  commit instead; the gates have already passed on the slice tree, and the merge is a
  mechanical fast-forward refusal (`--no-ff`) that records the slice as one unit.

## Alternatives

- **A separate `simt slice land <id>` run from main.** It would keep `finish`'s checkout
  where it was, at the cost of the two commands this decision exists to remove; the second
  command would also have to distinguish "committed but not landed" from "nothing staged".
- **Let `finish` commit in the worktree and remove it there.** Git would delete the
  directory the caller's shell is in, and the next command from that shell fails on a
  missing path.
- **Stage the row before merging.** Git refuses a merge with staged changes on a file the
  merge does not touch, which was measured while building this record.
- **`git worktree remove --force`.** It would make cleanup unconditional by deleting
  untracked files the caller never committed.
