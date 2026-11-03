---
simt-affects: ["src/index/overlay.mjs", "test/work-index.test.mjs"]
simt-supersedes: []
---
# ADR-155 — a working-tree overlay is labelled, merged, and never written into the cache

Status: accepted · 2026-11-03

## Context

The index is a cache of staged blobs, rebuilt from `git ls-files -s`. That is what makes it
safe to delete and cheap to trust: nothing in it can be a fact about a file that only exists
in somebody's editor. The gap shows up the moment a reader asks about an edit in progress:
the cached row is the last committed content, and a packet quoting it looks authoritative
while describing a file that has already changed.

Filling the gap by writing working-tree rows into the cache is the obvious fix and the wrong
one. The cache's authority comes from "these are the staged bytes"; a row that changes when
an editor saves makes every later digest comparison meaningless, and a build that then reads
the same database sees rows it did not put there.

## Rulings

1. **Two layers, one read.** The base stays the staged rows. The overlay holds working-tree
   rows, and a read merges them. Nothing in the merge writes to the base.

2. **A revision is labelled and the label is checked.** Staged revisions are `staged:<digest>`
   and working-tree revisions are `worktree:<digest>`. A row whose provenance and revision
   disagree is refused, so an overlay digest cannot pass for a blob in a later report,
   summary or evidence record.

3. **A denied path is filtered before it is read.** Deny and ignore prefixes, plus the
   always-denied `.git`, `.simt` and `node_modules`, are applied to the candidate list. A path
   that is filtered is never opened, so its contents cannot reach a row, a vector, a
   diagnostic or a summary; filtering after extraction would already have the bytes.

4. **A delete is a tombstone and a rename is a delete plus an add.** A tombstone removes the
   file's node and every row whose source is that file, which is what makes the old path's
   symbols and edges converge instead of lingering beside the new ones.

5. **An unreadable file is reported, not skipped.** A missing row and an unchanged row look
   identical to the merge, so a failed read is named.

6. **A scope conflict is reported, not guessed.** When two work scopes claim a path with
   equal specificity, the row carries no scope and the conflict is a problem (ADR-145).

7. **Two backends, one semantics.** JSON lines and SQLite store the same normalised rows in
   the same deterministic order, and a read through either returns identical data. A
   backend that returned a different shape would be a second model.

## Consequences

- W18 lands as `src/index/overlay.mjs` rather than inside `store.mjs`/`persist.mjs`: the
  base schema's v5 columns already carry kind, revision and trust for staged rows, and
  adding scope and provenance there would require a migration whose only writer is this
  overlay. The overlay carries them itself, in its own backend, until a slice reads it
  through the store.
- The base index is untouched, so its determinism, its migrations and its tests keep their
  meaning; the overlay is rebuilt per read and never committed.
- `digestOf` is imported from the observation model in the knowledge layer, so one spelling
  of a digest serves both lineages rather than two copies drifting apart.
