# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### A gate report keeps the failures and counts the passes

`simt gate` compacts a report it knows how to read: TAP, JUnit XML, pytest's junit file, vitest or jest JSON, and `go test -json`. Failures come first, with the name, the assertion and the location. Passing tests are a count. The raw log path is printed. Anything else is printed unchanged (ADR-095).

### A change runs the tests that import it

`simt gate` selects the test files that import a changed file, directly or through other files, and runs only those with the package's own runner. Paths name the change. `--changed` reads the diff. A clean diff runs nothing. Changing `src/resolve/resolve.mjs` in this checkout selects 51 files, the hand-built list, in about 40 ms. The bar is 5 seconds (ADR-094).

### what governs a file is the decision, rule, skill, gate or lesson that names it

`simt why` reads an Affects line as the tokens in backticks, including a line the paragraph wraps onto. A token that is a command, a path, or a glob is an edge. A token that is none of those is printed as `UNRESOLVED-AFFECTS`. Rules, skills, gates and lessons contribute the path lists they already publish. At `4c27514` every one of the sixteen Affects tokens resolves or is reported, and ADR-017 is the only record that names the dispatcher (ADR-093).

### The tests of a file are its importers, its conventional neighbour, and its coverage

`simt tests` lists the tests that exercise a file. An import counts, including one whose specifier is on the next line and a dynamic `import()`. So does the conventional source beside the test, and a coverage record that names both sides. Files that only share commits are a separate list, added with `--cochange`. On 30 hand-labelled files in this checkout every predicted test is in the label. The bar is 0.8 (ADR-092).

### The map ranks the files a task is likely to touch

`simt map` orders the index by the task's words and by the import and call edges around them. It renders paths, exported names, or signatures, inside a byte budget. `simt bench report` prints recall@10: the mean fraction of a mined task's gold files that land in the top 10. On the 20 mined tasks measured here that figure is 55.6%. The bar is 60% (ADR-091).

### The index names the exports and the imports

`simt index` fills symbols and import edges from the blob it already hashes. The built-in extractors are line-oriented, for the languages a map needs, and on the labelled fixtures they recall at least 90% of the exported names for TypeScript, Kotlin, Python and Go. A structural parser is a separate package named by `index.parsers`; with that key absent, nothing is loaded. It writes cache rows and does not edit the repository. A live comparison against tree-sitter is unmeasured (ADR-090).

### The local index is a cache of git blobs

`simt index` rebuilds `.simt-dev/index.sqlite` from `git ls-files`. A blob that has not changed is not read again, and the same blobs produce the same rows. When this Node cannot open `node:sqlite` with FTS5, the same rows are written to `.simt-dev/index.jsonl` instead (ADR-089).

### A marked line is enforced by a checker

A rule line may name a checker with `simt-check`. The projection keeps `Enforced:` and the checker's name, and `simt check` runs the checker. The file-length line is `max-file-lines`: past 400 lines warns, past 1000 fails, and a path is exempt only when `limits.fileLines.generated` names it. `import-direction` stays in the prose until the module graph exists. Probe compliance is unmeasured (ADR-088).

### A run is evidence for one tree

`simt evidence` prints the runs recorded against the tree on disk. A gate the dispatcher runs appends a line: the command, the exit, a short summary, and a digest of the output. Editing any file changes the tree, so that line no longer applies. `simt evidence check` warns when a commit message says the tests passed and this tree has no passing line, and fails the commit when `gates.evidence` is `block`. `simt hooks install --yes` writes the commit-msg shim only when that setting is present (ADR-087).

### A workspace carries its repeated rules once

`simt shared plan` names the rules every repository in a workspace renders with the same bytes, and where each harness would load that copy. `simt shared install --yes` writes the copy into the user-level file the harness actually reads, and records the ids on each repository's manifest under `shared`. The next `simt sync` drops those rules from the region and names them, with the command that shows each one. `simt doctor` says when the copy is missing or stale, and does not fail the repository for it. The 30 KB estate bar and the bench comparison are unmeasured (ADR-084).

### The region ends with the names of what it kept out

The generated region ends with a `## Disclosure` section: one line per scoped profile, with the patterns and the files it moved to, and one line per installed skill, with its name and the description that says when to open it. The skill body stays in its file. A surface that cannot narrow a profile still carries that profile in the region (ADR-085).

### The stable prefix comes first

Shipped rules lead the region, and the command card follows them, so an edit this repository makes changes only the tail. `simt sync --yes` writes `simt-dev.lock.json` with an input digest and an output digest. `simt check --frozen` fails when the output moves and the inputs did not, and names a stale lock separately (ADR-086).

## [0.3.0] — 2026-10-17

### The rules and the decisions are readable as MCP resources

A client that wants to browse this tool's rules and rulings had no way to: every answer came back from a tool call with an argument in it. They are addressable now, as one URI per rule and one per decision record, with the byte size each will cost stated up front — the one number a client cannot get without spending the read.

Both resource revisions of the specification were read rather than recalled, and they disagree about the behaviour that decides whether a client retries or gives up: a missing resource is `-32602` on the newest revision and `-32002` on the two older ones, and neither lets a server answer with an empty body. A decision record is redacted on the way out, because a resource travels further than the CLI did (ADR-074).

### A plan is resumed one slice at a time

`simt plan next` returns the next ready slice and only its section. `simt plan done` rewrites that one row, and previews the change unless `--yes` is given. The directories and the table format come from the `plans` key in `simt.json` when a repository sets one; otherwise the tracker template delivered with the tool is used, which reads `docs/plans` and `docs/reviews` (ADR-081, ADR-082). `init` keeps a manifest key it does not write, which is what lets `plans` survive a re-init.

### The rules are enforced at the tool call

Three rules that text does not hold — a `git push`, a `--no-verify`, an edit inside a generated region — are now a decision before the tool call. `simt agent-hooks install` writes one policy into the harnesses that read a hooks file, and keeps every key it does not own. `simt agent-hook` is the entry point those harnesses call (ADR-079).

### A line the repository already proves does not ship

A rule line may say when the repository already proves it. `simt sync` drops that line, and `--explain` names the line and the fact, so a removal is visible rather than silent (ADR-078).

### The region leads with this repository's commands

The projected region opens with the commands this repository actually runs, derived from its committed gates and runner, in both the full projection and kernel mode (ADR-077).

### A change to what an agent reads can be measured

`simt bench mine`, `run`, `report`, `ablate` and `probes` measure a change to projected context against tasks taken from this repository's own history. A change that cannot be run says `unmeasured` in its record rather than implying a result (ADR-076).

### What each reader loads, and a transcript split

`simt harness loaders` reports what each reader loads at session start, in bytes, and what its size cap drops. DeepSeek is one of those readers. `simt tokens --session` splits a local Claude Code or Codex transcript into rules, file reads and tool output.

### A name this tool owns is not reported as a repository

`simt rules why` keeps this tool's own names (`simt-priority`, `simt-hooks`, and the rest) and still redacts a repository the reader cannot open (ADR-080).

## [0.2.2] — 2026-10-14

### A repository can ask for a smaller projection

`simt tokens` measured the cost and `check` now holds the line the repository draws: `budget.bytes`
in `simt.json` is how many always-on bytes that repository has agreed to carry, and both the meter and
the gate report the overflow with the two numbers in them. It sits beside `gates` rather than inside
`projection`, because that key belongs to this tool and an upgrade replaces it.

`mode: kernel` is the other half. It keeps the rules a reader cannot do without — the ones a hard
constraint or a command depends on — and defers the rest behind a `## Deferred rules` section that
names each one and the command that shows it. A Python fixture projects 16% smaller. `full` is still
the default, because nobody has measured yet whether the smaller projection loses compliance, and a
tool that made that trade silently would be deciding it on the reader's behalf (ADR-073).

### A repository can declare how many always-on bytes it is willing to carry

`simt tokens` has reported that number since the meter landed, against a constant nobody
could argue with. A repository can now say what it will carry — `budget: { bytes: N }`
beside `limits` and `gates` in the manifest — and both `simt tokens` and `simt-dev check`
measure against that line. One declaration, one meter, one function that words the finding.

The declaration is deliberately *not* inside `projection`, which is the one block this tool
owns and `upgrade` is allowed to replace: a number written there would be deleted silently
on the next upgrade and never reported as drift. And a repository that declares nothing is
reported as declaring nothing, rather than being quietly handed the default as though it
had chosen it.

Over budget is reported and never fails the gate. Nothing was cut — the projection is
still full mode, every rule loaded as written — so the honest thing to say is "you are
over your line", not to fail a repository over a ceiling it wrote down itself. Which rules
move behind skills stays with the evaluation that has to decide it (ADR-072).

### A repository can declare the always-on bytes it intends to carry

`simt tokens` measured the number; it could not be held to one. A manifest now carries
`budget.bytes` — a declaration beside `limits` and `gates`, not inside `projection`,
because that block is regenerated on every upgrade and nothing in the repair would notice
its budget disappearing. A repository that declares nothing is measured against the
review's 30 KB and reports `declared: false` rather than looking like it chose it.

Over budget is reported, never enforced, and the report says what was not done: nothing
was cut, because the projection is still in full mode. Which rules move behind skills is a
measurement that has not been taken yet, and a budget that quietly dropped rules would be
enforcing a decision nobody made (ADR-072).

### A stack profile loads only when a matching file is in play

A stack profile used to be always-on everywhere, because profiles reached a reader through
the generated region in AGENTS.md and through nothing else. A profile can now declare
`simt-scope`, and a repository on Cursor, Copilot or Antigravity gets it as a file the
surface attaches on patterns: `.cursor/rules/python.mdc` with `globs` and
`alwaysApply: false`, an Antigravity rule with `trigger: glob`, a Copilot
`.instructions.md` with `applyTo`. AGENTS.md keeps one line naming the profile, the
patterns and the file it moved to — a profile that vanishes from the region reads as one
that was deleted.

The narrowing happens only when every selected surface can do it. Claude Code's `paths:`
key is documented and silently fails to lazy-load for quoted values, and opencode has no
per-rule channel at all, so a repository carrying either keeps its profiles in the region
and is told which surface stopped it. A rule that never loads is worse than a rule that
loads eagerly.

Reading the two vendors' docs changed the shape of this: Antigravity requires patterns
starting with `*` to be quoted or YAML reads them as an alias anchor and the rule is
discarded with no message, and it documents a 20,000-token budget for always_on rules past
which they are demoted to pointers — so eager profiles cost the reader a real budget. A
`simt-scope` that matches everything is now refused, since that is the same behaviour with
a narrowing-looking spelling (ADR-071).

### Every `--json` payload says which version it is

An agent that parses `--json` had no way to notice that a field had moved: the parse
succeeds, the lookup returns `undefined`, and the answer is quietly wrong. Every payload now
opens with `schemaVersion`, and a version in a comment is not a version, so it travels in
the document every reader is guaranteed to see.

The same document is now one line rather than four columns of whitespace, because the reader
of `--json` is a program and it pays for every byte. `--pretty` asks for the other form, and
a terminal gets it without being asked, because there the reader is a person.

Writing the contract test found two things the review that asked for this missed. Eight
commands — `doctor`, `mcp --list`, `graph lint`, `rules list`, and the `skills` ones — had a
private `emit(JSON.stringify(..., null, 2))` instead of the shared helper, so `--json` meant
something different depending on which command you asked. And a command that *failed* under
`--json` wrote only to stderr, so a scripted caller got an empty document and a non-zero
exit and no way to learn what went wrong. It now answers in the shape it was asked in (ADR-070).

### `graph lint` now checks skills against the published specification

The Agent Skills specification sets limits nobody here was checking: a name of lowercase
letters, digits and single hyphens that equals the directory it lives in; a description
under 1,024 characters; a compatibility note under 500; a body recommended under 5,000
tokens because an agent loads all of it once the skill activates. `graph lint --spec
agentskills` checks every skill against those, and the specification was fetched rather
than recalled — reading it turned up four rules the review that asked for this did not
list, including the one that breaks installs.

What the specification calls a must fails the exit code; what it calls a recommendation
warns. A lint that fails on advice is a lint that gets skipped. `skills install` now asks
the same name rules, since the directory is created from the name and an unaddressable
skill would be the last thing anyone notices.

### The MCP surface speaks three protocol revisions, and answers in the shape each asks for

The server was pinned to one revision and returned pretty JSON in a text block, so a
client could read the answer but could not validate it, could not cache it, and could not
tell a read-only tool from one that writes. All three published revisions were read rather
than guessed at, and each is answered in its own shape: the newest drops the handshake for
a version carried on every request, adds a discovery method servers must implement,
requires a result-type field and a cache lifetime on list results, and deleted the liveness
method — which older clients still get, and newest clients are told is gone by name.

Every tool now declares what it returns and says it is a reader, and every call returns
the answer in both shapes: the text block for a client that predates structured content,
the structured block for one that validates against the declared schema. The byte ceiling
bounds the text only, so the block a client can check still checks. The schema checker
that makes this testable lives in the package rather than in a dependency.

### Which harnesses a repository is set up for is now answerable

`simt-dev harness detect` looks at the configuration directories that exist and says
which harnesses this repository — and, with `--user`, its reader — is set up for. It
claims presence and nothing else: a directory found is not a claim about what its owner
reads, because the tool cannot answer that without a vendor document, and a guess here
would be the reader's problem the first time it was wrong. A harness that reads
AGENTS.md is served by the standard surface whatever else it reads, and every surface row
now records that in three values rather than two, because "reads AGENTS.md" and "is
covered for this harness" are not the same sentence — Copilot's CLI reads it and its
editor, code review and cloud agent do not.

No new harness rows ship with it. The candidates are recorded as directory names, which
claim presence and not coverage; a row still requires the vendor document it cites, and
one that reads nothing has to be added on purpose.

### A monorepo gets rules for each of its packages

One repository, one projection: every package under the root was given the root's rules,
so a React application inside a node workspace was handed the node profile and nothing
else, and the profile that should have applied to it was applied by nobody. The rule that
package needed was not wrong — it was missing.

Packages are now discovered from the declarations that already list them (npm and pnpm
workspaces, turbo, Cargo members, `go.work`, Gradle includes) rather than by walking the
tree, because a declaration states which directories are members and a marker file only
says there is a build here. The root keeps what every package shares; each package that
selects something new gets a generated region carrying exactly its own delta, and a
package that selects nothing new gets no file at all. `check` reports every package
region and fails on any one of them, and `compare` counts the drifted regions rather than
the repositories that hold them.

A gate can also name the directory it runs in, which is what a monorepo with no root test
script needs: `gates.cwd` maps a gate to a directory, a directory that does not exist or
resolves outside the repository fails the event and is reported by `check` before the
commit rather than at it, and a directory named for a gate that is not declared is
reported as the inert entry it is.

### One rule set, shared by the repositories that agreed on it

Several repositories want the same rules and each kept its own copy, so a policy change
was several edits that could be several-minus-one, and the repository that missed it
carried instructions nobody there wrote. A pack is that shared set: `packs` in the manifest
declares it, the bytes live in the repository, and a digest of them is recorded so nobody
has to trust that the two agree.

A pack's rules are selected by the same matcher as any profile and appear in the region's
source list under the pack's own directory. Precedence is the repository, then a pack it
declares, then what the tool ships, and every replacement is reported rather than silent.

A pack that disagrees with its pin still projects — the gate blocks and prints both
digests, because dropping it would let the repair delete the rules it is reporting. One
that is missing blocks with a remedy that restores it, and one with no digest is reported
without failing anything, since its rules render correctly. `compare` lists every pack and
the digest it is pinned to, so a repository behind a shared change is visible before
anyone follows stale instructions. Nothing is fetched: the bytes are in the repository,
which is what makes the rendered region reproducible from what the reader has (ADR-065).

### `simt tokens` counts what a reader loads

Review 0002 filed the estate's always-on context at 90 KB per turn, 72% of it a paragraph
an earlier repository had already loaded — a number produced by reading seven
repositories by hand, which ages the moment a rule is edited and cannot be re-derived by
the reader who has to act on it.

`simt tokens` is that reading, as a command. It reports the bytes this tool wrote per
channel (region, rule files, skill metadata), an approximate token figure, and — with
`--repos` — the same figure across a workspace, with every repeated paragraph attributed
to the first root that carries it. A region that ends past a harness's read limit is
reported with its byte offset, using the same numbers the existing check uses.

Three choices keep the figure honest, and all three are recorded in ADR-064: the meter
counts what the projection wrote and reports hand-written bytes beside it rather than
folding them into the budget; a region is the span between its two markers, so the blank
line a person left above the marker is billed to nobody; and an over-budget repository is
reported rather than failed, because a meter that went red would train people to ignore
the number.

S38 stays open — this is the instrument. Whether the estate gets under 30 KB is R07's
kernel, R08's budget field and R11's dedupe, measured with this.

## [0.2.1] — 2026-10-13

### `init` writes in place; the backup tag and adopt branch are opt-in

`simt init --yes` used to always tag the pre-adoption commit and branch onto a dedicated
adopt branch before writing. The safety argument was sound, but consumers kept reporting
the branch switch as a surprise — a well-announced surprise is still a surprise.

The default now writes in place on the branch you already have: nothing is tagged, nothing
is branched, and the run says so in an `in place` line. The reviewable diff survives —
`git diff` shows the whole adoption, and discarding it is a checkout and a clean.

The old behaviour moves behind `--backup`: `simt init --yes --backup` tags the pre-adoption
commit and branches as before, for readers who want the named undo path. ADR-063 records
the decision and the one behaviour it invalidates: consumers who scripted against the old
default add `--backup`.

### A fresh adoption seeds the gates it can run — and only those

The eight common ecosystems outside the JavaScript world — Rust, Go, .NET, Swift, Deno,
Ruby, Dart and Elixir — were recognised by the fingerprint and served by nothing: no
profile selected them, no gate was proposed for them. A fresh Rust repository received the
core essay and a manifest that runs nothing, while the ecosystems that emit stack tags got
the full treatment.

Each now has a profile that selects on its own `has-*` fact, so one marker file reaches
both the rules the repository reads and the gates its commits run. Maven's profile predates
this; its row is gates-only, wrapper-first, like `gradlew`.

`simt init` now seeds the canonical commands for a detected ecosystem — `cargo fmt
--check`, `go vet ./...`, `dotnet test`, and the rest of the table — into the manifest's
gates, but only where a probe found the tool: a binary on PATH, or a file in the repository
for the Maven wrapper. A marker says the ecosystem is here; the probe says its program can
run. A declared gate that cannot run fails closed on every commit, so the seed fires only
when both are true — and where the probe fails, the gate is dropped with a remedy that
names the install instead of blocking the first commit.

A seed is a default: a command the repository already declared is never re-seeded, and an
npm runner keeps its own scripts, because `package.json` is the repository's own answer to
"how do I test and format". ADR-062 rules the shape of all of it.

### The resolver is measured against a gold corpus

`simt skills eval` scores the skill resolver against a corpus of real tasks × real
repositories, each case carrying a gold list of the skills it should select and a list
of the ones it must not. It reports precision and recall, prints a PASS/FAIL line per
case naming the skills it missed or selected that it should not have, and exits
non-zero on a regression — so it can be run from CI the way the gate is run.

The scoring lives in `src/resolve/eval.mjs`, which the command and
`test/eval.test.mjs` both call, so a test cannot drift from what the command measures.
The corpus lives under `test/` because test data does not ship in the package: an
installed copy names the path it would have read and says so instead of scoring the
author's.

### The skill registry is workspace data; the package ships none of it

The npm tarball and the wheel carried `graph/skills.graph.json` — the directory
of skill sources for one workspace, naming the repositories whose bodies it
resolves. Every installed copy served that catalogue to readers who have none
of those skills, and `skills install` pointed at paths that exist only in the
workspace that wrote them. ADR-061 rules the registry out of the published set:
it is data about one workspace, not content of the package.

The default registry path now resolves in tiers, and every tier is file
existence plus configuration — nothing a pull request cannot diff:

1. an explicit path, the positional of `simt graph lint`,
2. the package's own `graph/skills.graph.json` — present in a source checkout,
   absent from an installed copy,
3. the member of a configured workspace that holds one — naming the workspace
   it came from, and refusing when several members hold one, because picking
   would be a guess.

An installed copy in a workspace with no registry says so, and names the three
ways to configure one (`--workspace`, `SIMT_DEV_WORKSPACE`, the user config
file) instead of failing on a path it does not have. `simt graph lint`'s
no-registry remedy names the path explicitly, because its default is the
registry it lints.

The provenance digest stops walking `graph/` for the same reason it no longer
leaves the package: the digest covers what a published copy ships, and the
registry is no longer among it.

### No published file may name a repository from this estate

The decision records ship in all three channels — npm, the wheel and the sdist — so a
private repository name written into one is published to three registries. That happened:
the records were pseudonymised once, across 28 files, and nothing stopped the next one. The
sweep's own commit says why, and it is the right reason: the redaction it used runs on the
way *out*, at print time, and the bytes on disk are what get published.

`test/shipped.test.mjs` now fails on an estate name anywhere in a published file, and
asserts its own scope against `package.json` in **both** directions — a directory added to
`files` without being guarded fails, and so does one guarded that nothing publishes, because
a guard nobody can fail is one somebody eventually deletes. It is scoped to the published
set rather than a hand-written list for the same reason: the sweep took 28 files to undo by
hand, and the guard should not need undoing at all.

Names are not removed, they are described. The records that use a repository as *evidence* —
a table of how three repositories answer the same question — carry stable `repo-NN` labels,
so the comparison survives. Everything else is better off naming what the repository *is*:
"a Gradle module with no wrapper", "a repository with no package.json". That reads to
someone outside the estate without a lookup table they do not have.

The one place estate names remain is `docs/reviews/`, which is not published by either
channel. A review whose subject is fourteen repositories cannot pseudonymise them without
becoming a document about `repo-01` that never existed.

### Four shipped strings named a command this package does not install

`0.2.0` installs one binary, `simt`, and `package.json`'s `bin` map says so. Four
places still said `simt-dev`, which a reader types and is met with `unknown command`:

- the default remedy on every bad invocation, `run: simt-dev --help` — so the advice
  printed after a bad command could not be followed
- the usage line, `usage: simt-dev <command>`, sitting above a command list that spelled
  the same tool `simt`
- `.github/dependabot.yml`'s header, which said `Yours from here: simt-dev` while the
  gate beside it said `Yours from here: simt`
- the hook shim, whose own resolution list said `simt-dev on PATH` directly above the
  `command -v simt` that does the looking

`test/naming.test.mjs` was supposed to prevent this and did not: its rule required a
verb after the project name, and none of the four is followed by one. It now also
catches a flag, a `<placeholder>`, the end of a line, and a program name in a
resolution list — while still accepting the sentences where the project is the
subject, which is the spelling that is correct. The two `.github` templates get their
own assertion, because the fourth of these was not a wrong word in a sentence; it was
two templates disagreeing with each other in the same position.

### Fixed

- `hooks install` removes a shim whose gate was dropped from the manifest instead of leaving it to run nothing. A repository that removed its last gate was refused outright, with a remedy telling it to put the gate back; only un-routing git was left to the reader. install also no longer chains a hook to itself.

- **Dead exports and duplicated frontmatter, with a test that stops them returning (S21).**
  Eight functions were exported and called by nothing (`gateKind`, `gateWhy`, `gateAdr`,
  `resetWorkspace`, `tracksIdentity`, `isTty`, `surfaceFrontmatter`, `workspaceOrNull`),
  three `__internals` testing seams had no importer, and thirteen more bindings were
  exported while being used only inside their own file — `isExecutable` among them, which
  a first pass through this list wrongly recorded as dead and which its own callers
  proved otherwise. `KNOWN_SUBS` was a hand-kept second copy of the dispatch table, and
  had already drifted: it carried `doctor`, a bare command the group lookup can never
  reach. `mdcFrontmatter` was a second construction of frontmatter the writer now derives
  itself, with a test asserting the copy rather than the behaviour.

- **"Did you mean" offered the shortest fragment first, and a misspelt skill was
  suggested for a correctly spelled one (S22).** `nearMatches` had no test at all.
  Both directions of substring scored 0 — the same score as an exact match — so the
  alphabetical tiebreak decided the order, and `skills graphs` suggested `graph`
  before `graphs`. Worse, the containment test had no length floor, so `test` matched
  the candidate `e` and the message read `did you mean e, test-writer?`, which an
  agent has every reason to install. A prefix now scores 1 rather than 0, a fragment
  counts only when it is at least half the query, and the edit bound scales with the
  query's length — three edits is a typo in `slice-commmit` and is most of a
  four-character query.

- **The conflict scanner skipped two of the five rule surfaces, and one pointer file
  (S22).** `rulePaths` enumerated filenames by hand, so `.claude/rules/` and
  `.agents/rules/` — added to the surface table after the list was written — were
  never scanned, and a hand-written rule contradicting a generated one there was
  invisible. A conflict detector that only looks where it was pointed looks nowhere
  new. The scan list is now derived from the surface table and the pointer table.

## [0.2.0] — 2026-10-11

### Publishable from PyPI and Homebrew as well as npm

simt-dev is a *repository* tool, and the people who adopt a repository are not
all Node developers. Somebody running `simt init` inside a repository with no
`package.json` has no reason to install a package manager, and a Homebrew user
has no reason to install Node to install a tool that needs Node.

So it now publishes to three channels, from one version number:

```sh
npm i -D simt-dev        # a tarball of .mjs files
pip install simt-dev      # a wheel carrying those same bytes
brew install QuazarMedia/tap/simt-dev
```

The wheel is not a wrapper around `npm install`. It carries the tool's own
source, and `scripts/verify-wheel.mjs` builds both artefacts and hashes every
file in both — a release fails when a single byte differs between them. That
check exists because the obvious defect in this arrangement is the wheel and the
tarball quietly shipping different code.

`simt` is the one command, on every channel. Where node comes from is
`SIMT_DEV_NODE`, then the bundled node from `pip install "simt-dev[node]"`,
then `node` on `PATH` — and if none of those resolve you get the remedy rather
than a placeholder path. There are no required dependencies on any channel.
*(ADR-058)*

The channels are published in a fixed order rather than in parallel, and the
reason is not taste: the Homebrew formula downloads the npm tarball at install
time, so a formula naming a version still sitting in npm's staging area
installs a 404. Both jobs fail with that stated, and are run again after
`npm stage approve`.

## [0.1.1] — 2026-10-11

### A foreign hook on an event this repo does not gate is chained

`0.1.0` chained the wrong set of hooks and is worth replacing rather than
recommending. It chained on the event *vocabulary* — anything that was not
`pre-commit` or `pre-push` — when the question worth asking is whether **this
repository** declares a gate for that event.

The difference is a repository whose `pre-push` is `git-lfs`. `pre-push` is an
event this tool gates in general, so `0.1.0` displaced that hook; and because
that repository declares no `pre-push` gate there was no shim for the event
either, so git would have found no `pre-push` hook at all. LFS objects would have
stopped being uploaded, with nothing to notice it — the exact silent failure
chaining exists to prevent, reached by fixing the wrong half of it.

`0.1.1` asks the manifest. An event the repo declares a gate for is left to
`gates.commands`, where the hook runs as a gate and its verdict appears in the
report; every other foreign hook is chained. That also picks up a static
site's Lighthouse pre-push, which declares no gates at all.
*(ADR-018, as amended)*

Upgrade with `npm i -D simt-dev@0.1.1`, then `simt hooks install --yes`. Any
repository already routed with `0.1.0` should re-run it: the shims it writes
will differ where a gated event was previously displaced.

## [0.1.0] — 2026-10-11

The first release with real contents in it. `1.0.0` was an empty reservation of the name
and `0.0.0-stage` was its rehearsal; neither shipped a byte anyone could run, so this entry
is the whole history. The decisions behind it are readable in the package under
`docs/decisions/`, and from any checkout with `simt rules why <id>`.

### The command is `simt`

The package is `simt-dev` and the command is `simt`. They are not the same thing and were
never required to be: the command appears only in text the tool itself writes, and that
text migrates on the next write. The package name, the `.simt-hooks/` directory and the
`simt-dev-check.yml` gate already exist in every repository that adopted this tool, and
they did not move. The manifest and the region markers did — see below.

### The manifest is `simt.json`

The manifest was called `simt-dev.json`; it is now `simt.json`. The move is a
read-both/write-new, so nothing in an adopting repository has to be done:

- Every read takes `simt.json` if it exists, else `simt-dev.json`, so a repository that
  has not written since the upgrade is still seen as adopted.
- Every write goes to `simt.json`, and a lone `simt-dev.json` is moved, not shadowed.
- The old name keeps working until the first `init` or manifest write in each repository,
  and that write closes it. *(ADR-056)*

### The region markers are `simt:`

The generated region was stamped `<!-- simt-dev:begin -->` / `<!-- simt-dev:end -->` — and
so was the provenance header inside it; every one of those lines is now `simt:`. The move
is the same read-both/write-new as the manifest:

- Every read accepts either spelling, so a repository that has not written since the
  upgrade is still seen as adopted.
- Every write emits `simt:` only, so the first `sync` in each repository migrates its
  regions in place, and that write closes the window.
- A file holding two regions — one of each spelling — is a state only a hand edit can
  make, and it is reported malformed rather than merged. *(ADR-056)*

### A hook you already had keeps running

`hooks install` points `core.hooksPath` at `.simt-hooks/`, and git reads **every** hook from
that one directory — not just the two events this tool gates. So adopting a repository that
had its own `post-commit`, `post-checkout` or `post-merge` would have quietly stopped them:
nothing fails, nothing is logged, and the hook is still on disk looking intact.

Those hooks are now **chained**. Install writes a shim for them that runs the repository's
own hook and forwards git's arguments, so nothing is lost and the reason is in the file. If
the hook is gone, the shim refuses and names the path instead of passing quietly. A hook on
an event this tool *does* gate (`pre-commit`, `pre-push`) is deliberately not chained —
declare it under `gates.commands` so the dispatcher runs it and its verdict appears in the
gate report. *(ADR-018, as amended)*

### What a first release has to say out loud

These are the behaviours a reader is most likely to trip over. Each one is deliberate,
and each has a numbered decision record behind it — but a behaviour nobody can discover
without reading the source is not a documented one.

- **`sync` and `init` write nothing without `--yes`.** Both print a plan and exit. `sync`
  exits **1** when the plan is non-empty, so bare `sync` doubles as a check. Neither ever
  commits or pushes. *(ADR-035, ADR-036)*
- **`upgrade` moves a pin and nothing else.** It never adopts a repository, never repairs
  one, and never rewrites a manifest. Every consumer moves to the same version as one set.
- **A pre-commit hook with no reachable binary fails closed.** The refusal is the correct
  behaviour, not a bug; the remedy it prints is the command that obtains one.
  *(ADR-010, ADR-018)*
- **A gate whose tool is not installed is dropped, with a remedy naming the package.**
  It is never declared and silently unrunnable. *(ADR-017)*
- **Two rules are never loaded twice.** Each rule projects to exactly one place, chosen by
  what the harness actually reads. *(ADR-021, ADR-046)*
- **macOS and Linux only.** Windows `npm i` fails with npm's `EBADPLATFORM`, which npm
  will not let a package explain; use WSL2. See the platform section of the README.
  *(ADR-012)*

### Packaging

- Licence set to Apache-2.0; the `LICENSE` file is the canonical, unmodified text.
- `files` no longer lists `skills`, `agents`, `tooling` or `hooks`, none of which exist,
  and no longer ships `docs/plans`. The tarball is the tool and the decisions behind it,
  and nothing else.
- The package `description` no longer names an internal ecosystem. It is the first line
  anybody outside the project reads.
- Unscoped, so the install command is `npm i -D simt-dev` rather than a name under an
  organisation. The `@simt` and `@quazarmedia` scopes were both free; an unscoped name is
  the one a reader can guess.

### Notes for anyone upgrading a hook

A shim installed by an earlier version looks for `SIMT_DEV_BIN`, then for
`node_modules/simt-dev/bin/simt-dev.mjs`, then for a program named `simt` on `PATH`. The
last of those is new, so a machine that installed the package before this release and
never ran `simt hooks install` again will find nothing until the dependency is refreshed
and `simt hooks install --yes` is re-run. That is a real upgrade step and it is called out
here rather than discovered.

[0.3.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.3.0
[0.2.2]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.2.2
[0.2.1]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.2.1
[0.2.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.2.0
[0.1.1]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.1.1
[0.1.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.1.0