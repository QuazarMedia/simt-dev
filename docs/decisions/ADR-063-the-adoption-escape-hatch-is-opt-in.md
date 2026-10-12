# ADR-063 — The adoption escape hatch is opt-in, and the default writes in place

Status: **accepted** · 2026-10-13 · filed after a consumer asked why every adoption branched
**Affects:** `simt init`, `src/commands/init.mjs` (`establishEscapeHatch` and its call site),
`src/argv.mjs`, `src/commands/help.mjs`; amends plan 0002 §8.2 item 3

## Context

Plan 0002 §8.2 item 3 ruled: "Create a branch and a `backup-before-simt-dev` tag before the
first write, always." The tool complied — `simt init --yes` in a git repository tagged the
pre-adoption commit, checked out a branch named after the tool, and wrote every adoption file
onto it. The reviewable-diff argument is sound: adoption writes a dozen files into a
repository the tool does not own, and doing it on a dedicated branch leaves the mainline
untouched with two named undo paths.

The "always" was the part that failed. Consumers kept reporting the branch switch as a
surprise: they ran the documented command to adopt their repository, and found themselves on
a branch they had not chosen, with a tag they had not asked for. Review 0001's S15 fixed the
silence — the output now names both operations and the command that undoes each — but a
well-announced surprise is still a surprise. The branch and the tag are an undo path for
readers who want one; making them unconditional turned a safety feature into a default that
every consumer has to explain away.

## Rulings

1. **The default adoption writes in place and creates no git object.** `simt init --yes`
   without the new flag leaves the reader on the branch they were on, tags nothing, and
   writes the adoption files as uncommitted changes. The reviewable diff survives: `git diff`
   shows the whole adoption, and discarding it is `git checkout -- .` plus a clean. The run
   says so in an `in place` line that names the flag which restores the undo path.
2. **The escape hatch moves behind a flag named for what it gives.** `--backup` is the
   opt-in: tag the pre-adoption commit as the backup tag and branch onto the adopt branch
   before the first write, exactly as the tool did before. The name is the promise — a way
   back to what the repository was — and it already appears in the output the tool prints, so
   the flag and its effect share one word.
3. **Whatever a run does to git state is reported, including doing nothing.** Plan 0002's
   heading over the adoption rules is "Nothing is silent". With the hatch opt-in, the
   in-place run is a git-state event too — the deliberate absence of one — and it gets a line
   that says what was not done and how to get it done. The `--backup` run keeps the two lines
   S15 established: what was tagged, and where the branch came from.

## Consequences

- `simt init --yes` on a git repository no longer moves the reader or writes a tag; consumers
  who scripted against the old default add `--backup`. This is the one behaviour the change
  invalidates, and it is named here rather than discovered in a broken pipeline.
- The `in place` line appears on every real adoption that does not pass the flag, and the
  help text for `init` and for the flag say what it means.
- The dry-run path is untouched: it already created no git object, and it still says `apply
  with: simt init --yes`.
- Acceptance: the S15 test now runs with the flag and asserts both operations are reported;
  a new test runs without it and asserts no tag, no branch, the reader stays put, and the
  in-place line names the flag; the not-a-git-work-tree test runs with the flag, because that
  is where the best-effort note lives now.

## Rejected

- **Keep "always" and add a flag to opt out.** An opt-out flag fixes the surprise for those
  who read the help, and it still surprises everyone else — which is every consumer of a tool
  whose default action is to touch someone's repository. The cost of the wrong default is
  paid on every adoption; the cost of the right default is one flag on the few that want it.
- **Two flags, one per operation.** The tag and the branch arrive together in the code and in
  the undo story: the tag is the reset target, the branch is where the adoption sits while it
  is reviewed. Splitting them lets a reader build a state the tool has never tested — a branch
  without a tag to reset to, or a tag with nothing isolated under it.
- **Move the decision into the dry-run preview.** The dry run shows what would change in the
  files; git state is not a file, and a preview line for an operation that now does not happen
  by default would describe the opt-in as if it were the plan. The `in place` line after
  `--yes` is where the reader learns what the real run did not do.
