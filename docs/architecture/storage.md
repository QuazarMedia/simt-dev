# Storage

Two kinds of file, and the difference matters: content a repository owns, and caches that
`git ls-files` can rebuild.

## Repository content

`AGENTS.md`, `simt.json`, `simt.lock.json`, the per-surface rule files, `.editorconfig` and
`.gitattributes` (for a repository that carries them), `.simt/hooks/`, `docs/decisions/`,
`docs/lessons/` and `docs/commands/`. A region inside a file is generated; the text around it
is not, and a regeneration does not revert it.

## Caches, in `.simt/`

| Path | Shape |
| --- | --- |
| `index.sqlite` | one format: `node:sqlite` with FTS5 (`unicode61 remove_diacritics 2` for text, `trigram` for CJK), keyed by git blob sha. A Node below 22.20.0 is refused by name |
| `ledger.jsonl` | one line per gate or test that actually ran, against one tree |
| `lessons.jsonl` | lesson candidates from fail-to-fix pairs, reverts, `BLOCK` reviews, hook denials |
| `events.jsonl` | agent-hook decisions and their reasons |
| `bench/` | mined tasks, the test-patch vault, and runs |
| `proposals/` | non-authoritative skill-description proposals, with provenance |
| `journal/` | the undo journal: one entry per journaled write, grouped by commit |
| `state/` | identity, leases, check snapshots, worktrees |

Every cache is gitignored by `simt init`. Nothing in `.simt/` is authoritative: deleting it
costs a reindex, never a decision.

## One format, one sidecar rule

The index is written by this version at `.simt/index.sqlite`. A database written by a *newer*
version is never opened for write: this version builds its own sidecar (`.simt/index.v5.sqlite`
style, named by schema version) and reads that, so two pinned versions cannot rewrite one file
past each other (ADR-059). An older database is migrated in place, through the ordered
schema steps.
