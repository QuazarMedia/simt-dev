# ADR-035 — One place decides whether a run may write, and one document says whether it did

Status: **accepted** · 2026-10-08 · affects every command that writes or reports

## Context

Review 0001's S10 tabulated eight inconsistencies in the `--yes` / `--dry-run` / `--json`
contract across six commands. Each was measured against the shipped binary before anything
was changed, and the table did not survive intact: **six were real, one was partly wrong, one
was inverted, and one defect the table missed turned up during the fix.**

The six, all reproduced:

- `upgrade --yes --dry-run` **wrote**. `upgrade.mjs` tested `flags.yes === true` and never
  consulted `flags.dryRun`, so the one flag that says "do not write" was not read on the one
  path that moves pins across every adopted repo.
- `skills install --yes --json` **never wrote**. An early `if (isJson(flags)) { emit(plan);
  return }` returned before the write — the exact combination a script uses.
- `skills install --yes` printed `note dry-run nothing written` and *then* wrote, because the
  note was emitted unconditionally.
- `skills install` read **neither** write flag. `grep -rn "dryRun"` over the file returned
  nothing.
- `doctor --json` exited **0** where the same command in a terminal exited **3** on an
  unparseable workspace config, and omitted the workspace answer entirely: its `isJson`
  branch returned *before* the `ws.error` check with `ok` hardcoded `true`.
- `hooks status --json` wrote `ok: true` and exited **0** while text mode exited **1** with
  four problems listed.

The one the table got backwards: it claimed `sync` and `init` emit JSON errors while `hooks`,
`skills` and `rules` emit only stderr text. Forcing genuine error paths showed `sync --json`
emits a JSON error correctly. The actual error-path lie was the `doctor` row above.

`init --json` looked like the same defect and is not one. `grep -rn "resolveWorkspace"
src/commands/` shows `init` never consults the workspace at all, and both modes agree — exit
`0`, `ok: true`, and no workspace line in text either. Two modes answering one question two
different ways is the defect; when neither asks the question there is nothing to disagree
about. Making `init` fail on a corrupt workspace config would be a new decision, not this one.

## Ruling

**1. Whether a run may write is decided in exactly one function.**
`writeMode(flags)` in `src/output/index.mjs` returns `{ dryRun, apply }` with
`apply = flags.yes === true && !dryRun`, and every mutating command reads it. A command that
consults `flags.yes` directly is a defect whether or not its arithmetic happens to agree
today, because the third copy is the one that will not.

**2. `dryRun` is reported separately from `apply`.** A run that was not authorised is a dry
run in effect even when nobody asked for one, and the JSON payload's `dryRun` says so.

**3. Under `--json`, stdout is exactly one JSON document, and its `ok` agrees with the exit
code.** A caller reads `ok`; a shell reads the exit code. If they disagree, one is a lie and
the caller cannot tell which, so the invariant is checked across the whole command surface
rather than per command.

**4. A non-zero exit under `--json` carries `error` and `remedy` in that same document.**
`ok: false` alone says it failed without saying what to do, and ADR-010 requires the remedy.
`doctor --json` also carries `workspace`, because the text path prints the workspace answer
and a JSON document that omits it answers a different question than the terminal does
(ADR-014).

**5. A caveat is a field, not prose on stdout.** `skills brief` with no task and no staged
files warns rather than silently answering; under `--json` that warning is a `warning` field
in the one document, and `--all` carries it too. `ok` stays `true` — the command did what was
asked, and it is the *answer* that is weak.

**6. Every command that reports honours `--json`, including the ones the review did not
name.** `skills why` built its output as lines and had no `isJson` branch at all, so
`skills why <skill> --json` printed prose. Its `gate` is a field rather than a sentence
because a skill that can never be selected in this repo is a decision, not a line of output.

## Consequences

`test/contract.test.mjs` is a new file because neither contract belongs to one command: a
test that runs `doctor` and a test that runs `skills install` would each assert their own
command and miss the other. It drives the shipped binary rather than calling functions,
because a flag the dispatcher never routes is invisible to a direct unit test — which is how
`--dry-run` reached `skills install` unreached while every unit test passed. Nineteen
commands are asserted to emit one parseable document whose `ok` matches the exit code; two
mutating commands are asserted to leave the filesystem byte-identical without `--yes` and
under `--dry-run`; and one test asserts an authorised, non-rehearsal run **does** write, so
"refuse everything" cannot pass.

Two of those tests were themselves broken when first written, and both were found only
because a mutation failed to fail them. One watched a path that nothing writes to, and in
doing so **self-adopted simt-dev**: `skills install` reads `flags.root ?? process.cwd()`, the
row passed the fixture root positionally to a subcommand that takes no positional, and the
install landed in this checkout, leaving an untracked `.agents/` and `simt-dev.json`. The
other asserted a fixture was a clean repo when it was not — `init` writes `simt-dev.json`
without staging it, so `dirtyPaths` was never empty and the no-input branch was never
reached. Both are the shape of harm ADR-031 exists to prevent, arrived at from the other
direction. The fixture now commits what `init` wrote and asserts the tree is clean, passes
`--root` to every command, and asserts the root is under the temp directory.

Six mutations were applied and reverted, each caught by its own test: `upgrade` and
`skills install` back to reading `flags.yes` alone, `hooks` and `doctor` back to a hardcoded
`ok: true`, and the `isJson` guard removed from the `skills brief` no-input branch and from
`skills why`. The `sync --yes` requirement is **not** part of this record; it is review 0002's
S24 and stays queued, because `sync` already honours `--dry-run` and what it lacks is the
authorisation gate, which is a separate decision.

## Rejected

- **Make `sync` require `--yes` as part of this record.** It is a real inconsistency and it is
  someone else's slice. S24 names S10 as its dependency, which is what makes S10 the
  prerequisite rather than half of it.
- **Keep a per-command `ok` field and rely on reviewers to notice disagreements.** The
  disagreement is the defect. It has to be checked where it is introduced, which is a table
  over the surface, not a discipline applied to each command in turn.
- **Add an `--json` mode to `skills why` by routing it through the text renderer and parsing
  the result back.** Printing prose and parsing it is how the no-input path went wrong: the
  warning was in the output shape and the document was nowhere.
- **Treat a missing `workspace` in `doctor --json` as cosmetic.** The text path prints the
  workspace answer; a JSON document that omits it is a second, quieter answer to the same
  question, and the caller has no way to know one of them is missing.
- **Record the review's table as the defect list.** Two of its eight rows did not survive
  measurement — one was backwards and one was not reproducible — and one real defect
  (`skills why --json`) was absent from it. A table of claimed defects is not a list of the
  actual ones, and writing one down as if it were is how the `skills why` gap survived.
</content>