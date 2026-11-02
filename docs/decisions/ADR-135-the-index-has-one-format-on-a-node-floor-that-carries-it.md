---
simt-affects: ["src/index/store.mjs", "src/index/persist.mjs", "src/commands/repoindex.mjs", "test/index.test.mjs"]
simt-supersedes: [{ adr: "ADR-089", ruling: 1 }]
---
# ADR-135 — the index has one format, on a Node floor that carries it

Status: accepted · 2026-11-02

## Context

ADR-089 ruled that the index is sqlite "when this process can open it and create an
FTS5 table", with a JSON-lines file otherwise. That was a hedge for a Node 22 line whose
`node:sqlite` was experimental and whose FTS5 availability was not something the package
could assume.

Review 0003 Q84 recorded the hedge as the defect it had become: a second format that
nothing chose, carrying the same rows through a second reader and writer, kept alive
because the floor might not have the first. The row's precondition was explicit — confirm
FTS5 on 22.20.0 before removing it — so the removal waited for that evidence rather than
for a convenient moment.

The evidence, run against the official v22.20.0 darwin-arm64 build: `process.versions`
reports `node 22.20.0`, `sqlite 3.50.4`; a `create virtual table … using fts5(a)` table
accepts a row and answers a `match` query; and
`fts5(kind UNINDEXED, ref UNINDEXED, body, tokenize = "trigram")` — the schema the CJK
path needs — builds. Both of the index's FTS tables exist on the floor.

## Rulings

1. **One format, and the floor carries it.** `src/index/store.mjs` writes and reads
   sqlite only; `src/index/persist.mjs` keeps the sqlite reader/writer and its schema
   migrations and no longer has a JSON-lines one. The `backend` option, the
   `writeJsonl`/`readJsonl` pair, `JSONL_FILE` and the per-backend branches in every read
   path are removed.

2. **A Node that cannot build the tables is refused by name.** `ensureIndexSupport`
   probes once per process by creating both FTS schemas in a memory database, and throws
   an error naming `22.20.0` when that fails. This replaces a silent downgrade to a file
   every other version reads differently.

3. **This supersedes ADR-089 ruling 1.** Its other rulings stand: the index is still a
   cache of git blobs keyed by blob sha, still rebuilt from `git ls-files -s`, still
   never repository content.

4. **The index is not an interchange format.** The JSON-lines file was never read outside
   this package, so removing it leaves nothing to export: a W23 bundle carries the
   records a peer needs, not a copy of somebody's cache.

## Consequences

- A `.simt/index.jsonl` written by an earlier version is no longer read. `simt index`
  rebuilds from git, which is what the cache is for; nothing is lost, because nothing in
  that file was authoritative.
- `simt index` stops printing a backend name. `file` in its JSON payload is
  `.simt/index.sqlite`, as before.
- The index file stays single-format, so the sidecar routing for a database written by a
  newer version (ADR-059) still applies to one file rather than to two.
- The floor is now a runtime requirement the code states in an error message rather than a
  fact in a document.

## Rejected

- **Keep the fallback behind a flag.** A flag is a promise to maintain two readers, and
  the second reader is the thing being removed.
- **Write a JSON-lines export from sqlite "for bundles".** No consumer reads one; adding
  a writer for a hypothetical reader is the same guess as the original hedge.
- **Depend on the floor's FTS5 without a probe.** The floor is a released binary, but a
  flagless Node build can ship a SQLite without FTS5. The probe costs one memory database
  per process and turns that into a named refusal.
