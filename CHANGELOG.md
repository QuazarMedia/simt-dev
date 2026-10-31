# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

The git shims move from the top-level `.simt-hooks/` directory into the state
directory at `.simt/hooks/`, and `core.hooksPath` follows (ADR-122). Every
piece of per-repo state now has one root, and the ignore line that existed
only for the shims is dropped. A repository installed before the move
self-heals on its next `hooks install --yes`: the routing re-points, the new
shims land, and the legacy directory is removed — journaled, so `undo`
brings it back — but only when every file in it carries a simt-dev marker; a
file the tool cannot recognise as its own leaves the directory in place.
Because the shims land under the state directory, the journal records writes
to the shim directory: it is the one named exception to the unjournaled state
directory, since the undo that restores `core.hooksPath` must restore the
shims with it.

Journal sets that predate the move into `.simt/local/journal` live in the
fallback directory `.simt/journal`, which `undo` can only see while the
current directory is absent — a repository that accumulated history under the
old path lost it to `undo` on its first write after the move. The next
journal write now moves the legacy sets into the current directory, and the
fallback directory goes with its last file: a name present in both keeps
both records when the bytes differ, and a crash mid-move is finished by the
next write, so the migration is idempotent.

## [0.7.0] — 2026-10-31

### Added

- `simt agent-hooks install --harness <id>` writes the policies into one harness instead of all of them; an unknown id is a usage error that names the valid ones. — [ADR-107](docs/decisions/ADR-107-an-install-can-name-one-harness-and-the-skipped-ones-are-named.md)
- `simt init --yes` builds the repository index as part of the adoption, so the first `simt map` or `simt brief` in a fresh repository answers from real files. — [ADR-108](docs/decisions/ADR-108-an-adoption-builds-the-index-and-a-command-refreshes-it-on-read.md)
- The rule text names the manifest as `simt.json`, the name it has had since the rename; four rule files still said `simt-dev.json`, which resolves in no repository.

### Changed

- The projection lock is `simt.lock.json`, the name that follows the command and the manifest. — [ADR-110](docs/decisions/ADR-110-the-lock-file-follows-the-manifest-name-and-the-old-name-is-read-until-the-next-write.md)
- This repository is now a consumer of itself: `simt init` ran on its own source, so the two tests that asserted it was *not* a consumer are rewritten to assert the new state, and `AGENTS.md`'s "not self-adopted" section now says what is true — [ADR-109](docs/decisions/ADR-109-simt-dev-is-its-own-consumer-and-the-guards-that-kept-it-from-being-one-are-retired.md)

## [0.6.3] — 2026-10-29

### Added

- `simt explain <CODE>` names what a `check` finding means, the decision behind it, how to fix it, and a concrete trigger — one table row per finding code, so every code `check` can emit has an entry.
- `simt doctor --fix` applies only the remedies flagged safe (local, idempotent, journaled) and lists the rest; a fixture with three safe and two unsafe findings fixes exactly three.
- `simt status --line` prints the gate state from the last `check` in under 50 ms from cache — `simt PASS ✓rules ✓hooks 3/3gates` — for shell prompts, tmux and agent status lines.
- Every write records `{path, beforeDigest, afterDigest, beforeBytes}` in `.simt/journal/`, and `simt undo` restores the last set when every file in it is untouched since.
- `--diff` on every writer prints a unified diff of the plan next to the report, changing nothing about what the run writes.
- `simt completions <bash|zsh|fish>` prints a completion script generated from the command registry, so the three shells complete exactly the commands the binary dispatches.
- One ignore list (`.simtignore`) renders `.cursorignore`, `.aiderignore`, `.geminiignore` and Claude `permissions.deny`, and a zero-dependency staged-diff secret scan (vendor patterns plus Shannon entropy over added lines only) blocks a comm
- `simt slice start <id>` isolates the work in a linked worktree on branch `slice/<id>` with the brief preloaded and flips the tracker row In progress; `simt slice finish <id>` runs the declared gates, commits a Conventional subject from the
- `simt lease <paths> --session <id>` claims files until a TTL in `.simt/leases.json`, and the pre-edit hook denies an edit leased by another session (ADR-101). — [ADR-101](docs/decisions/ADR-101-a-file-lease-belongs-to-one-session-and-the-pre-edit-hook-refuses-another.md)
- `simt pr-body [--base <ref>]` assembles the pull request body from the evidence ledger, the decision records the diff touches, the gate state from the last check, and the residual risk in ADR-008 vocabulary. — [ADR-008](docs/decisions/ADR-008-verdict-vocabulary.md)

## [0.6.2] — 2026-10-27

### Fixed

- The v0.6.1 tag run failed its own tests step: two decision-corpus lists in `test/rules.test.mjs` were not moved with ADR-099 (the partial-supersession shapes and the leaking-paths count, both designed to move with the corpus). — [ADR-099](docs/decisions/ADR-099-the-release-verifies-served-bytes-and-the-formula-mirrors-them.md)

## [0.6.1] — 2026-10-27 (tagged, never published to npm)

### Fixed

- The release automation, which the v0.6.0 tag proved broken in two places. — [ADR-099](docs/decisions/ADR-099-the-release-verifies-served-bytes-and-the-formula-mirrors-them.md)

## [0.6.0] — 2026-10-27

### Added

- `simt plugin <claude|gemini|cursor> --out <dir>` generates one of the three harness packages from the same tables `agent-hooks install` writes — the hooks file, the MCP registration and, for cursor, the kernel rules — each carrying a self-c
- The MCP server answers `prompts/list` and `prompts/get` with two templates: `simt-brief` starts a task from the pre-assembled brief packet, and `simt-slice` implements one slice of the working plan (the next one whose dependencies are compl
- Two fixed resources join `simt://rules/{id}` and `simt://decisions/{adr}`: `simt://kernel` serves the collaborating region rendered in kernel mode for whatever repository the server runs in — the URI promises the kernel's bytes, whatever `m
- The tool descriptions in `tools/list` are cut from 2,783 bytes to 1,949, inside the 2 KB budget plan 0003 R41 sets for a cacheable tools list; the input and output schemas stay full, per ADR-068. — [ADR-068](docs/decisions/ADR-068-the-mcp-revision-list-cites-what-was-read.md)
- `harness detect` reports the MCP registration files the loader table records — `.mcp.json` (Claude Code), `.codex/config.toml`, `.cursor/mcp.json`, `.agents/mcp_config.json`, `.gemini/settings.json`, `.vscode/mcp.json` — as `kind: 'mcp'` ro
- The loader table gains the Gemini CLI reader, whose configuration reference the table previously recorded as unavailable: it is live again (read 2026-10-26), so the row carries the GEMINI.md chain with `.git` boundary markers, the `context.
- Each release now carries a fourth artefact beside the tarball, the wheel and the formula: one single-file executable per target (`darwin-arm64`, `darwin-x64`, `linux-x64`), built from the same `files` set with a pinned Node runtime, publish
- `simt pack new <name> --source <npm:<package>|git+https://…>` scaffolds a versioned pack — `pack.json`, an unmeasured `bench.json`, one stack rule — and `simt pack lint [dir]` validates it and states its measured ΔR, rejecting a pack with n

### Changed

- `harness detect`'s "some readers read AGENTS.md" rows no longer say bare "some" when the row knows which one: the `readsAgentsMdNote` travels to the text output, and `.gemini` graduates from unverified candidate to verified detection facts
- The one-line description the three channels publish (npm, PyPI and Homebrew) now names the goal plan `0003` is building toward — an intelligence amplifier for AI coding agents — instead of the adoption-only story it grew out of.
- The per-repository state directory is renamed from `.simt-dev/` to `.simt/`: the index, ledger, lessons, bench artifacts, local-model proposals (`distilled/`, `reviews/`) and repo-local profiles all live under `.simt/` now.
- The skill registry leaves the published set again, as ADR-061 ruled when it first left in 0.2.1. — [ADR-061](docs/decisions/ADR-061-the-skill-registry-is-workspace-data.md)
- The entry point file is renamed from `bin/simt-dev.mjs` to `bin/simt.mjs`, matching the command it installs: the command has been `simt` for a long time, the package is still `simt-dev`, and the file path was the last place that carried the
- The hook shim's remedy and the generated CI workflow now install the release binary for a repository without npm, instead of the pinned global npm install (`npm i -g`) that needed the npm that repository kind is defined by not having.
- The locator resolves `.simt/bin/simt` between `node_modules` and `PATH`, so the bytes a repository downloaded are the bytes its gate runs and a machine-wide install cannot shadow them.
- Homebrew's formula downloads the release binaries rather than the npm tarball — one `url`/`sha256` pair per target, chosen at install time — and no longer declares `depends_on "node"`. — [ADR-098](docs/decisions/ADR-098-the-fourth-channel-is-one-file-and-it-needs-no-toolchain.md)

## [0.5.0] — 2026-10-25

- **An offline distiller that proposes, never projects** — `simt distill <skill|doc>` writes a budgeted summary of a skill body or repository document with citations to source line ranges (`[L12-L15]`). — [ADR-090](docs/decisions/ADR-090-an-optional-adapter-is-off-until-named.md)

- **An advisory critic over the staged diff** — `simt review` gathers the brief — the governing decision records and scoped rules for the staged files — with no model and no network. — [ADR-008](docs/decisions/ADR-008-verdict-vocabulary.md)

- **Model and effort advice in the brief header** — `simt brief` now carries an `ADVICE` header, such as `small model, no plan mode` or `frontier model, plan first`, derived from the estate's own bench history: the brief's task kind and estimated file size pick a neighbourhood of similar ben

### Fixed

- `package.json` gained the `repository` field npm's provenance verification requires: the sigstore bundle is checked against the public source repository, and the missing URL rejected the 0.4.0 upload with `E422`.

## [0.4.0] — 2026-10-20

- **Hybrid retrieval fuses BM25, the code graph, and the resolver** — `simt index` indexes full-text tokens across `code`, `docs`, `skills`, `decisions` and `lessons` into the SQLite FTS5 `fts` table (with an Okapi BM25 fallback when the index is JSON-lines). — [ADR-091](docs/decisions/ADR-091-the-map-ranks-files-a-task-mentions.md)

- **A local model adapter that opens zero sockets until named** — `simt local doctor` probes the OpenAI-compatible `local.chat` and `local.embed` endpoints declared in `simt.json` (`/v1/models`, `/v1/chat/completions`, `/v1/embeddings` for Ollama, `llama-server`, LM Studio and MLX servers) and reports rea — [ADR-075](docs/decisions/ADR-075-nothing-leaves-the-machine.md), [ADR-090](docs/decisions/ADR-090-an-optional-adapter-is-off-until-named.md)

- **Estate learning and ADR drafts across a workspace** — `simt compare --learn` aggregates benchmark uplift (`ΔR`, `ΔC`) per rule section across adopted sibling repositories, promotes lessons repeated across at least two repositories as shared candidates, and flags gates that fail more than 20% o

- **Rule text variants have to win on the bench** — A rule may declare candidate wordings under `simt-variants:` in its frontmatter (or supply them with `--variants-file`).

- **Decision records carry structured supersession frontmatter** — `simt decide "<title>"` scaffolds the next numbered ADR in `docs/decisions/` with structured frontmatter (`Status`, `Date`, `Supersedes`, `Superseded-by`, `Affects`) and updates the records it supersedes when `--supersedes` and `--yes` are

- **Lessons are captured from failure-to-fix pairs, recalled on match, and expire** — When a failing gate or test run in `.simt-dev/ledger.jsonl` is followed by a passing run on the same package, `simt lessons` records a deterministic candidate in `.simt-dev/lessons-candidates.jsonl`.

- **Skills compile to the Agent Skills standard and report their triggers** — `simt skills compile` validates and compiles skill sources against the Agent Skills standard (frontmatter `name` and `description`, description under 1024 characters, `SKILL.md` body at most 500 lines, and on-demand `references/` and `scrip

- **A task brief fits in the bytes a prompt can carry** — `simt brief "<task>"` assembles what a task needs into one packet: the kind of the task and the commands that kind needs, the files the map ranks highest, the tests the index knows for them, the decisions that govern them, the skills the re

- **The packet arrives without being asked for** — A repository that declares a `brief` key in its manifest gets the packet injected as context before every prompt: `simt agent-hooks install` writes a `UserPromptSubmit` hook into Claude Code's and Codex's own config, and `simt agent-hook pr

- **A brief can cite a code graph it did not build** — A repository may declare a `federation` block in `simt.json` naming external code-graph servers, each with the command that starts it and, optionally, the MCP tool to ask, the argument the question goes in, the languages it covers and the t

## [0.3.1] — 2026-10-18

- **Who a change reaches** — `simt impact` takes a tracked path or the name of one export. — [ADR-096](docs/decisions/ADR-096-impact-names-who-a-change-reaches.md)

- **A gate report keeps the failures and counts the passes** — `simt gate` compacts a report it knows how to read: TAP, JUnit XML, pytest's junit file, vitest or jest JSON, and `go test -json`. — [ADR-095](docs/decisions/ADR-095-gate-output-keeps-the-failures.md)

- **A change runs the tests that import it** — `simt gate` selects the test files that import a changed file, directly or through other files, and runs only those with the package's own runner. — [ADR-094](docs/decisions/ADR-094-a-change-runs-the-tests-that-import-it.md)

- **what governs a file is the decision, rule, skill, gate or lesson that names it** — `simt why` reads an Affects line as the tokens in backticks, including a line the paragraph wraps onto. — [ADR-017](docs/decisions/ADR-017-a-declared-gate-must-be-runnable.md), [ADR-093](docs/decisions/ADR-093-why-names-what-governs-a-file.md)

- **The tests of a file are its importers, its conventional neighbour, and its coverage** — `simt tests` lists the tests that exercise a file. — [ADR-092](docs/decisions/ADR-092-tests-are-imports-conventions-and-coverage.md)

- **The map ranks the files a task is likely to touch** — `simt map` orders the index by the task's words and by the import and call edges around them. — [ADR-091](docs/decisions/ADR-091-the-map-ranks-files-a-task-mentions.md)

- **The index names the exports and the imports** — `simt index` fills symbols and import edges from the blob it already hashes. — [ADR-090](docs/decisions/ADR-090-an-optional-adapter-is-off-until-named.md)

- **The local index is a cache of git blobs** — `simt index` rebuilds `.simt-dev/index.sqlite` from `git ls-files`. — [ADR-089](docs/decisions/ADR-089-the-local-index-is-a-cache-of-git-blobs.md)

- **A marked line is enforced by a checker** — A rule line may name a checker with `simt-check`. — [ADR-088](docs/decisions/ADR-088-a-marked-line-is-enforced-by-a-checker.md)

- **A run is evidence for one tree** — `simt evidence` prints the runs recorded against the tree on disk. — [ADR-087](docs/decisions/ADR-087-a-run-is-evidence-for-one-tree.md)

- **A workspace carries its repeated rules once** — `simt shared plan` names the rules every repository in a workspace renders with the same bytes, and where each harness would load that copy. — [ADR-084](docs/decisions/ADR-084-a-workspace-carries-its-repeated-rules-once.md)

- **The region ends with the names of what it kept out** — The generated region ends with a `## Disclosure` section: one line per scoped profile, with the patterns and the files it moved to, and one line per installed skill, with its name and the description that says when to open it. — [ADR-085](docs/decisions/ADR-085-the-region-ends-with-the-names-it-kept-out.md)

- **The stable prefix comes first** — Shipped rules lead the region, and the command card follows them, so an edit this repository makes changes only the tail. — [ADR-086](docs/decisions/ADR-086-the-stable-prefix-comes-first-and-the-lock-records-both-digests.md)

- **Kernel mode packs to the budget the repository declared** — `mode: kernel` reads `budget.bytes`, holds back a reserve for the files that load beside the region, and drops rules least-valuable-first until the region fits. — [ADR-083](docs/decisions/ADR-083-a-budget-is-met-by-cutting-the-kernel-and-hard-is-the-floor.md)

- **Vulnerability reports** — `SECURITY.md` names the two places a report goes: a GitHub issue on this repository, or `security@simt.space`.

## [0.3.0] — 2026-10-17

- **The rules and the decisions are readable as MCP resources** — A client that wants to browse this tool's rules and rulings had no way to: every answer came back from a tool call with an argument in it. — [ADR-074](docs/decisions/ADR-074-a-rule-and-a-decision-are-readable-by-uri.md)

- **A plan is resumed one slice at a time** — `simt plan next` returns the next ready slice and only its section. — [ADR-081](docs/decisions/ADR-081-a-tracker-is-read-through-the-repositorys-template.md), [ADR-082](docs/decisions/ADR-082-the-tracker-override-is-a-manifest-key.md)

- **The rules are enforced at the tool call** — Three rules that text does not hold — a `git push`, a `--no-verify`, an edit inside a generated region — are now a decision before the tool call. — [ADR-079](docs/decisions/ADR-079-the-rules-are-enforced-at-the-tool-call-from-one-policy-table.md)

- **A line the repository already proves does not ship** — A rule line may say when the repository already proves it. — [ADR-078](docs/decisions/ADR-078-a-line-the-repository-already-proves-does-not-ship.md)

- **The region leads with this repository's commands** — The projected region opens with the commands this repository actually runs, derived from its committed gates and runner, in both the full projection and kernel mode (ADR-077). — [ADR-077](docs/decisions/ADR-077-the-command-card-leads-the-region-and-reads-committed-evidence.md)

- **A change to what an agent reads can be measured** — `simt bench mine`, `run`, `report`, `ablate` and `probes` measure a change to projected context against tasks taken from this repository's own history. — [ADR-076](docs/decisions/ADR-076-a-change-to-what-agents-read-is-measured.md)

- **What each reader loads, and a transcript split** — `simt harness loaders` reports what each reader loads at session start, in bytes, and what its size cap drops.

- **A name this tool owns is not reported as a repository** — `simt rules why` keeps this tool's own names (`simt-priority`, `simt-hooks`, and the rest) and still redacts a repository the reader cannot open (ADR-080). — [ADR-080](docs/decisions/ADR-080-the-tools-own-names-are-not-repositories-and-neither-reader-decides-by-shape.md)

## [0.2.2] — 2026-10-14

- **A repository can ask for a smaller projection** — `simt tokens` measured the cost and `check` now holds the line the repository draws: `budget.bytes` in `simt.json` is how many always-on bytes that repository has agreed to carry, and both the meter and the gate report the overflow with the — [ADR-073](docs/decisions/ADR-073-a-kernel-is-a-smaller-projection-the-repository-asks-for.md)

- **A repository can declare how many always-on bytes it is willing to carry** — `simt tokens` has reported that number since the meter landed, against a constant nobody could argue with. — [ADR-072](docs/decisions/ADR-072-the-budget-is-a-declaration-beside-the-gates.md)

- **A repository can declare the always-on bytes it intends to carry** — `simt tokens` measured the number; it could not be held to one. — [ADR-072](docs/decisions/ADR-072-the-budget-is-a-declaration-beside-the-gates.md)

- **A stack profile loads only when a matching file is in play** — A stack profile used to be always-on everywhere, because profiles reached a reader through the generated region in AGENTS.md and through nothing else. — [ADR-071](docs/decisions/ADR-071-a-rule-that-can-be-narrowed-is-written-narrow.md)

- **Every `--json` payload says which version it is** — An agent that parses `--json` had no way to notice that a field had moved: the parse succeeds, the lookup returns `undefined`, and the answer is quietly wrong. — [ADR-070](docs/decisions/ADR-070-the-json-payload-carries-its-own-version.md)

- **`graph lint` now checks skills against the published specification** — The Agent Skills specification sets limits nobody here was checking: a name of lowercase letters, digits and single hyphens that equals the directory it lives in; a description under 1,024 characters; a compatibility note under 500; a body

- **The MCP surface speaks three protocol revisions, and answers in the shape each asks for** — The server was pinned to one revision and returned pretty JSON in a text block, so a client could read the answer but could not validate it, could not cache it, and could not tell a read-only tool from one that writes.

- **Which harnesses a repository is set up for is now answerable** — `simt-dev harness detect` looks at the configuration directories that exist and says which harnesses this repository — and, with `--user`, its reader — is set up for.

- **A monorepo gets rules for each of its packages** — One repository, one projection: every package under the root was given the root's rules, so a React application inside a node workspace was handed the node profile and nothing else, and the profile that should have applied to it was applied

- **One rule set, shared by the repositories that agreed on it** — Several repositories want the same rules and each kept its own copy, so a policy change was several edits that could be several-minus-one, and the repository that missed it carried instructions nobody there wrote. — [ADR-065](docs/decisions/ADR-065-a-pack-is-one-shared-rule-set-pinned-by-digest.md)

- **`simt tokens` counts what a reader loads** — Review 0002 filed the estate's always-on context at 90 KB per turn, 72% of it a paragraph an earlier repository had already loaded — a number produced by reading seven repositories by hand, which ages the moment a rule is edited and cannot — [ADR-064](docs/decisions/ADR-064-the-context-meter-counts-what-the-tool-wrote.md)

## [0.2.1] — 2026-10-13

- **`init` writes in place; the backup tag and adopt branch are opt-in** — `simt init --yes` used to always tag the pre-adoption commit and branch onto a dedicated adopt branch before writing. — [ADR-063](docs/decisions/ADR-063-the-adoption-escape-hatch-is-opt-in.md)

- **A fresh adoption seeds the gates it can run — and only those** — The eight common ecosystems outside the JavaScript world — Rust, Go, .NET, Swift, Deno, Ruby, Dart and Elixir — were recognised by the fingerprint and served by nothing: no profile selected them, no gate was proposed for them. — [ADR-062](docs/decisions/ADR-062-a-fresh-adoption-seeds-the-gates-it-can-run.md)

- **The resolver is measured against a gold corpus** — `simt skills eval` scores the skill resolver against a corpus of real tasks × real repositories, each case carrying a gold list of the skills it should select and a list of the ones it must not.

- **The skill registry is workspace data; the package ships none of it** — The npm tarball and the wheel carried `graph/skills.graph.json` — the directory of skill sources for one workspace, naming the repositories whose bodies it resolves. — [ADR-061](docs/decisions/ADR-061-the-skill-registry-is-workspace-data.md)

- **No published file may name a repository from this estate** — The decision records ship in all three channels — npm, the wheel and the sdist — so a private repository name written into one is published to three registries.

- **Four shipped strings named a command this package does not install** — `0.2.0` installs one binary, `simt`, and `package.json`'s `bin` map says so.

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

- **Publishable from PyPI and Homebrew as well as npm** — simt-dev is a *repository* tool, and the people who adopt a repository are not all Node developers. — [ADR-058](docs/decisions/ADR-058-one-tool-three-channels-and-the-order-is-forced.md)

## [0.1.1] — 2026-10-11

- **A foreign hook on an event this repo does not gate is chained** — `0.1.0` chained the wrong set of hooks and is worth replacing rather than recommending. — [ADR-018](docs/decisions/ADR-018-an-unset-hooks-path-is-not-an-absent-hook.md)

## [0.1.0] — 2026-10-11

- **The command is `simt`** — The package is `simt-dev` and the command is `simt`.

- **The manifest is `simt.json`** — The manifest was called `simt-dev.json`; it is now `simt.json`. — [ADR-056](docs/decisions/ADR-056-three-names-one-of-which-is-cheap-to-move.md)

- **The region markers are `simt:`** — The generated region was stamped `<!-- simt-dev:begin -->` / `<!-- simt-dev:end -->` — and so was the provenance header inside it; every one of those lines is now `simt:`. — [ADR-056](docs/decisions/ADR-056-three-names-one-of-which-is-cheap-to-move.md)

- **A hook you already had keeps running** — `hooks install` points `core.hooksPath` at `.simt-hooks/`, and git reads **every** hook from that one directory — not just the two events this tool gates. — [ADR-018](docs/decisions/ADR-018-an-unset-hooks-path-is-not-an-absent-hook.md)

- **What a first release has to say out loud** — These are the behaviours a reader is most likely to trip over. — [ADR-010](docs/decisions/ADR-010-runner-invocation.md), [ADR-012](docs/decisions/ADR-012-drop-windows-support.md), [ADR-017](docs/decisions/ADR-017-a-declared-gate-must-be-runnable.md), [ADR-018](docs/decisions/ADR-018-an-unset-hooks-path-is-not-an-absent-hook.md), [ADR-021](docs/decisions/ADR-021-one-surface-per-repo.md), [ADR-035](docs/decisions/ADR-035-one-write-decision-and-one-json-document.md), [ADR-036](docs/decisions/ADR-036-a-writer-that-writes-says-so-and-the-instructions-naming-it-move-with-it.md), [ADR-046](docs/decisions/ADR-046-one-rule-one-copy.md)

- **Packaging** — - Licence set to Apache-2.0; the `LICENSE` file is the canonical, unmodified text.

- **Notes for anyone upgrading a hook** — A shim installed by an earlier version looks for `SIMT_DEV_BIN`, then for `node_modules/simt-dev/bin/simt-dev.mjs`, then for a program named `simt` on `PATH`.
