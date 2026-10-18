# AGENTS.md — simt-dev

## What this repository is

simt-dev is the **source** for everything the tool projects into other repositories: the
rule bodies, the Cursor rule files, the skill registry, the gate definitions and the hook
dispatcher. It is not a consumer of itself. See "Why this repository is not self-adopted".

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

## Why this repository is not self-adopted

Running `simt init` here would pin this repository's own SHA into its own `AGENTS.md`, so
every commit would make that file stale and every `simt upgrade` would rewrite it. The
value of the generated region is that it is *stable text* — it should not churn because
unrelated code moved. So the rules are written by hand here and tested directly.

The acceptance test for a change to rule text is therefore not `simt check` in this
repository. It is: render the region for a real repository, read it as that repository's
agent, and confirm every instruction in it is one that agent can act on.