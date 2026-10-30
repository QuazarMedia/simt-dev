# AGENTS.md — simt-dev

## What this repository is

simt-dev is the **source** for everything the tool projects into other repositories: the
rule bodies, the Cursor rule files, the skill registry, the gate definitions and the hook
dispatcher. It is also a consumer of itself — it adopts its own repository with `simt init`.
See "Why this repository adopts itself".

If you are working in any other SIMT repository, this file does not apply to you — read that
repository's own `AGENTS.md`, where the rules generated from this one have landed.

## The rule this repository exists to enforce

**Every byte that leaves this repository must be readable and actionable by someone who has
only the receiving repository.**

That single sentence has been violated more often than any other, and every violation shipped.
The projected rules once told readers to edit a source tree they did not have, pointed at
`docs/decisions/`, cited a command (`simt sync`) that does not exist, and named repositories
from this estate. All of it was correct for its author and useless to its reader.

Before you write or change anything that leaves this repository, check it against this list:

| Check | The failure it prevents |
| --- | --- |
| Is the instruction addressed to the **reader** of the receiving repo? | "Edit the source in simt-dev" — advice for the author, projected into a file whose own header says do not edit |
| Does every **path** resolve in the receiving repo? | `docs/decisions/` resolves here and nowhere else; the receiving repo has no such directory |
| Does every **command** exist, under the name this package ships? | `simt sync` did not exist; the binary is `simt-dev`, and 102 remedy strings were unrunnable |
| Does every **repository name** mean something outside this estate? | `simt-garmin` in the Android profile meant nothing to a reader in a different company |
| Can the reader **act** on it — command, not location? | A remedy naming a path is a second problem stacked on the first |
| Is it a **fact**, or decoration that misdescribes the artefact? | A manifest comment claimed each value cites its decision record; none did |

Two corollaries that are easy to get wrong:

- **Check the rendered output, not the source file.** A rule file reads fine and projects into
  nonsense. Render it, then read it as the receiving repository's agent would.
- **"Generic" is not "vague".** `docs/plans/` in a substitution default is *correct*: it names
  where a repo keeps its own plans and it resolves against the reader. The defect is a path
  that resolves against *this* repository, not any path that looks like one. Judge by who
  owns the path.

## Rules for changing this repository

- **A change to shipped rule text is a change to every repo at once.** `rules/core.md` is
  projected into all of them. Treat an edit there as a breaking change: state which existing
  behaviour it invalidates, and bump the ADRs that settle it rather than editing a ruling in
  place.
- **A decision gets a record.** Any change to what the tool *believes* — what a gate runs, what
  a rule requires, how a conflict is classified — is a ruling, and rulings live in
  `docs/decisions/` as a numbered record with a `Status:` line. Supersede by writing a new
  record and editing the old one's status, never by rewriting history in place.
- **Content is data; the engine is code.** A new ecosystem must arrive as a new profile file
  and, where detection cannot see it, a new `has-*` fact. If you are editing
  `src/projection/project.mjs` or `src/resolve/fingerprint.mjs` to make a *product* work, the
  design is wrong (ADR-013).
- **Determinism is a feature, not a limitation.** Resolution ranks by path, keyword, name,
  capability and stack, with no model and no network, specifically so a pull request can
  meaningfully diff the result. Do not add a heuristic that cannot be explained by a score.
- **Zero runtime dependencies, POSIX only.** `package.json` declares `"os": ["darwin","linux"]`
  and an empty dependency set. Adding either back needs a decision record (ADR-012).

## Rules for working here at all

- **Run the tool the way a consumer runs it.** A test suite that only exercises the tool from
  its own source tree cannot detect that the tool only works from its own source tree. That
  failure has happened three times: workspace resolution that only worked in the checkout,
  content lookup that only worked with a workspace, and — after both were ruled on — the suite
  itself reading skill bodies out of sibling repositories, which kept the gate red on every
  push to `main` while passing on the author's machine (ADR-031). `test/fixture.mjs` is what
  makes that structural: it stages the workspace and the git identity, and nothing in `test/`
  reaches outside the checkout. **Run the suite from a copy at a path with no siblings before
  you believe it.** That is how ADR-031 found two more tests asserting the checkout's directory
  name — which passed on every machine, for a reason that had nothing to do with the code.
- **Never claim a check you did not run.** In particular, `npm test` passing is not the same as
  the projected text being correct; for rule content, read the rendered region.
- **Do the tool's work with the tool.** When a task is one `simt-dev` performs — updating a
  tracker row, checking a region, running the gates, building a harness package — run
  `node bin/simt.mjs <command>` against the working tree instead of editing the artefact by
  hand. The command is the implementation of that task: a hand edit bypasses the writer and
  leaves the file in a shape the next run calls drift, and working on a writer without
  running it is how a fix ships unexercised.
- **Commit locally and report the SHA. Push only on explicit approval** (ADR-001). Never
  push on a user's behalf unless asked for it, and never reach for `--no-verify`.
- **Do not refactor outside the blast radius** (ADR-002). A second real use inside the change
  extracts, and the extraction is finished; a third copy of the same logic is a defect, and so
  is an abstraction invented for a single caller.
- **Never write a comment that could be deleted.** A comment earns its place by recording why
  something non-obvious is true — the failure it prevents, usually. Restating the code is not
  a reason. Most of the design decisions in `src/` exist as comments because the mistake they
  prevent has already been made at least once.

## Layout

| Path | What lives there |
| --- | --- |
| `rules/core.md` | Stack-agnostic rules, projected into every repo |
| `rules/stacks/*.md` | One profile per ecosystem, projected on detection |
| `rules/mdc/*.mdc` | Canonical Cursor rule files, projected with per-repo substitutions |
| `graph/skills.graph.json` | The skill registry: capabilities, variants, byte sizes |
| `src/projection/` | Generated-region markers, rule selection, manifest, conflict scanning |
| `src/ci/` | The two `.github` files simt-dev ships: the gate and the Dependabot config |
| `src/tsconfig.mjs` | The TypeScript base file, its floor, and the checks it cannot replace |
| `src/toolchain.mjs` | The node, package-manager and `.nvmrc` pins, and the agreement between them |
| `src/hooks/` | Gate definitions, the POSIX shim generator, the dispatcher |
| `src/mcp/` | A read-only JSON-RPC surface over the same logic the commands use |
| `test/fixture.mjs` | The staged workspace and the identity-carrying `git`. Nothing in `test/` reads outside this checkout (ADR-031) |
| `docs/decisions/` | Numbered rulings. Read these before changing what the tool believes |
| `docs/plans/` | The two plans this was built from, with a state column per step |

## Why this repository adopts itself

This repository runs `simt init` on itself: `simt.json` declares its gates, and the
generated region below carries the rules it projects. The region's `simt:sha=` stamp is a
digest of the rule *content* — `rules/` and the baselines — not of this repository's HEAD,
so a commit here does not go stale. `simt check` reports the region current until the rule
text itself changes, and `simt sync --yes` re-renders it when that happens.

The acceptance test for a change to rule text is therefore not `simt check` in this
repository. It is: render the region for a real repository, read it as that repository's
agent, and confirm every instruction in it is one that agent can act on.

<!-- simt:begin -->
<!-- simt:generated -->
<!-- simt:sha=7e04d7cd326c125e2b76f9c02eb24c06f5123106 -->
<!-- simt:sources=rules/core.md,rules/stacks/python.md,rules/mdc/intake-questions.mdc,rules/mdc/slice-commit.mdc,rules/mdc/test-gate.mdc -->
<!-- Generated content. Do not edit by hand - your changes are overwritten.
     Run `simt sync --yes` to regenerate, or `simt check` to see what is stale. -->

## Core

Where a rule cites a decision, run `simt rules why ADR-NNN` to read it,
including whether it is still in force.

These rules are stack-agnostic. Whatever is specific to your stack, your product or your
commands belongs in this repository, not here.

### Truth

- Never claim a test you did not run, a check you did not execute, or a deploy you did not
  perform.
- Read the real runner manifest before running anything. A command absent from it is not a
  command. (Which file that is depends on the stack: `package.json` scripts, Gradle tasks,
  `pyproject.toml` entry points.)
- Report what you left alone: unrelated dirty files, skipped checks, unreviewed scope.

### Git

- Commit locally, report the SHA. **Push only on explicit approval.** (ADR-001)
- Before asking for push approval, state whether the push triggers a deployment, a migration
  or any remote mutation.
- Never use `--no-verify`, amend, rebase, reset or rewrite history unless explicitly asked.
- Never commit failing, partial, secret-bearing or unrelated work.

### Refactoring

- Outside the current change's blast radius, do not refactor. (ADR-002)
- Inside it, a second real use extracts, and the extraction is finished: no orphaned imports,
  exports, styles, messages or files remain.
- A third copy of the same logic is a defect. So is an abstraction invented for one caller.

### Validation

- Focused tests are the default gate. A full suite runs only against a named trigger: phase
  exit, release gate, cross-system behaviour, a repo-declared numeric gate, explicit
  instruction, or pre-push on a declared protected branch. (ADR-003)
- Name the exact commands and test files. Partial pass is a blocker; `6/8 pass` is the
  canonical example of a blocked state. Never justify a skip without a pre-existing written
  reason. (ADR-006)
- Evidence discipline is mandatory everywhere. A **numeric** bar is declared per repo in the
  repository's manifest (`simt.json`), never assumed centrally. (ADR-006)
- The pre-commit hook owns format and lint for staged files; do not re-run what it just ran.
  Manual runs are correct when the hook is absent, when diagnosing a failure, or for a check
  the hook does not cover. (ADR-004)
- Declare a gate only if this repository can run it — a script that exists, a tool that is
  installed, a command you name. A gate that cannot run blocks every commit until someone
  reaches for `--no-verify`. (ADR-017)
- Invoke tools through the repository's own runner — `npm run`, `uv run -m`, `./gradlew` —
  never a package runner like `npx` or a bare console entrypoint. (ADR-010)

### Code and review

- No type-system escapes, no unawaited async work, no debug printing in application code.
- Enforced: by `simt check`: more than 400 lines warns, more than 1000 fails (`limits.fileLines`)
- Never weaken CSP, CORS, auth, audit, cache or validation controls to silence a test, warning
  or alert.
- Review verdicts are exactly three: `BLOCK`, `APPROVE WITH RESIDUAL RISK` (must list what was
  not reviewed), `APPROVE`. (ADR-008)
- Accessibility, correctness, privacy and security are hard gates, not subjective tradeoffs.
- Never direct two agents to edit the same files concurrently. Select the minimum viable team.
- Every agent works to a stated budget and stops at a concrete blocker rather than drifting.
  Approval by budget never converts a known failure into an approval.

### Scope of these rules

Product policy, stack-specific rule bodies, repo commands and paths stay in the repo. A rule
here states only what holds everywhere; the moment one repository needs an exception, it is that
repository's rule, not a widening of this one.

## Stack: python

Applies to: Python — `pyproject.toml`, `requirements.txt` or `setup.py`. The
environment rules — how to invoke tools, and which lockfile owns them — are in the
`uv` profile (`simt rules show uv`), which selects on a committed `uv.lock`.

### Invocation

- Run through the repository's own runner: `uv run` where a `uv.lock` is committed,
  `poetry run` where a `poetry.lock` is, and the repository's documented wrapper
  otherwise. See `simt rules show uv` for the form that must not be used.
- Never invoke a tool from whatever environment the shell happens to have. It will
  usually be a different copy of the package than the one under test, and the failure
  it produces looks like a bug in the code.

### Typing

- No `typing.Any`. Accept `unknown`-equivalent types (`object`) at genuinely untrusted
  boundaries and narrow explicitly.
- `Mapping` for a read-only parameter, `dict` for a value that is mutated. Returning a
  concrete `dict` from a function annotated `Mapping` forces a copy on every caller.
- Every public function annotated. An unannotated signature is a review finding.

### Tests

- `fail_under` is set per repo in the repository's manifest (`simt.json`) (ADR-006).
  Where a repo requires 100 %, treat it as a behavioural gate: an uncovered path is
  either a missing test or dead code, and both are defects.
- No `pytest.skip` without a pre-existing written justification.
- Test the narrowest layer that proves the behaviour; reach for an integration test
  only when the behaviour is genuinely cross-system.

### Diff hygiene

- `git diff --check` before handoff: no whitespace errors, no conflict markers, no
  stray debug prints.
- Generated artifacts (coverage output, build directories, caches) are not committed.

### Async

- `Awaitable` in annotations, never a bare coroutine where an `Awaitable` is the contract.
- No blocking I/O on the event loop.
- No unbounded task creation: a fan-out needs a concurrency limit.

Commands for this repository:

- test: `npm run test`
- lint: `npm run lint`
- focused test (Python): `pytest {file}::{test}`
- focused test (Node): `node --test {file}`

New task? Run `simt brief "<task>"` before exploring; before editing a file, `simt why <file>`.

## Process: intake-questions

When starting, resuming, or scoping a feature slice or plan task, do not jump into code
without resolving open material decisions.

### Agent Defaults (Do Not Ask)

Apply documented defaults without questions for:

- Operational/procedural choices (tracker updates, commit vs push, validation depth,
  artifact shape).
- Slice sequencing and repository ownership when already defined in the active plan
  tracker table (`docs/plans/*`).
- Standard engineering conventions.

### When To Ask (1-5 Questions Max)

Ask only when a functionality, business, privacy, security, or technical decision is not
settled in authority docs, and the answer materially changes behavior, scope, contracts,
migrations, or risk.

Five is a ceiling, not a quota. Ask fewer when fewer decisions are genuinely open; never pad
the list to reach it, and never split one decision into several questions to fit under it.

- Ask the user, offering choices with the recommended one first.
- If that is not available, present numbered choices with `(recommended)` on the first option.
- Do not ask operational or procedural choices; apply the best documented option.

### Required First Turn

1. State the smallest independently valuable slice, the owning repo, the active plan
   tracker task ID (from `docs/plans/*`), and the acceptance checks.
2. Either ask the unresolved material decision questions, or state that the authority docs
   leave no material open decision and proceed to implementation.
3. Proceed without waiting when no material decision remains.

## Process: slice-commit

A slice is the smallest change that is independently valuable on its own. Committing
one is a mechanical procedure with a fixed order, because every step after it depends
on the one before: you cannot review a diff you have not staged, and you cannot claim
evidence for a test you have not run.

### Order

1. **Run the focused test the change needs**, through the repository's own runner,
   naming the exact command and the exact file — see `test-gate`. A full suite is
   for a named trigger, not for progress.
2. **Stage only what the slice touched.** `git status` first, and leave unrelated work
   alone. Report what you left alone; silence about it reads as "I reverted it".
3. **Read the staged diff.** Not the working tree — the diff. It is what will be
   committed, and it is the last chance to notice a file that does not belong.
4. **Write the message.** Conventional Commits, imperative subject, no trailing period:
   `fix(gates): declare only gates a repo can run, and report the ones it cannot`.
   The subject says what changed; the body says why, and what was deliberately not
   changed.
5. **Commit.** `git commit`, non-interactive. Report the SHA.
6. **Stop.**

### Pushing is a separate decision

**Never push because the work is finished.** Push is a separate act with its own
approval, and pushing the branch a remote treats as production can deploy it.

Before asking for approval, state what the push will do: which branch, how many
commits, and whether it triggers a deployment, a migration, or any other remote
mutation. Then wait. Approval to commit is not approval to push.

Never use `--no-verify`. A hook that fails is telling you something about the change;
skipping it turns a gate into a suggestion and the next person has no way to know it
was skipped.

### What never belongs in a commit

- Failing, partial, or unrun work. A commit is a claim; a partial one is a false one.
- Secrets, tokens, or generated artefacts that drift.
- Work nobody asked for. Unrelated changes in a slice commit are invisible in review
  and impossible to revert on their own.

## Process: test-gate

Applies to every feature slice, bugfix, and plan tracker task. Docs/config-only chores are
exempt from test deltas but require named doc/format checks to pass.

### Implementer Requirements

1. **Name exact commands and test files**: your test runner, through the repository's own script or task, selecting
   `path/to/the.changed.test.ts` on its own.
2. **100% Pass Required**: the named commands must exit 0 with every test passing. A
   partial pass (e.g. 6/8 passing) is a hard blocker, and so is quoting the passing subset.
3. **Behavioral Test Deltas**:
   - New feature/contract/route path -> new or extended test asserting the behavior.
   - Bugfix -> regression test reproducing the failure mode.
   - If no test file changed, justify why the existing tests fully prove the invariant.
4. **Cross-Repo Order**: commit the API producer (contract/migration) before any
   consumer generates against it. Never apply remote migrations or deploy from uncommitted
   code.

### Reviewer Mandatory Block

Return `BLOCK` when:

- Any test fails, is skipped (without pre-existing justification), or is unrun.
- An executable diff has no test delta and no explicit justification.
- The coordinator cites partial suite results or defers a failing test.
- **Consumer side:** a consumer requires a new API field with no backward-compatibility or
  deploy-order evidence.
- **Producer side:** the API producer ships without a test asserting the new invariant
  or field.

The last two are complementary, not alternatives. A reviewer that checks only one of them
misses half of the failure they exist to catch.

<!-- simt:end -->
