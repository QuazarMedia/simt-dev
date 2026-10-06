# Decisions

Architecture decision records for the SIMT development ecosystem. One canonical home per
decision; nothing here is duplicated into a repo's `AGENTS.md`.

A decision is superseded by writing a new ADR with a higher number and editing the old
record's status line — never by editing the ruling in place.

| ADR | Decision | Status |
|---|---|---|
| [001](ADR-001-push-requires-approval.md) | Push requires explicit approval | accepted |
| [002](ADR-002-refactor-blast-radius.md) | Blast radius bounds refactoring; a third copy is a defect | accepted |
| [003](ADR-003-test-breadth.md) | Focused tests by default; a full suite needs a named trigger | accepted |
| [004](ADR-004-hook-owns-format.md) | The hook owns format and lint for staged files | accepted |
| [005](ADR-005-file-length.md) | File length: 400 review trigger, 1000 hard ceiling | accepted |
| [006](ADR-006-coverage-bar.md) | Evidence discipline is central; the numeric bar is per-repo | accepted |
| [007](ADR-007-section-skeleton.md) | One canonical section skeleton | accepted |
| [008](ADR-008-verdict-vocabulary.md) | One review verdict vocabulary: three values | accepted |
| [009](ADR-009-skill-layout.md) | Skills are `<name>/SKILL.md` with mandatory frontmatter | accepted |
| [010](ADR-010-runner-invocation.md) | Invoke through the repo's own runner, never a package runner | accepted |
| [011](ADR-011-windows-support.md) | Windows is supported from v1 for the CLI | **superseded by 012** |
| [012](ADR-012-drop-windows-support.md) | Windows support dropped; POSIX only | accepted |
| [013](ADR-013-genericity-by-facts-and-local-profiles.md) | Genericity comes from emitted facts and repo-local profiles | accepted |
| [014](ADR-014-workspace-is-configuration.md) | The workspace is configuration, and a single repo is a supported shape | accepted |
| [015](ADR-015-a-source-is-content-not-a-location.md) | A source is identified by its content; the repo is a location, not a precondition | accepted |
| [016](ADR-016-a-divergent-rule-is-retired-not-merged.md) | A divergent rule is retired by a union, not merged by a variant | accepted |
| [017](ADR-017-a-declared-gate-must-be-runnable.md) | A declared gate must be one the repo can actually run | accepted |
| [018](ADR-018-an-unset-hooks-path-is-not-an-absent-hook.md) | An unset hooks path is not an absent hook | accepted |
| [019](ADR-019-a-declared-command-is-the-runner.md) | A declared command is the runner; the remedy must be one the reader can take | accepted |
| [020](ADR-020-a-rule-is-written-per-surface-and-pointed-not-copied.md) | A rule is written per surface, and pointed at — never copied | accepted |
| [021](ADR-021-one-surface-per-repo.md) | One surface per repo, chosen or defaulted to opencode | accepted |

ADR-001 to ADR-010 resolve the contradictions found across the 16 repos in the 2026-10-05
audit; each record names the repos whose text it replaces. ADR-011 and ADR-012 are the
platform decision for the CLI described in
[plan 0002](../plans/0002-simt-dev-cli.md), and they are a worked example of the
supersession rule above: 011 was accepted, 012 reversed it the same day, and 011's record was
kept rather than rewritten because the cost table it contains is the evidence 012 relies on.
ADR-013 is the same rule applied to the tool rather than to the repos: the mechanism carries
no product taxonomy, and adding an ecosystem is a profile file rather than a code change.
ADR-014 and ADR-015 are the same rule applied to the **filesystem**. ADR-014 made the workspace
optional; ADR-015 found that a repository is itself a location for a declared source, so a clone of
one repo is self-sufficient with no configuration at all. Both were found by running the tool the
way a consumer runs it, not the way its author does: the tool's own directory layout turned out to
be part of its interface, and every test that ran from the checkout could not see that it only
worked from the checkout.

ADR-016 applies the rule to rule content itself. The estate's three always-on `.mdc` families
existed in eight copies, none byte-identical, the worst pair differing by one byte while hiding
three semantic losses. The canonical body is therefore the **union** of what every copy needed —
not a per-stack variant, because two of the differences were rules each repo was missing rather
than a choice either repo made.

## The rule these records enforce

Every shared rule has exactly **one** canonical home. Every other location is either a
generated region or a thin pointer. Repeated policy text, duplicated source-of-truth, verbose
prose and redundant examples are **review blockers**, not style nits.

This ruling came out of the estate's own review agent, which already carries it as a checklist
item — in exactly one file, aimed at exactly the duplication the audit found.

ADR-017, ADR-018 and the one before them share a cause worth naming. Each was found by
running the tool the way a consumer runs it — against a real repository, doing the thing a
person would do — and not by a unit test. A test exercises the function; the defect lived in
what the function was asked, in a location it never looked, or on a surface the JSON never
carried. Two of the three were also cases of the same question being answered in two places:
ADR-018's guard could not see the default hooks directory because it looked only at a config
key, and `hooks status` carried its own copy of the read logic the shared module already had.

A fourth joins them. ADR-019 is the same shape one layer over: `simt init` dropped all
five gates on `simt-app` and told the reader to add a script to a `package.json` the
repository will never have. The facts were right, the remedy was not followable, and once
the repository declared what it does have, the dispatcher, `check` and `hooks status`
gave three different answers about one manifest. Every one of these shipped green because
the verification stopped at the tool's own gate.

A fifth joins them, and it is the first about *where* the rules land rather than what they
say. ADR-020 found that the tool's own conflict scanner read `.github/instructions/` while
the projector wrote nothing there, so three of the four editors that read this repository's
rules never received the always-on process rules at all — Cursor did. The fix was not a
missing branch but a missing table: every editor is now a named row carrying the document it
was verified against, and the test suite fails if that row emits a frontmatter key the vendor
does not document. The failure it would have caught is quiet in both directions — an editor
that ignores an unknown key, and an editor that discards a rule whose `trigger` it does not
recognise, which is what Antigravity documents.
