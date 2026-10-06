# ADR-023 — The gate ships as a file the repo owns

Status: accepted · 2026-10-08
**Affects:** `src/ci/workflow.mjs`, `src/locate.mjs`, `src/hooks/shim.mjs`, `src/commands/init.mjs`, `src/projection/project.mjs`, `test/ci.test.mjs`, `test/leaks.mjs`. Settles plan 1 §6 phase 3 ("Reusable workflow live").

## Context

`simt-dev check` is the whole gate: projection drift, an unreadable rule, an unrunnable
gate, a stale manifest. `init` installs it as a `pre-commit` hook, which means it runs on
the machine of whoever remembers to run it, and a hook is a developer's machine. Every
review is somebody else's, and every merge is a machine nobody gated.

The plan called this "a reusable workflow", and named
`QuazarMedia/simt-dev/.github/workflows/sync-check.yml` as a file "referenced by every
consumer". Nothing in this repository had a `.github/` at all. There were three ways to
close the gap, and they differ in who the resulting file belongs to:

- **`uses:` a reusable workflow.** One file, changed centrally, no copying. Every consumer
  references a path inside a repository its team has no access to, cannot diff in review,
  and cannot edit. The gate's own behaviour becomes a function of someone else's push, and
  a red build becomes something the reader cannot diagnose from what they have.
- **Copy the bytes in.** Each repo gets a file it can read, edit, argue with and delete.
  Improving the template does not reach repos that already have it.
- **Run the tool from the consumer's CI, configured by them.** No shipped file at all,
  which means every repo writes the same three lines and none of them are checked.

This repository has one rule that settles it: **every byte that leaves this repository
must be readable and actionable by someone who has only the receiving repository.** A
`uses:` line points at bytes the reader does not have. That is not a style preference; it
is the failure this tool exists to stop having shipped, and it has shipped — the projected
rules once told readers to edit a source tree they did not have.

## Rulings

1. **The gate ships as copied bytes, written into `.github/workflows/simt-dev-check.yml`.**
   A `uses:` reference is ruled out by the rule above. The file is fully readable in the
   pull request that adopts it, which is the only review it ever gets.

2. **It is written once and never rewritten.** From creation the file belongs to the repo:
   their extra jobs, their triggers, their matrix. Overwriting it would delete work this
   tool has no way to know about, which is the same defect as replacing a hand-written
   `.mdc` body (ADR-016). `planWorkflow` reports an existing file as `unchanged` and never
   reads its contents for comparison.

   **The cost, stated rather than discovered later:** a template improvement does not
   reach an adopted repo. There is no marker, no managed region, no way for `upgrade` to
   tell their edit from ours. A repo that wants the newer template takes the diff by hand.
   This is a deliberate trade, and ruling 4 is what keeps it cheap.

3. **The gate only appears where GitHub Actions already runs.** `.github/workflows/` must
   exist as a directory. Creating it silently would start running jobs on pull requests the
   team did not ask for, which is the mirror image of the defect: a tool making a
   decision for someone and reporting success. `init` prints `skip` with the reason and
   the way out — "create `.github/workflows/` first if this repo is on GitHub Actions,
   then rerun init" — so a skip is a decision they can reverse rather than an absence they
   discover from a failing build.

4. **`check` reports the absence; it never inspects a file's contents.** An Actions repo
   with no simt-dev workflow is a blocking `absent` finding with the remedy
   `simt-dev init --yes`. A workflow that exists is never diffed, never opened, never
   counted. A gate that inspects a file it also owns would report its own drift forever,
   and the reader's only fix would be to re-run `init` — the "permanently red check
   nothing can fix" failure the code comments fear elsewhere. Their file, their content.

5. **The binary resolution is one function, shared with the hook.** The hook shim already
   resolved the dispatcher through `$SIMT_DEV_BIN` → `node_modules` → `PATH` → refuse. That
   block moved to `src/locate.mjs` so the workflow could take it rather than re-spell it.
   Two copies diverge the first time one is fixed, and the symptom is the worst available:
   a gate that passes on a laptop and cannot start in CI.

6. **A job that cannot find the tool fails.** Every resolution chain ends in a refusal with
   a non-zero exit, and the file says so in its own header. A green tick from a check that
   never ran is the one outcome worse than a red one.

## Consequences

- `init` writes one more file, so one more line in its plan. Every file `init` creates is
  named in the plan it prints: a file the reader was not shown is a file they approve by
  reading the diff afterwards, which is the one review step this tool exists to make
  unnecessary.
- The rendered bytes are subject to the same leak check as rule bodies, now shared as
  `test/leaks.mjs`. This is the first thing simt-dev ships that a human has to *read and
  argue with* in a review rather than merely receive, so the guard is a requirement and not
  a courtesy.
- The workflow's `run:` body is checked with `sh -n`. A shell syntax error inside a YAML
  block scalar is otherwise found on the adopting repo's first pull request, in public.
- A repo with no `.github/` sees no change at all: no finding, no file, no directory.
- The template is not a managed region and this record does not pretend otherwise. If a
  future release changes what the gate does, existing repos keep what they have.

## Rejected

- **`uses: QuazarMedia/simt-dev/.github/workflows/sync-check.yml@main`.** Rejected under
  ruling 1: it is the plan's own suggestion, and it points every reader at bytes they do
  not have. Worth recording that the plan wrote it, because the next person to read §6
  will find it there.
- **Maintain it as a marker-managed region, refreshed by `upgrade`.** Rejected: it needs a
  merge strategy for a repo that added their own job, which is the problem ruling 2
  declines to take on. A refreshed file that overwrites a deployment job is worse than a
  stale one.
- **Create `.github/workflows/` when it is missing.** Rejected under ruling 3.
- **Ship a reusable workflow *and* copy it.** Rejected: two sources for one gate, and the
  copy is the one nobody reads.