# ADR-090 — An optional adapter is off until a repository names it

Status: **accepted** · 2026-10-18 · filed as R21 (plan 0003)

**Affects:** `src/index/extract.mjs`, `src/index/store.mjs`, `src/index/persist.mjs`,
`test/extract.test.mjs`

## Context

The index can say which file defines a name only if something reads the blob. A
structural parser does that more accurately than a scan of lines, and it is also a
dependency: grammars, a WASM runtime, a package this tool would then require. The
floor this package ships is zero dependencies. An adapter that is always loaded is
not optional, and an adapter this package names for one organisation is a name the
next repository does not have.

The module graph of imports now exists. ADR-088 ruling 3 kept `import-direction` in
the prose because that graph did not. The graph still does not say which way an
import is allowed to point.

## Rulings

1. **The built-in extractors are the index.** They read one line at a time and
   record definitions, exports and imports for the languages a map needs. The same
   blob produces the same symbol rows and the same import edges. A blob that has
   not changed is not read again. Recall against a hand-labelled set of exported
   names, for TypeScript, Kotlin, Python and Go, is at least 90%. A comparison
   against a structural parser was not run.

2. **An optional adapter is a separate package, and it is off until named.**
   `index.parsers` is the package name. Absent, nothing is imported. This package
   does not depend on a parser and does not ship a default name for one. When the
   named package does not load, the built-in rows are the cache and the index says
   so. When it loads, its symbols and edges replace the built-in rows for that
   blob. It writes those rows into the cache. It does not edit a source file.

3. **`import-direction` still does not replace its line.** ADR-088 ruling 3 stands,
   except for the sentence that the module graph is not built. The edges are
   recorded. No rule names the direction they must follow, so the instruction stays
   and `simt check` does not fail a repository for the missing direction.

## Consequences

`simt index` now reports how many symbols and edges the cache holds. Whether the
line extractor misses a name a parser would have found, on a real repository, is
unmeasured: the bar above is the labelled fixtures, not a live parser.

## Rejected

- **Depending on a parser, or probing one this package names.** The dependency set
  would no longer be empty, and a name that only one organisation publishes is not
  a default for every repository.
- **Treating the import edges as a direction check.** An edge says that A imports B.
  It does not say that A was allowed to. Dropping the instruction would report the
  line as enforced.
