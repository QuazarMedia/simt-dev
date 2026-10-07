# ADR-032 — provenance is a digest of the content that leaves this package, not a commit id

Status: accepted · 2026-10-08
**Affects:** `src/projection/rules.mjs`, `src/projection/markers.mjs`, `test/upgrade.test.mjs`,
`test/install.test.mjs`, `test/project.test.mjs`. **Implements:** proposal P1 in
`docs/reviews/0002-full-review-adoption-and-public-release.md` §10. **Relates to:**
ADR-031 (a test that inherits the author's directory is not evidence) — the same defect found
one layer down, in the tool rather than the suite — and ADR-015 (a source is content, not a
location), which already argued that a declared skill's identity is its bytes.

## Context

Two tests in `test/upgrade.test.mjs` failed in any copy of this repository that had no `.git`:
a `git archive` export, a tarball, and — the case that matters — the published npm package.

The proximate cause was `headSha()`, which ran `git rev-parse --short=7 HEAD` in the package
root and returned the string `unknown` when git could not answer. That fallback was only the
second of two ways the stamp was wrong, and the quieter one.

**The first way: the stamp recorded the reader's own repository.** `git rev-parse` run inside
`node_modules/` walks *up* until it finds a `.git`, so for anyone who installed this package
into a repository — the entire audience for it — the tool stamped the consumer's HEAD. Not a
near miss: the correct-looking answer to the wrong question. A consumer's HEAD changes on
every commit they make, including commits that touch nothing this tool projects, so:

- the stamp changed under a region that had not changed, and `check` reported `DRIFT` on all
  three generated files plus `STALE-GENERATED-FIELD` on the manifest — **after an unrelated
  commit**, and **exit 1**. A gate that is red on every commit trains people to ignore it,
  which is the failure mode this tool exists to prevent;
- `upgrade` reported `state behind`, `pin f9036cd -> f3014d5`, and the cause it named —
  *"pin moved and region restamped (the rules changed)"* — was false. A pin that moves because
  the consumer typed a commit message has not detected anything about the rules;
- no fallback could ever have caught this, because git succeeded and returned a plausible sha.

Review 0002 recorded this as probe #2 and slice S01 and it was correctly read there as
"provenance stamp comes from the consumer's git, not simt-dev". It reproduced exactly.

**The second way: where git could not answer, `unknown` was treated as a value.** The old
comment defended the fallback — "a region stamped with an honest `unknown` is visibly
unverified while one stamped with a wrong answer is not" — and the defence is sound in
isolation. It is defeated by the fact that `unknown` was then compared and written like any
other string:

- `files` in `package.json` does not list `.git`, and npm never packs one. **`npm pack`
  produces 98 entries and no `.git`**, so a tarball or a copy extracted outside a repository
  got `unknown`.
- The marker grammar reads `simt-dev:sha=([0-9a-f]{7,40})`. `unknown` does not match, so
  `parse()` returned `sha: undefined` for a region the tool had just written. **The tool could
  not read back its own stamp**, and `check` reported `recordedSha: null` for a file that
  plainly carried one.
- `planUpgrade` computed `pinBehind = base.pinnedSha !== sha`. With `sha === 'unknown'` this
  is true for every real pin, so `upgrade` called a repo pinned at `2614462` `behind`, again
  naming the false cause above. `upgrade --yes` then wrote `unknown` into both the region's
  stamp and the manifest pin, and the original pin was unrecoverable.

So the identity was never the identity of this tool. It was either the reader's repository or
a sentinel the tool could not parse — and the review's probe found the first while the test
suite, written by someone reading a checkout, could not see it.

## Ruling

**Provenance is a SHA-256 digest of `rules/` and `graph/`, truncated to 40 hex characters. It
is not a commit id, and there is no fallback.**

Three consequences, each of which is the point:

1. **The identity exists wherever the content does, and depends on nothing outside the
   package.** `rules/` and `graph/` are in the published tarball, so the digest is computable
   from a checkout, a tarball and an `npm install` alike — one value, no environment to be in.
   This also ends the walk-up: with no `git` invoked at all, there is no ancestor repository
   for the stamp to be borrowed from, so a consumer's own commits can no longer move a pin.
   Verified by the review's own probe, against a package installed inside a repo that then
   commits an unrelated file: before, `check` reported `DRIFT` on three files plus
   `STALE-GENERATED-FIELD` and exited 1; after, three `CURRENT` lines and exit 0.
2. **A stamp the tool cannot read is a defect, not a degraded mode.** `compose()` now throws
   unless `sha` matches `[0-9a-f]{7,40}`. The write and the read share one grammar by
   construction, so the failure this record describes cannot be reintroduced by adding a
   fallback.
3. **`unknown` is gone, not guarded.** There is no sentinel to compare against, so the
   comparison that destroyed the pin has nothing to misread. A repo stamped by a version of
   simt-dev older than this record still carries `unknown`, or a consumer commit's sha, and
   `upgrade` now repairs it to the digest — the same path as any other stale pin.

### What the digest covers, and what it deliberately excludes

`rules/` and `graph/` are the bytes whose change moves a consumer's projection: the shared
rules, the per-ecosystem profiles, the Cursor rule files, and the skill registry. `src/` is
excluded deliberately. A refactor that changes no rule and no registry entry produces
byte-identical regions; stamping those consumers would report drift where there is none, and
the estate's own rule is that a report must be a fact.

This is the same reasoning as ADR-015: a skill is identified by its bytes, so a projection is
identified by the bytes it projects.

Entries are hashed in sorted path order, each framed as `path:length:` before its bytes. The
ordering makes the value independent of `readdir` order — determinism is a feature of this
tool, not a limitation. The framing means two different renames cannot collide into one
digest, which is why this is not a hash of concatenated text.

## Consequences

- **Every adopted repo's stamp moves once.** A consumer stamped at a commit sha will report
  `behind` the first time it runs this version, and `simt-dev upgrade` fixes it. That is the
  intended reading of a pin, not a regression.
- **The two `.git`-less test failures are fixed at the source for one of them.** The stale
  `.mdc` test failed only because it could not find a sha to rewind; it now passes. The other
  (`upgrade --root` at the package root) is a *test* defect and is fixed as one — see below.
- **`test/upgrade.test.mjs` no longer asserts a property of the author's checkout.** It had
  asserted `summary.repos === 1`, which is only reachable when this checkout happens to be a
  git repo. A `.git`-less package root is a directory holding no repositories, which
  `discover` correctly refuses with exit 3 and a remedy. Both answers are right, so the
  invariant is now stated directly: simt-dev is not a consumer of itself, so no
  `simt-dev.json` appears. Both halves are non-vacuous — planting a manifest fails the first,
  and forcing the no-manifest case to write one fails the second.
- **S01 is discharged.** Its proposal is P1; this record implements it, so the slice can move
  to Complete against this SHA rather than waiting on a second implementation of the same idea.

## Rejected

- **Guard the sentinel instead of removing it.** Treat `unknown` as non-comparable: refuse to
  move a pin to or from it, and say so. Smaller diff, and it leaves the tool writing a stamp
  its own parser rejects for every npm consumer. It fixes the data loss and not the lie, and
  it does nothing at all about the walk-up, which was never a sentinel — git succeeded.
- **Resolve the repository explicitly** — pass `--git-dir`, or run `git rev-parse` with
  `GIT_CEILING_DIRECTORIES`, so the stamp names this package and never an ancestor. This is
  the smallest change that fixes the walk-up, and it is still wrong: in a tarball there is no
  repository to name, so it restores the `unknown` fallback and with it the pin destruction.
  It also keeps the identity meaning "which commit of simt-dev", which is a fact about a
  history a consumer does not have and cannot verify. The ruling is that the stamp answers
  *what content produced these bytes*, not *which commit was checked out at the time*.
- **Stamp the package version.** `version` is present in the tarball. But it is `0.0.0` here
  and rises only at release, so it cannot distinguish two working trees that project
  differently — which is the case `check` and `upgrade` exist for.
- **Hash the whole package.** Includes `src/`, with the consequence above, and hashes files
  the consumer never receives.