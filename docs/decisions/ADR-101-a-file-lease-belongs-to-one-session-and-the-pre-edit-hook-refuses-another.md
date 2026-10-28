---
simt-affects: ["src/lease.mjs", "src/commands/lease.mjs", "src/agenthooks/policy.mjs", "src/agenthooks/decide.mjs"]
simt-supersedes: []
---

# ADR-101 — a file lease belongs to one session, and the pre-edit hook refuses another's edit

Status: **accepted** · 2026-10-28

Affects: `src/lease.mjs`, `src/commands/lease.mjs`,
`src/agenthooks/policy.mjs`, `src/agenthooks/decide.mjs`

## Context

Parallel agents share one working tree, and the cheapest collision between them
is two sessions editing the same file at once: each edit is valid alone, and
the pair is neither — one session's work is overwritten by the other's save,
with no gate, no diff and no hook that ever sees a conflict. Git notices this
only at merge time, which is far after the fact either session can explain.

Plan 0003 R54 asks for a claim mechanism: `simt lease <paths>` records which
session is working on which path, with a TTL, and the pre-edit half of the
agent hook denies an edit from a session that does not hold the claim.

The policy table is where every other agent-time refusal lives (`push`,
`rewrite`, `generated`), so a lease refusal belongs there too — one table,
four harness dialects, one message. What the table has never had is a fact
that is not in the payload: which session is asking, and who else has claimed
the path.

## Ruling

1. **A lease is a claim, not a lock.** `.simt/leases.json` records one entry
   per path: the repo-relative path, the session name, and an absolute expiry
   timestamp. It is taken with `simt lease <paths>` (preview unless `--yes`),
   the session comes from `--session` or `SIMT_SESSION`, and the TTL defaults
   to an hour. There is no lock on the file and no daemon: a claim is advisory
   data that expires on its own, last writer wins, and a claim lost to a race
   is simply re-made. Coordination machinery would be a system built around a
   file a TTL already cleans up.

2. **A live claim held by a different session refuses a re-claim.** Stealing
   is what expiry is for: the refusal names the holder and the expiry, and
   the session that wants the path waits for the TTL or asks the holder. The
   holder may re-claim (refresh) its own paths at any time.

3. **The pre-edit hook denies an edit to a path another session holds.** The
   check joins two facts at decision time: the active claims in the file, and
   the asking session's name from `SIMT_SESSION` — one variable for the claim
   and the check, because a denial is only explainable if the session it
   protected is the same name the claim was filed under. A session that cannot
   prove ownership is treated as another session: an unrecognised edit is
   refused with the holder's name, not waved through. Expiry is read when the
   hook runs, so a TTL needs no sweeper, and a claim with no file (the default
   state of every repository) denies nothing.

4. **An unreadable claim file fails closed for edits and only for edits.**
   A `.simt/leases.json` that does not parse is evidence someone — possibly a
   session routing around the check — broke the claims the hook is about to
   enforce, so any write is refused until the file is fixed or removed; a
   `lease` command refuses to write over it for the same reason. A shell
   command with no file fact is not an edit and is not refused. This mirrors
   the fail-closed contract every gate has, scoped to the question the lease
   can actually answer.

5. **The refusal is the `lease` policy, with the table's full machinery.** It
   carries `ADR-101`, is lifted by `SIMT_ALLOW=lease` exactly as every other
   policy is, exits with the harness's deny code, and its message names the
   held paths, the holders and the expiry in ISO — the three things the
   blocked session needs to act. The per-instance detail is a `detail` hook on
   the row, so the message that quotes a timestamp does not become a special
   case inside `decide`.

## Consequences

- Two sessions in one working tree can coordinate with one command and no
  shared process; a crashed session's claims lapse on their own.
- The hook's hot path gains one small `readFile` of a file that is usually
  absent, and only when the payload named a file to write.
- `learn.mjs` reads policy rows by `id` and `adr` only, so the `lease` row
  joins the estate's violation aggregation with no further wiring.
- The claim file is local state under `.simt` like the index and the journal:
  never projected, never committed.

## Rejected

- **File locking (`flock`, a lockfile protocol).** A lock that blocks is a
  deadlock with a crashed session in it, and it needs the very daemon ruling 1
  refuses. The TTL already bounds every claim.
- **Inferring leased paths from shell commands.** Only the edit tools name a
  file with no guesswork; guessing at what a `sh -c` line will write is the
  payload-shaped false positive the policy table was built to avoid — no fact
  is not a violation.
- **A lease the holder must release to finish.** Forgetting to release is the
  expected failure of any release-based protocol; an expiry is not.
