# ADR-089 — The local index is a cache of git blobs

Status: **accepted** · 2026-10-18 · filed as R20 (plan 0003)

**Affects:** `src/index/store.mjs`, `src/commands/repoindex.mjs`, `test/index.test.mjs`

## Context

Later slices ask which file defines a name, which test covers a change, and which
decision governs a path. Those questions need a store, and the store has to be
rebuildable: a cache that cannot be reconstructed from the repository is a second
source of truth. The plan names `node:sqlite`, with a fallback for a Node that does
not have it, and it names the blob hash from `git ls-files` as the unit of change.

The floor this package declares is older than the Node that first shipped that module
as something a program can rely on. A store that only works on the machine that
happened to build it is not the store the plan describes.

## Rulings

1. **The store is sqlite when this process can open it and create an FTS5 table.**
   The file is `.simt-dev/index.sqlite`. The tables are the ones the plan names:
   files, symbols, edges, an FTS5 table, and meta. When the module is absent or FTS5
   cannot be created, the same file rows are written to `.simt-dev/index.jsonl`.
   Nothing is added to the dependency set.

2. **A row is keyed by the git blob.** `git ls-files -s` supplies the path and the
   blob. A path whose blob has not changed is not read again, and its row is not
   rewritten. A path that left the index leaves the store, and so does anything
   recorded against that path. Two indexes of the same blobs produce the same file
   rows. The language comes from the extension, and the package comes from the
   nearest manifest walking up from the file.

3. **`simt index` rebuilds the cache.** It does not preview, because the file it
   writes is not repository content. It says when the path is not gitignored. A
   directory that is not a git repository cannot be indexed.

## Consequences

Reindexing one changed file reads that blob and leaves the others. The symbols and
edges tables exist and are cleared for a path whose blob changed. Nothing fills them
until a later slice extracts names from the bytes.

## Rejected

- **Requiring sqlite.** The floor this package already ships does not promise the
  module. A repository on that floor still gets an index.
- **Hashing the worktree instead of the blob.** An unstaged edit is not what
  `git ls-files` reports. The index follows the index, so two machines with the same
  committed blobs agree.
- **Treating the cache as a writer that previews.** A preview that does not write
  leaves the reader with no index. The command's only effect is the cache.
