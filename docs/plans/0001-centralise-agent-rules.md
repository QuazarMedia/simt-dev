# Plan 0001 — Centralise agent rules, skills and tooling in simt-dev

Status: **implemented** · created 2026-10-05 · state read at `4aaa441`
Scope: the sibling repos under the estate root. The estate holds 16 consumers today and this
plan named 16, but they are not the same 16: `simt-api` and `simt-space-review` have appeared
since, and `bunnyland-server`'s skill was removed from the registry at `86093e1` (38 skills → 37,
ADR-006 and ADR-009 amended in the same commit) although the repo itself is back on disk. 14 of
the 16 have adopted; `bunnyland-server` and `simt-space-review` have not, which is why this plan
is `implemented` rather than `complete`.
Supersedes: nothing. Feeds into: `0002-simt-dev-cli.md`

Row state, checked against the tree at `4aaa441` rather than against this table's own prose:

| Row | Delivered | Evidence |
| --- | --- | --- |
| 1 always-on rules | **done** | `rules/core.md` (the `simt-core` of this row) and three `.mdc` rules: `intake-questions`, `test-gate`, `preview-postflight`. `slice-commit.mdc` is a fourth file, from row 2 |
| 2 process skills | **done** | `slice-commit`, `bug-commit`, `complete-testing`, `parallel-feature-team` all in `graph/skills.graph.json` |
| 3 agent policies | **done, 4 of 8** | `rules/core.md` carries the minimum viable team, never weakening a security control, anti-overclaim with report-what-you-left-alone, and the stated agent budget that never converts a failure into an approval. The other four — the 70/30 split, the 12-state coverage list, the matrix-trigger heuristic and strict review budget — are recorded unmade in ADR-033; there is no source for them anywhere in the estate, and writing them would put invented doctrine in front of every adopted repo |
| 4 stack profiles | **done, 7 files for 8 ecosystems** | `jvm-android.md` carries this row's Kotlin/Gradle/Compose *and* JVM; `react-web.md` carries React/RTL/WCAG *and* LESS/CSS; `node.md` is this row's TypeScript-strict. `container.md` is a seventh this row did not ask for — ADR-013's `has-dockerfile` fact. No ecosystem in the row is unserved |
| 5 tooling baselines | **done** | `.editorconfig` (ADR-025), `.gitattributes` (ADR-027), `tsconfig.base.json` (ADR-028), Dependabot (ADR-026), `packageManager`/`engines`/`.nvmrc` as three checks and no file (ADR-029). Commitlint and the shared ESLint block are refused by ADR-030; the shared Prettier config is **unruled** — ADR-048 withdrew ADR-025's `singleQuote`, which was inert, and recorded why a shared `quote_type = single` reformats two of the five repositories that run Prettier |
| 6 shared hook library | **done** | `src/hooks/` — dispatcher, per-repo gate list, POSIX shim generator — with 59 tests |
| 7 `init` | **done** | AGENTS.md, hooks, CI check, Dependabot and the four baseline regions. The two omissions row 7 names are ADR-030's refusals, not unwritten code |
| 8 CI workflow | **ruled otherwise** | ADR-023 — the gate is copied into each repo rather than referenced. The Dependabot file this row also wanted shipped by ADR-026 |

Every row is now either delivered or ruled. Nothing is outstanding, and where a row is closed by a
decision rather than by code the decision is named so the next reader is not left hunting for a file
that was never going to be written.

---

## 1. Problem

The workspace has no single source of truth for agent behaviour. Sixteen repos each carry
their own `AGENTS.md`, `.cursor/rules/*.mdc`, `.agents/skills/*`, `.agents/agents/*`, git
hooks and tooling config, and they have drifted apart in ways no reviewer would catch.

An audit (2026-10-05, read-only, all 16 repos) found:

- **46 skill entries / 38 unique names / 928 KB**, of which only **1 of 8** skills shared by
  the two Social repos is byte-identical.
- **3 `.mdc` rule families, 8 files, 0 byte-identical.** One pair differs by a **single
  byte** while hiding three semantically loaded line changes — so no size-, hash-adjacency- or
  line-count-based dedup detector will ever flag it.
- **10 direct contradictions** between repos on commit/push, refactoring neighbours, test
  breadth, hook ownership, file length, coverage bar, section naming, verdict vocabulary,
  skill layout and test-runner invocation. Two of these are flatly incompatible
  philosophies and cannot both be org rules.
- **4 incompatible git-hook conventions**; 11 repos have no hooks at all; zero use
  husky/lefthook; one `pre-push` is 0 bytes (dead code); one gate is permanently red by
  design.
- **5 Prettier configs with a live contradiction** (`singleQuote` set in three repos,
  silently defaulted to `false` in the two that also run ESLint), **4 near-disjoint
  `.prettierignore`**, **10 repos with no `.editorconfig` at all** (precisely the entire
  JS/TS/Python side), **3 disagreeing `.nvmrc`**, **no `packageManager` anywhere**, no npm
  Dependabot anywhere.
- **9–10 repos have no `AGENTS.md` at all**, including two Android repos, the design-system
  repo and the whole static-site group.

The estate already contains the right pattern — committed symlink fan-out from a canonical
`.agents/` directory (simt-social, simt-social-api, simt-app) and one git
submodule (app-ui). It has simply never been pointed at a central repo.

## 2. Decision

**Single source of truth in `simt-dev`, delivered to every repo as a committed generated
projection, enforced by a drift gate. Never a runtime symlink or a runtime include.**

Agents do not "discover" simt-dev. They read the repo they are in. The agent surface is a
projection; the human and generator surface is canonical.

### 2.1 Why not the alternatives

| Option | Verdict |
|---|---|
| Committed generated copies + drift gate | **Chosen.** Portable in CI, in fresh clones, in Docker, for teammates. Drift is caught by a job, not by luck. Tool-agnostic. |
| Cross-repo symlink (`../../simt-dev/.cursor/rules`) | Rejected. Breaks in CI, in any clone that did not also clone simt-dev as a sibling, and in Docker. Same reason `git.config` needed a local fallback in simt-space. |
| Git submodule (the `app-ui` precedent) | Rejected. Correct for versioned product code; wrong for rules — every typo becomes a 16-repo SHA-bump. |
| User-level only (`~/.claude/CLAUDE.md`, `~/.agents/skills/`) | Kept as an **optional thin layer** (see §8). Invisible to teammates and CI, so never the source of truth. |

### 2.2 The load-bearing mechanism

**A generated region inside a hand-owned file.** Each repo keeps its own `AGENTS.md`;
`simt-dev sync` owns only the bytes between:

```
<!-- simt-dev:begin -->
...generated...
<!-- simt-dev:end -->
```

Same for `.editorconfig`, `.prettierrc`, `.gitattributes`. Local content is never clobbered;
shared content can never drift silently. The marker also records the source identity, so a
half-applied sync is detectable rather than invisible. That identity is a content digest rather than
a commit SHA (ADR-032), so it is computable from an installed package with no git present.

## 3. What moves, what stays

### 3.1 Moves to simt-dev

| # | Content | Source | Note |
|---|---|---|---|
| 1 | 4 always-on rules | `intake-questions`, `test-gate`, `preview-postflight` (3-way divergent), plus a new `simt-core` | `test-gate` canonical **carries both halves** of the diverged BLOCK list — producer-side *and* consumer-side — plus social's `Partial pass (e.g. 6/8 pass)` worked example. media's deleted `Allowed Without Account` section and 4th BLOCK trigger are restored. |
| 2 | 4 process skills | `slice-commit`, `bug-commit`, `complete-testing`, `parallel-feature-team` (8 skills, 4 duplicated, only 1 identical) | Repos keep the existing `add-country-galaxy` stub pattern: a ~10-line local skill pointing at the canonical one. The audit judged this the cleanest pattern already in the estate. |
| 3 | 8 agent policies | Independently authored in 2–4 files each | one-writer-per-file · minimum viable team · never-weaken-security-controls · anti-overclaim · 70/30 quality-vs-perf · 12-state coverage list · matrix-trigger heuristic · strict review budget. Also fixes the 3-way verdict vocabulary split. |
| 4 | 8 stack profiles | Kotlin/Gradle/Compose, Monkey C/ConnectIQ, Python/uv/ruff, TypeScript-strict, Cloudflare Workers (JS + TS), React/RTL/WCAG, LESS/CSS, JVM | Separate files, **never inlined** into core — this is what stops the core degenerating into a lowest-common-denominator nobody's rules. |
| 5 | Tooling baselines | Prettier, `.editorconfig`, `tsconfig.base.json`, shared 6-rule ESLint block + `eslint-config-prettier`, `packageManager`/`engines`, `.nvmrc`, `.gitattributes`, commitlint | Resolves: the `singleQuote` contradiction; the 10 repos with no editorconfig; simt-goto's 7 missing strictness flags; 3 disagreeing nvmrc; no `packageManager`; eslint/prettier fighting in 3 of 5 configs. **Two of these six were miscounted, and reading the estate is what found it:** the 3 `.nvmrc` files each agree with their own `engines`, so what differs is three repositories' node choices, not a defect (ADR-029 rules the check out); and the eslint/prettier fight is in 2 of 4 configs, not 3 of 5, in exactly one detectable shape — `stylisticTypeChecked` without `eslint-config-prettier`. `no packageManager` is real, in all nine node repos. **PARTIAL — `.editorconfig` shipped (ADR-025), `.gitattributes` shipped (ADR-027).** Both are the files here that can carry a generated region, so both are shared content rather than owned content: the indentation rules land above whatever the repo already declared, and `singleQuote` is **not** settled here at all — ADR-048 withdrew the claim that `.editorconfig` settled it, because an editorconfig section header is a glob over paths and `singleQuote` is a key no reader honours; `.gitattributes` carries one line — `* text=auto eol=lf` — above each repo's own LFS and binary declarations, which keep winning because git takes the last match. `end_of_line` stays out of `.editorconfig` because a repo wanting CRLF could only opt out by deleting the region; in `.gitattributes` it is one line beneath. The other six are JSON or bare strings, so they would need a whole-file write; **ADR-026 answers that question** — a config whose grammar cannot hold a region is owned whole, on the gate's own rule — and three have now shipped: Dependabot (ADR-026), because its absence is a security gap, and `tsconfig.base.json` (ADR-028), because it is the only remaining one with a named defect behind it. ADR-028's contribution is the limit rather than the mechanism: a child overrides every key its parent sets, so the base file is a floor for what is *missing* (simt-goto's seven flags) and inert for what is *spelled differently*, which is why `moduleResolution` became a check and not a shared line. `noEmit` is inherited-capable and stays out — two repositories bundle elsewhere, and a repository nobody looked at must not stop emitting. **`packageManager`/`engines`/`.nvmrc` shipped no file at all (ADR-029)**, because it is the one item here with no derivable value: the npm version is not in `package-lock.json` and a node floor is per-repository. It ships as three checks whose remedies are commands run where the answer exists. The missing `printWidth` is left unruled on purpose. |
| 6 | Shared hook library | 4 incompatible conventions | A dispatcher + per-repo check list. Gives the 11 hook-less repos a pre-commit, and delivers the dead `simt-app/hooks/pre-push` fix for free. |
| 7 | `simt-dev init <repo>` | — | Scaffolds AGENTS.md, editorconfig, tsconfig.base, commitlint, hooks, CI check, dependabot. Repo #17 must be one command, not a rewrite. **DONE for AGENTS.md, hooks, CI check and dependabot; `.editorconfig` by ADR-025, `.gitattributes` by ADR-027, `tsconfig.base.json` by ADR-028.** `init` also writes the baseline regions now, and reports a moved one as `MISPLACED` rather than trusting the bytes. Writing `tsconfig.base.json` taught the one thing row 5 could not say in advance: a base file repairs a repo that is missing a flag and cannot repair one that spells it differently, so `init` writes the file *and* prints the `extends` line the repo must add itself, and `check` reports a base file nothing extends as `INERT`. Still missing: commitlint and the ESLint block, and **neither is only unimplemented — each is an unmade decision, which is why neither shipped (ADR-030).** Commitlint appears in zero rule files (a rule asks for the message *shape*, `slice-commit.mdc:27`, not for the linter) and in zero `package.json` files, so there is no disagreement to repair and no repo failing over it. The ESLint fight is real and precise — `stylisticTypeChecked` without `eslint-config-prettier` in `simt-social` and `simt-social-api` — but two of the four configs are plain JavaScript with no rules to share, and flat config has no cross-repository include without publishing an npm package. No file has been written for either and none should be inferred. This is the difference from everything row 5 has shipped so far: those hit a mechanism question, and these two have not had a policy question answered yet. |
| 8 | Reusable CI workflow | — | As written here: `QuazarMedia/simt-dev/.github/workflows/sync-check.yml`, referenced by every consumer. **Ruled otherwise by ADR-023** — the gate is copied into each repo's `.github/workflows/simt-dev-check.yml` instead, so it is reviewable where it lands. The Dependabot config this row also wanted was still missing when this ruling was written, and is now shipped by **ADR-026** as a second `.github` file under the same ownership rule — written once where Actions already runs, refreshed only in simt-dev's own repository by `simt-dev ci`. It could not be a region: `updates:` is a YAML list, and two lists cannot be merged. Its entries are detection-driven, so a repo is never given a `package-ecosystem` it has no manifest for. |

`graphify` (40 KB, byte-identical in 2 repos) also becomes a synced vendored copy. All other
vendored third-party skills (`cloudflare`, `wrangler`, `firebase-*`) stay where used.

### 3.2 Stays local — do not move

All product policy (gender/onboarding rules, country registries, capability crypto). All
stack-specific rule *bodies* (the Compose component catalogue, MapLibre chrome, Room
migrations, the 35-row Garmin platform-defect table, ECS modelling). All repo commands and
paths. The whole point of the stack profiles is that the *shape* is shared and the *content*
is not.

## 4. The 10 rulings

Six are syntheses that preserve both original positions as distinct tiers. Four are
mechanical. Every ruling lands in `docs/decisions/ADR-NNN.md` before any canonical file is
authored.

| # | Conflict | Ruling |
|---|---|---|
| 1 | garmin **autopushes** (DoD #8 "Committed and pushed") vs social pair **forbids** push | Commit locally, report the SHA, **push only on explicit approval**. garmin's DoD #8 is the single outlier and changes. 4:1 majority, and it is also the safe direction. |
| 2 | social: "extract at 2nd use, a 3rd copy is a defect" vs an out-of-scope repo §2: "do not refactor neighbouring code" | **Synthesis.** Never refactor code outside the current change's blast radius. Within it, a second real use extracts, and the extraction is finished — no orphaned imports, exports, styles or files. A third copy is a defect; a single-caller abstraction is a defect. Both halves survive verbatim. |
| 3 | social pair: "running a full suite is a defect, not diligence" vs an out-of-scope repo: `fail_under=100` + full gate pre-push | **Synthesis.** Focused is the default. The full suite is a *trigger*, not a sin. Triggers: phase exit, release, cross-system behaviour, a repo-declared numeric gate, explicit request, pre-push on a protected branch. Re-running it as a progress meter is a defect. |
| 4 | social-api: "lint/format are enforced by the pre-commit hook — do not run them manually" vs an out-of-scope repo: run its linter + `git diff --check` by hand | **Synthesis.** The hook owns format and lint for staged files — do not re-run what the hook just ran. Manual runs are correct when the hook is not installed, when something failed, or when the check is not hook-covered. |
| 5 | 1000-line hard split vs 400-line "smell threshold, not a hard gate" | **Tier both.** 400 = review trigger. 1000 = hard ceiling. Generated files exempt. Nothing is lost. |
| 6 | `fail_under=100` vs garmin memory budgets vs *no number at all* | **Evidence discipline is central; the number is declared per repo.** Central mandates the qualitative bar — 100 % pass, no unjustified skips, behavioural test delta, named commands. The numeric threshold is a repo-declared constant. The central file specifies *how to declare it*, never the value. |
| 7 | 3 capitalisation variants of section headings | One canonical skeleton. Mechanical. |
| 8 | `BLOCK` only vs `APPROVE / APPROVE WITH RESIDUAL RISK / BLOCK` | Adopt the 3-value vocabulary everywhere; update the `.mdc` files to match. |
| 9 | `<name>/SKILL.md` vs flat `.md` missing `name:` | Central mandates `<name>/SKILL.md`. Wrap any flat `.md` entry found at adoption. |
| 10 | "no `npx`/`npm exec`" vs "no `uv run pytest`" | Already agrees — same rule, two ecosystems, same rationale (console entrypoint loses the import path). Pure promotion. |

## 5. Target layout

```
simt-dev/
├── README.md
├── docs/
│   ├── decisions/          ADR-001 … ADR-010, the rulings above
│   └── plans/              this plan, 0002 (the CLI)
├── rules/                  canonical, one .mdc-ready file per rule
│   ├── simt-core.mdc
│   ├── simt-intake-questions.mdc
│   ├── simt-test-gate.mdc
│   ├── simt-preview-postflight.mdc
│   └── stacks/             kotlin, gradle, connectiq, python,
│                          typescript, cloudflare-workers, react-rtl, less-css
├── skills/<name>/SKILL.md  canonical shared process skills
├── agents/<name>.agent.md  canonical + symmetric-pair agents
├── tooling/                prettier, editorconfig, tsconfig.base, eslint,
│                          gitattributes, nvmrc, commitlint, dependabot
├── hooks/{pre-commit,pre-push}
├── scripts/sync.mjs        the generator — zero runtime deps, node + git only
├── .github/workflows/simt-dev-sync-check.yml
└── git.config              (already here)
```

`scripts/sync.mjs` is deliberately **zero-dependency Node**: the lowest common denominator
across six engines-less repos, and it matches an existing house pattern (simt-space already
ships zero runtime deps).

## 6. Phases

Each phase has an exit criterion. Phases 4–6 are per-repo and independently revertable.

**Phase 0 — Rulings.** Blocking. Get sign-off on the 10 contradictions, especially #6.
Written into `docs/decisions/`. Nothing else starts; every canonical file is a direct edit
of one of these positions.

**Phase 1 — Scaffold.** README, ADRs, directory skeleton, `sync.mjs` v0 (marker-region
injector + `--check` mode). No consuming repo touched.

**Phase 2 — Author canonical content.** The 4 always-on rules, 8 stack profiles, 4 process
skills, 8 agent policies, tooling baselines, hook library. Each canonical file records which
files it replaces and why.

**Phase 2a — DONE (`rules/mdc/*.mdc`, ADR-016).** The three always-on `.mdc` families are
authored as **unions**, not variants, because two of the eight differences were rules a repo
was *missing* rather than a choice it made. `test-gate` carries both the producer-side and
consumer-side `BLOCK` bullets plus social's `6/8 pass` example; `preview-postflight` carries both
the `SOCIAL_API_BASE_URL` build instruction and the keychain/never-in-D1 prohibition and restores
media's deleted `## Allowed Without Account`; `intake-questions` keeps `migrations` and social's
fuller Required First Turn. Only genuinely per-repo substrate is a declared substitution
(`{{plansGlob}}`, path vocabularies, domain lists), and an empty value **drops** its line, which is
how one canonical body reaches a repo with no plan tracker. `preview-postflight` is `optIn`
because detection cannot tell a Workers repo that has this problem from one that does not.

**Phase 2b — DONE (rule discovery).** `RULE_FILES` named only `AGENTS.md`, `CLAUDE.md` and
`CONTRIBUTING.md` for the whole life of the tool, so `simt init` reported `CONFLICTS none detected`
on `simt-social-api` — the repo holding the worst-drifted content in the estate — because it never
looked at the `.mdc` files. Discovery is now by name **and** by glob, and generated regions are
stripped before scanning so quoting a ruling is never mistaken for contradicting it.

**Phase 2c — DONE (one surface per editor, `src/projection/surfaces.mjs`, ADR-020).** The rules
were being written to two places — the `AGENTS.md` region and `.cursor/rules/*.mdc` — so the three
always-on rules reached **Cursor and nobody else**. Claude Code reads `CLAUDE.md` and only falls
back to `AGENTS.md`; Copilot reads `.github/copilot-instructions.md` and
`.github/instructions/*.instructions.md`, which the projector wrote nowhere while the conflict
scanner already read them. Each editor is now a row carrying its readers, its path template, its
frontmatter, and **the vendor document it was verified against**; each rule is written per surface
with a byte-identical body, `CLAUDE.md` and `GEMINI.md` are symlinks rather than copies, and the
default is every surface unless the repo narrows it in `simt-dev.json`. The test suite fails if a
row emits a frontmatter key its own vendor does not document — the quiet failure mode, since
Antigravity discards a rule whose `trigger` it does not recognise.

**Phase 3 — Prove the engine.** `sync.mjs --check` exits non-zero on drift. Reusable workflow
live — DONE, but not as a `uses:` reference. ADR-023 copies the gate into each repo's own
`.github/workflows/`, written once and never rewritten, and only where that directory already
exists. Row 8 below is the version this plan wrote before that ruling; the reference it
promised would have pointed every reader at bytes they do not have.

**Phase 4 — DONE — Pilot, 3 repos: one web, one API, one mobile.** One per consumer surface, so the
pilot proves the three shapes the estate actually ships rather than three shapes that happen
to be easy to find. It was run, all three repos adopted, and it is the phase that produced
ADR-018 and ADR-019; re-running it is an `upgrade`, not a step. See the note under the table
for where the trio stands now.

| Repo | Surface | Why this one |
|---|---|---|
| `simt-space` | web | **Zero agent configuration at all** — no `AGENTS.md`, no `.agents`/`.cursor`/`.claude`, so `init` scaffolds from nothing (`0 -> 6387` bytes). A hand-written `.git/hooks/pre-commit` (4 KB, the best prose in the estate) sits in the *default* location with `core.hooksPath` unset, so adopting the dispatcher means taking over a hook nobody declared. The only `printWidth: 120` prettier config, prettier installed with **no script invoking it**, no `.editorconfig`, and the only repo with a two-entry `git.config` include. `wrangler.jsonc` makes it a Workers repo, so it selects `core + cloudflare-workers` rather than the `node` fallback |
| `simt-social-api` | API | The only pilot that **adopts an existing `AGENTS.md`** (`12850 -> 19238`, hand-written content preserved outside the markers) and the largest agent surface in the estate: 6 agents + **18 skills** + 3 `.mdc`. Canonical owner of `add-country-galaxy` (the 238-line cross-repo playbook), so retiring the web stub has to happen here. Holds the producer-side `BLOCK` bullet that `simt-social` is missing, the credential-handling prohibition that conflicts with the web copy's build-config bullet, `has-migrations-dir`, and a `pre-push` with a 90-line Cloudflare API Shield publish block. A production-branch push is a production deploy with D1 migrations, so ADR-001 is load-bearing here. Reports 1 duplicate (`AGENTS.md:29`, ADR-005) — reported, not blocking |
| `simt-app` | mobile | Also **no `AGENTS.md`** (`0 -> 5667`), but with **12 `.mdc` + 7 skills already in place**, so it is the case where a scaffolded central region has to coexist with a repo's own hand-written rules rather than be the only rules. Proves the Kotlin/Compose/Wear profile, including the Wear `applicationId` invariant. `core.hooksPath hooks` points at a directory whose `pre-push` was deleted in `ca0e803b4`, leaving the real git-lfs `pre-push` in `scripts/hooks/` unreferenced |

Three routes that are genuinely different: **scaffold with nothing to collide with**
(`simt-space`), **adopt an existing `AGENTS.md`** (`simt-social-api`), and **scaffold beside
an existing rules layer** (`simt-app`). A mechanism that survives all three has no fourth
shape to meet in this estate.

**All three are adopted.** `simt-social-media` was adopted first and is not part of this
trio; it exists because ADR-016 needed a repo that *had* all three `.mdc` families to
establish that they are unions rather than variants.

*Verified 2026-10-06, after the question was asked whether this phase was still outstanding.*
All three still exist and still carry the tool: each has a `simt-dev.json` on its default
branch and its top commit is `merge: adopt simt-dev agent rules`. All three pin
`simt-dev@09c596d`, which is ten commits behind `a831794`. Two of those commits changed what
a repo receives — `slice-commit.mdc` gained a rule, and the registry lost the `coverage-hunt`
skill — and the rest changed nothing a receiving repo can see, because ADR-022's key rename
happens in frontmatter that `stripFrontmatter` removes. So the trio is stale, not wrong, and
closing that gap is `simt-dev upgrade` run in three repositories: a deliberate choice, since
each is a production repository and ADR-001 applies to all of them.

The trio produced three findings that no amount of reading would have:

| Finding | Found by | Ruling |
|---|---|---|
| `hooks status` read `core.hooksPath` but not what git actually runs, so an **unset** path read as "no hooks" and `install` took over a working 4 KB `pre-commit` with no warning | piloting `simt-space` | ADR-018 |
| `init` dropped all five gates on `simt-app` and told the reader to add a script to a `package.json` it will never have; once it declared real commands, the dispatcher, `check` and `hooks status` gave **three different answers** about one manifest | piloting `simt-app` | ADR-019 |
| `core.md` told every repo to read `package.json`, and `test-gate.mdc` taught "name exact commands and test files" using `npm run test:focused` — a filename no non-npm repo has | piloting `simt-app` | a new gate in `test/shipped.test.mjs` |

Each was found by doing to the repo what a person does, not by reading the tool. The pattern
is now stated where it will be read: `simt-dev/AGENTS.md` says run the tool the way a consumer
runs it, and `docs/decisions/README.md` names the shared cause.

**What this trio no longer covers, stated rather than hidden.** The earlier draft picked
a repo outside this estate for its byte-identical `CLAUDE.md`, the `python` profile and the
only declared numeric coverage bar (`fail_under = 100`), and `simt-social-media` for having
the worst `.mdc` drift. Swapping to one-web/one-API/one-mobile drops both, which means:

- `rules/stacks/container.md` is **not** exercised in the pilot; it is selected by
  `simt-goto`'s `Dockerfile`, which adopts in Phase 5.
- `rules/stacks/python.md` has **zero adopters**: this estate has no Python repo, and the
  wider audit's one has left scope. The profile is kept deliberately — ADR-013 makes profiles
  content, and a profile for an ecosystem with no current member is content waiting for its
  first repo, not a defect. It is recorded here so "unexercised" is a decision on the record
  rather than an oversight.
- The duplicate-`CLAUDE.md` repair stays in Phase 6, where it already had a line.
- `simt-social-media`'s missing `intake-questions.mdc` and its 3-trigger `test-gate.mdc` are
  **unmeasured by the pilot**. That is the largest remaining risk in this swap: media is a
  Cloudflare Worker with the *least* process scaffolding in the estate, so if adoption
  depends on scaffolding already being present, the pilot would not reveal it. Mitigation
  without changing the trio — `simt-social-api` adopts the same three `.mdc` families, so
  retiring the drifted twins in Phase 6 covers media, and media's two missing rules are
  restored by the canonical `intake-questions` it never had rather than by migrating its own.

Three web repos against one Python repo is the shape the estate actually has, which is why
this trade is worth stating rather than arguing.

**Phase 5 — DONE — Roll out the remaining 13**, grouped by stack so one set of decisions covers a
group: Workers/TS (social, social-media, api, goto, jobs) · static/LESS (blog, landing,
social-landing) · JVM (garmin, wakt-app, app-ui) · bare (space). `simt-app`, `simt-social-api` and `simt-space` are the Phase 4 pilots and are
not repeated here; `simt-dev` is the tool and never adopts itself.

**Measured at `4aaa441`: 14 of the 16 consumers carry `simt-dev.json`.** The 13 named here plus
`simt-api`, which appeared after this plan was written. `bunnyland-server` and `simt-space-review`
have not adopted and are not expected to — the first was removed from the registry at `86093e1`
and the second has no stack for the tool to detect. Every adopted repo also pins the ADR-032 content
digest, so a pin is now a statement about the bytes that left this package rather than about a
commit that may no longer exist.

**Phase 6 — DONE.** The tracked `git.config` copies are gone: there were 11, not the 13 this
phase expects, all byte-identical and all a personal author identity rather than a hook shim.
`simt-space`'s is the only one its own `.git/config` still includes, so that one stays, and
`simt-dev`'s is the one every other repo includes. Every one of the 11 resolves the same identity,
so deleting 10 changed nothing but the tree. `simt-garmin/README.md` carried a line claiming the
copy was in use; it now points at the canonical one.

The skill twins are **superseded, not collapsed** (ADR-033). This phase's instruction predates
`graph/skills.graph.json`'s `sources.role` vocabulary, which landed at `a9983c8` two hours after
this plan was written. All three resolvers install only the `canonical` source, so a `duplicate` or
`variant` copy is a declared state that resolution never reads. `add-country-galaxy` — the one pair
that genuinely had to become a stub — already is one in `simt-social`, pointing at the API repo.

The 8 divergent `.mdc` copies are retired by `sync`, not by hand: a managed `.mdc` is a generated
file whose frontmatter is preserved and whose body is replaced, with the retirement reported as
`retiring N bytes of divergent hand-written rule text` so the deletion is auditable. Phase 6 only
has to *confirm* the result and delete the per-repo `substitutions` values that are no longer
needed — **confirmed**: all 14 adopted manifests declare zero substitution keys. `simt-social-media`
gained an `intake-questions.mdc` it never had.

`.prettierignore` needed no edit: `graphify-out/` is already gitignored in both Social repos and
`prettier --check` does not walk it, verified by running it against the directory directly.

**Phase 7 — DONE, and two of its items were already closed before the sweep.** The hardcoded
`/Users/<developer>/...` sweep found 17 tracked files, not the 6 implied here. Six were fixed:
`app-ui-submodule.mdc` (three absolute paths, to a directory that does not exist, now `../app-ui`),
two migration docs, a dead script constant in `simt-landing`, and `simt-goto`'s Claude launch
config. The remaining matches are verbatim captured build output, generated Connect IQ and ProGuard
artifacts that would be rewritten on the next build, and two `local.properties` files that are
committed deliberately and stay that way (ADR-033).

simt-app's orphaned git-lfs `pre-push` is **fixed, and this phase named it wrong**: it was the
tracked `hooks/pre-push` deleted at `ca0e803b4`, not the fuller `scripts/hooks/pre-push`, which was
never dead but never installed. LFS objects are tracked and nothing was checking for them.
`scripts/hooks/pre-push` is now the tracked `hooks/pre-push`, so git runs it.

garmin's malformed ```bash fence and red `memcheck` gate were already fixed, and its broken DoD
numbering was never real — both apparent breaks are a table of contents followed by a list that
restarts, and a version string matched as a list item. simt-space's prettier install is not dead:
its pre-commit hook is installed and invokes it.

The "8 dangling references" were 53. `web-perf` does not exist in any repo and is not in the
registry; the two files citing it now name `production-quality-review`, which holds the browser
matrix and the performance budget itself. In `simt-social-api`'s Cloudflare skill, 47 of 67 product
rows named a `references/` directory that was never written and are now marked `not written`, with
the decision tree's arrows annotated the same way and the frontmatter's `references` list trimmed to
the three that resolve. Firebase references are legitimate prose. Both byte counts moved with the
bodies, which moved the provenance digest, which is why every adopted repo was re-stamped after.

npm Dependabot ships (ADR-026) in the seven repos that run GitHub Actions; the other three have no
`.github/workflows` and `init` correctly declines to create one. `packageManager` is missing in
every repo with a `package.json`, and that is intended: ADR-029 settled these three as checks with
no file behind them, so the finding stands until a floor is decided (review 0002 proposal P8).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Marker parsing corrupts a hand-edited `AGENTS.md` | Markers are idempotent; `--check` diffs before writing; every repo gets a branch + `backup-before-simt-dev` tag before its first sync |
| Teams bypass the gate | The reusable workflow is required-status-check-able; the pre-commit hook runs `sync --check` too |
| Canonical files grow a lowest-common-denominator that fits nobody | Stack profiles are separate files, never inlined into `simt-core.mdc`; core stays ~200 lines and stack-agnostic |
| simt-dev churn cascades into 16 repos | The marker stores the source identity (ADR-032: a content digest, not a commit), so a broken sync is *detected*, not silently half-applied. `simt-dev upgrade --all` raises all pins as one reviewable operation |
| Everything at once | Phases 4–6 are per-repo, independently revertable |

## 8. Optional thin layer (layer 0)

A global `~/.claude/CLAUDE.md` and `~/.agents/skills/simt-dev/` entries carrying only the
rules that apply *outside* a repo — never `--no-verify`, read scripts before running them,
`simt-dev check` before claiming done. Explicitly documented as **not** a source of truth so
it can never become a divergent fourth copy. See `0002-simt-dev-cli.md` §8.

## 9. The doctrine that keeps this from rotting

Promote the review agent's checklist item 5 — which today exists in exactly one file and is
aimed at precisely this problem — into a first-class central rule:

> Every shared rule has exactly **one** canonical home. Every other location is either a
> generated region or a thin pointer. Repeated policy text, duplicated source-of-truth,
> verbose prose and redundant examples are **review blockers**, not style nits.

Then point the consolidated review agent at the drift check. The gate and the rule defend
each other.
