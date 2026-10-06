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
| [022](ADR-022-a-key-simt-dev-reads-is-prefixed.md) | A key simt-dev reads is prefixed `simt-`; an editor's key is not | accepted |
| [023](ADR-023-the-gate-ships-as-a-file-the-repo-owns.md) | The gate ships as bytes the repo owns, written once where Actions already runs | accepted · ruling 2 superseded by 024 |
| [024](ADR-024-simt-dev-overwrites-its-own-gate-file.md) | simt-dev overwrites its own gate file, and no repository else's | accepted |
| [025](ADR-025-a-baseline-is-a-region-in-a-file-the-repo-owns.md) | A baseline is a region in a file the repo owns, and only a file that can hold one | accepted · rulings 1 and 2 narrowed by 026 |
| [026](ADR-026-a-config-without-a-region-is-a-file-the-repo-owns.md) | A config whose grammar cannot hold a region is a file the repo owns | accepted |

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

A sixth is about a key rather than a byte, and it came from a question asked about this
repository's own rule files rather than from a command anyone ran. A canonical `.mdc`
frontmatter block holds Cursor's keys and simt-dev's in one list, and `alwaysApply: true`
sat four lines away from `applies: always` with nothing to say which reader owned which.
ADR-022 gives every key this tool reads a `simt-` prefix, leaves the vendors' spellings
alone, and makes an unrecognised key a reported defect — because the mistake it looks like
is the one ADR-016 already shipped: a rule that reaches no repository because its
selection key was missing.

A seventh is about the gate itself. Plan 1 promised a reusable workflow referenced by
every consumer, and nothing in this repository had a `.github/` directory. A `uses:`
line satisfies the promise by pointing every reader at bytes they do not have — the exact
defect the rule at the top of this file exists to prevent — so ADR-023 copies the gate
into `.github/workflows/` instead, writes it once, never rewrites it, and skips it
entirely for a repo that does not run GitHub Actions. The record also states what the
choice costs: a template improvement does not reach a repo that already has the file, so
that limitation is written down rather than left for someone to rediscover as a bug.

An eighth narrows it, and the reason it was needed is the shape of ADR-023's own cost.
Write-once is right for a repo whose file may contain their deployment job, and wrong for
the one repository that owns the template: a gate file that is a frozen copy of the gate is
a second gate nobody maintains, and ADR-023 ruling 4 means nothing would ever report the
gap. ADR-024 gives the exception exactly one boundary — a path, not a flag, because a flag
is a spelling for the wrong answer — and refuses `simt-dev ci` everywhere else. Both copies
say which world they are in, in their own header, because the reader of a diff in this
repository should not have to guess who changed their CI.

A ninth is about a file rather than a byte. The plan's tooling row asks for eight
baselines and the same plan, eight sections earlier, already said how they should work:
a generated region, so local content is never clobbered. Six of the eight are JSON or bare
strings and cannot hold a region, which is not a reason to ship them anyway — it is the
answer. `.editorconfig` can, so it is the baseline, and it goes in first so the repo's own
settings keep winning underneath it. `end_of_line` is left out on purpose: it is a claim
about line endings, which is `.gitattributes`' claim to make, and a repository that wanted
CRLF could only opt out by deleting the indentation settings with it.

A tenth supplies the counterexample the ninth predicted, and it arrives as a file that was
already owed: no repository in the estate had a Dependabot config, and the plan named that
as missing before any of this existed. The ninth said a config whose grammar cannot hold a
comment is ruled out as a baseline, and left its consequences promising that the next such
file would need a different mechanism. This is that mechanism, and it is not a new idea —
it is the gate's own ownership rule, unchanged, pointed at a file whose `updates:` is a YAML
list and therefore has nowhere to put a region. The lesson is narrow and worth stating
plainly: partial ownership was never the reason the gate file is write-once, and a rule read
as depending on mergeability will predict the wrong answer here. What detection buys is
different — an entry per manifest the repo actually has, so the config never names an
ecosystem that would sit there opening no pull requests.
