# ADR-060 — A repository with nothing to run is adopted, and says so; a gate is verified where it runs

Status: **accepted** · 2026-10-12 · filed as S36 · amends the adopted-repository definition in review 0002
Affects: the S36 acceptance criterion, `hooks install`'s refusal on a gate-less repository, the estate's CI triggers

## Context

Review 0002 defined adoption as eight things a repository must have, and S36's acceptance
criterion as `current: 14, hooksRouted: 14`, no `UNRUNNABLE` gate, and a green CI run in
every repository that has CI. Fourteen repositories were in scope.

Three of them cannot satisfy item 3, and the row and its own runbook already said so. S36's
step 4 reads, of `simt-jobs`: *"none (no runner). Record that in the manifest rather than
invent one."* That is an instruction not to route it. The acceptance criterion then demands
that it be routed. One of the two is wrong, and the row could not be closed without settling
which.

This was not theoretical. It became concrete when the roll-out ran:

- **`app-ui`** is a Gradle module consumed as a submodule by `simt-app` and `wakt-app`. It
  has no `gradlew` — those two own the wrapper — and its `package.json` declares no scripts
  at all. There is no command in it that anything could run.
- **`simt-jobs`** has no `package.json`. No runner, no scripts, nothing to probe.
- **`simt-landing`** declares no gate, has no `format:check` and no `test` script, and owns
  a Lighthouse `pre-push` in `.githooks/` that routing would displace.

ADR-017 already settled the principle in one direction: a gate is declared only if the
repository can run it. This record settles the other direction, which the corpus never
exercised — what a repository that can run nothing looks like when it has adopted the tool.

A second thing surfaced at the same time, and it is not a repository's fault. The roll-out
pushed to fourteen repositories and GitHub Actions executed no steps: every run completed
with `failure`, zero steps, and no logs — including `simt-api`'s pre-existing `CI` workflow,
whose body this record's author never touched. Actions is enabled on all eight repositories
(`/repos/{owner}/{repo}/actions/permissions` returns `enabled: true`), and the org-level
setting is not readable without `admin:org`. The workflows are syntactically valid, they
parse, and they have run before. The jobs are not being started.

## Ruling

**One. A repository that cannot run a gate is adopted when it says so, and routing is not
required of it.** `hooksComplete` is not the measure of adoption and `hooksRouted: 14` was
never achievable. The three repositories carry the evidence in the manifest and in their own
commit messages: what is missing and why. That is a stronger artefact than a shim that runs
nothing, which is what forcing them would have produced — and the runbook already forbade
inventing one.

**Two. A gate must be runnable, and a shim must not be installed over one that is working.**
This is ADR-018 as amended, restated because the roll-out made it concrete.
`simt-landing`'s `pre-push` keeps running in `.githooks/` precisely because the repository
declares no `prePush` gate and therefore nothing displaces it. Routing a repository that
enforces nothing is not a smaller change than routing one that does: `core.hooksPath` moves
to `.simt-hooks/`, git reads every hook from the one directory, and the gain is zero.

**Three. "Green CI" is verified where CI runs, and is not a property of the repository when
it does not.** The acceptance clause is replaced by two that can be answered: the workflow
file is present and valid in every repository that has CI (7 of 7, measured), and the gate
that can run locally runs (`simt check` exits 0 in all fourteen, measured). Whether GitHub
executes those workflows is a fact about the account, and a gate that reports a property it
cannot observe is ADR-039's defect — the step that cannot fail is the one nobody reads.

**Four. The estate's CI runs on pull requests, and delivery does not.** A check that fires on
a timer is not evidence about a change: by the time it reports, the commit is days old and
nobody is waiting. This is why the weekly runs were removed rather than de-scheduled, and why
the two API-contract workflows were split out of their `ci.yml` files: republishing to
Cloudflare API Shield needs a token a fork does not have, so it fires on merge to `main`, and
a workflow cannot have both triggers once the checks and the delivery need different ones.
The template moved in `546b477`, so the estate followed the template rather than fourteen
hand edits.

**Five. The measure is `check` and `compare`, and they are held in agreement.** ADR-045 made
`compare` count a defect it was hiding; this cycle found the same row reporting `current: 14`
while `check` exited 1 in every one of them. Both are now driven at one fixture and compared
— a parity test, because two copies of one question each asserted separately is how they
drift, which is ADR-052's shape. The number that decides adoption is `check` exiting 0, and
`compare` is what makes it visible across fourteen repositories at once.

## Consequences

- **S36 closes with 11 of 14 routed, and the three exceptions named in three commit
  messages** rather than in a spreadsheet. `app-ui` (`3e31e54`), `simt-jobs` (`5d5b6f4`),
  `simt-landing` (`d65e15a`).
- **If one of those three gains something to run, it routes in one command** and nothing else
  about it changes. The measure is not a permanent exemption; it is the current answer to
  "can this repository enforce anything", and it is re-read on every `compare`.
- **The gate is now stronger than the review asked for.** `check` exits 0 in all fourteen,
  every manifest records a released version, no rule is loaded twice, and no declared gate is
  unrunnable. Three of those were false when this row was written.
- **Nothing here is verifiable from the repositories alone.** Whether GitHub Actions executes
  the workflows is unmeasured until it does, and this record says so rather than claiming a
  green build nobody has seen. Re-run `gh run list` and the clause comes back.

## Rejected

- **Route the three anyway, with an empty gate list.** `hooks install` already refuses — it
  prints *"declares no gate it can run, so there is nothing to enforce."* Overriding it would
  mean a shim on every commit that dispatches, reads a manifest, and exits having enforced
  nothing. The cost is a repository that believes it is gated.
- **Declare a gate to satisfy the count.** `gates.commands` would need a name for a check
  that does not exist. `simt-garmin` has the shape of this: seven scripts that run, and a
  gate vocabulary with no name for five of them. Two are declared (`i18n-completeness`,
  `codegen-drift`) and the other five stay manual rather than borrow `test` or `lint` — a
  gate whose printed name misdescribes the command it runs teaches a reader not to trust the
  other seven.
- **Keep the weekly runs because they are "just checks".** They were the most expensive thing
  in the estate — `simt-app`'s ran a headless Android emulator — and the least timely. Where
  the checks were worth keeping they moved to the pull request that changes the code;
  `simt-social`'s did exactly that when its own test suite refused the push that deleted them.
- **Mark S36 complete before measuring it.** The four `compare` figures and the fourteen
  `check` exits in this record are from a committed build run over the estate, not from the
  roll-out's own working tree. That distinction caught a false attribution earlier in this
  cycle and is why the review's earlier note about a fourteen-repository defect turned out to
  be caused by an uncommitted change rather than by anything the estate was doing.