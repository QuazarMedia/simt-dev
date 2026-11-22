---
simt-affects: ["src/index/persist.mjs", "test/index-open-error.test.mjs", "test/mcp-session.test.mjs", "test/fixture.mjs"]
---

# ADR-229 — a read waits for a transient index write, then names it

Status: accepted · 2026-11-22

## Context

The index is a SQLite cache written incrementally while commands and tests read it. The
writer has had `busy_timeout = 5000` since ADR-115, so a concurrent build waits for the
other writer. The readers did not set the pragma: `storedVersion`, `readSqliteRows` and
`readSqliteBatch` opened the database and queried it immediately. A lock held for a few
milliseconds could therefore turn into `INDEX_BUSY` for a reader, even though the same
contention would have cleared within the writer's own five-second bound.

That is not a test-isolation defect. MCP `brief` and `skills_brief` are read-only and pass
`build: false`; they open the index another process may be writing. The full suite exposed
the reader path when one test rebuilt the shared checkout's index while `skills_brief`
read it. Returning `INDEX_BUSY` there was accurate about the lock and wrong about the
contract: the tool told the caller to retry a wait it could have performed itself.

## Rulings

1. **A read uses the writer's five-second busy timeout.** `storedVersion`,
   `readSqliteRows` and `readSqliteBatch` open through one helper that sets
   `busy_timeout = 5000`. A transient lock is waited out and the read answers from the
   index it found.

2. **The wait is bounded; after it, `INDEX_BUSY` is still the answer.** The code, message
   and remedy are unchanged: `another index run is writing; wait a moment and run again`,
   with the brief's `wait for the other index run, then retry` remedy. A read must not
   return empty rows, a stale packet or `E_READ` because the lock outlasted the bound.

3. **The tools stay read-only.** `brief` and `skills_brief` continue to pass `build: false`;
   this ruling changes only how their read waits. A cold index is still an error naming
   `simt index`, and nothing in a tool writes an index.

4. **The wait is tested from another process.** A `node:sqlite` busy wait is synchronous,
   so a timer in the reading process cannot release the lock it is blocked on.
   `holdIndexLock` in `test/fixture.mjs` holds a DELETE-mode exclusive transaction in a
   child, signals readiness, and releases it. `test/mcp-session.test.mjs` proves
   `skills_brief` waits through that lock; `test/index-open-error.test.mjs` proves the
   primitive waits and that a lock held past the bound still reports `INDEX_BUSY`.

## Consequences

- A reader now waits up to the five-second bound at each open before reporting contention,
  and usually pays only the duration of the build it was racing.
- The writer and the reader share one timeout constant in `src/index/persist.mjs`; a
  future change to the bound changes both.
- The `INDEX_BUSY` mapping remains testable without pretending the index is empty.
- The MCP flake is no longer hidden by test isolation: the test that exercises the tool
  holds the lock on purpose and expects the wait.

## Rejected

- **Return an empty index or a registry-only packet on a busy lock.** ADR-226 rejected
  the second document under the same tool name; an empty answer is a different index, not
  the one that was locked.
- **Retry in the MCP tool.** An unbounded retry makes a tool call hang on a genuinely long
  build, and a second timer above SQLite's own busy handler duplicates the first bound.
- **Only set the timeout on the writer.** That is the defect this record corrects: a
  writer that waits is no help to a reader that does not.
- **Treat `INDEX_BUSY` as a cold index.** It would make the reader build over the writer,
  or report a repository it has not read.
