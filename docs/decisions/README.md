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
| [025](ADR-025-a-baseline-is-a-region-in-a-file-the-repo-owns.md) | A baseline is a region in a file the repo owns, and only a file that can hold one | accepted · rulings 1 and 2 narrowed by 026 · ruling 8 withdrawn by 048 |
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
| [037](ADR-037-unchanged-means-writing-would-not-change-a-byte.md) | `unchanged` means writing would not change a byte, not that the body matches | accepted |
| [038](ADR-038-the-gate-filter-belongs-to-every-manifest-writer.md) | The gate filter belongs to every writer of a manifest, not to `init` | accepted |
| [039](ADR-039-a-ci-step-runs-a-form-that-can-fail.md) | A gate a CI step runs must have a form that can fail, and a refusal is a failure | accepted |
| [040](ADR-040-the-last-writer-that-wrote-by-default-was-not-the-one-named.md) | The last writer writing by default was not the one the finding named | accepted |
| [041](ADR-041-the-suite-installs-the-package-in-order-to-test-it.md) | The suite installs the package in order to test it | accepted |
| [042](ADR-042-a-declared-glob-must-match-a-path-built-from-it.md) | A declared glob must match a path built from it | accepted |
| [043](ADR-043-a-keyword-is-a-phrase-and-two-letters-is-a-word.md) | A keyword is a phrase, and two letters is a word | accepted |
| [044](ADR-044-compatibility-is-not-evidence.md) | Compatibility is not evidence, and a resolver nobody measured is merely felt | accepted |
| [045](ADR-045-a-dashboard-that-counts-a-defect.md) | A dashboard that counts a defect and will not name it is worse than one that does not count it | accepted |
| [046](ADR-046-one-rule-one-copy.md) | One rule, one copy: a reader that reads AGENTS.md must not also get the file | accepted |
| [047](ADR-047-a-profile-selects-on-what-a-repository-runs-on.md) | A profile selects on what a repository runs on, not on what it is written in | accepted · refines ADR-013 r1 |
| [048](ADR-048-a-baseline-carries-only-keys-a-reader-honours.md) | A baseline carries only keys a reader honours | accepted · withdraws ADR-025 r8 |
| [049](ADR-049-a-ruling-that-a-later-record-moved-says-so-where-it-is-printed.md) | A ruling that a later record moved says so where it is printed | accepted |
| [050](ADR-050-a-byte-count-is-not-a-region-and-updated-is-not-a-change-of-rules.md) | A byte count is not a region, and `updated` is not a change of rules | accepted |
| [051](ADR-051-a-pointer-is-the-readers-only-route-so-it-is-not-a-convenience.md) | A pointer is the reader's only route, so it is not a convenience | accepted |
| [052](ADR-052-a-dependency-is-counted-against-the-budget-and-there-is-one-budget.md) | A dependency is counted against the budget, and there is one budget | accepted |
| [053](ADR-053-the-node-floor-is-22-20-0.md) | The Node floor is 22.20.0 | accepted |
| [054](ADR-054-the-digest-covers-every-byte-that-leaves-the-package.md) | The digest covers every byte that leaves the package, and a cause is read off the body | accepted · amends ADR-032 |
| [055](ADR-055-a-status-line-travels-so-it-may-not-name-a-location.md) | A status line travels, so it may not name a location; prose is the record's own argument | accepted |
| [056](ADR-056-three-names-one-of-which-is-cheap-to-move.md) | The command, the package and the project are three names, and only one of them is cheap to move | accepted · amends ADR-023 |

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

ADR-037 is the same failure inside the projection primitive, and the first record here whose
finding arrived with a line number and turned out to be two branches over. Review 0002's S29
pointed at the code that appends a region to a document that has none; that branch was
already correct. The blank line was missing in the code that *replaces* one, so the defect
only appeared once a repository already had a region — which is every repository that has
been adopted. The list case is worth reading for what it says about the failure: with no
separating gap, a Markdown formatter reads the whole region as a continuation of the last
list item and indents every line of it, so the file comes back changed in a way no amount
of careful body comparison would notice. The second half is the part that made the first
worth doing: a body that matched behind a wrong seam was reported `unchanged`, so `check`
found nothing to report and `sync` had nothing to repair, and the repository was red on its
own formatter with no remedy on offer. Fixing the seam without that half would have shipped
a fix that worked once, for the one repository whose rules happened to change next.

ADR-038 is the same failure once more, and the smallest instance of it so far: a decision
record that named the right rule and attributed it to the wrong command. ADR-017 ruled that
a gate is declared only if the repo can run it, and wrote *"`init` filters the stack table's
proposals"* — so for as long as `init` was the only writer of a manifest, the belief and the
code agreed. `skills install` also writes one, for a repo that has none, and it did not
probe. The result was four gates in a repo with no scripts and no formatter, `check` red on
all four, and a pre-commit hook that blocked the first commit it was installed in front of.
Nothing about the rule was wrong; only the sentence that carried it. That is what the
`Affects:` line on a record is for, and this record amends one in place of editing it —
because a reader who finds the record and trusts it has to be able to trust the whole of it.

ADR-039 is the same shape turned on the tool's own controls, and it is the only one of these
whose subject is a gate that was enforcing a gate. This repository's workflow carries a step
named "the gate copy in this repo is current", commented as the place the drift would be
caught, running `simt-dev ci`. With a hand edit in that copy, `ci` printed the drift and
exited 0 — so the step read the thing it was written to catch, said it out loud, and passed.
Every other record here is about a check that reports pass and does not; this one is about
the check on the checks. The same slice found two smaller instances of the same habit in the
same command: `--json --dry-run` printed no document at all, because the mode guard was in
the wrong place, and a refusal in a repository that adopted simt-dev printed a paragraph
saying it was refused directly above `ok: true` and exited 0.

ADR-040 is the only one here that says a previous record's *premise* was wrong, and it is worth
reading for the shape rather than the command. Review 0002 opened Wave 0 with "`sync` is the only
writer that writes by default" and named five siblings that "all preview first". Four were. The
fifth, `hooks install`, read `flags.yes` and `flags.dryRun` directly, imported no write decision
at all, and wrote the shims and repointed `core.hooksPath` whenever neither flag said otherwise —
in the ordinary case, where ADR-018's takeover consent never fired. Three strings that ship into
adopting repositories assumed the preview, one of them inside the shim being installed, and 586
tests passed. What makes it a rule rather than a fix is that the same commit had to amend a
comment written the day before, which called `hooks install` a previewing writer; a comment that
enumerates which commands follow a rule is a claim about code its file does not own, and the next
reader has no cheap way to check it. So the writers are a set, the set is checked by a table, and
the table asserts the exit code as well as the bytes — because a command that *refuses* also
changes nothing, and "wrote nothing" is the one claim a refusal satisfies for free.

ADR-041 is the one that closes the gap those other records kept falling into. Every test in this
repository imported from `../src`, which is right for a unit and blind to the artefact: S01 shipped
a package whose `files` list and whose runtime reads disagreed, with the whole suite green, because
no test was reading the tarball. The fix is not a better assertion but a different subject — pack
the working tree, install it with `--offline`, and drive `node_modules/.bin/simt-dev`. `--offline`
is the load-bearing word, and it is a constraint rather than a setting: the package has no
dependencies to install, so adding a build-time or test-time tool starts costing a network on a
cold runner, and a suite that fails there gets skipped, and a skipped test is indistinguishable
from a passing one. The same constraint is why one thing that test cannot assert is recorded as
open instead of worked around: there is no formatter to run over the output, so S29's second
acceptance half stays pending and the seam it would have caught is asserted structurally in
`markers.test.mjs` instead.

ADR-042 is the smallest instance of the same habit: a declared value nobody ever executes. 13 of the
registry's 65 path globs began with a double star, which compiled to an invalid regex that a `catch`
turned into `false`, so the heaviest signal the resolver has was silently dropped for every skill
that used one. The lint rule that keeps the registry honest asked only whether `paths` was *present* —
the same question, in the same file, that `checkStack` had already answered for stack tags by
rejecting a tag the detector cannot emit. A glob that matches nothing is that failure under another
field name, so `graph lint` now requires each declared glob to match a path built from itself. Its
third ruling is the part worth carrying forward: the registry-wide test reads the same generator the
lint rule validates, so narrowing the generator narrows the test in step, and the test passed with
the generator sabotaged. A check that shares its subject with the thing it checks has to have its own
assertion about that subject.

ADR-043 is the same failure in the other half of the resolver, and the word that connects them is
*declared*. A hand-authored field is checked for being present and well-formed, which is a question
about the file, while the resolver asks whether the value can reach anything — and a value nobody
executed costs nothing to write. Thirteen globs matched nothing (ADR-042); thirteen keywords could
never be produced by a task, including `durable object`, declared on three skills and dead on all
three. Two filters were responsible: a tokenizer that discarded every word of length two, which in
this domain is where `d1`, `r2`, `kv` and `ci` live, and a keyword comparison that asked whether one
task token equalled the declaration, which no multi-word keyword can ever satisfy. Both were filters
on precision applied to a registry whose values were never reachable in the first place — the same
inversion, in the same file, one field over. It also records what the fix costs, because it does
cost something: six two-letter stopwords now reach the summary signal, while `the` already selected
eleven skills before the change. The honest reading is that S04's threshold was too low all along,
and hiding that by putting the floor back to 3 would make `d1` disappear again.

ADR-044 is what came after the two above, and it is the first of the three that is about the shape of
an argument rather than about a broken value. The resolver asked two questions of a skill — *is this
compatible with my repo* and *is this about my task* — and scored them into one number. The gate had
already answered the first, so a skill matching three stack tags reached 45 points having said nothing
about the task, and any score above zero selected. Meanwhile a shared word of English was worth 8 and
cleared the bar, so a brief for "fix a typo in the README" filled a 20 KB budget with launch galaxies.
The rule it lands on is one sentence: compatibility is a precondition, not evidence, and a
precondition must not be counted twice. It also carries the first gold corpus, because plan 0002 has
claimed an `eval` corpus since before this file existed and every ranking change until now was argued
from examples. The corpus immediately earned its keep by failing a case where the resolver was right and
the author was wrong — two skills written into a rejection list both declare the `contract`
capability, and a hand-authored gold set is an opinion written down. Its fourth mutation is the one to
remember: reverting the third of three commands to its own older copy of the rule passed all 621 tests,
because nothing checked the set. ADR-035 said a promise about a set of commands holds only while
something checks the set; that sentence was written about seven writers and turned out to be about
three readers too.

ADR-046 is the third of these records to be settled by running the command against the estate
rather than by reading the code, and the first to overturn an earlier ruling on a fact about a
vendor. ADR-021 decided that a Cursor reader could not be reached through `AGENTS.md` — so a repo on
`opencode,cursor` was given the same three rules twice, once folded and once in `.mdc`, across five
repositories and 28 KB. Cursor's documentation says plainly that it reads `AGENTS.md`. The claim was
false when written, and it was false in a way simt-dev's own surface table already contradicted: the
`readers` line on the opencode row names Cursor as reading `AGENTS.md` natively. A decision that
depends on a fact should be checked against the file that records facts, and here that file was one
row away.

Its more useful lesson is the one that cost the most. The first version of the change made the
estate go *quiet*: `staleRuleFiles` fell from 17 to 0 and every one of those files was still on
disk, still being read twice. Then the fix for that scanned the wrong set and reported nothing at
all, because a file becomes orphaned exactly when a repo drops the surface that wrote it. Both were
found by running `compare` over sixteen repositories, not by reading the code. The flip side is worse:
three of six mutations passed all 627 tests, including the one that would have made a gate nothing
can satisfy — a file simt-dev will never write again and may never delete. A feature whose failure
mode is "the tool silently stops looking at something it wrote" needs a negative control, because
the broken version returns an empty list and passes every positive test.

ADR-047 is the same rule applied to what a profile *selects on*, and it refines ADR-013 ruling 1
rather than overturning it. ADR-013 promised genericity from emitted facts and repo-local
profiles, and said detection emits facts and profiles select on facts. But the shipped
`simt-applies` lists were keyed on language tags — `typescript`, `gradle`, `react` — which name
what a repo is *written in*, not what it *runs on*. So any TypeScript library received Cloudflare
Workers rules (D1, Durable Objects, wrangler), a Spring backend on Gradle received Compose and
Wear OS rules, a React Native app received web CSS rules, and a Poetry project received `uv`
rules. The defect was invisible in the usual way: the selection was deterministic, every test
passed, and the profile simply landed in the wrong ecosystem. The fix is data plus `has-*`
facts, exactly as ADR-013 requires — no engine change — and the one piece that needed a mechanism
was `has-android-manifest`, a nested path, which is the glob walk S07's dependency closed.

ADR-048 is the first record here to withdraw a value rather than a mechanism, and it
found it by reading a format's specification instead of its own source. The shared
`.editorconfig` shipped `[prettier] singleQuote = true` under a comment explaining why
that section was the right home for the estate's one formatting disagreement. An
editorconfig section header is a glob over paths, so `[prettier]` matched a file named
`prettier`; and `singleQuote` is not one of the nine keys the specification defines, nor
one of the six properties Prettier maps. The specification says what an undefined key
does — cores accept and report it, plugins ignore it — which is the worst possible
outcome: a line that parses, in a file that was current, enforcing nothing. Nothing in
this tool could have seen it, because the gate compares bytes and the bytes agreed with
the shipped body. The spelling that does work is `quote_type`, and the survey says not to
use it: three of the five repositories running Prettier already state `singleQuote` and
two do not, so a shared value reformats every source file in those two on the day they
adopt the tool. The lesson is the narrowest one in this file — a baseline earns its place
by naming a key a reader honours, and the ability to hold a comment says nothing about
whether anything reads what is inside.

ADR-049 is the same failure one level down, and it is the reason this index exists: a
citation has to be resolvable, or it is decoration. `rules why ADR-023` printed the status
`ruling 2 superseded by` — a sentence with no object, because the status is a paragraph and
the parser read one line of it — and then printed ruling 2 as a ruling in force, which is
the reversal the module's own header names as its failure mode. Making the status a
paragraph is half the fix and the other half is a trap: the obvious pattern for
whole-record supersession then matches *ruling 2 superseded by ADR-024*, and five rulings in
that record that the status line itself says stand would have been dropped by the field
that exists to stop exactly that. Underneath both halves is the thing neither the finding
nor the fix mentioned — the rulings are numbered in five different ways across the records
and the extractor read one, so ADR-045 declared six rulings and printed one, and ADR-013
printed the literal text `### 2.` to an agent. A supersession names a ruling by number, and
a number that cannot be located cannot be reported as no longer in force. The record's
ninth ruling is the mutation that earned its keep: dropping the ordinal from `**One.**`
passes every test in the suite, because no record in the estate has both a word-numbered
ruling and a partial supersession to catch it — the failure ADR-042 recorded, reproduced
inside the fix for it.

ADR-050 is the same habit in a command rather than a reader, and its finding named one line
of code where the defect was two questions. `upgrade` decided a repository had no region by
asking whether its `AGENTS.md` was empty, which a hand-written one never is — so a version
bump wrote nine kilobytes of rules into a repository that had never asked for any. But the
obvious repair, asking whether every *region* is absent, reproduces it exactly: the estate
builds this state by adopting and then replacing `AGENTS.md` by hand, which leaves the
baselines' regions in place, and a guard that sees two regions concludes the repository is
adopted. The question was never about all the files. The second half is a trap of the same
shape: ADR-037 made a correct body behind a wrong seam report as `updated` so that `sync`
would repair it, which gave one field two meanings, and the command whose entire job is to
say *why* a repository is behind was reporting a formatting repair as a change of policy.
The reader is told to diff rules that did not move. Both are the same mistake: a field read
for the thing it was not.

ADR-051 is the same mistake about a *file*, and it is worth reading for where the belief
came from. `CLAUDE.md` was classified as a convenience and a misaimed pointer made the gate
go green, on the reasoning that "the editors that matter already read `AGENTS.md`" — which
this repository's own pointer table refutes with a quotation from Claude Code's
documentation: *"Claude reads CLAUDE.md by default and AGENTS.md only as a fallback."* A
pointer is not a second copy of a file, it is the route to one, and the old test named
DeepSeek's loader rendering a drifted copy beside its twin. That observation is true and it
is about duplication; a symlink aimed elsewhere is not duplication, it is a reader looking
at the wrong file. The belief was written down in a test, so the finding it produced could
not see it. The second half was worse and quieter: a directory at `CLAUDE.md` — which is
where Claude Code keeps per-project instructions — was classified as *absent*, so `check`
said nothing and `sync` crashed with `EEXIST` after writing every other target, naming
`simt-dev doctor`, which reports nothing about it either. The note that would have said so
printed `undefined bytes`, and `undefined` in a report reads as nothing at a glance.

ADR-052 is the same habit in the resolver, and it is the first record here where the *fix*
was the second copy of the logic rather than the first. The budget loop existed in `skills
brief` and in the MCP tool, and both tested `entry.via.size > 0` and inlined a dependency
whatever it weighed — so `--skill parallel-feature-team --budget 2000` resolved **13,503
bytes against a 2,000-byte budget**, with nothing in the output saying so. The comment gave
the reason: *"a skill that is useless without its dependency is worse than a large context,
because it silently misleads."* The premise is right and the conclusion does not follow: a
missing dependency is fixed by a line in the output, and an unbounded budget is not a fix
for anything. The copies had also drifted — one tested `deferred` first and never inlined
one, the other tested it second and would inline 384 KB — so the same question had two
answers and neither could see the other. ADR-035's sentence about a promise about a *set*
of readers holds only while something checks the set; here the check is a test that drives
both surfaces and compares them, because two copies asserted separately drift and two
copies asserted against each other do not.

ADR-054 is the same habit found in the stamp itself, and it is worth reading for the order
the two defects arrived in. ADR-032 ruled that the digest covers `rules/` and `graph/` and
deliberately excludes `src/`, on reasoning that still holds: a refactor that projects
byte-identical bytes must not move a consumer's stamp. But the exclusion was drawn around a
*directory*, and the shared `.editorconfig` and `.gitattributes` blocks are not in one — they
are two string constants in `src/projection/baselines.mjs`, and every adopting repository
receives them. By ADR-015's own rule a source is identified by its content rather than by the
file it lives in, so those bodies were excluded content, not excluded code. What exposed it
was an unrelated slice: deleting seven inert lines from a shipped baseline was the first
change here that moved bytes out of `src/` without moving the digest. `check` caught it,
because the gate compares bytes. `upgrade` did not, and printed a pin that was unchanged
beside a restamped region, and then named the cause as *the rules changed* — two false
sentences, one caused by the other. With the stamp silent about a baseline, the only cause
left to report was the one least likely to be true, and the reader is sent to diff `rules/`
when the change is in `.editorconfig`. So the fix is two halves that have to land together:
the digest now covers the rendered baseline bodies and names them by the file they become,
and `upgrade` reads its cause off the projected body with the two kinds of content counted
apart. The second half is the one worth keeping, because it is what makes a stamp that
cannot see a change stop being able to invent one.

ADR-055 is the same rule applied to the record index, and it is worth reading for a finding
that grew while it was being fixed. The review filed this as "two records out of
forty-eight, pre-existing". Re-measuring the corpus said five — three of them written after
that measurement, including two in this cycle, by the same convention each time: put the
clause in `Status:`, because `Status:` is the line the tool reads. It is the one line
guaranteed to travel, into repositories that own none of this package's files, so the path
arrives there resolving against nothing. `Affects:` is the field for it and is deliberately
not printed; five records had one available and used the other. What makes the record worth
keeping is ruling four and its cost: the ruling covers `Status:` and deliberately not the
record's own argument, because `docs/plans/` means this package's plan in one record and the
reader's own plans in another, and four records use that exact string for both — so a
redaction there would corrupt them to protect six. Six prose leaks therefore remain, and a
test asserts the count and the ids rather than leaving them as an unmeasured shrug. The
docstring that used to claim the whole output "never contains a path" is withdrawn: it
asserted a property the function never had, which is the same defect as a citation that
cannot be resolved — a sentence that reads like evidence and carries none.

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
five gates on `repo-05` and told the reader to add a script to a `package.json` the
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
