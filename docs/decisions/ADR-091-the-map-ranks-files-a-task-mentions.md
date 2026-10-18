# ADR-091 — The map ranks the files a task mentions, and the files next to them

Status: **accepted** · 2026-10-18 · filed as R22 (plan 0003)

**Affects:** `src/index/map.mjs`, `src/commands/map.mjs`, `src/commands/bench.mjs`,
`test/map.test.mjs`

## Context

A task names a behaviour. The files that behaviour lives in are a small part of
the tree, and an agent that reads the tree in path order spends its budget on
files the task never touches. The index now records imports. What it did not
do is say which of those files to read first.

The mined tasks store a gold patch outside the worktree. The published task
record counts the files and the lines. It does not list the paths. Recall has
to be read from the patch, and a machine without that patch cannot invent the
denominator.

## Rulings

1. **The map is PageRank over import and call edges, personalised to the task.**
   Twenty iterations, damping 0.85. An edge counts in both directions, once.
   A file the task mentions sorts ahead of a file it does not: on this graph
   the file every module imports otherwise occupies the top 10. A term that
   labels too many paths is ignored. A token that contains a digit and names
   one path counts more the more often the task says it, so a citation does
   not rank with the subject. A file that already matched, in a directory of
   at most eight files, is lifted toward its neighbour. Files the task does
   not mention, and that are not one edge away from a file it does, are left
   out. With no task text the whole graph is ranked. Equal ranks break by
   path, ascending. The same graph and the same text return the same order.

2. **The rendering fits a budget, at one of three levels.** `outline` is paths.
   `names` adds the exported symbols. `signatures` adds the line they were
   declared on. The default budget is 2048 bytes. Zero means no ceiling. The
   first file is kept when it alone is over the budget, so a map of a real
   ranking is not an empty page.

3. **recall@10 is the mean, over mined tasks, of the fraction of gold files
   that land in the top 10.** The gold paths are the destination side of the
   patch. A task whose patch is not in the vault is unmeasured, not a miss.
   `simt bench report` prints the figure. It does not fail the cost report
   when the figure cannot be computed.

## Consequences

`simt map` reads the index and rebuilds it when the cache is empty. The
comparison against the mined patches is a property of this checkout's index
and of the vault on this machine. A checkout with no index, or no vault,
reports the figure as unmeasured. On the 20 mined tasks available here, mean
recall@10 is 55.6% of gold files. The bar is 60%, and this ranking does not
meet it.

## Rejected

- **One-directional edges.** Rank would flow only toward the imported file, and
  the test that imports the file the task named would never surface.
- **A zero when the gold patch is absent.** That number would punish a machine
  for a file the benchmark hides, and it would read as a measurement.
