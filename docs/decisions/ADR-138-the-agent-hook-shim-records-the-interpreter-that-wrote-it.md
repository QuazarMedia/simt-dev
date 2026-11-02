---
simt-affects: ["src/locate.mjs", "src/agenthooks/shim.mjs", "src/commands/agenthook.mjs", "test/agenthooks.test.mjs"]
simt-supersedes: []
---
# ADR-138 — the agent-hook shim records the interpreter that wrote it

Status: accepted · 2026-11-02

## Context

One adopting repository had hooks installed by this tool and Cursor stopped working: every
shell command and every edit was refused. Two defects stacked.

The first was an install from before the shim existed. Every surface in that repository named
the bare `simt` binary, and no harness shares an interactive shell's PATH — `simt` lives in a
node version manager's global bin, which a window-server launched application does not read.
Claude degrades silently in that case (a non-2 exit is no enforcement); Cursor's entry is
written with `failClosed: true`, so a command that resolves to nothing blocks the tool call.
A guard that cannot start is indistinguishable, to the person using the editor, from a guard
that denies everything.

The second defect survived fixing the first. The shim the install writes looks for the
dispatcher in four places: `$SIMT_DEV_BIN`, `node_modules/simt-dev`, `.simt/bin/simt`, and
`simt` on PATH. All four depend on the same thing the harness does not give it. Measured on
this machine, in a repository with no local dependency: with the normal PATH the shim answers
a Cursor payload and exits 0; with `PATH=/usr/bin:/bin` it exits 1 and prints
`cannot locate the agent hook`. `failClosed` turns that into the same refusal as before,
one layer deeper.

## Rulings

1. **The shim gains a fifth locator, and it is the one PATH cannot take away: the interpreter
   and entry point that installed it**, as absolute paths, emitted after the four above and
   before the refusal. `.simt/` is gitignored in every adopting repository, so these are local
   bytes rather than a committed path that would be wrong on the next machine.

2. **`agent-hooks install` records that pair** from `process.argv[1]` and `process.execPath`
   when the entry point is an absolute `.mjs`. A packaged or SEA binary records nothing: it is
   found on PATH or not at all, and a path to a build that no longer exists is worse than none.

3. **The block is an option on `renderLocator`, not a second locator.** `beforeGivingUp` is
   spliced between the PATH search and the refusal, so the shim and the CI workflow keep one
   resolution order (ADR-062) and the workflow passes nothing.

4. **The regression is measured where it broke.** A test installs into a scratch repository and
   runs the shim with `PATH=/usr/bin:/bin` and no `node`, feeding a Cursor `preToolUse`
   payload; it fails on `cannot locate the agent hook`, which is the reported symptom rather
   than a proxy for it.

## Consequences

- Every existing install gets the new locator on its next `simt agent-hooks install --yes`,
  and the shim's `UNCHANGED` second run still holds: the pair is derived from the same install.
- A checkout that moves leaves the recorded pair stale, and the shim then falls through to the
  refusal and its remedy — which names the reinstall command. That is the same failure a
  missing install always had, and the message is the same one that explains it.
- The pair is machine-specific and the file is not: a repository ignores `.simt/`, and this
  record is the reason that must stay true.

## Rejected

- **Widen PATH in the hook entry.** A harness runs the command it is given; it does not source
  a shell profile, and a `PATH=… ./shim` wrapper in a JSON config is the same guess as the
  bare binary with more characters.
- **Copy the binary into `.simt/bin/` at install time.** That directory is a release download
  (ADR-041); a source checkout has no binary to copy, and the failure being fixed is exactly
  the one that appears before anybody has downloaded anything.
- **Drop `failClosed` from the Cursor entry.** It would turn a broken hook into an absent one
  and pass every command the policy exists to refuse.
