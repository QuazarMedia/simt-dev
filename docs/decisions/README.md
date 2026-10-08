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
| [027](ADR-027-the-one-gitattributes-line-that-is-neither-dangerous-nor-empty.md) | The one gitattributes line that is neither dangerous nor empty | accepted |
| [028](ADR-028-a-base-file-is-a-floor-so-the-disagreement-it-cannot-repair-becomes-a-check.md) | A base file is a floor, so the disagreement it cannot repair becomes a check | accepted |
| [029](ADR-029-the-pins-a-repository-declares-are-its-own.md) | The pins a repository declares are its own, so a check reports them and never writes them | accepted |
| [030](ADR-030-what-a-plan-does-not-ship-is-a-decision-with-a-record.md) | What a plan does not ship is a decision with a record, not a silence | accepted |
| [031](ADR-031-the-suite-stages-the-environment-it-needs.md) | The suite stages the environment it needs, because a test that inherits the author's directory is not evidence | accepted |
| [032](ADR-032-provenance-is-a-content-digest-not-a-commit.md) | Provenance is a digest of the content that leaves this package, not a commit id | accepted |
| [033](ADR-033-three-plan-rows-closed-by-decision-not-by-authoring.md) | Three plan rows are closed by ruling on them, not by authoring what they asked for | accepted |
| [034](ADR-034-a-staged-tool-refuses-a-partially-staged-file.md) | A staged tool refuses a partially staged file rather than staging around it | accepted |
| [035](ADR-035-one-write-decision-and-one-json-document.md) | One place decides whether a run may write, and one document says whether it did | accepted |
| [036](ADR-036-a-writer-that-writes-says-so-and-the-instructions-naming-it-move-with-it.md) | A command that writes says so, and every instruction that names it moves with it | accepted |

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

ADR-031 is the same lesson arriving from the other end. ADR-014 and ADR-015 fixed the tool's
dependence on the checkout; ADR-031 fixes the **suite's**, which had quietly reintroduced it —
nineteen tests read skill bodies out of sibling repositories and passed only on a machine that
had them. The gate had been red on every push since the first baseline record landed. What makes
this one worth a paragraph rather than a table row is the third cause it found: two tests that
passed for a reason that had nothing to do with the code, because the checkout's directory
happened to be named `simt-dev`. Those failed on nobody's machine and would have failed for
anyone who cloned the repository under a different name. A green test that asserts a folder's
name is worse than a red one, because it looks like evidence.

ADR-032 is that lesson inside the tool rather than around it. The provenance stamp was read
with `git rev-parse HEAD`, run in the package root — and for anyone who installed the package
into a repository, which is the entire audience, git walks *up* out of `node_modules` and
answers with the **consumer's** HEAD. It succeeded, so no fallback could catch it. Every
commit a consumer made moved the stamp, including commits touching nothing the tool projects,
so `check` reported drift on all three generated files and exited 1 after an unrelated commit,
and `upgrade` named a cause that was false. Where git could not answer at all the answer was
`unknown`, which the marker grammar cannot read back and `upgrade` compared against a real pin
as though the two were versions. The stamp now identifies the content that leaves the package,
which is the one thing every install can compute.

ADR-033 is the same instinct applied to a plan instead of a tool. Closing plan 0001 meant auditing
each row against the tree, and three rows asked for things that had never been decided: seven agent
policies with no surviving source anywhere in the estate, a skill-collapse step that a mechanism
landed two hours after the plan was written already answered, and two `local.properties` files that
were committed on purpose. Each is closed by saying so, because the failure the plan's own text
invites is a reader concluding a mechanism is outstanding and going to build it.

ADR-034 is the same instinct in a hook, and the second time the defect was a promise the code
already made in writing. `src/hooks/gates.mjs` defines a staged gate as one that runs over the
staged files only, precisely so that "whole-repo formatting from a pre-commit hook" cannot
"rewrite unstaged work the author did not ask to touch" — and the dispatcher then ran
`git add` on every staged path. A file staged with `git add -p` came back with its unstaged
hunk replaced, not merely committed, and the gate said nothing. The same loop also fed
staged deletions to `git add`, whose failure was swallowed, so a commit holding a deletion and
a formattable file recorded unformatted bytes silently. Both are the shape this estate's rules
keep warning about: a control that appears to hold, reports pass, and does not.

ADR-035 is the same thing measured across a whole command surface instead of one control.
Six commands disagreed about what `--yes`, `--dry-run` and `--json` mean: `upgrade` read
`--yes` and ignored `--dry-run`, `skills install` read neither and printed "nothing written"
on the path that wrote, and `doctor --json` and `hooks status --json` both reported `ok: true`
while the same commands in a terminal exited non-zero. Two of those are the shape above
again — a check that appears to hold and reports pass. The difference is where the fix goes:
one function decides whether a run may write, and one table asserts the JSON contract for
every command at once, because a contract checked one command at a time is checked by
whoever remembers.

ADR-036 is the deferral that record made, settled. ADR-035 left `sync` writing by default
because the change belonged to a slice that depended on it, and wrote the reason down
twice rather than quietly half-applying it. Measured afterwards, `sync` was the only
writer left that rewrote a file a bare invocation had no permission to touch — and it is
the command a caller reaches for most, because it is the one that regenerates the text in
front of them. The second half is the half that would have been easy to skip: the note
inside every generated region and the comment in every manifest both tell the reader to
run that command, and both ship into repositories that have no other copy of the
instruction. A flag that changes what a command does without changing what the tool says
about it leaves a permanently-false instruction in every repository in the estate, which is
the same failure as a check that reports pass and does not hold — one layer up.

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

An eleventh goes back to a deferral and finds it was one line too broad. The ninth refused
`.gitattributes` because every line that earns its place in a shared region changes what git
does to the working tree, and concluded the region would be "either dangerous or empty" —
which is true of every attribute worth sharing and false of the file. Thirteen of sixteen
repositories had none at all; the three that did agreed about almost nothing. What survives
is one line, and its safety is a single word: `text=auto` detects rather than instructs, so
`* text eol=lf` — the usual way a repository quietly corrupts its own binaries — is the form
the shared region refuses to use. Line endings were left unruled in the ninth because a
repository wanting CRLF could only opt out by deleting the region; here it opts out with one
line beneath it, which is what last-match-wins is for.

A twelfth turns out to be about a limit rather than a mechanism, and the limit is the
record. Row 5 named two tsconfig problems and they look like one: seven strictness flags
missing from a repository, and one option spelled `Bundler` in three repos and `bundler` in
a fourth. `tsconfig.base.json` fixes the first. It cannot touch the second, and no amount of
thinking about it will make it able to — a child overrides every key its parent sets, so a
base file is a floor for what is *missing* and is inert for what is *spelled differently*.
Writing that limit down is what turned the second problem into a check, which is the only
form of it a reader can act on. It also decided what the floor may contain: `noEmit` is
inheritable and two of these repositories bundle elsewhere, so shipping it would have
silenced the emit in a repository nobody had looked at.

A thirteenth is the first one that finds the plan wrong. Row 5 offered to resolve "three
disagreeing `.nvmrc` files", and reading them showed each one agrees perfectly with its own
`engines`; what differs is three repositories choosing different node majors, which is a
decision each has a reason for. There was no defect to resolve, and the useful half of the
work was ruling out the check that would have reported it — with a test, so completeness
does not put it back. What is left is one real defect, and it is the first shipped baseline
with no correct value to write: the npm version is not in `package-lock.json`, and a node
floor is as many answers as the team has reasons for. So this one ships no file at all. It
reports, and every remedy is a command run where the answer exists, which is the only shape
available when the tool can name the field and the manager but not the version.

A fourteenth ships nothing at all, and that is the point of it. The first six baselines each
hit a mechanism question — a region or a whole file, a floor or a check, a value to write or
no value to derive — and each answer was waiting for somebody to find out what the format
permits. The two items still open in the plan have no such question, because nobody has
decided whether they should exist: commitlint is named by the plan and by no rule file and
by no `package.json` in the estate, and the ESLint "block" cannot describe two of the four
configurations because they have no TypeScript in them at all. Writing that down in the rows
that asked for them costs less than shipping either one would, and it is the difference
between a row that says "unfinished" and one that says "undecided". It also corrected two
counts the plan got wrong, which is only possible because somebody read the estate rather
than the plan.
