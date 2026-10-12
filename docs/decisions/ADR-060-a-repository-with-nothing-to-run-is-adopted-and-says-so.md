# ADR-060 — A repository with nothing to run is adopted and says so, and a gate is verified where it runs

Status: **accepted** · 2026-10-12 · filed as S36
**Affects:** `hooks install`, `compare`, the adoption criterion in review 0002

## Context

Review 0002 defined adoption as eight things a repository must have, and gave the estate
roll-out an acceptance criterion: every repository current, every repository routed, no
unrunnable gate, and a green CI run in every repository that has CI. Fourteen repositories
were in scope.

Three of them cannot satisfy the second of those, and the row contradicted itself about it.
The runbook's own step 4, for one of the three, reads: *"none (no runner). Record that in
the manifest rather than invent one."* That is an instruction not to route it. The
acceptance criterion then requires that it be routed. One of the two is wrong, and the row
could not be closed without settling which.

This stopped being hypothetical when the roll-out ran. The three are:

- **A Gradle module consumed as a submodule.** It has no wrapper of its own — the two
  repositories that embed it own that — so `./gradlew` cannot be run from it. Its
  `package.json` declares no scripts at all; it exists to carry one devDependency.
- **A repository with no `package.json`.** No runner, no scripts, nothing to probe.
- **A static site with no gate and its own hook.** No `format:check` and no `test` script to
  declare a gate from, and a Lighthouse pre-push in `.githooks/` that routing would displace.

Each is ungated for a reason that was checked rather than assumed, and each records that
reason in its own commit message.

ADR-017 already settled the principle in one direction: a gate is declared only if the
repository can run it. This record settles the other, which fourteen repositories of real
use never exercised — what a repository that can run nothing looks like once it has adopted
the tool.

A second thing surfaced at the same moment, and it is not a repository's fault. The roll-out
pushed to fourteen repositories and GitHub Actions executed no steps: every run completed
with `failure`, zero steps, and no logs — including a pre-existing lint-and-test workflow
whose body this work never touched. Actions reports `enabled: true` on all eight
repositories; the organisation-level setting needs `admin:org` and could not be read. The
workflow files parse, and the same workflows have run before. The jobs are not starting.

## Ruling

**One. A repository that cannot run a gate is adopted when it says so, and routing is not
required of it.** `hooksComplete` is not the measure of adoption, and "every repository
routed" was never achievable. The three carry the evidence in the manifest and in their own
commit messages: what is missing, and why. That is a stronger artefact than a shim that
runs nothing — which is what forcing them would have produced, and which the runbook already
forbade inventing.

**Two. A gate must be runnable, and a shim must not be installed over one that is working.**
This is ADR-018 as amended, restated because the roll-out made it concrete. The static site's
pre-push keeps running in `.githooks/` precisely because its manifest declares no `prePush`
gate and therefore nothing displaces it. Routing a repository that enforces nothing is not
a smaller change than routing one that does: `core.hooksPath` moves, git reads every hook
from the one directory, and the gain is zero.

**Three. "Green CI" is verified where CI runs, and is not a property of a repository when it
does not.** The clause is replaced by two that can be answered: the workflow file is present
and valid in every repository that has one, and the gate runs locally. Whether GitHub
executes those workflows is a fact about the account, and a gate that reports a property it
cannot observe is ADR-039's defect — the step that cannot fail is the one nobody reads.

**Four. The estate's CI runs on pull requests, and delivery does not.** A check that fires on
a timer is not evidence about a change: by the time it reports, the commit is days old and
nobody is waiting on it. That is why the weekly runs were removed rather than de-scheduled.
It is also why the two API-contract workflows were split out of the `ci.yml` files they
shared: republishing to the edge needs a credential a fork does not have, so it fires on
merge to `main`, and one workflow cannot carry two triggers once its checks and its delivery
need different ones. The template moved in one commit and the estate followed the template,
which is the only way to move fourteen repositories that do not own the file.

**Five. The measure is `check`, and `compare` is what makes it visible at estate scale.**
ADR-045 made `compare` count a defect it had been hiding. This cycle found the same row
reporting every repository current while `check` exited non-zero in all of them. Both are now
driven at one fixture and compared — a parity test, because two copies of one question, each
asserted separately, is how they drift. That is ADR-052's shape, reached from a different
direction.

## Consequences

- **The roll-out closes with eleven of fourteen routed, and the three exceptions named in
  three commit messages** rather than in a dashboard. An audit trail beats a count.
- **If one of the three gains something to run, it routes in one command** and nothing else
  about it changes. This is not a permanent exemption; it is the current answer to "can this
  repository enforce anything", and `compare` re-reads it every run.
- **The result is stronger than the row asked for.** Every repository's gate exits zero,
  every manifest records a released version, no rule is loaded twice, no declared gate is
  unrunnable, and no region sits past a harness's read limit. Three of those were false when
  the row was written.
- **The CI clause is recorded as unverified, not met.** Nothing in a repository can make
  GitHub execute a workflow, and a claim about a green build nobody has seen is the thing
  this repository's own rules exist to prevent. Re-run the query and the clause comes back.

## Rejected

- **Route the three anyway, with an empty gate list.** `hooks install` already refuses —
  it prints *"declares no gate it can run, so there is nothing to enforce."* Overriding it
  means a shim on every commit that dispatches, reads a manifest, and exits having enforced
  nothing. The cost is a repository that believes it is gated.
- **Declare a gate to satisfy the count.** That needs a name for a check that does not
  exist. The Connect IQ repository has the shape of this: seven scripts in `scripts/` that
  all run, and a gate vocabulary with no name for five of them. Two were declared, where the
  name matched, and the other five stay manual rather than borrow `test` or `lint` — a gate
  whose printed name misdescribes the command it runs teaches a reader not to trust the
  other seven.
- **Keep the weekly runs because they are "just checks".** They were the most expensive
  thing in the estate — the Android one booted a headless emulator every Saturday — and the
  least timely. Where the checks were worth keeping they moved to the pull request that
  changes the code, and one repository's own test suite refused the push that deleted them,
  which is the gate working.
- **Close the row before measuring it.** Every figure in this record comes from a committed
  build run over the estate, not from the working tree that produced it. That distinction
  matters here: earlier in this cycle an apparent fourteen-repository defect turned out to be
  caused by an uncommitted change, and the number would have been reported as a fact about
  the estate.

## Notes

This record names no repository. The sweep that pseudonymised the estate used stable
`repo-NN` labels because several older records use repository names as *evidence* — a table
of how three repositories answer the same question, where "a repository and a repository"
would destroy the argument. That argument is not present here: every repository in this
record is identified by what it *is*, which is both publishable and more useful to a reader
who has none of the files.

`test/shipped.test.mjs` now fails on any estate name in anything this package publishes —
the records, the changelog, the readme. It is scoped to the published set and asserts that
scope against `package.json`, in both directions, so a directory added to `files` without
being guarded fails rather than leaking.