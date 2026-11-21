---
simt-affects: ["src/name.mjs", "src/state.mjs", "src/projection/manifest.mjs", "src/manifest/schema.mjs", "src/projection/markers.mjs", "src/projection/lock-file.mjs", "src/projection/lock.mjs", "src/projection/project.mjs", "src/kernel/variants.mjs", "src/lease.mjs", "src/ledger/index.mjs", "src/memory/lessons.mjs", "src/journal.mjs", "src/status.mjs", "test/naming.test.mjs", "test/markers.test.mjs", "test/lock.test.mjs", "test/lease-v2.test.mjs", "test/ledger-v2.test.mjs", "test/undo.test.mjs", "test/deprecation.test.mjs", "test/status.test.mjs"]
simt-supersedes: []
---

# ADR-213 — a legacy format has one owner, and only recovery value keeps it

Status: accepted · 2026-11-21

## Context

Compatibility accumulated one rename at a time. The manifest, lock and region markers moved
with the command; the state directory moved under `.simt/local/`; leases and the ledger gained
versioned records; the journal moved its sets. Each move was correct, but the readers that
kept the old format alive were written where the move happened, and some questions acquired
more than one answer.

Two of those answers were wrong in a way the suite did not see:

- The lock's location was looped over independently by the frozen check, the plan's
  previous-bytes comparison and the variant fold. A lock could be damaged for one reader and
  accepted by another, and the plan could create a second lock beside one it claimed was absent.
- A legacy `.simt/leases.json` was read only when `.simt/local/leases.json` did not exist. Once
  any write created the new file, every still-active claim in the old file disappeared from the
  hook's view. A released claim could also come back, because the old file was never retired.

The opposite mistake is just as expensive: deleting every fallback at once strands repositories
holding a published name or the only copy of history. The review asks for retirement on
evidence, not on the age of a comment.

## Rulings

1. **A format has one owner.** The module that understands a document owns both its current and
   legacy spelling. A second module may not decide which file is the lock, parse the manifest,
   or choose between the two state roots. Shared location logic lives in a module with no
   interpretation in it (`src/projection/lock-file.mjs`); the format owner consumes it.

2. **Read both, migrate on write.** While a legacy spelling is supported, a reader sees the
   current document first and the legacy one when the current is absent — or, for active
   coordination state, both. The next write emits the current format and retires the old file.
   A crash between the write and the retirement is safe: the next read merges both and dedupes
   by holder and resource, so a retry is idempotent.

3. **History is not rewritten.** Append-only records (the ledger, lessons) keep their old lines
   and their old meaning forever. The journal moves whole sets; it does not rewrite their
   contents. A migration may change where a record lives, never what it says.

4. **Derived state is not recovered.** A cache holds no fact that `check` cannot measure again.
   The pre-move `.simt/check.json` cache is retired: it is not read, and the remedy is the one
   the miss already prints — `run check`. It stays in `TREE_EXCLUDES` so an old checkout cannot
   change its tree id.

## Inventory

| Format | Legacy spelling | Current spelling | Owner | Decision |
| --- | --- | --- | --- | --- |
| Manifest | `simt-dev.json` | `simt.json` | `manifest/schema.mjs` (read), `projection/manifest.mjs` (write) | Keep. Fourteen adopted repositories carry the old name; the write renames it rather than shadowing it. |
| Projection lock | `simt-dev.lock.json` | `simt.lock.json` | `projection/lock-file.mjs` | Keep. It may hold variant winners nothing can regenerate; read until the next write, never rewrite the legacy file. |
| Region markers | `simt-dev:` | `simt:` | `projection/markers.mjs` | Keep. A region is rewritten only by the sync that migrates it; hand-written bytes outside the region are untouched. |
| State root | `.simt/<file>` | `.simt/local/<file>` | `state.mjs` | Split by value: ledger and lessons keep reading old history; the journal migrates sets; leases merge and migrate; the check cache is retired. |
| Lease schema | v1 flat record | v2 resource/holder/fence | `lease.mjs` | Keep both shapes. A v1 claim is still an enforced claim; the writer emits v2 and retires the legacy file only after the new one is in place. |
| Ledger records | v1 line | v2 line | `ledger/index.mjs`, `ledger/evidence.mjs` | Keep forever. Old lines are evidence with a narrower meaning (local tree, no remote target), not a format to upgrade. |
| Journal sets | `.simt/journal` | `.simt/local/journal` | `journal.mjs` | Keep and migrate on the next commit. A name in both directories is a collision, not a winner; both records survive. |
| Check cache | `.simt/check.json` | `.simt/local/check.json` | `status.mjs` | Retired. Disposable, rebuilt by `check`, no recovery value. |

The shim directory (`.simt-hooks` to `.simt/hooks`) already has its own retirement ruling in
ADR-122 and is unchanged here.

## Consequences

- `src/projection/lock-file.mjs` is the one place that answers which lock file exists; the
  frozen check, plan and variant fold read it through that module.
- `readLeases` merges a legacy and a current lease document, with the current record winning a
  duplicate holder/resource. `writeLeases` removes the legacy file after the atomic rename.
- `readCheckCache` no longer reads `.simt/check.json`; a repository carrying one sees
  `no cache - run check`, which is the same remedy as a first run.
- `test/lock.test.mjs`, `test/lease-v2.test.mjs` and `test/status.test.mjs` hold the mixed-state
  and retirement cases; the existing journal tests hold crash/retry for set migration.

## Rejected

- **Delete all legacy readers now.** The manifest name, lock variants, region markers, old
  ledger lines and active leases are all still recoverable state in repositories this tool does
  not own. Age is not evidence that nobody holds them.
- **Keep the check-cache fallback because it is harmless.** It is not: it can report a tree that
  the current `check` has already invalidated, and the cache exists only to be rebuilt. A
  disposable record that outlives its writer is a stale answer with no owner.
- **Last file wins when both leases exist.** That is what silently un-leased held paths. The
  current file wins a duplicate record, but a claim only in the legacy file remains a claim.
