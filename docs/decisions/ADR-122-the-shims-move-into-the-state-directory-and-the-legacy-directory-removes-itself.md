---
simt-affects: ["src/hooks/shim.mjs", "src/commands/hooks.mjs", "src/journal.mjs", "src/agenthooks/shim.mjs", "test/hooks.test.mjs", "test/agenthooks.test.mjs"]
simt-supersedes: []
---

# ADR-122 — the shims move into the state directory, and the legacy directory removes itself

Status: **accepted** · 2026-10-31

## Context

The git shims live in a top-level `.simt-hooks/` directory, and `core.hooksPath` points
git at it. Every other piece of per-repo state — the journal, the ledger, the evidence,
the index — lives under the state directory `.simt/`, which the repository ignores as a
single line. The top-level split has no technical reason: `core.hooksPath` accepts any
path, and nothing about the shims requires a location of its own. It does have a cost —
two roots for what is one body of state, and an ignore line that exists only for the
shims.

The move has one genuine collision. The journal's stated boundary is that nothing under
the state directory is journaled: the journal recording itself is recursion, and the
ledger, index and candidates are evidence and caches whose byte-shape must not be
rolled back. Review 0003 Q22 ruled the opposite for the shims: `undo` restores
`core.hooksPath` and the shims together, because a routing restored without its shims is
a hook that no longer runs. Shims that land under the state directory unjournaled would
recreate Q22 exactly — the undo restores the routing and the shims stay. The move is
therefore not a rename; it is a rename plus a named exception to a recorded boundary.

Repositories installed before the move carry the legacy directory. The move must be
self-healing in those repositories, and the cleanup must obey the rule that already
governs the hooks directory: a file this tool cannot recognise as its own is never
deleted on its way.

## Ruling

### 1. The shims live in the state directory, and everything derives from one constant

`HOOKS_DIR` is `.simt/hooks`. The shim file names (`fileFor`), the agent-hook shim
(`.simt/hooks/agent-hook`), the `core.hooksPath` value a write installs, the hooks
status, and the agent-hooks `rm` policy all derive from that one constant, so the
location has exactly one home. The preceding location is `HOOKS_DIR_LEGACY`
(`.simt-hooks`), named because it is read during cleanup and cited in the plan.

### 2. The legacy directory removes itself on install, judged in the plan

On `hooks install` (and `doctor --fix`, which shares the plan), a present legacy
directory is scanned and judged removable in the plan: every entry in it must be a
regular file carrying a simt-dev marker — the shim marker or the chain marker. Removable
means the plan announces the removal and the apply removes each file journaled and then
takes the directory down, so `undo` re-creates the files and their directory. A single
entry the tool cannot recognise as its own — a foreign file, or anything that is not a
regular file — leaves the directory in place, unannounced and untouched. The judgment
lives in the plan and the deletion in the apply, so preview and apply agree by
construction, the way every other write in this command does.

### 3. The shim directory is the one named exception to the unjournaled state directory

`journaledWriteFile` and `journaledRemoveFile` record writes under the state directory
only when the path is the shim directory. The exception is named, not broadened: the
recursion and evidence arguments for the rest of the directory are untouched, and the
module header states the exception alongside the rule. Without it, `undo` after an
install restores `core.hooksPath` to unset and leaves the shims behind — the Q22
defect, relocated.

## Consequences

- `src/hooks/shim.mjs` exports both constants; `src/commands/hooks.mjs` gains
  `legacyHooksScan` (the plan-side judgment) and the apply-side removal; `doctor --fix`
  inherits both through the shared plan.
- `src/journal.mjs` imports the shim location from `src/hooks/shim.mjs` — the
  dependency direction is the journal learning one named path, not the location module
  learning about the journal.
- The repository's ignore file drops the `.simt-hooks/` line: the state directory line
  already covers the shims.
- A repository installed before the move self-heals on its next `hooks install --yes`:
  the routing re-points, the new shims land, and the legacy directory is gone — journaled,
  so an `undo` brings it back.
- `src/toolwords.mjs` keeps `simt-hooks` as a tool word: the legacy name is still a
  reference to the tool in remedies and history, and the estate pattern that exempts it
  is unchanged.
- The agent-hook shim is re-rendered at its new location by the agent-hooks installer,
  which reads the same constant.

## Rejected

- **Leaving the shims at the top level.** The split buys nothing and costs an ignore
  line, a second state root, and a location that the state-directory story does not
  explain.
- **Removing the legacy directory without the marker check.** A file a person put there
  is not the tool's to delete, and the hooks directory already carries exactly this rule
  for its own files; the cleanup is the same principle applied to the directory.
- **Journaled everything under the state directory.** The recursion and evidence
  arguments are load-bearing for the ledger and the index; the exception must be the one
  directory git's routing points at, and no wider.
