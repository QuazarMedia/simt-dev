# Plan 0005 — Co-author trailer, hooks under .simt, journal legacy migration

Status: **in progress — H1–H3 queued** · created 2026-10-31 · baseline `0c7507e`

## Scope

Three housekeeping decisions from the operator:

1. Every commit message this toolship defines or writes ends with a
   `Co-Authored-By: Simt Dev <noreply@simt.space>` trailer.
2. The shim directory moves from a top-level `.simt-hooks/` into the state
   directory as `.simt/hooks/`, so a repository carries one `simt` folder. No
   technical reason for the split surfaced: `core.hooksPath` accepts either,
   nothing in the code depends on the directory sitting at the top level, and
   the tool writes no `.gitignore` line for it in either location.
3. `.simt/journal` and `.simt/local/journal` are not duplicates: the first is
   the pre-move directory (review 0003 Q19), and `listJournalSets` falls back
   to it only when the new one is absent. Once both exist the legacy sets are
   invisible to `simt undo`. The journal never implemented the migrate-on-write
   step its own fallback comment promises, unlike the ledger.

All three slices are in this repository. None touches the gate list, the rule
set, or the resolution scores.

## Tracker

| ID | Slice | Phase | Depends on | Size | Needs ADR | Success metric | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Co-Authored-By trailer in the commit template and in `slice finish` commits | 1 | — | S | — | trailer in rule text, in `slice finish` commits, in the regenerated region; `node --test test/slice.test.mjs test/rules.test.mjs` green | Queued | |
| H2 | Shims move to `.simt/hooks`; `core.hooksPath` follows; the old directory cleans up on install | 1 | — | M | ADR-122 | `hooks install --yes` in a repo with a legacy `.simt-hooks/` re-routes and removes it; `node --test test/hooks.test.mjs test/agenthooks.test.mjs` green; full suite green | Queued | |
| H3 | Journal migrates legacy sets on write, restoring `undo` reach | 1 | — | S | — | a repo with only `.simt/journal` gets its sets moved into `.simt/local/journal` on the next write; `node --test test/undo.test.mjs` green; this checkout's 35 legacy sets reachable | Queued | |

## H1 — Co-Authored-By trailer

**Goal.** The commit message template carries the trailer at the end, and the
commit the tool writes on the operator's behalf carries it too.

**Design.**

- `rules/mdc/slice-commit.mdc`, `## Commit message`: the body format gains a
  final, always-present trailer line — `Co-Authored-By: Simt Dev
  <noreply@simt.space>` — stated as part of the message, after the sections.
- `src/commands/slice.mjs:554`: the commit message becomes subject + blank
  line + trailer; the remedy on 558 keeps naming the full message.
- Regenerate this repository's own region (`simt sync --yes`): the
  slice-commit rule is projected into `AGENTS.md`, so its bytes and the
  `simt:sha=` stamp move together.
- This is shipped rule text: a change to every repository at once. It adds a
  trailer; it invalidates no existing behaviour, and no standing ADR settles
  the message format, so no new record (operator ruling, 2026-10-31: a
  technical update does not need a record).

**Accept.** Rule text, generated region, and a `slice finish` commit all carry
the trailer; focused tests green.

## H2 — Shims under `.simt/hooks`

**Goal.** One `simt` folder per repository: shims live in `.simt/hooks/`,
`core.hooksPath` points there, and the legacy directory removes itself.

**Design.**

- `src/hooks/shim.mjs:40`: `HOOKS_DIR = '.simt/hooks'`. Everything else —
  `fileFor`, the agent-hook shim (`AGENT_HOOK_SHIM`), `core.hooksPath`
  writes, `hooks status` expectations — derives from the constant.
- `src/commands/hooks.mjs` `applyHooksInstall`: after the routing update, if
  the legacy `.simt-hooks/` exists and every file in it carries a simt-dev
  marker (`SHIM_MARKER` or `CHAIN_MARKER`), remove the directory, journaled.
  A file without a marker leaves the directory in place, untouched. This is
  what makes the move self-healing in the fourteen repositories that already
  carry `.simt-hooks/`.
- ADR-122 records the move (the location is what the tool believes — where
  git reads its hooks in every repository). It does not supersede a record:
  no standing ADR settles the directory's location; ADR-056 measures it,
  ADR-018 governs routing, and both keep their rulings intact.
- `README.md` and `CHANGELOG.md` name the directory; update both.
- This checkout migrates in place: `simt hooks install --yes` re-renders the
  shims at the new path, repoints `core.hooksPath`, and removes
  `.simt-hooks/` (including the harness `agent-hook` shim, which the
  `agent-hooks` installer re-writes at the new path).

**Accept.** `node --test test/hooks.test.mjs test/agenthooks.test.mjs` green,
full suite green, `hooks status` clean in this checkout, one `simt` folder
left on disk.

## H3 — Journal legacy migration

**Goal.** A repository whose journal predates the Q19 move keeps its history
reachable: the next write moves the legacy sets into `.simt/local/journal`.

**Design.**

- `src/journal.mjs` `commitJournal`: before writing the new set, if
  `.simt/local/journal` is absent-or-being-created and `.simt/journal` holds
  sets, move the directory's contents into the new location. The fallback
  read in `listJournalSets` stays for the window before the first post-move
  write, matching the ledger's migrate-on-write shape (state.mjs header).
- `test/undo.test.mjs` gains the regression: a repo with legacy-only sets
  stays listable before the write and reachable after it.
- This checkout: the 35 legacy sets move into `.simt/local/journal` and
  `simt undo` reaches them again.

**Accept.** `node --test test/undo.test.mjs` green; `listJournalSets` in this
checkout returns 157 sets; `.simt/journal` empty.
