---
simt-affects: ["src/index/persist.mjs", "src/index/store.mjs", "src/commands/map.mjs", "test/index.test.mjs", "test/map.test.mjs"]
simt-supersedes: []
---

# ADR-115 — the index stamps its schema version, migrates older databases in place, serves newer ones from a sidecar, and names a corrupt index

Status: **accepted** · 2026-10-31 · filed as review 0003 Q44

## Context

Review 0003 (Q44) verified three failures in the local index's persistence:

- The database carried no schema version a reader trusted. A newer simt
  silently rewrote a database an older simt had written, and two pinned
  versions rewrote one file past each other — the ADR-059 flip-flop.
- The FTS tables, whose tokenizer lives in their definition, were
  recreated by a per-write wipe (`ensureFtsSchema`) whenever the stored DDL
  drifted: a migration that ran on every build, unnamed and unobservable.
- Every read failure answered `[]`. "Locked", "no such column" and "corrupt"
  all looked like a cold index, so a damaged database read back as an empty
  one and the command quoted the emptiness as the repository's shape.

Plan 0004 §1 fixes the shape of the answer: the index declares the version it
was written at; a version change is a named, ordered migration; a file this
version does not own is not opened for write; and a read failure is named, not
silenced.

## Ruling

1. **The version is stamped on every write.** `PRAGMA user_version` carries
   the schema version in the sqlite database; the meta `schema` row is kept
   as the fallback for databases written before the stamp existed, and as the
   version carrier in the jsonl backend, whose lines carry no pragma.
2. **Migrations are an ordered list, and the 3 → 4 step is the FTS
   recreation.** Each step is idempotent and runs in list order; a database
   older than the current version is opened in place and upgraded on the next
   write. A database at a version past the last step is not opened for write
   at all — opening it would demote the stamp.
3. **A file a newer version owns stays with its owner.** This version reads
   and writes a sidecar named after itself, `index.v<SCHEMA_V>.sqlite` (and
   `.jsonl`); the canonical file is untouched. A sidecar that has not been
   built yet is cold, not broken. `indexFileFor` is the single owner of the
   sidecar name, shared by readers and writers.
4. **A read returns `{ rows, error }`, and a failure is named.** `INDEX_BUSY`
   is a retryable write contention; `INDEX_CORRUPT` is a file that cannot be
   read as a database. The store's read wrappers attach the error to the row
   array, so callers that iterate are untouched and callers that report can
   tell a broken index from an empty one. `loadGraph` answers `broken`
   alongside `cold` and `stale`: `cold` is "nothing here", `broken` is
   "something is here and the read failed".
5. **A corrupt canonical file is rebuilt in place by the next build.** The
   index is a cache of git blobs (ADR-089): a damaged file is named on read
   and replaced on write, and the rebuildability that makes the file
   disposable is what makes in-place replacement safe.

## Consequences

- `ensureFtsSchema` and its per-write wipe are gone; the FTS tables converge
  through the named migration, which runs once per upgrade, not per build.
- `migrateDb` stays module-private: it is called by the writer, and the
  dead-code gate reads an export as a promise to a caller this package does
  not have.
- `reindex`'s `force = version !== SCHEMA_V` remains sound: an older database
  is fully rewritten and then migrated in place; a newer one is left alone
  and the build goes to the sidecar.
- `simt repoindex`, `simt init` and `simt map` output paths are unchanged;
  `SQLITE_FILE` and `JSONL_FILE` keep their names, and the sidecar is the
  only new file this ruling introduces.
