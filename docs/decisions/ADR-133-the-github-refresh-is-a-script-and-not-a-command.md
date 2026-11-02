---
simt-affects: [".github/dependabot.yml", ".github/workflows/simt-dev-check.yml", "README.md", "scripts/ci.mjs", "src/ci/dependabot.mjs", "src/ci/workflow.mjs", "src/commands/help.mjs", "src/commands/index.mjs", "src/commands/init.mjs", "src/commands/spec.mjs", "src/projection/project.mjs", "test/ci.test.mjs", "test/contract.test.mjs", "test/naming.test.mjs"]
simt-supersedes: []
---
# ADR-133 — the .github refresh is a script and not a command

Status: accepted · 2026-11-02

## Context

`simt ci` (309 lines, plus a `refresh` finding in `project.mjs` reachable only from this
checkout) does one thing: it keeps simt-dev's own `.github/workflows/simt-dev-check.yml`
and `.github/dependabot.yml` equal to the templates in `src/ci/`. It refuses in every other
repository, because there the file is the repository's own and `init` writes it once
(ADR-023, ADR-024, ADR-026).

That makes it the only command on the surface that cannot do anything for an adopter. A
reader of `simt --help` in any other repository sees a word that answers, when typed,
"this file belongs to your repository" — and pays for the loader, the spec row, the help
line, the MCP list and the contract fixture that every shipped command carries. Review
0003 Q84 measured it as "maintains simt-dev's own `.github`; refuses everywhere else" and
recommended moving it to `scripts/`, out of `files`.

## Rulings

1. **The refresh is a script, and only the renderers ship.** `scripts/ci.mjs` is the
   writer; `src/ci/workflow.mjs` and `src/ci/dependabot.mjs` stay in the package because
   `init` renders the same bytes once for a repository that adopts simt-dev. A script is
   not in `files`, so the writer leaves the package while the data it renders does not.

2. **A remedy names an invocable thing.** Every string that told a reader to run `simt ci`
   now says `node scripts/ci.mjs --yes` — including `check`'s `DRIFT` remedy for this
   repository's own copies and the two `init` plan lines. A remedy naming a retired
   spelling is the same defect as the remedies that named `simt sync` before it existed
   (ADR-030): the reader types it and gets `unknown command`.

3. **The own gate runs the form that can fail.** `node scripts/ci.mjs --check` exits `1` on
   a stale copy; the previous step ran the preview, which printed the drift it existed to
   catch and exited `0`. A check whose exit code is always zero is decoration.

## Consequences

- `simt ci` is not a command: no spec row, no dispatch entry, no help line, no MCP tool,
  no contract fixture, no `naming` verb.
- The behaviour is unchanged for this repository: same two files, same plans, same
  journaled write through `applyPlan`, same `--check`/`--diff`/`--json` surface, now
  parsed by the script itself instead of by the command dispatcher.
- `test/ci.test.mjs` spawns the script where it used to spawn the binary, so the checks it
  asserts are the checks the workflow step runs.
- An adopter sees no difference at all; that is the point.

## Rejected

- **Keep it as a hidden command.** A hidden row still ships, still loads, still appears in
  `help --all` and the JSON spec, and still has to be explained by every test that
  enumerates commands. Hiding a writer is not the same as not shipping it.
- **Fold it into `init`.** `init` adopting simt-dev's own repository would pin this
  repository's SHA into its own AGENTS.md, which is the reason it is not self-adopted.
  The refresh exists precisely because that path cannot run here.
- **Keep the command for the `refresh` finding.** `check` already compares this
  repository's copies because their plans are content-compared there and nowhere else;
  the finding is a property of the plan, not of a shipped command.
