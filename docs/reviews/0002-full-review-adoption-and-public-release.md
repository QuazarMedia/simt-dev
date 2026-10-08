# Review 0002 — simt-dev at `4c27514`: fixes, enhancements, SIMT adoption, public release

Status: open · 2026-10-06
Reviewed at: `4c27514` on `main` (clean worktree, level with `origin/main`), 13 commits after
review 0001 (`09c596d`)
Verdict: **BLOCK** for a public release and for estate-wide enforcement (ADR-008 vocabulary)
Companion: `docs/plans/0003-intelligence-amplifier-research-plan.md`, the R&D plan this review
feeds

This review re-verified every review 0001 slice at `4c27514`, carried the open ones into a single
tracker here, and added S23–S51. Where a 0001 fix still stands, it is referenced rather than
repeated.

**§3 below is the only tracker of slice state.** Review 0001 used to carry its own copy of
S01–S22, which is now removed: two tables is how S11 shipped at `5c079cd` while review 0001
still read Queued. 0001 is kept as reference — what each slice *is*, where it was found, why it
mattered — under `Status: reference`. If you are here to ask whether something is done, read §3;
if you are here to ask what a slice means, read 0001's `## Slice details`.

## Summary

The design holds. A zero-dependency, deterministic projector with fail-closed gates,
byte-verified sources and a decision index is the right shape for this job, and the 492-test
suite is fast and careful. But at `4c27514` the tool is not doing its job in any repository,
for five reasons:

1. **Every consumer drifts on its own next commit** (S01, still open). All 14 adopted estate
   repositories read as drifted, although `git diff 2835821 4c27514 -- rules/` changes only
   frontmatter key names. The drift is the stamp, not the rules.
2. **Nothing is enforced.** 0 of 14 repositories route their hooks through simt-dev, none has
   the CI workflow, and none can obtain the binary. The package is unpublished, not on `PATH`
   and not in any `node_modules` (S35, S36).
3. **Writers break their own safety contract.** `sync` writes without `--yes`, and it wrote
   into `simt-api` during this review (§1.3). `upgrade --yes --dry-run` writes,
   `skills install --json --yes` does not, and the pre-commit restage commits unstaged work
   (S08, S10, S24).
4. **It is not generic yet.** Any TypeScript repository receives Cloudflare D1 and Durable
   Object rules. A Gradle backend receives Compose and Wear OS rules, React Native receives web
   CSS rules, and a Poetry project receives `uv` rules (S28). The shipped profiles and the
   registry carry SIMT product policy (S18, S39).
5. **It spends the tokens it exists to save, and nothing measures it.** This 7-root workspace
   loads 90,042 bytes (~22.5k tokens) of generated text on every turn, and 72% of it repeats
   text already loaded from another root (S38). An ICLR 2026 study of `AGENTS.md` files found
   that context files raise agent cost by more than 20% without improving task success. Plan
   0003 is built on that finding.

None of this needs a redesign. Wave 0 in §9 is eight slices. It makes `check` green and keeps
it green, and the runbook in S36 then turns the estate from advisory to enforced.

## 1. Scope and method

### 1.1 Read

Every module under `src/`, plus `bin/`, `rules/` (core, 8 stack profiles, 5 `.mdc` rules),
`graph/skills.graph.json`, the status line and cited rulings of all 26 ADRs, `test/` (what
each suite calls), `.github/workflows/`, `.githooks/` and `package.json`. Also read: review
0001 in full, and plans 0001 and 0002 for intent.

### 1.2 Run

Mutating commands ran only in scratch repositories under `/tmp/simt-review`. The estate was
only read, with `compare`, `graph lint` and `git status/diff`, apart from the incident in §1.3.

| # | Probe | Result | Slices |
| --- | --- | --- | --- |
| 1 | `npm test`, outside the sandbox (inside it, `git init` cannot write `.git/hooks`) | 492/492 pass, 15.7 s | — |
| 2 | `npm pack` → install into a scratch repo → `init --yes` → commit → `check` | stamp = the consumer's HEAD; `check` exits 1 after each commit; `sync` restamps regions but leaves `projection.simtDevSha` behind | S01 |
| 3 | `compare --workspace ~/code/simt` | 16 repos: 14 adopted, 0 current, 14 drifted, 17 stale rule files, 0 hooks routed, 6 running their own hooks | S01, S25, S36 |
| 4 | `git diff 2835821 4c27514 -- rules/` | frontmatter key renames only | S01 |
| 5 | plain TypeScript repo, `init --yes` | profiles `core, cloudflare-workers`; `AGENTS.md` 38 B → 12,026 B | S28 |
| 6 | fingerprint matrix: JVM backend, React Native, Poetry, npm-workspaces monorepo, Rust, Go, .NET, Swift, Deno, Ruby, Flutter, Elixir | wrong profile for 3; node fallback for the monorepo; core only for 8 | S28, S32, S40, S41 |
| 7 | Prettier 3.8.3 on a freshly adopted `AGENTS.md` and on the `.editorconfig` baseline | `--check` exits 1 (blank line before the region); `[prettier] singleQuote = true` changes nothing | S29, S30 |
| 8 | partial stage plus a `format` gate, then commit | the unstaged line is committed; the hook prints `PASSED` | S08 |
| 9 | `CLAUDE.md` → `README.md`, and a directory named `CLAUDE.md` | `check` exits 0; `sync` crashes with `EEXIST` after partial writes | S09 |
| 10 | workspace with one region-less adopted repo; `upgrade --yes --dry-run` | writes both repos, and adds a region to the one that had none | S10, S26 |
| 11 | `--json` runs: `hooks status` with a hook deleted, `skills brief` with no task, `skills install --yes`, `ci --dry-run` | `ok: true` with exit 0; text, not JSON; nothing installed; 0 bytes on stdout | S10, S23 |
| 12 | `ci` in a clone whose workflow copy was hand-edited | exit 0 | S23 |
| 13 | `skills install` into a repo with no manifest and no scripts | the new manifest declares `format, lint, test, typecheck`; `check` reports 4 × UNRUNNABLE | S27 |
| 14 | `skills brief --task "fix a typo in the README"` with no workspace | 4 estate skills selected on `summary:the`; 30.9 KB against a 20.5 KB budget; a dependency of a deferred skill inlined; the same remedy printed 4 times | S04, S06, S33 |
| 15 | MCP over stdio: `initialize` (2025-11-25), `tools/list`, `rules_why`, `check` | answers 2025-06-18; `rules_why` crashes for both argument shapes; every result is pretty-printed text | S05, S43 |
| 16 | `rules why ADR-023` | status cut at "ruling 2 superseded by"; ruling 2 printed as in force | S31 |
| 17 | generated bytes in this session's context, 7 roots | 90,042 B, of which 64,738 B (72%) repeat text from another root | S38 |
| 18 | byte offset of the region in each `AGENTS.md` | the `simt-garmin` region starts at byte 38,251, past Codex's 32 KiB default read limit | S37 |
| 19 | `graph lint`, with and without `--workspace` | 37 skills, 23 capabilities, byte counts verified, no findings | — |
| 20 | hook shim with no reachable binary | the commit is refused (fail-closed, correct); the remedy `npm i -D @quazarmedia/simt-dev` cannot succeed | S35 |

### 1.3 Incident during the review

`node bin/simt-dev.mjs sync --root ../simt-api` was run in the belief that it previews. It
wrote `AGENTS.md` (one line, `sha=2835821` → `4c27514`) and created a new `.editorconfig`. The
diff was checked to be exactly those two changes and reverted (`git checkout -- AGENTS.md`,
`rm .editorconfig`), and `simt-api` is clean. Every other writer previews unless given `--yes`.
That `sync` does not is S24.

### 1.4 Left alone

Pre-existing uncommitted work was not touched. This covers 10 files in `simt-app` (onboarding
and compass work), and `simt-dev.json` in `simt-social` and `simt-blog`. In both of those,
`simtDevSha` went from `d4329ce` to `2835821`, written at 13:42 by an earlier `upgrade` and
never committed. That is S01 again, seen from the estate.

## 2. Vocabulary

- **Severity**, as in review 0001: **P0** breaks consumers or blocks release; **P1** is wrong
  behaviour an agent will hit and act on; **P2** misleads but does not break; **P3** is hygiene.
- **Group**: **F** must fix (wrong behaviour or a broken contract); **E** enhances existing
  behaviour; **A** is needed for full SIMT adoption; **R** is needed for a public release.
- **State**: **Queued**, **In progress**, **Complete**, or **Accepted** (left open on purpose,
  with the written reason in the row). When a row changes state, record the SHA and the exact
  test command in it.

ADR numbers proposed here (027–035) are provisional. Take the next free number when the
record is written.

## 3. Tracker

| ID | Slice | Sev | Grp | Area | Needs ADR | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Provenance stamp came from the consumer's git, not simt-dev | P0 | F | projection | yes (P1) | — | Complete | ADR-032; `provenanceDigest()` |
| S02 | Leading `**/` path globs never match | P0 | F | resolve | no | S47 (optional) | Queued | re-verified |
| S03 | Multi-word and short keywords/aliases are unreachable | P1 | F | resolve | no | — | Queued | #14 |
| S04 | Stack overlap alone selects a skill; a stopword selects too | P1 | F | resolve | yes | S02, S03 | Queued | #14 |
| S05 | MCP `rules_why` crashes on every call | P0 | F | mcp | no | — | Complete | `1791a95` (review 0001 #15) |
| S06 | MCP and CLI disagree; the closure ignores the budget | P1 | F | mcp, resolve | no | S05 | Queued | #14, code |
| S07 | Directory facts with a `/` in the path are never detected | P1 | F | fingerprint | no | — | Queued | #6 |
| S08 | Hook restage stages unstaged hunks; deletions break restage | P0 | F | hooks | **yes (ADR-034)** | — | Complete | `e3566dc` |
| S09 | `sync`/`init` crash on a mispointed pointer, and `check` passes it | P1 | F | projection | only if pointer drift blocks | — | Queued | #9 |
| S10 | `--yes` / `--dry-run` / `--json` contract is inconsistent | P1 | F | cli | **yes (ADR-035)** | — | Complete | `14fcd5b`; **amended by ADR-040**, which found a sixth writer still writing by default |
| S11 | `slice-commit` rule can never be projected | P1 | F | rules | no | — | **Complete** | `5c079cd` |
| S12 | Folding + per-rule surfaces load every process rule twice | P1 | F | surfaces | yes (P7, supersedes ADR-021 §3) | — | Queued | 5 estate repos, #17 |
| S13 | `rules list/show/why` cannot see the `.mdc` rules | P2 | F | rules | no | — | Queued | re-verified |
| S14 | Shipped text that fails "readable from the receiving repo" | P1 | F | content | no | — | Queued | re-verified, +1 |
| S15 | Help text and flags do not match the CLI | P2 | F | cli | no | S10 | Queued | re-verified |
| S16 | Generated rule-file frontmatter never regenerates | P2 | F | projection | no | — | Queued | re-verified |
| S17 | Declared gate commands split on whitespace | P2 | F | hooks | amend ADR-019 | — | Queued | re-verified |
| S18 | Public-release packaging | P0 | R | package | yes (P4) | S01, S14, S39 | Queued | re-verified, +3 |
| S19 | Docs and ADR consistency | P2 | F | docs | no | — | Queued | 1 item done in `fd37ab5` |
| S20 | Test gaps that let S01–S11 ship green | P1 | F | tests | no | lands with each slice | Queued | re-verified |
| S21 | Dead code, duplicate parsers, stale comments | P3 | E | hygiene | no | — | Queued | re-verified |
| S22 | Robustness at the edges | P3 | E | various | no | — | Queued | re-verified |
| S23 | simt-dev's own "gate copy is current" CI step cannot fail | P1 | F | ci | **yes (ADR-039)** | S10 | Complete | `97f8da7` |
| S24 | `sync` writes without `--yes` | P1 | F | cli | **yes (ADR-036)** | S10 | Complete | `f5a626c` — **its premise named the wrong command**: `hooks install` also wrote by default, and is ADR-040 |
| S25 | `compare` hides stale rule files; `profiles` is never filled | P1 | F | compare | no | — | Queued | #3 |
| S26 | `upgrade` adds a region to a repo that has none | P1 | F | upgrade | no | S10 | Queued | #10 |
| S27 | `skills install` creates a manifest with gates the repo cannot run | P1 | F | skills | **yes (ADR-038, amends ADR-017)** | — | Complete | `4c73025` |
| S28 | Profiles select on language tags, not on platforms | P1 | F | rules, fingerprint | yes (P3) | S07 | Queued | #5, #6 |
| S29 | An appended region fails `prettier --check` | P1 | F | projection | **yes (ADR-037)** | — | Complete | `1bbc36a` |
| S30 | `.editorconfig` baseline ships an inert section and a false comment | P1 | F | baselines | yes (P9, amends ADR-025) | — | Queued | #7 |
| S31 | Partial supersession is lost by the decision index | P2 | F | decisions | no | S19 | Queued | #16 |
| S32 | Sources in a standard Gradle layout are never sampled | P2 | F | fingerprint | no | — | Queued | #6 |
| S33 | `skills brief` spends bytes on bodies it cannot show | P2 | F | resolve | no | S06 | Queued | #14 |
| S34 | Folded rules break the heading hierarchy | P2 | F | projection | no | — | Queued | rendered regions |
| S35 | No estate repo or CI runner can obtain the binary | P0 | A | distribution | yes (P5) | S18 | Queued | #20 |
| S36 | Estate roll-out: from 14 drifted to 14 enforced | P1 | A | adoption | amend ADR-018 | S01, S08, S10, S24, S35 | Queued | #3 |
| S37 | A region past a harness's read limit is invisible to it | P1 | A | projection | no | — | Queued | #18 |
| S38 | Workspace token cost: 90 KB per turn, 72% repeated | P1 | A | projection | yes (P7) | S12 | Queued | #17 |
| S39 | Estate policy belongs in an estate pack | P1 | A | rules, package | yes (P4) | S28 | Queued | profiles |
| S40 | Eight common ecosystems get only the core rules | P1 | R | fingerprint, rules | no (data, ADR-013) | S28 | Queued | #6 |
| S41 | A monorepo gets one root projection | P1 | R | projection | yes (P6) | S28 | Queued | #6 |
| S42 | Harness coverage stops at five surfaces | P1 | R | surfaces | no (rows are data) | S12 | Queued | research |
| S43 | MCP server is two spec revisions behind and returns text only | P2 | R | mcp | no | S05, S06 | Queued | #15 |
| S44 | Agent Skills conformance is not linted | P2 | R | skills | no | — | Queued | 37/37 names conform |
| S45 | Core and process rules speak one language and one harness | P2 | R | rules | no | S14 | Queued | rendered regions |
| S46 | The POSIX-only stance reaches an installer as `EBADPLATFORM` | P3 | R | docs | no (ADR-012 stands) | S18 | Queued | — |
| S47 | The Node floor is end-of-life | P2 | E | runtime | yes (P8) | — | Queued | release schedule |
| S48 | Workflow templates: tag-pinned actions, Node 20, an install that needs npm | P2 | E | ci | no | S35, S47 | Queued | `workflow.mjs` |
| S49 | Dependabot misses Gradle, submodules and seven more ecosystems | P2 | E | ci | no | — | Queued | `dependabot.mjs` |
| S50 | Rule files load eagerly where a surface could scope them | P2 | E | surfaces | yes (P7) | S12 | Queued | `surfaces.mjs` |
| S51 | JSON output has no schema version and no compact form | P3 | E | output | no | S10 | Queued | `output/index.mjs:68` |
| S52 | `hooks install` writes without `--yes` | P1 | F | hooks | **yes (ADR-040)** | S10 | Complete | found while probing §9's exit criterion for S20; see the resolution below |

## 4. Review 0001 at `4c27514`

| ID | At `4c27514` | What changed since `09c596d` |
| --- | --- | --- |
| S01 | open, and visible estate-wide | **now Complete** — ADR-032 replaced the git stamp with `provenanceDigest()`; the `sync` half below still stands |
| S02 | open | `**/*.md`, `src/a?.ts`, `src/{a,b}.ts` still fail; a stable built-in now exists (below) |
| S03 | open | `tokenize("Fix the UI CI job in Go: add a DB migration for i18n, ar/RTL, café, تحويل")` → `fix, the, job, add, migration, for, i18n, rtl, caf` |
| S04 | open, extended | a stopword selects (below) |
| S05 | **Complete** | `1791a95` — all three call shapes crashed, not two; `tools.mjs:316` destructured an array |
| S06 | open, extended | the closure runs before the budget (below) |
| S07 | open | a fixture with all six slash-path facts emits only `has-tests-dir` (`fingerprint.mjs:168-173`) |
| S08 | open, reproduced | ADR-034: the gate now refuses a partially staged file; restage covers only the formatter's own targets and reports only files whose blob moved |
| S09 | open, extended | `check` passes the mispointed pointer (below) |
| S10 | open, extended | **now Complete** — ADR-035: one `writeMode()` decides whether a run may write, and `test/contract.test.mjs` asserts the JSON contract for 19 commands at once. Six of the eight claimed defects were real and reproduced; the error-path row was **backwards** (`sync --json` emits its errors correctly), the `--all` row was not reproducible, and `skills why --json` — which printed prose and had no `isJson` branch at all — was a defect the table missed. `init --json` is **not** a defect: `init` never consults the workspace, so both modes agree. `sync` requiring `--yes` stays S24. |
| S11 | **Complete** | `5c079cd` gave `slice-commit.mdc` `simt-applies: always`; its estate sentence is tracked in S14 |
| S12 | open | 5 estate repos run `opencode,cursor` (below) |
| S13 | open | `commands/rules.mjs` still reads `loadRules` only |
| S14 | open, +1 | remedies moved to `sync.mjs:62`, `init.mjs:167`, `project.mjs:174`; the leak guard misses `simt-api` |
| S15 | open | `argv.mjs:21-24,35` unread flags; `--skill` keeps the last value; `init --yes` still tags and switches branch |
| S16 | open | `targets.mjs:52` |
| S17 | open | `hooks/resolve.mjs:98` |
| S18 | open, +3 | below |
| S19 | partly done | the `AGENTS.md` contradiction was fixed in `fd37ab5`; the rest stands (below) |
| S20 | open | no pack-install test; `test/mcp.test.mjs` calls 3 of the 10 tools |
| S21 | open | the same items at `hooks/resolve.mjs:17,24,28,32`, `commands/index.mjs:37,131`, `skills.mjs:21`, `graph/load.mjs:482`, `targets.mjs:163` |
| S22 | open | `near.mjs` substring match, `conflicts.mjs:22,25` |

### 4.1 Fixes that change since review 0001

**S01.** 0001's fix stands: stamp the content, compare only the region body, and record the change
in an ADR (proposal P1, "a projection is identified by its content"). It was **not** implemented as
written: 0001 and this review both propose the package `version` alongside the digest, and ADR-032
stamps content only — `0.0.0` cannot distinguish two working trees that project differently, and a
version that looks identical in both is worse than no version at all. Add three things:

1. `sync` must rewrite `projection` in `simt-dev.json` in the same write as the regions. Today it
   restamps the regions and leaves `simtDevSha` behind, so `check` reports
   `STALE-GENERATED-FIELD` with the remedy `init --yes`.
2. **Migration without churn.** Treat a legacy `sha=` header as equal whenever the body
   matches. Upgrading the tool must not rewrite 14 repositories whose rules did not change.
3. The root cause is `rules.mjs:43-50`. `git rev-parse` runs with `cwd: ROOT`, and inside a
   consumer's `node_modules` git walks up to the consumer's `.git`. Read the version from the
   package's own `package.json` (`new URL('../../package.json', import.meta.url)`). Ask git
   only when `git -C ROOT rev-parse --show-toplevel` equals `ROOT`.

**S02.** 0001's segment translation still works. With S47 it becomes one line instead:
`path.matchesGlob(filePath, glob)`, stable since Node 22.20 and 24.8. On Node 26.10 it returns
`true` for all four failing cases (`a/b/c.ts` and `c.ts` against `**/*.ts`, `src/a.ts` against
`src/{a,b}.ts`, `src/ab.ts` against `src/a?.ts`). Delete `resolve.mjs:153-167`, and keep the
`graph lint` compile check.

**S04.** New evidence: for `"fix a typo in the README"`, the single token `the` matched a skill
summary (weight 8) and selected `add-country-galaxy` in a repository unrelated to the estate.
Add a stopword list to summary matching, and a minimum score of 25, so that only a
capability-strength signal or better selects. This is on top of 0001's "stack is a
tiebreaker".

**S06.** Both budget loops also inline the `requires` closure of a parent that was itself
deferred. `closure()` runs before the budget (`skills.mjs:266`, `tools.mjs:127`), and `isDep`
bypasses it (`skills.mjs:274-275`, `tools.mjs:135-136`). In probe #14, `parallel-feature-team`
was deferred while its dependency `slice-commit` was inlined. 0001's extracted
`selectWithinBudget()` must:

- take the closure of *inlined* parents only;
- count dependencies against the budget;
- defer a parent together with its group when the group does not fit.

**S09.** Two additions:

- `check` exits 0 when `CLAUDE.md` points at `README.md`. `pointer-drift` is in `NON_BLOCKING`
  (`sync.mjs:37`), so Claude Code reads none of the rules while `check` is green.
- A *directory* named `CLAUDE.md` is reported as nothing at all.

Proposed fix: pointer drift blocks whenever the pointer belongs to a selected surface, and a
directory is `foreign`.

**S10.** Add rows: `ci --json --dry-run` emits nothing (S23); `sync` writes by default (S24). The
`writeMode(flags)` helper from 0001 covers both.

**S12.** The estate scale is now measured. Five repos use `opencode,cursor`: `simt-app`,
`simt-blog`, `simt-social`, `simt-social-api` and `simt-social-media`. Their 17 managed `.mdc`
files repeat text already folded into `AGENTS.md`, and in this session `simt-app`'s three
files alone are 6,530 B loaded twice. The decision moves into P7 (S38), so that one record
settles every context-budget question.

**S14.** `test/leaks.mjs` matches `simt-(app|space|goto|social|blog|landing|garmin|jobs|media|wearable)`,
which omits `simt-api`. A projected rule that names `simt-api` passes the guard. Add it, and
derive the list from the workspace registry rather than hand-keeping it.

**S18.** Three additions:

- `files` still lists `skills`, `agents`, `tooling` and `hooks`, none of which exist, and
  `docs/plans` still ships. That means plan 0003 ships in the tarball too until this row lands.
- npm returns 404 for both `@quazarmedia/simt-dev` and the unscoped `simt-dev`. Decide the
  public name before anything links to it.
- The tarball is 244.1 kB packed, 739.4 kB unpacked, 90 files, with no `README` and no
  `LICENSE`. An own CI workflow now exists, but it runs on `ubuntu-latest` only, so ADR-012's
  macOS claim is still false (S48).

**S19.** Still open:

- ADR-001 to ADR-020 write `**accepted**` and ADR-021 to ADR-026 write plain `accepted`. The
  loader keys on the bold form (`decisions/index.mjs`, `accepted: status.includes('**accepted**')`),
  so six accepted records read as not accepted.
- The dates run out of order: ADR-019 to ADR-021 are 2026-10-07, ADR-022 is 2026-10-08, and
  ADR-023 to ADR-026 are 2026-10-06.
- `docs/decisions/README.md:76` still says `simt init`, and plan 0002 says `simt graph lint` /
  `simt check` at lines 57, 201 and 317.

**S20.** All five 0001 test families are still missing. The pack-install end-to-end test is the
one that would have caught S01, S27 and S35 before they shipped; land it first, with S01.

## 5. Must fix — new findings

### S23 — simt-dev's own "gate copy is current" CI step cannot fail (P1)

**Finding.** The own workflow's last step, "the gate copy in this repo is current", runs
`node bin/simt-dev.mjs ci` (`workflow.mjs:188-191`). With a stale copy, `ci` prints the plan
and returns `EXIT.OK` (`ci.mjs:99-102`). The step therefore lets through exactly the drift its
own comment says it exists to catch. Two more defects:

- `ci --json --dry-run` prints nothing, because JSON is emitted only when neither flag is set
  (`ci.mjs:92`).
- Run in an adopting repository, `ci` refuses but reports `ok: true` with exit 0
  (`ci.mjs:135-154`).

**Repro.** Clone the repo, edit `.github/workflows/simt-dev-check.yml`, then run
`node bin/simt-dev.mjs ci; echo $?`. It prints `0`.

**Fix.** Add `ci --check`, which exits `EXIT.FAIL` when any target's action is not
`unchanged` and prints the unified diff, and have the own workflow run it. Route the flags
through `writeMode` (S10). `failOutside` returns `EXIT.UNSUPPORTED` with `ok: false`.

**Accept.** A stale copy makes `ci --check` exit 1 and a current copy exits 0.
`ci --json --dry-run` emits exactly one JSON document. Run in a consumer, `ci` exits 5.

> **Resolved by ADR-039**, all three acceptance points implemented. The line numbers in the
> finding had drifted — the command has changed since — but all three behaviours reproduced
> exactly as described, so only the references were wrong.
>
> The own gate now runs `node bin/simt-dev.mjs ci --check`, and `--check` never writes
> whatever else it is given: a check that repairs is a second writer, which is ADR-036's
> subject. It prints a unified diff of the two files, because the reader is the author of
> the template change and the question they have is *what did I change*; the plan now
> carries both sides of the comparison so the verdict and the diff cannot disagree, and
> both are stripped from the JSON payload. Context is elided to three lines a side — fifty
> lines of workflow around one changed step buries the only reason the step beats an exit
> code.
>
> The refusal is `EXIT.UNSUPPORTED` with `ok: false`. Not because something is wrong, but
> because the request cannot be satisfied *in this repository*, which is what that code
> means (`output/index.mjs:16`). It was also contradicting ADR-035 directly: `ok: true` and
> exit 0, one line below a paragraph saying it was refused. The existing test asserted exit 0
> and carried the reasoning *"the refusal must not be an error, because nothing is wrong"* —
> that is this record's third ruling overturned, so the comment now says why the opposite
> holds.
>
> The `--check` and `--json` tests run **in this repository against a stale copy**, with a
> `finally` that restores the file, because `isOwnRepo` compares against the package root
> and no temp repo reaches this code at all. The first version of the JSON test used a
> fixture and **passed with the guard restored**: the fixture was not the own repository, so
> every mode took the refusal path and printed a perfectly good document for the wrong
> reason. A mutation found it. Four mutations were applied and reverted, each caught by its
> own test.

### S52 — `hooks install` writes without `--yes` (P1, decision)

**Finding.** Not in this review. Found while probing §9's exit criterion — "a packed install
survives `init`, two commits, `check`, `upgrade`, `hooks install` and a real commit, **with every
writer previewing by default**" — by running the criterion by hand against a packed install
before writing the test that would assert it. In a fresh repo declaring `lint` and `test`,
`simt-dev hooks install --root .` printed `WROTE    shims and set core.hooksPath` and exited 0.

`hooks.mjs` read `flags.yes` (line 146) and `flags.dryRun` (line 169) directly and imported no
write decision at all. ADR-035's ruling already named that pattern as a defect; S24 then took
`sync` out of the set and, in doing so, asserted that the rest of the set was clean. **Four of the
five commands S24 named as previewing were. The fifth was not.**

This is S24's premise, corrected. The other four sources agreeing it is a defect are: ADR-035's
ruling ("a command that consults `flags.yes` directly is a defect whether or not its arithmetic
happens to agree today"); the code being that pattern; §7's migration script telling an operator to
run `hooks install` "for a plan" and then `--yes`; the four shipped strings that assumed a
preview, one of them the `Reinstall with:` comment inside the shim that gets installed into every
adopting repository; and `contract.test.mjs`'s `WRITERS` table, which covered `upgrade`, `sync`
and `skills install` and never `hooks install` — which is why 586 tests passed.

The comment `sync.mjs` gained under ADR-036 is part of the evidence and had to be amended: it
called `hooks install` one of the writers that "all preview unless told otherwise", one commit
after it was written.

**Fix.** ADR-040. `hooks install` reads `writeMode(flags)`; `--yes` writes; the preview exits 0
and names the command that applies it. Four shipped strings move with it — `init`'s remedy, both
`compare` remedies, the shim's `Reinstall with:`, and the help synopsis.

**Accept.** The `WRITERS` row, plus an exit-code assertion that the row could not have passed
without.

> **Resolved by ADR-040**, and the interesting part is the test rather than the fix. The first
> `WRITERS` row would have been **vacuous**: pointed at the table's existing python fixture,
> `hooks install` is *refused* (correctly — a shim with an empty gate list enforces nothing yet
> still replaces whatever git was running), a refusal changes nothing, and "wrote nothing without
> `--yes`" holds. The row carried `stack: 'node'` and the table grew an assertion on the exit
> code of every unauthorised run — 0 for a rehearsal, non-zero only for `sync`, which is also a
> check. That assertion was **itself wrong first**: it also covered the rehearsed form, and
> `sync --yes --dry-run` reports the work it found exactly as the unauthorised form does
> (ADR-036), so the whole table failed. Both were caught by mutations, and both are the same
> shape as S29's and S23's first drafts this batch.
>
> The row's `verify` fingerprints **both** things the command writes — the shim and
> `core.hooksPath` inside `.git/config`. A preview that set the config without writing the shims
> would leave a repo whose commits are gated by a hook git does not run; that mutation is caught
> by the fingerprint and **passes** with the config probe removed. Six mutations, each caught by
> its own test, and a seventh recorded because it was **not**: `hooks install --yes` that never
> sets the config passes `contract.test.mjs` entirely, because the row only exercises
> unauthorised and rehearsed runs. Six tests in `hooks.test.mjs` catch that one.

### S24 — `sync` writes without `--yes` (P1, decision)

**Finding.** `sync` is the only writer that writes by default (`sync.mjs:119`,
`if (checkOnly !== true && flags.dryRun !== true)`). `init`, `upgrade`, `hooks install`,
`skills install` and `ci` all preview first. An agent that pattern-matches on the other five
previews by running `sync` and writes instead. That is what happened in §1.3.

> **The finding is wrong about one of the five.** `hooks install` did not preview first; it
> wrote the shims and repointed `core.hooksPath` whenever neither `--yes` nor `--dry-run` was
> passed. The rest of the finding stands and the fix is unchanged, but the claim that made it
> urgent — that `sync` was the odd one out among six — was one of five rather than one of six.
> See **S52** and ADR-040.

**Fix.** Proposal P2, "every writer previews unless told to write", as follows:

- `sync` without `--yes` prints the plan. It exits 0 when nothing would change and 1 when
  something would, so plain `sync` also works as a check.
- `--yes` writes.
- Every remedy string `run: simt-dev sync` becomes `run: simt-dev sync --yes`. Grep `src/` for
  `simt-dev sync`; the S14 test asserts the new spelling.

This is a breaking CLI change, so state it in the CHANGELOG (S18).

**Accept.** The S10 contract table includes `sync`. No file's mtime changes without `--yes`.

> **Resolved by ADR-036**, with both halves of the acceptance implemented: `sync` is a row in
> `test/contract.test.mjs`, and its unauthorised run is asserted to exit **non-zero** as well
> as to leave the bytes alone — the byte assertion alone passes on a preview that reported
> success. The fix as specified was incomplete in a way worth recording. Twenty-six places in
> `src/` name `simt-dev sync` in a remedy and **two of them ship**: the note inside every
> generated region and the manifest's `$comment` both instruct the reader to run the command
> that regenerates the text they are looking at. Changing the gate without changing them
> leaves a permanently-false instruction in every consumer repository — the reader with no
> other copy to check it against. The guard that was supposed to catch this read
> `/simt-dev sync/`, which passes identically on both sides of the change, so it could not
> have prevented the defect it appeared to cover; it now asserts `/simt-dev sync --yes/`, and
> a new test walks `src/` for the bare spelling. Three mutations were applied and reverted,
> each caught by its own test. The CHANGELOG entry the fix asks for is not actionable yet —
> there is no CHANGELOG, and S18 is the row that adds one, so it is recorded there as a
> dependency rather than created here.

### S25 — `compare` hides stale rule files; `profiles` is never filled (P1)

**Finding.**

- `row.mjs:112` pushes the stale-rule-file problem only when `row.adoption === 'adopted'`, but
  `adoption` is still `'unmanaged'` at that point (it is initialised at `row.mjs:78` and only
  assigned at `row.mjs:127-131`). In the estate, `simt-app` has 0 of 3 rule files current, yet
  its `problems` lists only the pin and the hooks path. The summary still counts
  `staleRuleFiles: 17`.
- `profiles` is documented as "profile ids that would be selected" (`row.mjs:33`) and is
  initialised to `[]` (`row.mjs:83`). Nothing assigns it, so every row reports no profiles.

**Fix.** Assign `adoption` before collecting problems. Fill `profiles` from the same `select()`
that `sync` uses.

**Accept.** Fixture: an adopted repo with one stale `.mdc` lists it in `problems`, and
`profiles` equals the profile set `sync` renders.

### S26 — `upgrade` adds a region to a repo that has none (P1)

**Finding.** The no-region guard (`upgrade/plan.mjs:73`) is
`list.every((t) => t.action === 'added' && !t.previousBytes)`. A repository whose `AGENTS.md`
is hand-written with no region has `previousBytes > 0`, so the guard is false and `upgrade`
adds a region. It is a repo that opted in (manifest present) and never had a region. The
message then says "the rules changed" when only the stamp moved.

**Fix.** Guard on region state, not bytes: skip when every target's `regionBefore` is
`absent`, with the note `no generated region; adopt with: simt-dev init`. Word the message from
the body diff (S01): either "rules changed" or "stamp only".

**Accept.** Workspace fixture: `upgrade --yes` leaves a region-less repo byte-identical and
names it in the output.

### S27 — `skills install` creates a manifest with gates the repo cannot run (P1)

**Finding.** With no `simt-dev.json`, `recordLocal` builds one through
`buildManifest({ root, stack, sha })` with no capability probe (`skillsinstall.mjs:468-477`). In
a repository with no scripts and no Prettier, the result declares `format` and `lint`
(pre-commit) and `test` and `typecheck` (pre-push). `check` then reports four UNRUNNABLE gates,
and once hooks route through the manifest every commit is blocked. ADR-017 exists to prevent
exactly that. The stamped `simtDevSha` is also simt-dev's own HEAD (S01).

**Fix.** Pass the same capability probe `init` uses, so that `planGates(stack, capability)`
keeps only runnable gates, and write `gates: {}` when none are. Separately, move line 186's
"dry-run nothing written" note below the `--yes` check (0001 S10 row 3).

**Accept.** The fixture from probe #13 produces a manifest whose every gate `check` accepts.

> **Resolved by ADR-038**, which amends ADR-017 rather than restating it. The behaviour is
> the fix as written — `recordLocal` passes the same capability probe `init` uses, so
> `planGates` keeps only runnable gates — and the second half of the fix (moving line 186's
> `dry-run nothing written` note below the `--yes` check) shipped with ADR-035 as S10 row 3.
> The `Needs ADR` column said `no` because the belief looks settled, and it is: **ADR-017
> ruled that a gate is declared only if the repo can run it.** What had gone wrong was the
> sentence carrying it. ADR-017 attributes the mechanism to one command — *"`init` filters
> the stack table's proposals"* — and that attribution stayed true only while `init` was the
> sole writer of a manifest. `skills install` also writes one, for a repo that has none.
> Settling a belief and attributing it to a single command are different acts, and only the
> first one is safe to skip a record for.
>
> Measured end to end before changing anything: a bare Node repo ran
> `skills install api-contract-sync --yes` and was handed four gates it cannot run; `check`
> reported 4 × UNRUNNABLE and exited 1; after `hooks install`, a real commit ran the
> pre-commit gate, which failed both staged gates and blocked. The hook's own exit code is
> not the commit's, so the reader's first evidence is a commit that silently did not happen.
>
> The test that should have caught it asserted the opposite of the truth —
> `assert.ok(manifest.gates.preCommit.length > 0 && …)`, reading non-empty as correct. That
> is a test about manifests being right passing on a manifest declaring four gates nobody
> could run, and it is the fourth instance in this repository of presence read as
> correctness. It now asserts `deepEqual(manifest.gates, { preCommit: [], prePush: [] })`,
> and a new test runs `unrunnableGates(manifest, await readCapability(root))` — the function
> `check` runs, with the probe `check` uses — against a bare fixture *and* a capable one, so
> a fix that hardcoded two empty lists cannot pass either half.
>
> Three mutations, each caught by its own test: the `capability` argument removed, a
> hand-built empty capability substituted for the probe (caught by the capable half, not the
> bare one), and the capable half's non-empty assertion deleted — which the bare half alone
> did not notice, confirming both halves earn their place.

### S28 — Profiles select on language tags, not on platforms (P1, decision)

**Finding.** `simt-applies` lists tags such as `typescript`, `gradle` and `react`. These say
what a repo is written in, not what it runs on:

| Repo | Profile it gets | Why it is wrong |
| --- | --- | --- |
| any TypeScript library | `cloudflare-workers` (D1, Durable Objects, wrangler) | the profile applies on `typescript` |
| Spring or Ktor backend on Gradle | `jvm-android` (Compose, Wear OS, overlay policy) | the profile applies on `gradle` |
| React Native / Expo | `react-web` (CSS logical properties, WCAG reflow, browser matrix) | the profile applies on `react`, and `DEP_TAGS` maps `react` and `react-dom` to the same tag (`fingerprint.mjs:50-51`) |
| Poetry project | `python` (`uv run -m`, `uv.lock`) | the profile is `uv`-specific |

Two smaller ones: `hono` runs on Node, Bun and Deno, so it is not evidence of Workers, and
Wrangler also accepts `wrangler.json`, which `MARKERS` misses (`fingerprint.mjs:26`).

**Fix.** Proposal P3, "a profile selects on what a repository runs on":

- `cloudflare-workers` applies on `cloudflare-workers` only (a wrangler marker, or the
  `wrangler` dependency).
- Split `jvm-android` into `jvm` (Gradle or Maven, Kotlin or Java: wrapper-only, no `!!`) and
  `android`. `android` selects on a new `has-android-manifest` fact
  (`**/src/main/AndroidManifest.xml`, or the `com.android.application` / `com.android.library`
  plugin in a build file).
- `react-web` applies on `react-dom`. Map `react-dom` to a `react-dom` tag and keep `react` for
  ordering.
- Add `react-native.md`, selected on the `react-native` or `expo` dependency.
- Split `python` into a generic `python.md` plus a `uv.md` selected on `has-uv-lock`.

All of this is data plus `has-*` facts, as ADR-013 requires. Removing a selection changes what
existing repos receive. P3 lists the expected per-repo diff, computed with `compare`
before and after.

**Accept.** Each row of the table above is a fingerprint fixture with an asserted profile set.
`compare` over the estate shows the same profiles as before for every SIMT repository, and
`simt-app` gains `android`.

### S29 — An appended region fails `prettier --check` (P1)

**Finding.** When `AGENTS.md` ends in a paragraph, `inject` appends
`<!-- simt-dev:begin -->` after a single newline (`markers.mjs:232`, `absent` branch). Markdown
needs a blank line before an HTML block, so Prettier 3.8.3 inserts one and `--check` exits 1.
Commit `2835821` fixed the end seam only. Every repository that runs `format:check` over
Markdown fails on the first adoption.

**Fix.** In the bottom-placement path, normalise the separator:
`const base = text === '' ? '' : text.replace(/\n*$/, '\n\n')`.

**Accept.** A markers test asserts that a blank line precedes the begin marker whenever text
precedes it. The pack-install test (S20) runs `npm run format:check` in a fixture that has
Prettier.

> **Resolved by ADR-037**, with the first half of the acceptance implemented and the second
> deferred to S20, which is the row that stages a packed install. The finding named
> `markers.mjs:232` — the `absent` branch — and that branch was **already correct**:
> measured against Prettier 3.8.1, its output passes `--check` unchanged. The blank line
> was missing from `splice`, the branch that *replaces* a region, so the defect appeared
> only in a repository that already had one — which is every repository that has been
> adopted. Six shapes of preceding text were measured (paragraph, heading, list, fenced
> block, blockquote, and one already correct) and all six came back rewritten; the list
> case is not a missing newline but a reindent of the entire region, because with no gap
> the formatter reads it as a continuation of the last list item.
>
> The half that made the first worth doing is the one the fix did not mention. `inject`
> compared the region **body** to decide `unchanged`, so a file with a correct body and a
> wrong seam reported no drift: `check` found nothing, `sync` had nothing to repair, and the
> repository stayed red on its own formatter with no remedy this tool offers. `unchanged`
> now means writing would not change a byte. The `top` style is exempt and the reason is
> recorded in the code, because there the splice legitimately moves a misplaced region home
> — an exemption discovered by breaking `baselines.test.mjs` rather than by reasoning.
>
> Two mutations, each caught by its own test. One of those tests was itself wrong first: it
> built its fixture from a hand-written region without the do-not-edit note, so the body
> genuinely differed and it passed with the byte comparison removed while claiming to police
> it. It builds the fixture from a composed region and deletes the blank line now.

### S30 — `.editorconfig` baseline ships an inert section and a false comment (P1, decision)

**Finding.** `EDITORCONFIG_BODY` (`baselines.mjs:67-76`) ends with a `[prettier]` section
holding `singleQuote = true`, with the comment "Prettier reads this section, and only this
section, from .editorconfig". That is false. A section header is a glob, `[prettier]` matches
only a file literally named `prettier`, and Prettier reads only standard editorconfig
properties from sections that match the file being formatted.

Measured with Prettier 3.8.3: `[prettier] singleQuote = true` leaves `"x"` unchanged, while
`[*] quote_type = single` produces `'x'`. ADR-025's context makes the same claim (line 35:
"`singleQuote` is a `[prettier]`-section value, which prettier reads from `.editorconfig`").
This is the "decoration that misdescribes the artefact" failure that this repo's own
`AGENTS.md` lists.

**Fix.** Proposal P9 amends ADR-025's context and baseline content:

1. **Now:** delete the `[prettier]` block and its comment. That changes no behaviour, because
   the block was inert.
2. **Only with an estate survey:** add `quote_type = single` under the JS/TS glob. This *does*
   change formatting in every repo whose Prettier config does not set `singleQuote`, so the
   ADR lists those repos first.

**Accept.** A test asserts that every section header in the baseline is a glob that matches at
least one real file type. A Prettier-backed fixture in the pack-install test proves the chosen
quote style applies.

### S31 — Partial supersession is lost by the decision index (P2)

**Finding.** `loadDecisions` reads the status with `/^Status:\s*(.*)$/m`, which takes the first
line only. `supersededBy` then looks for `superseded by [ADR-NNN]` on that line.

ADR-023's status wraps onto the next line ("… · ruling 2 superseded by" / "[ADR-024] …"). As a
result, `rules why ADR-023` shows a truncated status with no supersession, and prints ruling 2
("It is written once and never rewritten") as in force, although ADR-024 overturned it. ADR-025
("rulings 1 and 2 narrowed by ADR-026") is not modelled either. The module header calls a
reversed ruling printed as current "the failure mode of a provenance feature".

**Fix.** Parse `Status:` as a paragraph, up to the first blank line. Recognise
`ruling N superseded by [ADR-M]` and `rulings N and M narrowed by ADR-K` as
`partial: [{ ruling, by, kind }]`, and have `summarise` annotate each affected ruling
("superseded by ADR-024"). Define `accepted` as `/^accepted\b/i` on the status with bold
markers stripped (S19).

**Accept.** `rules why ADR-023` marks ruling 2 superseded, and `rules why ADR-025` marks rulings
1 and 2 narrowed. Every ADR whose status starts with "accepted" reads `accepted: true`.

### S32 — Sources in a standard Gradle layout are never sampled (P2)

**Finding.** Extension tags are sampled two levels deep (`fingerprint.mjs:187`). Gradle
projects keep sources in `src/main/kotlin/...`, three or more levels down, so a standard
Kotlin backend never gets the `kotlin` tag. That is why the estate's `simt-app` declares
`gradle, wear-os` and no `kotlin`.

**Fix.** Count extensions from `git ls-files` (bounded at 5,000 paths). It is fast, respects
`.gitignore`, and reads every depth. Fall back to a depth-4 walk outside git.

**Accept.** A fixture with `app/src/main/kotlin/a/b/C.kt` emits `kotlin`.

### S33 — `skills brief` spends bytes on bodies it cannot show (P2)

**Finding.** With no workspace, every selected body is "unavailable", and `skills.mjs:501`
repeats the same 200-byte `WORKSPACE_REMEDY` once per body (4 times in probe #14). The brief
still lists those bodies as `SELECTED` and reports "budget capped". An agent pays about 2.5 KB
for a packet that inlines nothing.

**Fix.** When no body is readable, print one header line (`bodies: not on this machine —
<remedy>`) and switch to the pointer-only plan. Count against the budget only the bodies that
will actually be inlined.

**Accept.** The probe #14 output is under 1 KB, names the remedy once, and lists the skills as
`pointer`.

### S34 — Folded rules break the heading hierarchy (P2)

**Finding.** `rules.mjs:258` folds each `.mdc` body under `### ${rule.id}`, but the bodies use
`##` headings. A rendered region therefore reads `### intake-questions` followed by
`## Agent Defaults (Do Not Ask)` (it is visible in every adopted `AGENTS.md`). Stack profiles
lose their H1 as well, so a reader cannot tell where core ends and a profile begins: the line
"Applies to: `gradle`, `kotlin`, `wear-os`." floats under core's "## Scope of these rules".

**Fix.** Render each source under its own `## <title>` (`## Core`, `## Stack: jvm`,
`## Process: test-gate`). Demote the source's headings by one level, so that `##` becomes
`###`. Render "Applies to" as the first line under the source's heading.

**Accept.** A test parses the rendered region and asserts that heading levels never increase by
more than one, and that every source has exactly one `##` heading.

## 6. SIMT adoption

What "adopted" must mean, per repository, when this group is done:

1. `check` exits 0.
2. The `compare` row is `current`.
3. Hooks are routed.
4. The CI workflow is present and green.
5. Every declared gate is runnable.
6. No rule is loaded twice.
7. Every generated region sits inside each selected harness's read limit.
8. The pin is a released version, not a SHA.

Today no repository meets 1, 2, 3, 4 or 8.

### S35 — No estate repo or CI runner can obtain the binary (P0, decision)

**Finding.** Nothing that runs the tool can get it:

- `@quazarmedia/simt-dev` is unpublished (npm 404), and no estate repository has it in
  `node_modules`.
- `simt-dev` is not on `PATH`, and `SIMT_DEV_BIN` is unset.
- The shim therefore refuses every commit once hooks are installed, which is correct
  fail-closed behaviour. Its remedy (`npm i -D @quazarmedia/simt-dev`) cannot succeed, and in
  a Gradle repository it is the wrong ecosystem entirely.
- The consumer workflow runs `npm ci || npm install` (`workflow.mjs:204-206`) before locating
  the binary. In `simt-app`, `app-ui`, `wakt-app`, `simt-garmin` and `simt-jobs` that can never
  produce one.

**Fix.** Proposal P5, "how a repository without npm obtains simt-dev":

1. **Publish** under the name chosen in S18, from CI, with `npm publish --provenance`. JS repos
   pin it as a devDependency; the shim already finds it in `node_modules`.
2. **Repositories without npm** install it globally, pinned to the manifest's
   `projection.version`: `npm i -g @quazarmedia/simt-dev@<version>` on machines and in CI. This
   is a pinned install, not a package runner, so ADR-010 is not weakened; the ADR records the
   distinction. The shim compares `simt-dev --version` with the pin and refuses on a mismatch.
3. **Remedy strings per repo kind**: `npm i -D …@<v>` where `package.json` exists, otherwise
   `npm i -g …@<v>` or `export SIMT_DEV_BIN=/path/to/simt-dev`.
4. **The consumer workflow** chooses the install step by repo kind: `npm ci` when the package is
   a declared devDependency, the pinned global install otherwise.
5. **Estate stopgap until publishing:** on machines,
   `export SIMT_DEV_BIN="$HOME/code/simt/simt-dev/bin/simt-dev.mjs"`; in CI, check out this
   repository at the pinned tag and set `SIMT_DEV_BIN`. This is estate-only, because it points
   at bytes outsiders do not have (the same objection as ADR-023 ruling 1).
6. **Later:** a single-file executable, so that repositories without Node can run it (plan 0003,
   R44).

**Accept.** In a Gradle fixture with no `package.json`, the rendered workflow installs a pinned
binary and `check` runs. The shim's remedy in that fixture names a global install.

### S36 — Estate roll-out: from 14 drifted to 14 enforced (P1)

**Finding.** The state per repository, from `compare` at `4c27514`. Every row is pinned at
`2835821` and drifted on the stamp alone (S01).

| Repo | Declared stack | Surfaces | Gates today | Own hooks (would be replaced) | Stale rule files |
| --- | --- | --- | --- | --- | --- |
| `app-ui` | gradle | opencode | — | — | — |
| `simt-api` | cloudflare-workers, hono, node, vitest | opencode | format, lint, test | — | — |
| `simt-app` | gradle, wear-os | opencode, cursor | i18n-completeness | post-checkout, post-commit, post-merge, pre-commit (`hooks/`) | 3 |
| `simt-blog` | less, node, node-web | opencode, cursor | format, lint | — | 3 |
| `simt-garmin` | connectiq | opencode | — | — | — |
| `simt-goto` | cloudflare-workers, node, node-web, react, react-router, typescript, vitest | opencode | format, test, typecheck | — | — |
| `simt-jobs` | — | opencode | — | — | — |
| `simt-landing` | less, node, node-web | opencode | — | pre-push (`.githooks/`) | — |
| `simt-social` | cloudflare-workers, firebase, maplibre, node, node-web, react, react-router, typescript, … | opencode, cursor | format, lint, test, typecheck | pre-commit, pre-push (`scripts/git-hooks/`) | 3 |
| `simt-social-api` | cloudflare-workers, hono, node, typescript, vitest | opencode, cursor | format, lint, test, typecheck | pre-commit, pre-push (`scripts/git-hooks/`) | 4 |
| `simt-social-landing` | cloudflare-workers, less, node, node-web, vitest | opencode | test | — | — |
| `simt-social-media` | cloudflare-workers, hono, node, typescript, vitest | opencode, cursor | test, typecheck | — | 4 |
| `simt-space` | cloudflare-workers, less, node, playwright | opencode | format | pre-commit (`.git/hooks`) | — |
| `wakt-app` | gradle | opencode | — | — | — |

Two repositories are unmanaged: `bunnyland-server` (not a SIMT product) and `simt-dev` (by
design). `simt-space-review` is not a git repository, so `compare` does not list it.
`simt-social` and `simt-blog` carry an uncommitted pin edit (§1.4).

**Fix: the runbook.** It runs only after Wave 0 (§9) and S35's stopgap.

1. **Release.** Tag simt-dev `v0.1.0`. From then on, a pin is a version (S01).
2. **Move pins.** Per repo: `simt-dev upgrade` to read the plan, then
   `simt-dev upgrade --yes` and a commit. With S01 fixed, a stamp-only difference is not drift,
   so this step writes only where rules really changed. Resolve the two uncommitted pin edits
   first.
3. **Migrate own hooks before routing.**
   - Each existing gate-type hook becomes a declared command:
     `gates.commands.legacy-pre-commit = "scripts/git-hooks/pre-commit"`, listed in
     `preCommit`. This needs S17 (`sh -c`).
   - Non-gate events (`simt-app`'s post-checkout, post-commit and post-merge) must be
     *chained*, not replaced. Amend ADR-018: "a foreign hook for an event simt-dev does not
     gate is chained", implemented as `hooks install` writing a shim that runs the dispatcher
     and then the repository's original hook.
4. **Declare runnable gates for gate-less repos.** Propose each through the `init` capability
   probe and accept only what runs (ADR-017):
   - `simt-garmin`:
     - pre-commit: `./scripts/check_string_comparisons.sh`, `./scripts/check_translations.sh`,
       `./scripts/check_glance_scope.sh`;
     - pre-push: `./scripts/check_codegen_drift.sh --fixtures-only`,
       `./scripts/check_settings_defaults.sh`, `./scripts/check_permissions.sh`,
       `./scripts/check_no_truncating_arithmetic.sh`;
     - not `build-matrix.sh` or `memcheck.sh`, which need the SDK or Simulator.
   - `simt-app`: pre-push `./gradlew spotlessCheck checkOverlayModalPolicy`, keeping
     `i18n-completeness`.
   - `app-ui`, `wakt-app`: `./gradlew spotlessCheck` if the probe finds Spotless applied.
   - `simt-landing`: none until the repo has a `format:check` or `test` script; its pre-push
     migrates as a command.
   - `simt-jobs`: none (no runner). Record that in the manifest rather than invent one.
5. **Route hooks.** `simt-dev hooks install` (plan), then `--yes`.
6. **CI.** Add the workflow per repo after S35 and S48.
7. **Order:** `simt-api` and `simt-goto` first (gates exist, no own hooks), then the JS repos
   with own hooks, then the Gradle repos, then `simt-garmin`, then `simt-jobs`.

**Accept.** `compare --workspace ~/code/simt` reports `current: 14`, `hooksRouted: 14`, no
`UNRUNNABLE` gate, and a green CI run in every repo that has CI.

### S37 — A region past a harness's read limit is invisible to it (P1)

**Finding.** Codex concatenates `AGENTS.md` files from the repo root to the working directory
and stops at `project_doc_max_bytes`, 32 KiB by default. `simt-garmin`'s `AGENTS.md` is
50,295 B, and its region starts at byte 38,251, so Codex reads none of simt-dev's rules there.
`check` reports nothing. More generally, nothing bounds the size of a region; the largest in
the estate is 15,875 B (`simt-goto`).

**Fix.**

1. Add `readLimitBytes` to surface rows, with vendor provenance like the existing `verified`
   field: 32,768 for Codex.
2. `check` raises `BEYOND-READ-LIMIT` when a region ends past the limit of any reader of the
   file.
3. Add `projection.place: "top"` for the html marker style. The mechanism already exists for
   `.editorconfig` (`markers.mjs:51`).
4. For `simt-garmin` itself, its owners move the hand-written defect tables to `docs/` or a
   nested `AGENTS.md`. That is the repo's change, not simt-dev's.
5. Document the user-level workaround: raise `project_doc_max_bytes` in the Codex config.

**Accept.** Fixture: a 40 KB hand-written prefix makes `check` report `BEYOND-READ-LIMIT` naming
Codex, and `place: "top"` clears it.

### S38 — Workspace token cost: 90 KB per turn, 72% repeated (P1, decision)

**Finding.** Measured in this session's context across 7 workspace roots:

- The generated regions total 83,512 B, and 58,208 B of it repeats paragraphs already loaded
  from an earlier root.
- `simt-app`'s 3 managed `.mdc` files add 6,530 B more, which repeat folded text (S12).
- That makes 90,042 B, about 22.5k tokens, on every turn. 64,738 B of it (72%) is redundant,
  and only 25.3 KB is unique.

Prompt caching softens the price of a stable prefix but not the context the model must read
past. The ICLR 2026 `AGENTS.md` study measured more than 20% higher cost with no success gain
from context files.

**Fix.** Proposal P7, "context has a budget", decided with plan 0003's measurements:

1. **S12 now:** skip per-rule files for readers that also read the primary file (6.5 KB here).
2. **Process rules on demand.** `intake-questions`, `slice-commit` and `test-gate` are
   procedures. Offer them as `.agents/skills/<name>/SKILL.md`, which loads by description,
   with a one-line pointer in the always-on text. That saves about 6.3 KB per root; adopt it
   only if plan 0003's evaluation (R01–R05) shows no loss in compliance.
3. **A short always-on core** (plan 0003, R07–R10).
4. **Workspace dedupe** (plan 0003, R11).

**Accept.** For these 7 roots, generated always-on bytes are at most 30 KB, and every rule is
still reachable via `rules show` or a skill. Plan 0003's `simt-dev tokens --workspace` reports
the number.

### S39 — Estate policy belongs in an estate pack (P1, decision)

**Finding.** SIMT product policy ships as if it were universal:

- `jvm-android`: `:core:domain`, `checkOverlayModalPolicy`, `RepositoryResult<T>`, the `cd_`
  prefix, the Wear and Play Console SDK note.
- `react-web`: Arabic mirroring of map chrome, a `gender` sentinel, MapLibre/WebGL. Its
  "Applies to:" line also lists tags it does not select on: `node-web`, `less`, `typescript`,
  `vitest`, `playwright`.
- `connectiq`: a Gradle `--configuration-cache` line in a platform without Gradle, and a
  `getGlanceView()` claim that misstates the repository's own defect note.
- `preview-postflight.mdc`: Firebase, `SOCIAL_API_BASE_URL`, Google-only sign-in.
- `slice-commit.mdc`: "in this ecosystem also deploys it".
- The registry: 37 estate skills, 810 KB of bodies.
- The `ESTATE` regex in `decisions/index.mjs:179-180`.

Repo-local profiles exist (`.simt-dev/profiles/*.md`, `LOCAL_PROFILE_DIR`). What is missing is a
way to share one set across fourteen repositories.

**Fix.** Proposal P4, "estate policy ships as a pack, not as the product":

- `simt-dev.json` gains `packs: [{ source, version, digest }]`.
- A pack has this repository's layout: `rules/stacks/*.md`, `rules/mdc/*.mdc`,
  `graph/skills.graph.json`.
- Precedence: repo-local, then pack, then built-in. `compare` reports the pack digest per repo.
- SIMT's pack is published like the tool (S35), so CI can render the expected regions. The
  public package ships only generic profiles and an example registry.
- Moving the estate content out is S18's registry decision, made concrete.

**Accept.** A fresh install renders no estate name in any region (the leak guard runs on
rendered output). An estate repo with the pack renders byte-identical regions before and after
the move.

## 7. Public release

Beyond S18, S35 and S39, a public release needs everything below. Done means: someone outside
SIMT can install the tool, adopt a repository in any common stack, monorepo or harness, and
never read a rule, remedy or path that only makes sense inside this estate.

### S40 — Eight common ecosystems get only the core rules (P1)

**Finding.** Rust, Go, .NET, Swift, Deno, Ruby, Flutter/Dart and Elixir produce no stack tag,
no profile and no gates. Go, Rust, Ruby, PHP, Maven and Terraform emit a `has-*` fact, but
only Dependabot reads it (`dependabot.mjs:73-86`). For a reader in these ecosystems, simt-dev
is a 9 KB essay and a hook that runs nothing.

**Fix.** Data only (ADR-013): a marker, a profile file and gate templates per ecosystem. Every
gate is probed before it is declared (ADR-017).

| Ecosystem | Marker | Gates (format · lint · test · typecheck) |
| --- | --- | --- |
| Rust | `Cargo.toml` | `cargo fmt --check` · `cargo clippy -- -D warnings` · `cargo test` · — |
| Go | `go.mod` | `test -z "$(gofmt -l .)"` · `go vet ./...` · `go test ./...` · — |
| .NET | `*.sln`, `*.csproj`, `global.json` | `dotnet format --verify-no-changes` · — · `dotnet test` · `dotnet build -warnaserror` |
| Swift | `Package.swift` | `swift format lint -r .` (if installed) · — · `swift test` · `swift build` |
| Deno | `deno.json`, `deno.jsonc` | `deno fmt --check` · `deno lint` · `deno test` · `deno check .` |
| Ruby | `Gemfile` | `bundle exec rubocop` · — · `bundle exec rspec` or `bin/rails test` · — |
| Dart/Flutter | `pubspec.yaml` | `dart format --output=none --set-exit-if-changed .` · `dart analyze` · `dart test` / `flutter test` · — |
| Elixir | `mix.exs` | `mix format --check-formatted` · — · `mix test` · — |
| Maven | `pom.xml` + `mvnw` | wrapper only, like `gradlew`: `./mvnw -q verify` (pre-push) |

**Accept.** Each ecosystem gets a fingerprint fixture with asserted tags, profile and runnable
gates. A missing tool yields a dropped gate with a remedy, never a declared one.

### S41 — A monorepo gets one root projection (P1, decision)

**Finding.** Only the root is fingerprinted and only the root `AGENTS.md` is written. An npm
workspaces fixture (`apps/web` with React, `apps/api` with Workers) received the node fallback
only.

**Fix.** Proposal P6, "a package in a monorepo is a projection root":

- Detect workspace roots from `pnpm-workspace.yaml`, `package.json` `workspaces`, `turbo.json`,
  `nx.json`, the Cargo `[workspace]` table, `go.work` and Gradle `include(...)`.
- Fingerprint each package.
- The root keeps core plus anything shared. Each package's nested `AGENTS.md` carries only its
  own profile delta; readers that walk from the root to the working directory get both.
- Gates gain an optional `cwd`, and `check` covers every root.

**Accept.** The fixture yields a root region plus `apps/web/AGENTS.md` (react-web) and
`apps/api/AGENTS.md` (cloudflare-workers). `check` fails if either drifts.

### S42 — Harness coverage stops at five surfaces (P1)

**Finding.** `surfaces.mjs` has rows for opencode, Cursor, Claude Code, Antigravity and
Copilot. Plenty of other harnesses read instruction files: Codex (`AGENTS.md`,
`AGENTS.override.md`, the 32 KiB limit), Gemini CLI (`GEMINI.md`, or
`context.fileName: ["AGENTS.md"]` in `.gemini/settings.json`, which avoids a pointer),
Windsurf, Zed, Kiro, Cline, Roo Code, JetBrains Junie, Aider (`read:` in `.aider.conf.yml`),
Continue, Amp and Goose. Most of them read `AGENTS.md` natively.

**Fix.**

- Add a `readsAgentsMd` column, and add rows only for readers that do *not* read `AGENTS.md`.
- Every row carries vendor-doc provenance in `verified`, as the existing rows do. This review
  did not re-verify each vendor's current docs, so treat the list above as candidates.
- Add `simt-dev harness detect`, which reports which harnesses a repo or user setup implies,
  from the config directories present.

**Accept.** A test asserts that every row has `verified` and `documentedKeys`, and that no two
rows would make the same reader load the same rule.

### S43 — MCP server is two spec revisions behind and returns text only (P2)

**Finding.** `server.mjs` pins `PROTOCOL_VERSION = '2025-06-18'` and `negotiate` echoes only
that. Revisions 2025-11-25 and 2026-07-28 exist. 2026-07-28 drops the `initialize` handshake
in favour of a protocol version in each request's `_meta`, adds `server/discover` and list
results cacheable by `ttl`, and replaces error `-32002` with `-32602`. Every result is
`JSON.stringify(payload, null, 2)` in a text block, with no `structuredContent`, no
`outputSchema`, and no `annotations.readOnlyHint` (all ten tools are read-only). There are no
resources or prompts, and the `rules_why` description says "restsates".

**Fix.**

- Negotiate among `[2026-07-28, 2025-11-25, 2025-06-18]`, statefully when the client calls
  `initialize` and per request when it sends `_meta`.
- Return compact JSON text plus `structuredContent`, declare `outputSchema` per tool, and set
  `annotations: { readOnlyHint: true, idempotentHint: true }`.
- Expose rules and decisions as resources (`simt://rules/{id}`, `simt://decisions/{adr}`).

Plan 0003 (R41) extends this.

**Accept.** Each protocol version runs as a handshake test. Every tool is called with minimal
arguments (S20), and each structured result validates against its `outputSchema`.

### S44 — Agent Skills conformance is not linted (P2)

**Finding.** The Agent Skills specification (agentskills.io) sets these rules:

- `name`: at most 64 characters, lowercase and hyphens, and equal to its directory name.
- `description`: at most 1,024 characters.
- `compatibility`: at most 500 characters.
- Bodies: under about 5,000 tokens recommended, with detail pushed into references.
- `.agents/skills/` is the cross-client location.

`graph lint` checks bytes and structure, not these. All 37 registry names conform today. The
bodies were not read (§12), but seven skills exceed 20 KB, and `cloudflare` is 384 KB.

**Fix.** Add `graph lint --spec agentskills`, which checks frontmatter against the
specification and warns on bodies over 5k tokens (bytes ÷ 4). `skills install` refuses an
install whose `name` will not equal its directory, and the flat-file wrapper emits conforming
frontmatter.

**Accept.** A fixture skill with an uppercase name or a 1,100-character description fails lint
with the rule that it broke.

### S45 — Core and process rules speak one language and one harness (P2)

**Finding.** Two examples:

- `intake-questions.mdc` tells every reader to use "the interactive `AskQuestion` tool".
  That is Cursor's name; Claude Code's is `AskUserQuestion`, and other harnesses have none.
- `core.md`, the stack-agnostic core, says "No `any`, no unsafe casts, no non-null boundary
  bypasses, no floating promises, no `console.*`". That is TypeScript vocabulary. In Kotlin,
  `Any` is the ordinary root type.

**Fix.**

- Phrase the core in stack-neutral terms: "no type-system escapes, no unawaited async work, no
  debug printing in application code". Move the TypeScript spelling into the TypeScript
  profile.
- Make the question tool a per-surface substitution (`{askTool}`), and fall back to "ask the
  user, offering choices with the recommended one first".
- Extend `test/shipped.test.mjs` with a vocabulary guard: core and process rules may not
  contain a deny-listed language or harness token outside a substitution.

**Accept.** Rendered for a Kotlin repo using Claude Code, the region contains neither `any` nor
`AskQuestion`.

### S46 — The POSIX-only stance reaches an installer as `EBADPLATFORM` (P3)

**Finding.** ADR-012 rules POSIX only, and `package.json` declares `"os": ["darwin","linux"]`,
so `npm i` on Windows fails with npm's generic `EBADPLATFORM` and no explanation.

**Fix.** The ADR stands. The README (S18) states "Windows: use WSL2". The install error cannot
be customised, so the README is where the stance lives.

**Accept.** The README has a platform section, and the row moves to **Accepted** with that
reason.

## 8. Enhancements

### S47 — The Node floor is end-of-life (P2, decision)

**Finding.** `engines.node` is `>=20`, and Node 20 reached end of life on 2026-04-30. Node 22 is
in maintenance until 2027-04-30, Node 24 is LTS, and Node 26 enters LTS on 2026-10-28. Raising
the floor unlocks built-ins that replace hand-written code:

- `path.matchesGlob`, stable since 22.20 and 24.8, fixes S02.
- `fs.promises.glob`.
- `util.parseArgs`, a candidate for S15.
- `node:sqlite` with FTS5, a release candidate since 24.15, is the store plan 0003 builds on.
  Verified working on 26.10.

**Fix.** Proposal P8: floor `>=22.20.0`. CI runs 22, 24 and 26. Workflow templates use 24
(S48).

**Accept.** `engines`, both workflow templates and the README agree. S02's fix uses
`path.matchesGlob`.

### S48 — Workflow templates: tag-pinned actions, Node 20, an install that needs npm (P2)

**Finding.** Both templates use `actions/checkout@v4` and `actions/setup-node@v4` by tag
(`workflow.mjs:148,178,202`) and `node-version: '20'` (`workflow.mjs:152`). The own workflow runs
on `ubuntu-latest` only. The consumer template's install step assumes npm (S35). The template
already does well on least-privilege `permissions`, `concurrency` and `timeout-minutes`; keep
those.

**Fix.**

- Pin actions by full commit SHA with a version comment. Dependabot's `github-actions`
  ecosystem keeps SHAs current.
- Use Node 24.
- The own workflow gets a `macos-latest` and `ubuntu-latest` matrix, which makes ADR-012's
  claim true.
- Take the install step from S35.

**Accept.** A template test asserts that every `uses:` is SHA-pinned and that the Node version
equals the documented one.

### S49 — Dependabot misses Gradle, submodules and seven more ecosystems (P2)

**Finding.** `ECOSYSTEMS` (`dependabot.mjs:73-86`) has no `gradle`, although `gradle` is one of
this tool's own stack tags, and three estate repositories are Gradle. It has no
`gitsubmodule`, although `simt-app` and `wakt-app` carry `app-ui` as one. Also missing:
`nuget`, `pub`, `swift`, `mix`, `uv`, `bun` and `devcontainers`.

**Fix.** Add the rows, keyed on stack tags or `has-*` facts (`.gitmodules` becomes
`has-submodules`).

**Accept.** A Gradle fixture with a submodule renders `gradle` and `gitsubmodule` entries.

### S50 — Rule files load eagerly where a surface could scope them (P2, decision)

**Finding.** Every per-rule file is always-on: `alwaysApply: true`, `applyTo: "**"`, or Claude
rules without `paths`. Four surfaces document scoping keys: Cursor `globs`, Claude Code
`paths`, Copilot `applyTo`, and Antigravity `trigger: glob` (all already in `documentedKeys`).
Stack profiles, 2–3 KB each, could load only when matching files are in play. Today profiles
can only be folded into `AGENTS.md`.

**Fix.** Within P7:

- Let a profile declare `simt-scope: ["wrangler.jsonc", "src/**/*.ts"]`.
- Surfaces that can scope get one scoped file per profile.
- `AGENTS.md` keeps a one-line pointer per scoped profile.
- Monorepos get directory scoping from S41.

**Accept.** For `cursor`, a Workers repo's profile renders as `.cursor/rules/cloudflare-workers.mdc`
with `globs` and `alwaysApply: false`. The `AGENTS.md` region shrinks by the profile's size.

### S51 — JSON output has no schema version and no compact form (P3)

**Finding.** `emitJson` writes `JSON.stringify(value, null, 2)` (`output/index.mjs:68`), and no
payload carries a `schemaVersion`. Exit codes are documented only in code (`EXIT`). An agent
parsing `--json` pays for indentation, and has no way to detect a shape change.

**Fix.**

- Write compact JSON when stdout is not a TTY, and keep `--pretty` for humans.
- Every payload carries `schemaVersion: 1`.
- The README carries the exit-code table and a JSON contract per command, generated from the
  command registry (S15).

**Accept.** A contract test parses every command's `--json` output as compact, single-document
JSON with `schemaVersion`.

## 9. Order of work

| Wave | Slices | Exit criterion |
| --- | --- | --- |
| **0: stop the bleeding** | S08, S24, S10, S01 (+ S20 pack-install test), S29, S27, S23, S05 | a packed install survives `init`, two commits, `check`, `upgrade`, `hooks install` and a real commit, with every writer previewing by default |
| **1: what agents read is right** | S12, S28, S30, S31, S25, S26, S09, S02, S03, S04, S06, S07, S32, S33, S34, S14, S45 | `compare` over fixtures and the estate is truthful; no rule loads twice; no profile lands in the wrong ecosystem |
| **2: the estate is enforced** | S35, S36, S37, S38, S39, S47, S48, S49 | S36's definition of "adopted" holds for all 14 repositories |
| **3: anyone can adopt it** | S18, S40, S41, S42, S43, S44, S46, S50, S51, S13, S15, S16, S17, S19, S21, S22 | someone outside SIMT installs it from npm and adopts a Rust monorepo under Codex with no estate text in any output |

S20 is not a wave. Each slice lands with its own regression test, and the pack-install test
lands with S01.

## 10. Decisions this review needs

These rulings are numbered by position here (`P1`…`P9`), not by a record number. An earlier
draft of this section carried a block of record numbers, `ADR-0[27–35]`; by the time it was
written, the first five of them had been issued to unrelated records, and the next plan's
block would have collided with the renumbering. A proposal that does not exist yet has no
number — the number is assigned when the record is written, which is the only moment it is
knowable. Every `ADR-` reference in this review therefore names a record you can read in
`docs/decisions/`, and `test/rules.test.mjs` fails if one does not.

| Proposal | Ruling | Slices | Supersedes or amends |
| --- | --- | --- | --- |
| P1 | A projection is identified by its content, not by a commit | S01 | the stamp described in plan 0002 §9 |
| P2 | Every writer previews unless told to write; `--dry-run` always wins; `--json` changes format only | S24, S10 | — |
| P3 | A profile selects on what a repository runs on | S28 | refines ADR-013 |
| P4 | Estate policy ships as a pack; the product ships generic profiles and an example registry | S39, S18 | — |
| P5 | How a repository without npm obtains simt-dev | S35 | clarifies ADR-010 |
| P6 | A package in a monorepo is a projection root | S41 | — |
| P7 | Context has a budget: one copy per reader, scoped where a reader can scope | S38, S12, S50 | ADR-021 §3 |
| P8 | Node floor `>=22.20.0` | S47 | plan 0002 "Runtime" line |
| P9 | The editorconfig baseline carries only keys a reader honours | S30 | ADR-025 context and baseline content |
| amend ADR-018 | A foreign hook for an event simt-dev does not gate is chained, not replaced | S36 | ADR-018 |
| amend ADR-019 | A declared command runs as `sh -c` | S17 (0001) | ADR-019 |

The two amendments are different in kind: they name a record that already exists, so the
number is known and the reference is checkable. A new record has neither property until it is
written.

## 11. What is solid and should be kept

Everything in review 0001's list still holds: the generated-region primitive, fail-closed gates
with a remedy on every refusal, workspace precedence with a reported source, byte-verified
sources, and zero dependencies. New since 0001:

- **The shim fails closed.** With no binary reachable it refuses the commit rather than
  passing it (§1.2 #20). The remedy is wrong (S35); the behaviour is right.
- **The registry verifies against disk.** `graph lint` checks 37 skills and 23 capabilities
  with byte counts, with and without a workspace.
- **`surfaces.mjs` is exemplary.** Every row cites the vendor documentation it was verified
  against, and `documentedKeys` guards the frontmatter. S42 and S50 should extend the table
  rather than work around it.
- **The workflow template has sound defaults.** Read-only `permissions`, `concurrency` with
  cancellation, and a 5-minute timeout.
- **The ADR discipline works.** All 26 records state their scope: ADR-001 to ADR-010 in the
  status line ("affects all repos"), the other 16 in an `Affects:` line. Plan 0003 builds a
  decision graph on those lines (R25).
- **Comments record why.** `baselines.mjs` explains why `end_of_line` is absent: the claim
  belongs in `.gitattributes`. S30 is the one place where such a comment states something
  false.

## 12. Not reviewed (residual risk)

- **Linux.** Every run was on macOS (darwin 25.6, Node 26.10, git 2.54).
- **Skill bodies.** The 37 `SKILL.md` files in sibling repositories were not read, only their
  registry metadata and byte counts, so their Agent Skills conformance is unknown (S44).
- **Vendor claims in `surfaces.mjs`.** Not re-verified, except Codex's 32 KiB limit and the hook
  systems researched for plan 0003.
- **`src/compare/discover.mjs` and `hooksstate.mjs`.** Exercised through `compare`, not traced.
- **Scale and trust.** A 50-repo workspace and a 100k-file repository were not measured, and the
  trust boundary of `gates.commands` under S17's `sh -c` proposal was not reviewed in depth
  (the amended ADR-019 should state it).
