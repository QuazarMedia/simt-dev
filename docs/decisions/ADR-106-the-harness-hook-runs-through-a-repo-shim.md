---
simt-affects: ["src/agenthooks/shim.mjs", "src/agenthooks/render.mjs", "src/commands/agenthook.mjs"]
simt-supersedes: []
---

# ADR-106 — the harness hook runs through a repo shim, and `failClosed` only with it

Status: **accepted** · 2026-10-29

## Context

Review 0003 (Q21) verified by code-read that every harness config named the
bare `simt` binary. A devDependency install puts `simt` in
`node_modules/.bin`, not on a harness's PATH, so that entry runs nothing on
Claude — a non-2 exit is silent: no enforcement — and blocks every tool call
on Cursor, whose entry sets `failClosed: true`. The install wrote a command
that worked only on machines that happened to have the binary on PATH, which
are exactly the machines that least need the hook.

## Ruling

1. **Every harness config names the repo shim, never the binary.**
   `agent-hooks install` writes `.simt-hooks/agent-hook` beside the git shims,
   rendered with the same `renderLocator` block from `src/locate.mjs`, and
   every entry's command is `<shim> <event> --harness <id>`. The shim takes its
   arguments through (`agent-hook "$@"`), so one file serves every event and
   every harness, and `--harness` stays explicit rather than detected.
2. **`failClosed` is set only because the command is the shim.** Cursor keeps
   `failClosed: true` on entries that point at the shim. It is never set on a
   bare-PATH binary: that combination blocks every tool call on the machines
   where the binary is not installed, which is exactly the machines the shim
   exists for.
3. **A shim that cannot resolve refuses.** When no binary is reachable the shim
   exits 1 with a remedy, the way the git shims do. On Claude that is still a
   non-2 exit — silent, no enforcement — and that limitation is accepted and
   stated here rather than hidden: the shim fixes the machines where `simt`
   is installed but not on PATH, not the machines where it is absent.

## Consequences

- `ours()` recognises both spellings, so an install over a pre-shim config
  migrates the entry in place instead of stacking a second one.
- The shim is journaled with the configs, so `undo` removes or restores it
  with the run that wrote it.
- A hand-written bare-`simt` entry is the author's, not this tool's: `status`
  does not claim it, and `install` replaces it.
