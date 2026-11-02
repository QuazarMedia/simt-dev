---
simt-affects: ["src/docs/commands.mjs", "src/commands/docs.mjs", "src/commands/spec.mjs", "test/docs.test.mjs", "README.md", "docs/commands"]
simt-supersedes: []
---
# ADR-136 — the command reference is generated into `docs/commands`, and the front page is a front page

Status: accepted · 2026-11-02

## Context

`simt docs readme` rendered the command list into `README.md`, which was the right answer to
Q60's question — one source, one rendering, a test that fails when they disagree — and the
wrong place for the bytes. The block was 240 lines, so the front page carried more reference
than prose, and the install channels, the workspace-shape table, the module table and the
files-written table all sat in the same file. Adding a command meant editing a front page.

Review 0003 Q90 measured the result: 431 lines, 33 KB, command information in four places,
and a status report ("where the plan finishes") that no longer described the plan.

## Rulings

1. **The reference lives in `docs/commands/`.** `simt docs commands --yes` renders an index
   page, which carries the flat list, and one page per group, from `src/commands/spec.mjs`.
   The README no longer carries the list and no longer has a `simt:commands` region, so the
   command that renders it is `docs commands`; `docs readme` is withdrawn.

2. **The front page is bounded, and the bound is a test.** `README.md` is at most 150 lines
   and links to the pages that carry the detail. A test fails when it grows past the bound
   or when a relative link in it does not resolve, because an index nobody maintains is how
   the 431-line README happened.

3. **Nothing is summarized into a link.** The install channels, the workspace shapes, the
   module table, the files-written table and the rule-selection section moved to
   `docs/getting-started.md`, `docs/guides/workspace-shapes.md`, `docs/reference/modules.md`,
   `docs/reference/files-written.md` and `docs/architecture/pipeline.md` with their content
   intact. The status report the README carried ("where the plan finishes") is deleted: the
   tracker is the status, and a prose copy of it goes stale between releases.

4. **The tracker reads subdirectories.** A finished plan or review is archived under
   `docs/plans/archive/` or `docs/reviews/archive/`, and `src/plan/index.mjs` reads those
   directories recursively. A tracker that stopped at the top level would report a finished
   document as missing rather than as finished, which is the failure that made the archive
   wait for this record.

## Consequences

- Removing the block from the README changes a repository's generated files only where it
  adopted the block; the block was never a region `sync` maintained in a consumer, so no
  consumer's AGENTS.md moves.
- `docs/commands/` is committed. A stale page fails the suite, which is the same guarantee
  `test/docs.test.mjs` gave the README block.
- The README's own prose is now the only thing that has to be true on the front page, and
  the pages it links are where a reader goes next.

## Rejected

- **Keep the block in the README and drop the other sections.** The block alone is 240
  lines; the bound would be unreachable.
- **Generate only the index, keep the per-command prose hand-written.** The hand-written
  copy is the defect: it is the fifth place a command is declared.
- **A `scripts/gen-docs.mjs` that nobody runs.** The check lives in the test, which runs on
  every change; a script is a convention, a test is a gate.
