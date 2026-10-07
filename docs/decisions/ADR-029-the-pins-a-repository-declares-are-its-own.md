# ADR-029 — the pins a repository declares are its own, so a check reports them and never writes them

Status: accepted · 2026-10-07
**Affects:** `src/toolchain.mjs`, `src/projection/project.mjs`, `test/toolchain.test.mjs`.
**Settles:** the `packageManager`/`engines`/`.nvmrc` items of §3.1 row 5 of
`docs/plans/0001-centralise-agent-rules.md`. **Extends:** ADR-026 ruling 9 (absence and
disagreement are reportable; content is not) to a file this tool authors no part of.

## Context

Row 5 promised to resolve "no `packageManager`" and "3 disagreeing nvmrc". Reading the
estate before writing anything turned the second of those into a different problem, and
the difference is the whole record.

Nine node repositories commit `package-lock.json`. None declares `packageManager`. That is
one real defect, stated by `rules/stacks/node.md` in four consecutive claims and enforced by
nothing: one `packageManager` matching the lockfile, a floor in `engines.node`, a `.nvmrc`
that agrees with both, and `engines` stated at all.

The `.nvmrc` claim does not survive contact. Three repositories have one, and each agrees
with its own `engines` exactly — `24.19.0` against `>=24.19`, `22.21.1` against `>=22`,
`22.22.0` against `>=22`. What the plan called three disagreeing files are three
*repositories* choosing different node majors, which is a per-repository decision each of
them has a reason for. There is no defect. A check that reported it would produce a finding
with no remedy, and a gate whose findings cannot be acted on is the failure this package
exists to prevent — so the check does not exist, and `test/toolchain.test.mjs` asserts its
absence out loud so a later reader does not add it back as a completeness improvement.

That left one defect, and it has a property none of the shipped baselines has: **there is no
correct value to write.** A strictness flag has one right answer. A node floor has as many as
the team has reasons for, and `package-lock.json` carries a lockfile format number, not the
npm version that produced it. A tool that picked one would be embedding a locally-observed
version into every repository in the estate, which is the thing ADR-001's determinism rule
exists to prevent.

## Rulings

1. **A pin is reported, never written.** `simt-dev init` writes no `packageManager`, no
   `engines` and no `.nvmrc`. ADR-026's ruling 9 already said a check reports absence rather
   than contents; this extends it to a file where simt-dev has no content to report *on*,
   because the correct content is not derivable from anything in the tree.

2. **The remedy is a command run where the answer exists.** `npm pkg set
   packageManager=npm@$(npm --version)` fills in the version from the machine that has it,
   and the tool ships no version of its own. This is the first remedy in the package that is
   a command rather than an edit, and it is the shape the answer forces: the tool can name the
   field and the manager, and only the reader can name the version.

3. **A lockfile is the evidence that a manager was chosen.** A node repository with no
   lockfile is not asked to declare a manager, because there is nothing to declare one
   *about*. Every check is gated on `has-lockfile`'s evidence rather than on `package.json`
   existing.

4. **Two lockfiles are the absence of a package manager,** reported as such and never
   resolved by picking the alphabetically-first one. That resolution would be a guess about
   which of two committed artefacts is the mistake, and it would be wrong half the time.

5. **`engines.node` absent is reported as a floor nobody enforces.** This is `node.md`'s own
   phrasing — "a version floor nobody enforces is a comment" — promoted from a rule to a
   gate. Four repositories in the estate declare neither `engines` nor a `.nvmrc`.

6. **A `.nvmrc` the declared floor forbids is the one contradiction worth reporting**, because
   the floor is a promise about what is supported and the pin is the instance of it, so the
   pin is what has to move. The remedy names both values rather than choosing between them:
   which one is wrong is a decision about intent, not about syntax.

7. **A range this tool cannot evaluate produces no finding.** `lts/*`, `22.x` and anything
   else outside a named subset reads as unknown, and an unknown is silence. The alternative is
   an approximate reading reported with the same confidence as an exact one, and a reader who
   cannot tell which findings were guesses stops trusting the ones that were right.

8. **The subset is written down and tested as a subset:** `>=`, `>`, `<`, `<=`, `^`, `~`,
   bare `22` and `22.1`, space-separated conjunctions and `||` disjunctions. A bare `22` means
   every 22, as npm reads it, so a pin of `22.9.9` against a floor of `22` is satisfied —
   reading either as one exact version would report a matching pin as a contradiction.

9. **This check reads and never writes, and a test says so.** The gate that judges a
   repository must not be able to green itself by editing what it judges. ADR-024 drew that
   line for the `.github` files; this is the same line drawn for a check with no file of its
   own.

## Consequences

Three findings go live where nine repositories will see them: `undeclared` fires in every
node repository in the estate, `unfloored` in four, and `contradiction` in none. That is the
intended effect — row 5 asked for these to be resolved and nothing in this package will
resolve them, because it cannot. A repository that adopts simt-dev and runs `check` gets a
red gate with three commands that each end in a value only the reader can supply, which is the
honest version of "resolves this defect".

The remedy strings are also the first place this package asks a reader to run a shell
substitution, and that is worth stating plainly: a version detected on the machine running
`check` is not the version the repository should record, so the remedy does not embed one.

What this settles and what it does not: `packageManager`, `engines.node` and `.nvmrc` are now
gated for **agreement**, not normalised. A shared value for any of them was never derivable
and is not attempted. What remains unwritten in row 5 is commitlint — which no rule file
mentions and no package in the estate installs — and the ESLint block, whose four
configurations are not variants of one configuration. This paragraph named those two and
stopped. ADR-030 answers what they are: not mechanisms awaiting code, but policy questions
nobody has been asked, and it is the record to read next for either.

## Rejected

- **A shipped `.nvmrc` or an `engines` value in a shared baseline.** Rejected as
  unrulable: the value is per-repository and the tool can only guess it. Shipping `22` would
  break `simt-social`, which pins 24.
- **Reporting cross-repository node divergence as a finding.** Rejected by the Context. The
  plan's premise was wrong and the correction is recorded here so it is not re-derived from
  the plan text.
- **Writing `engines.node` from the `.nvmrc` already present, or the reverse.** This is the
  one baseline case where simt-dev could derive a value from another value in the same repo,
  and it is rejected: the two disagree in four of the estate's repositories' worth of
  intent, and picking the winner would make one file's absence silently decide the other's
  value. The contradiction is reported with both values and the reader resolves it.
- **A full semver implementation,** for the reason in ruling 7. `22.x`, ranges with prerelease
  tags, and `>=22 <23 || >=24` shaped exclusions read as unknown.
- **Deriving the npm version from `package-lock.json`.** It is not there; the file records
  `lockfileVersion`, a format number. Reading a version from anywhere else would make the
  remedy depend on a file that is not evidence for it.
