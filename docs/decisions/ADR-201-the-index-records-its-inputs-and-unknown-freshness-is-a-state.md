---
simt-affects: ["src/index/store.mjs", "src/index/persist.mjs", "src/index/open.mjs", "src/commands/map.mjs", "src/commands/repoindex.mjs", "test/index.test.mjs", "test/index-open-error.test.mjs", "test/map.test.mjs"]
simt-supersedes: [{ adr: "ADR-089", ruling: 2, kind: "narrowed" }]
---
# ADR-201 — the index records the inputs it was built from, and unknown freshness is a state

Status: accepted · 2026-11-21 · filed as review 0005 PR23 · narrows ADR-089 ruling 2

## Context

The index reused a file's row when the blob had not changed (ADR-089 ruling 2). That test
is necessary and not sufficient: a row is a function of more than its bytes. The parser
named by `index.parsers`, the language table the ecosystem records supply, the nearest
package marker and the tracked path set all decide what the row says. Changing any of them
left every unchanged file eligible for reuse:

- a new parser produced the old symbols until the file itself was edited;
- a new `package.json` above an unchanged file left its `pkg` stale;
- an import specifier was resolved once, so adding, deleting or renaming its destination
  left the importer's edge pointing at a path that no longer existed — or missing one that
  did.

Freshness had the complementary defect. `isIndexStale` answered `false` when git could not
list the tree, because the only alternative a boolean offered was `true`. A cache nobody
could compare against was reported as current, which is the one reading a caller cannot
distinguish from a verified one.

Three reads (files, symbols, edges) each opened the database separately, so a read that
straddled a concurrent build could answer with rows from two of them, and no answer named
the build it came from.

## Ruling

1. **Every build stamps what it read.** `meta` carries `tree` (the `git ls-files -s`
   listing), `inputs`, `resolution` and `build`. A database with no `inputs` stamp was
   written by a reading this version cannot describe, and the next build re-extracts every
   listed file rather than reusing part of it.

2. **`inputs` covers the parser, the language table, the package layout, the scope and the
   index revision.** The parser identity is its config name, resolved file and bytes; the
   language table is the resolver's extension map; the package layout is the set of package
   roots the tracked files resolve to; `INDEX_INPUT_REVISION` covers a change to the
   built-in extractor or resolver that a schema version is not for. `SCHEMA_V` remains the
   database format and its ordered migrations, not a content version.

3. **`resolution` covers the tracked path set and the language table.** When it changes, the
   edges of an unchanged importer are rebuilt from the import specifiers stored with its row
   - no blob is read again. Edges an adapter supplied are the adapter's reading and are
   re-extracted only when the adapter identity, part of `inputs`, changes. A file that
   imported nothing has no edge to refresh and is not touched.

4. **Reuse is a decision about bytes; edges are a decision about resolution.** An unchanged
   blob is not re-read and its source row, symbols and FTS rows are not rewritten. Its edges
   may be, which is the one place ADR-089 ruling 2 is narrowed: "its row is not rewritten"
   now means its extracted row.

5. **Freshness is a state, not a boolean.** `indexFreshness` answers `cold` (no build has
   vouched for a tree), `current`, `stale`, `unknown` (git could not list the tree) or
   `busy` (another writer holds the database). `isIndexStale` remains as the narrow helper
   that is true only for `stale`; a caller for which unknown matters reads the state. A read
   failure is named before emptiness: a locked or corrupt index is `INDEX_BUSY` or
   `INDEX_CORRUPT`, never "the index is empty".

6. **A graph read is one build.** Files, symbols and edges are read in one transaction on
   one connection, so the rows of two concurrent builds cannot be mixed. Every retrieval
   result names its basis: the index build, tree, inputs and resolution; whether a
   working-tree overlay was merged into the answer; and that the rows come from the staged
   git index, which equals committed content only when the worktree is clean.

## Consequences

- A parser change, a package-root change or a language-table change rebuilds the tree
  once. A path-set change re-resolves unchanged importers without reading their blobs, and
  reports how many it touched as `edgesRefreshed`.
- A cache written before this ruling is rebuilt on its next build; its rows are not
  trusted to say how they were produced.
- `simt index` reports `updated`, `edgesRefreshed`, and the build's `inputs`, `resolution`
  and `build`; `simt index --open` reports the freshness state and the basis;
  `openIndex()` attaches the same basis to every answer without changing the rows a caller
  iterates.
- A stale or unknown cache is still served when a caller may not build. The label is the
  contract: the caller can distrust the packet instead of quoting it.

## Rejected

- **Re-extract everything whenever the tracked path set changes.** Every tracked add or
  delete would become a full rebuild, and a delete is exactly when an unchanged importer's
  edge must be corrected cheaply.
- **Store only resolved edges and no specifiers.** Re-resolution would then need the
  importer's bytes, which is the read this ruling exists to avoid.
- **Fold unknown into "not stale".** That is the defect: a boolean cannot say "I could not
  check", and the caller reads it as "I checked".
- **Version only the schema.** The format did not change when the parser or the package
  layout did; a schema bump would have forced a migration to express a content change.
