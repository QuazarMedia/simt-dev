---
simt-affects: ["src/plan/archive.mjs", "src/commands/plan.mjs", "src/commands/spec.mjs", "src/commands/index.mjs", "src/argv.mjs", "test/archive.test.mjs"]
simt-supersedes: []
---
# ADR-140 — archiving is a command, and it refuses what it cannot close

Status: accepted · 2026-11-02

## Context

A finished plan or review stayed where it was written. The tracker reads archived documents
recursively, so an archived one is still counted — but nothing moved it there, and the
status line beside it was written by hand. Review 0002 was archived that way, with a status
sentence assembled from a table a person had to read, and review 0003's header claimed every
row was complete while the tracker still listed one as queued.

The two claims are one act. Moving a document out of the live directory says it is not work
in progress; its status says why. Written separately, the second drifts from the table the
first was checked against.

## Rulings

1. **`plan archive <id>` is the only writer.** It accepts a row id the document tracks or
   the document's own file name, and it moves the file into an `archive/` subdirectory of
   the directory it lived in — beside its peers, never across directories.

2. **Only plans and reviews are archivable.** A document whose first heading is not `Plan
   <number>` or `Review <number>` is refused by name. Research notes are not tracked work:
   they have no satisfying state, so a command that moved them would be guessing what done
   means for them.

3. **A row still short of the satisfying state refuses the archive**, unless `--force`. The
   refusal names the rows and the flag, because "unfinished" without the count is a message
   that sends the reader to read the whole table.

4. **The status line is replaced, not edited.** It becomes `Status: **closed** — <n> row(s):
   <counts> · <date>`, with the counts taken from the rows the tracker just parsed. Fields
   that followed an open status — a baseline, a re-verification commit — described the work
   while it was open and do not survive into the closed line. A document with no status
   line gains one under its title.

5. **The write is journaled as a creation at the new path and a removal at the old one**, so
   `undo` restores the document where it was, with its original bytes. The new path is
   written first: a crash between the two leaves both copies, which a reader can see and
   finish, where the other order leaves neither.

6. **A preview is the default.** `--yes` applies. The move is the part a reader cannot undo
   by eye, so the destination and the exact status line are reported before anything moves,
   and running the command on an already-archived document is refused rather than reported
   as success.

## Consequences

- A closed plan or review leaves the directory an agent lists when it looks for work, and
  stays counted by `plan status` because the read is recursive.
- The status sentence is now derived from the rows, so a reopened row cannot leave a closed
  archive claiming completeness — the next archive run refuses until the row is finished or
  the caller forces it.
- Nothing changes for a repository that has never archived a document, beyond the new
  subcommand appearing in `plan`'s own help.
