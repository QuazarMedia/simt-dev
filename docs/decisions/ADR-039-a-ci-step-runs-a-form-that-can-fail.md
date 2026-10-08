# ADR-039 — A gate a CI step runs must have a form that can fail, and a refusal is a failure

Status: **accepted** · 2026-10-08 · affects `ci`, its own workflow copy, and any command a workflow runs

## Context

Review 0002's S23 found three things about `simt-dev ci` and the step this repository's own
workflow runs. All three reproduced against the shipped binary, and the first is the reason
this record exists.

**The own gate's own copy is checked by a step that cannot fail.** `.github/workflows/simt-dev-check.yml`
carries a step named "the gate copy in this repo is current", with the comment *"the drift
this exception exists to prevent, checked where it would be caught"*, running
`node bin/simt-dev.mjs ci`. With a hand edit appended to the copy, `ci` printed:

```
file      .github/workflows/simt-dev-check.yml
action    refresh
why       this repository is simt-dev's own, and the gate template has changed since this copy was written
```

and exited **0**. The step read the drift it was written to catch, printed it, and passed.
That is the shape this repository's own rules keep warning about — a control that appears to
hold and does not — except that here the control was the one enforcing the control.

**`ci --json --dry-run` printed nothing.** The JSON branch was guarded by
`flags.yes !== true && flags.dryRun !== true`, so the one combination a script reaches for
was the one combination with no document on stdout at all.

**A refusal reported success.** Run in a repository that adopted simt-dev, `ci` explains at
length that the `.github` file is the repository's own, names `simt-dev init --yes` as the
remedy, and then emits `{"ok": true, …, "own": false}` and exits **0**. A caller reading `ok`
is told the request succeeded, one line above a paragraph saying it was refused.

## Ruling

**1. A command whose output a CI step consumes has a form that can fail, and that form is
what the step runs.** Previewing by default is right for a human at a terminal and wrong for
a gate: a step has no reader to hand the plan to. `ci --check` exists for that and never
writes, whatever else it is given — a check that repairs is a second writer, which ADR-036
is about.

**2. A check that names drift shows the drift.** `--check` prints a unified diff of both
files. The reader is the author of the template change that made the copy stale, and the
question they have is "what did I change". The plan now carries both sides of the
comparison — `source: { text, desired }` — so the verdict and the diff cannot disagree, and
those two bodies are stripped from the JSON payload, because a document is not the place
for two copies of a workflow file.

**3. A refusal is `EXIT.UNSUPPORTED` with `ok: false`.** Not because nothing is wrong, but
because the request cannot be satisfied *in this repository*, which is what the code is
documented to mean (`output/index.mjs:16`). The prior behaviour also contradicted ADR-035
directly: it emitted `ok: true` and exited 0 while the text beside it said the opposite, and
ADR-035 requires the two to agree. This is the first place in the tool where they
disagreed by design rather than by oversight.

**4. `--json` emits one document in every mode, and `ok` agrees with the exit code.** The
mode guard was the bug; the invariant is ADR-035's. The test walks the modes rather than
trusting the guard.

## Consequences

`test/ci.test.mjs` gains a `run()` helper that reports the exit code instead of rejecting.
`promisify(execFile)` rejects on non-zero, which is right for a helper asserting success and
useless for every test about a command that must fail — and the code a refusal test needs to
check is the code inside the rejection.

The existing refusal test asserted exit 0 and carried the reasoning *"the refusal must not
be an error, because nothing is wrong"*. That reasoning is this record's third ruling
overturned, so the comment now says why the opposite holds.

The `--check` and `--json` tests run **in this repository on a stale copy**, with a `finally`
that restores the file, because `isOwnRepo` compares against the package root and no temp
repo can reach this code. The first version of the JSON test used a fixture and passed with
the guard restored: the fixture was not the own repository, so every mode took the refusal
path and printed a perfectly good document — for the wrong reason. A mutation found it.

Four mutations were applied and reverted, each caught by its own test: `--check` returning
`EXIT.OK`, the refusal returning `EXIT.OK`, the mode guard restored, and the workflow
template reverted to the bare `ci`.

## Rejected

- **Leave the own gate's step running `ci` and rely on the reader.** The reader is a person
  who did not make the template change and will not know that the step passed. A gate whose
  failure is visible only to someone reading logs is a note.
- **Make `ci` itself exit non-zero on drift, without a `--check`.** That is what the review
  asked for and it would break ADR-036: previewing by default is the rule every writer
  follows, and one writer that reports drift is the exception nobody remembers.
- **Keep the refusal at exit 0 and change only `ok` to false.** Two answers to one question
  is the defect ADR-035 exists to prevent, and the more surprising half of the two: the
  shell reads the code, and it was reading success.
- **Exit `EXIT.FAIL` (1) for the refusal.** It is not a gate that failed; nothing ran. `1`
  means "a gate failed: drift, policy violation, missing evidence", and a caller deciding
  whether to re-run on `1` would retry a request that can never succeed in this repository.
- **Ship the diff as a dependency rather than writing it.** ADR-012 rules the dependency, and
  the diff here has one reader and one shape: two whole files this tool wrote, differing by
  lines. A line-level LCS table is a screen and a risk, not a dependency.
- **Print the whole file rather than eliding context.** The output is the only reason the
  step is worth having over a bare exit code, and fifty lines of context around one changed
  step buries it.