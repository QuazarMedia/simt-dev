---
simt-id: core
simt-title: Shared rules
simt-applies: always
simt-priority: hard
---

# Shared rules

Where a rule cites a decision, run `simt-dev rules why ADR-NNN` to read it,
including whether it is still in force.

These rules are stack-agnostic. Whatever is specific to your stack, your product or your
commands belongs in this repository, not here.

## Truth

- Never claim a test you did not run, a check you did not execute, or a deploy you did not
  perform.
- Read the real runner manifest before running anything. A command absent from it is not a
  command. (Which file that is depends on the stack: `package.json` scripts, Gradle tasks,
  `pyproject.toml` entry points.)
- Report what you left alone: unrelated dirty files, skipped checks, unreviewed scope.

## Git

- Commit locally, report the SHA. **Push only on explicit approval.** (ADR-001)
- Before asking for push approval, state whether the push triggers a deployment, a migration
  or any remote mutation.
- Never use `--no-verify`, amend, rebase, reset or rewrite history unless explicitly asked.
- Never commit failing, partial, secret-bearing or unrelated work.

## Refactoring

- Outside the current change's blast radius, do not refactor. (ADR-002)
- Inside it, a second real use extracts, and the extraction is finished: no orphaned imports,
  exports, styles, messages or files remain.
- A third copy of the same logic is a defect. So is an abstraction invented for one caller.

## Validation

- Focused tests are the default gate. A full suite runs only against a named trigger: phase
  exit, release gate, cross-system behaviour, a repo-declared numeric gate, explicit
  instruction, or pre-push on a declared protected branch. (ADR-003)
- Name the exact commands and test files. Partial pass is a blocker; `6/8 pass` is the
  canonical example of a blocked state. Never justify a skip without a pre-existing written
  reason. (ADR-006)
- Evidence discipline is mandatory everywhere. A **numeric** bar is declared per repo in
  `simt-dev.json`, never assumed centrally. (ADR-006)
- The pre-commit hook owns format and lint for staged files; do not re-run what it just ran.
  Manual runs are correct when the hook is absent, when diagnosing a failure, or for a check
  the hook does not cover. (ADR-004)
- Declare a gate only if this repository can run it — a script that exists, a tool that is
  installed, a command you name. A gate that cannot run blocks every commit until someone
  reaches for `--no-verify`. (ADR-017)
- Invoke tools through the repository's own runner — `npm run`, `uv run -m`, `./gradlew` —
  never a package runner like `npx` or a bare console entrypoint. (ADR-010)

## Code and review

- No type-system escapes, no unawaited async work, no debug printing in application code.
- 400 lines is a review trigger; 1000 lines is a hard ceiling. Generated files are exempt
  when the hook names the generator. (ADR-005)
- Never weaken CSP, CORS, auth, audit, cache or validation controls to silence a test, warning
  or alert.
- Review verdicts are exactly three: `BLOCK`, `APPROVE WITH RESIDUAL RISK` (must list what was
  not reviewed), `APPROVE`. (ADR-008)
- Accessibility, correctness, privacy and security are hard gates, not subjective tradeoffs.
- Never direct two agents to edit the same files concurrently. Select the minimum viable team.
- Every agent works to a stated budget and stops at a concrete blocker rather than drifting.
  Approval by budget never converts a known failure into an approval.

## Scope of these rules

Product policy, stack-specific rule bodies, repo commands and paths stay in the repo. A rule
here states only what holds everywhere; the moment one repository needs an exception, it is that
repository's rule, not a widening of this one.