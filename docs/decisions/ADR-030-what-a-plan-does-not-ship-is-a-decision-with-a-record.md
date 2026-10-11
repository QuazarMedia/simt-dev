# ADR-030 — what a plan does not ship is a decision with a record, not a silence

Status: accepted · 2026-10-07
**Affects:** `docs/plans/0001-centralise-agent-rules.md` §3.1 row 5 and row 7. Ships no
code. **Refuses:** the commitlint baseline and the shared ESLint block named in row 5 and
row 7, and records why in the plan itself rather than leaving the rows to imply that two
mechanisms are merely unwritten.

## Context

Row 5 asks for eight baselines and row 7 asks `init` to scaffold them. Five have shipped:
`.editorconfig` (ADR-025), `.gitattributes` (ADR-027), `tsconfig.base.json` (ADR-028), and
the `packageManager`/`engines`/`.nvmrc` checks (ADR-029), alongside Dependabot (ADR-026).
Six of the eight are now ruled on one way or another.

Two are not, and the reason they are not is not the reason the first six took. Each of the
first six hit a **mechanism** question — a region or not, a floor or a check, a value to
write or none to derive — and each question had an answer once somebody wrote down what the
format actually permits. The remaining two have no mechanism question to answer yet, because
nobody has decided whether the thing should exist.

That is the gap this record closes. AGENTS.md's first rule is that every byte leaving this
repository must be actionable for a reader holding only the receiving repository, and the
plan is a byte that leaves. A row that reads "still missing" tells the reader a mechanism is
outstanding. For these two, what is outstanding is a policy decision, and a reader who
trusted the row would go looking for the file to write.

The two were also miscounted, which is a separate failure and the reason the plan needed
correcting at all.

## Rulings

1. **A baseline that is not shipped is recorded in the row that asked for it,** with the
   reason, so the plan never implies an unfinished mechanism where the real state is an
   unmade decision. An honest row and a silent row differ in what the next person does, and
   the silent one is the more expensive.

2. **A convention asked for in prose is not a tool requirement.** `slice-commit.mdc:27`
   says "Conventional Commits, imperative subject, no trailing period", and gives an example.
   `commitlint` appears nowhere in `rules/` — zero matches across the directory, verified
   rather than assumed. What the estate mandates is a message shape; what the plan named is a
   linter that enforces it. Shipping the linter is a policy ruling about how strictly the
   shape is held, and nothing in the rules says how strictly.

3. **No rule file mentions commitlint, and no `package.json` in the workspace installs
   it.** Both are `grep` claims and both are written as claims: `grep -ri commitlint rules/`
   returns nothing, and `grep -l commitlint */package.json` returns nothing. That is the
   whole of the evidence, deliberately — a count of how many repositories were checked would
   be decoration, and one already in this estate disagrees with itself about what it counts.
   So there is no existing disagreement to repair, no config to inherit, and no repo
   currently failing a gate over it. Row 5's other items each had at least one of those.

4. **`eslint-config-prettier` is installed in exactly one of the four configurations,** and
   the fight is in exactly the two that use `stylisticTypeChecked` without it. The plan said
   "3 of 5 configs"; the estate has four configs and two conflicts, in one shape that is
   detectable by reading the file. Corrected in the row.

5. **Two of the four configurations are plain JavaScript with no TypeScript in them,**
   `repo-04` and `repo-06`. A "shared 6-rule ESLint block" cannot describe all four,
   because two of them have no rules to share — they differ in `ignores` and per-file
   `globals`, which are per-repository facts about paths.

6. **Flat config has no cross-repository include.** Bringing a shared block into a repo
   requires either publishing it as an npm package or editing the repo's own
   `eslint.config.mjs` to import and spread a local file. This package is a CLI with zero
   runtime dependencies (ADR-012); becoming a registry is not a mechanism decision this row
   may make on its own.

7. **The fix for the two conflicts is one dependency each,** and it is not a shared block.
   Installing `eslint-config-prettier` in `repo-14` and `repo-11` and spreading
   it last in the config array resolves both. That is a command per repository, run by the
   repositories, and simt-dev has no business writing it.

8. **The `.nvmrc` claim in row 5 was wrong and is corrected there.** Three repositories
   disagree, and each one's `.nvmrc` agrees exactly with its own `engines.node`. What differs
   is three legitimate per-repository choices. ADR-029 rules the cross-repository check out
   and asserts the silence in a test.

## Consequences

Row 5 ships five of its eight items, and now says so in a way that separates the two kinds
of remainder. Row 7 stops reading as though commitlint and the ESLint block are waiting on
code.

Neither refusal forecloses the decision. Both are one record away from being built, and this
record is what a later one would read first: it says what the mechanism would have to be
(ruling 6), what the state of the estate is (rulings 3 and 4), and what the cheapest correct
fix is today (ruling 7). Nothing here needs to be undone to start them.

The estate consequence of this record is one line changed in a plan and one rule about what
a plan row owes its reader. That is a smaller change than the five baselines that preceded
it, and it is the change that makes the other five legible: a reader of row 5 can now tell
the difference between what was built, what was ruled out, and what nobody has decided.

## Rejected

- **Shipping a `.commitlintrc.json` anyway,** on the grounds that the mechanism is settled
  and only the file is missing. Rejected by ruling 2: the file is a decision about
  enforcement strength, and writing it would answer that question by accident. A rule that
  says "no trailing period" and a commitlint config that rejects one are not the same
  commitment, and only one of them has been asked for.
- **A `commitlint` check** reporting a malformed subject, as a lighter alternative. Rejected
  for the same reason as the rest of ADR-029: a check for a convention nobody has adopted
  turns silence into a failure, and this is a plan item rather than a rule requirement.
- **A shared ESLint block as a local file each repo imports.** Rejected by ruling 6 for the
  published case, and for the local case because a file only two of four configs could use
  is not the shared block row 5 describes.
- **Deleting the `stylisticTypeChecked` entry from the two configs.** This would resolve the
  conflict, and it is rejected as simt-dev's business: it is an edit to a rule set a team
  chose, in a repository that has not asked, and its loss is that the stylistic rules were
  there for a reason nobody has written down.
- **Rewriting row 5 to drop the two items,** on the grounds that the plan should only list
  what will be done. Rejected by ruling 1. A plan that quietly forgets is not honest; it is
  just a document nobody can audit.