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
| [014](ADR-014-workspace-is-configuration.md) | The workspace is configuration; a single repo is a first-class case | accepted |

ADR-001 to ADR-010 resolve the contradictions found across the 16 repos in the 2026-10-05
audit; each record names the repos whose text it replaces. ADR-011 and ADR-012 are the
platform decision for the CLI described in
[plan 0002](../plans/0002-simt-dev-cli.md), and they are a worked example of the
supersession rule above: 011 was accepted, 012 reversed it the same day, and 011's record was
kept rather than rewritten because the cost table it contains is the evidence 012 relies on.
ADR-013 is the same rule applied to the tool rather than to the repos: the mechanism carries
no product taxonomy, and adding an ecosystem is a profile file rather than a code change.
ADR-014 completes it on the filesystem, where ADR-013 did not reach: the tool's own directory
layout turned out to be part of its interface, and every test that ran from the checkout could
not see that it only worked from the checkout.

## The rule these records enforce

Every shared rule has exactly **one** canonical home. Every other location is either a
generated region or a thin pointer. Repeated policy text, duplicated source-of-truth, verbose
prose and redundant examples are **review blockers**, not style nits.

This ruling came out of the estate's own review agent, which already carries it as a checklist
item — in exactly one file, aimed at exactly the duplication the audit found.
