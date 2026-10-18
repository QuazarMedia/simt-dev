# ADR-094 — a change runs the tests that import it

Status: **accepted** · 2026-10-18 · filed as R16 (plan 0003)

**Affects:** `src/index/gate.mjs`, `src/commands/gate.mjs`, `test/gate.test.mjs`

## Context

A gate that always runs the whole suite teaches people to skip it. The tests
that can see a change are the ones that import it, including through another
file. A name that looks like a test, and a commit that also touched a test,
are different facts. They are already answered by `simt tests`.

The pre-commit hook, the stop hook and an agent call this command. They do
not need the dispatcher rewritten to do it.

## Rulings

1. **Selection is the import closure.** A test file is selected when an import
   reaches a changed file, at any depth. A changed file that is itself a test
   is selected. A cycle is walked once. A conventional neighbour and a shared
   commit are not imports, so they are not a selection. A file the test-path
   rule already treats as a test counts, including a helper that lives beside
   the tests and imports the change.
2. **The command is `simt gate`.** Paths name the change. `--changed` reads
   the diff, staged, unstaged and untracked. No path and no `--changed` is a
   usage error. A clean diff selects nothing and runs nothing. A repository
   that is not git is unsupported.
3. **The run is the package's own runner, and only the selected files.** Tests
   are grouped by the package that contains them. The runner is the one that
   package already declares. A package with no runner is unsupported. The
   child's test-runner environment is cleared, so a parent test process cannot
   take the child's result and report a pass.
4. **The hand list for the plan's named file is 51 files, and the selection
   finished in under 5 seconds.** Eight other test files do not import it, and
   they are not selected. The set is wide because the shared fixture imports
   the loader that imports that file. Measured at about 40 ms.

## Consequences

`simt tests` still answers "which tests exercise this file", including a
conventional name and, when asked, a shared commit. `simt gate` answers "run
the tests this change can reach". Compaction of the runner's text is a later
slice. The dispatcher is unchanged.
