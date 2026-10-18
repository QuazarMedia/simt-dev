# ADR-092 — A test is an import, a conventional neighbour, or a coverage record

Status: **accepted** · 2026-10-18 · filed as R24 (plan 0003)

**Affects:** `src/index/tests.mjs`, `src/commands/tests.mjs`, `test/mapping.test.mjs`

## Context

The index records imports. A test file that imports a source file is evidence
that the test exercises it, and so is a coverage report that names both. A
shared commit is weaker: most commits touch a test and several sources that
the test does not exercise.

The line extractor reads one line at a time, so an import whose specifier sits
on the next line is absent from the stored edges. The mapping has to see that
specifier or it misses the tests this repository actually writes.

## Rulings

1. **The default answer uses only the precise edges.** Kind `test`, weight 1.
   A test file imports a tracked source file, including a dynamic `import()`.
   Or the conventional source beside the test exists: `foo_test.go` beside
   `foo.go`, `test_foo.py` beside `foo.py`, `FooTest` beside `Foo` in the same
   directory, `foo.test.mjs` beside `foo.mjs`, and `src/test/java` mirrored to
   `src/main/java`. Or a coverage record names both sides. lcov pairs a source
   only when the test name is non-empty. JaCoCo pairs a source file with the
   one class whose stem is that file plus `Test` or `Tests`. A Go profile
   counts a hit, and the test is `stem_test.go` in that directory, or the
   single `*_test.go` there. A file that is not one of those is not an edge.

2. **Co-change is a different kind, and it is off unless asked.** Kind
   `cochange`. A pair counts when it appears in at least two commits. A commit
   with more than five tests or more than fifteen sources is skipped. Each
   test keeps its eight strongest pairs. History is the last 200 non-merge
   commits. `simt tests --cochange` appends those files after the precise
   ones. A git failure leaves the history empty; the import map still answers.

3. **The edges are computed when asked, and not stored.** The index write
   replaces every edge of a changed path. Storing the test map in that write
   would drop the import edges, and reading the commit log inside a reindex
   would miss the one-file time bar. Coverage is read from a fixed list of
   paths. A path that is absent is not a failure.

4. **Precision is the share of predicted tests that the label also names.**
   An empty prediction does not pass. On the 30 hand-labelled files in this
   checkout the figure is 1.0. The bar is 0.8.

## Consequences

`simt tests` with no path prints how many test edges and how many co-change
edges the tree has. `simt tests <path>` lists the tests for that file. A path
the index does not contain is a usage error. A directory that is not a git
repository is unsupported.

## Rejected

- **A stem that is unique somewhere else in the tree.** The test named for a
  directory is not the test of the one file that happens to share that stem.
- **Writing the test edges into the index.** The next reindex of a touched
  path would have to know about every edge kind or it would delete them.
