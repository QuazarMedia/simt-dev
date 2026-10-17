# ADR-087 — A run is evidence for one tree

Status: **accepted** · 2026-10-18 · filed as R17 (plan 0003)

**Affects:** `src/ledger/index.mjs`, `src/commands/evidence.mjs`, `src/hooks/dispatcher.mjs`,
`test/ledger.test.mjs`

## Context

The rule that a test was run is otherwise a sentence in a commit message. Nothing checks
it, so a message can say the tests passed for a tree they were never run against, and
for a tree that has been edited since. The plan asks for a ledger, a proof block, and a
commit-message check that warns unless the repository asks it to block.

The tree has to be named without staging. `git add -A` on the real index would take the
author's unstaged work into the commit that is about to happen, which is the opposite of
what a hook is allowed to do.

## Rulings

1. **The tree is everything on disk, taken with a private index.** `git add -A` and
   `git write-tree` run against a temporary `GIT_INDEX_FILE`, which is deleted
   afterwards. The repository's own index is not read for this and not written. A file
   the author left unstaged stays unstaged. The ledger file is left out of that add,
   because the line is a record of the tree and writing it must not replace the tree
   it names.

2. **A ledger line records the run, not its output.** The command, the exit code, the
   duration, a one-line summary, and a digest of the output. The output itself is not
   stored. The line is appended when the dispatcher actually runs a gate. A gate that
   does not run leaves no line. A tree that cannot be named leaves no line, and the
   claim check then finds nothing.

3. **A verification claim is a passing line for this tree.** The phrases are `tests
   pass`, `tests passed`, `test pass`, `test passed`, and `verified`. `unverified` and
   `not verified` are not claims. A line with a non-zero exit does not support the
   claim. Editing any file changes the tree, so the line stops supporting it.

4. **The check warns, and blocks only when the repository says so.** `gates.evidence`
   set to `block` fails the commit. Unset, or `warn`, prints the warning and exits 0.
   Any other value is an error, because a misspelt `block` must not become a warning.
   `simt evidence` prints the lines for the current tree and writes nothing.
   `simt hooks install --yes` writes a commit-msg shim only when `gates.evidence` is
   `warn` or `block`. The shim forwards the message file. Unset installs nothing,
   and removing the setting removes the shim, so a hook the repository did not ask
   for does not stay behind and replace git's own.

## Consequences

A green run followed by an edit of any file leaves the new tree with no evidence. The
old line is still in the ledger, and it names the tree it was true for. A commit
message that claims the tests passed is blocked only in a repository that set
`gates.evidence` to `block`.

## Rejected

- **Staging with the real index in order to name the tree.** The next commit would
  contain files the author had not staged.
- **Storing the command's output in the ledger.** A test log is not evidence the next
  reader needs, and it is where a secret printed by a failing command would be kept.
- **Treating any ledger line as proof the tests passed.** A failing run is a line. It
  is not a pass.
- **Blocking every repository by default.** The check is new. A repository that has
  not asked for it gets a warning, which it can read, and its commit still happens.
- **Adding commit-msg to the dispatcher events.** Those shims do not forward git's
  arguments, because a pre-push remote would be read as one. The message file is
  the argument, so the claim check is its own shim.
