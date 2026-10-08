# Review 0001 — simt-dev CLI, structure and docs: release readiness

Status: open · 2026-10-06
Reviewed at: `09c596d` (clean worktree)
Verdict: **BLOCK** for public release and for wider estate rollout (ADR-008 vocabulary)

## Scope and method

Everything that ships or that a consumer runs: `bin/`, every module in `src/`, `rules/`,
`graph/skills.graph.json`, `docs/decisions/`, `docs/plans/`, `package.json`, `.githooks/`,
and the root `AGENTS.md`.

Evidence was gathered by running the tool, not only by reading it:

| Check | Result |
| --- | --- |
| `npm test` | 430/430 pass, 15 s |
| CLI from a scratch directory outside this tree (`node bin/simt-dev.mjs ...`) | defects below |
| `npm pack`, `npm i -D` the tarball into a fresh git repo, `init --yes`, commit, `check` | **`check` goes red after the consumer's first commit** (S01) |
| MCP over stdio (`tools/call` for `rules_why`, `check`) | `rules_why` crashes on every input (S05) |
| `doctor`, `check`, `compare` against `simt-social-api` | fact detection misses (S07), duplicate rule loading (S12) |
| `graph/skills.graph.json` scanned against the resolver | 13/68 path globs and 56 keywords can never match (S02, S03) |

The suite passing is not evidence that these slices are fine. Most of the defects below sit
where the tests don't reach: a packed install, a long-lived MCP process, globs and keywords
taken from the real registry, and partial staging.

## Severity

| Level | Meaning |
| --- | --- |
| P0 | Breaks consumers or blocks release; fix before any further rollout |
| P1 | Wrong behaviour an agent will hit and act on |
| P2 | Inconsistency between commands, surfaces or docs; misleads but does not break |
| P3 | Hygiene: dead code, stale comments, robustness at the edges |

## Tracker

State vocabulary: **Queued**, **In progress**, **Complete**, **Accepted**. Record the commit
SHA and the test command in the row when a slice changes state.

| ID | Slice | Sev | Area | Needs ADR | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Provenance stamp comes from the consumer's git, not simt-dev | P0 | projection | yes | — | Complete | ADR-032; `provenanceDigest()` |
| S02 | Leading `**/` path globs never match | P0 | resolve | no | — | Queued | |
| S03 | Multi-word and short keywords/aliases are unreachable | P1 | resolve, registry | no | — | Queued | |
| S04 | Stack overlap alone selects a skill | P1 | resolve | yes | S02, S03 | Queued | |
| S05 | MCP `rules_why` crashes on every call | P0 | mcp | no | — | Complete | `loadRules` returns an array; `rules_why` destructured `{ rules }` |
| S06 | MCP and CLI disagree (`check`, `skills_brief`, memoised workspace) | P1 | mcp | no | S05 | Queued | |
| S07 | Directory facts with a `/` in the path are never detected | P1 | fingerprint | no | — | Queued | |
| S08 | Hook restage stages unstaged hunks; deletions break restage | P0 | hooks | no | — | Queued | |
| S09 | `sync`/`init` crash on a mispointed pointer after partial writes | P1 | projection | no | — | Queued | |
| S10 | `--yes` / `--dry-run` / `--json` contract is inconsistent across commands | P1 | cli | no | — | Queued | |
| S11 | `slice-commit` rule can never be projected; opt-in note is false | P1 | rules | no | — | Queued | |
| S12 | Folding + per-rule surfaces load every process rule twice | P1 | surfaces | yes (supersedes ADR-021 §3) | — | Queued | |
| S13 | `rules list/show/why` cannot see the `.mdc` rules | P2 | rules | no | S11 | Queued | |
| S14 | Shipped text that fails "readable from the receiving repo" | P1 | content | no | — | Queued | |
| S15 | Help text and flags do not match the CLI | P2 | cli | no | S10 | Queued | |
| S16 | Generated rule-file frontmatter never regenerates | P2 | projection | no | — | Queued | |
| S17 | Declared gate commands split on whitespace | P2 | hooks | amend ADR-019 | — | Queued | |
| S18 | Public-release packaging | P0 | package | yes (registry scope) | S01, S14 | Queued | |
| S19 | Docs and ADR consistency | P2 | docs | no | — | Queued | |
| S20 | Test gaps that let S01–S11 ship green | P1 | tests | no | lands with each slice | Queued | |
| S21 | Dead code, duplicate parsers, stale comments | P3 | hygiene | no | — | Queued | |
| S22 | Robustness at the edges | P3 | various | no | — | Queued | |

Suggested order: S01, S05, S08 and S02 first. Each is small and blocks a different surface
(the gate, MCP, hooks, resolution). Then S07, S09, S10 and S11, then S03 and S04 together,
then S12 once its decision is made. S18 comes last because it depends on S01 and S14.

---

## Slice details

### S01 — Provenance stamp comes from the consumer's git, not simt-dev (P0)

**Finding.** `headSha()` ran `git rev-parse --short=7 HEAD` with `cwd` set to the package
root (`src/projection/rules.mjs:43-50`). In a checkout that is simt-dev's HEAD. When the tool
is installed under a consumer's `node_modules`, git walks up and answers with the
**consumer's own HEAD**.

> **Resolved by ADR-032.** The stamp is now `provenanceDigest()`, a SHA-256 digest over
> `rules/` and `graph/`. `headSha` no longer exists; the finding below is kept as it was
> written, because the reproduction is what the record is for. The suggested fix below was
> not adopted as written — the version is not stamped at all, because `0.0.0` cannot
> distinguish two working trees that project differently.

Reproduced from a packed tarball:

```text
init --yes      -> AGENTS.md stamped sha=4fc4ac3   (the consumer's commit, not 09c596d)
git commit      -> consumer HEAD becomes 81373cb
check           -> DRIFT AGENTS.md  region is updated; run: simt-dev sync   (exit 1)
```

`sync` then restamps with the new consumer SHA, which goes stale at the next commit. Any repo
with `check` in CI or a hook fails on every commit. `upgrade` and `compare` inherit the same
wrong stamp.

There is a second, quieter version of the same issue inside the checkout. The stamp is part
of the compared region (`markers.mjs` `inject` compares header and body), so **every
simt-dev commit**, including docs-only ones, makes every consumer drift. That is the churn
this repo's own `AGENTS.md` gives as the reason it is not self-adopted.

**Suggested fix.**

1. Stop deriving provenance from ambient git. Stamp the package `version` plus a content
   digest of the inputs the region is built from: rule sources, substitutions and the
   surface set. Use the git SHA only when `git rev-parse --show-toplevel` equals the package
   root, and only as extra information.
2. Have `check` compare the region **body** for drift. Report a stamp-only difference as
   `stamp-behind` (non-blocking, remedy `simt-dev upgrade`), not as `drift`.
3. Write an ADR that changes what `simtDevSha` means. The manifest field likely becomes
   `projection: { version, digest }`, and `upgrade`/`compare` need the matching change.

**Acceptance.** A new test packs the tarball, installs it into a temp git repo, runs
`init --yes`, commits twice, and `check` stays exit 0. A docs-only commit in simt-dev leaves
consumer `check` green.

### S02 — Leading `**/` path globs never match (P0)

**Finding.** `matchesGlob` (`src/resolve/resolve.mjs:153-167`) only rewrites `/**`, so a glob
that *starts* with `**/` compiles to `^**/...$`. That is an invalid regex, the `catch` turns
it into `false`, and the glob never matches.

```text
matchesGlob('a/b/c.ts', '**/*.ts') -> false
matchesGlob('c.ts',     '**/*.ts') -> false
```

13 of the 68 registry path globs start with `**/`, for example `complete-testing`'s
`**/*.test.ts` and `data-layer`'s `**/*.kt`. Path is the highest-weighted signal (100), so
the strongest evidence the resolver has is silently dropped for those skills.

**Suggested fix.** Translate segment by segment. A leading `**/` becomes `(?:.*/)?`, a middle
`/**/` becomes `/(?:.*/)?`, a trailing `/**` becomes `(?:/.*)?`. Compile every registry glob
once in `lintRegistry` and fail lint on one that does not compile, instead of swallowing the
error at match time.

**Acceptance.** Unit tests for leading, middle, trailing and bare `**`. A registry test
asserts every declared glob matches at least one synthetic path built from it.

### S03 — Multi-word and short keywords/aliases are unreachable (P1)

**Finding.** `tokenize` splits on `[^a-z0-9]+` and drops tokens of length ≤ 2
(`resolve.mjs:23-29`). Keywords are compared token by token. As a result:

- 56 registry keywords can never match. They are either multi-word (`durable object`,
  `conventional commit`, `do not push`, `press kit`) or short (`d1`, `r2`, `kv`, `ci`).
- Capability aliases `ui`, `r2`, `kv` and `d1` are dead (`resolve.mjs:36-60`).
- `"fix d1 migration"` tokenises to `fix, migration`. `d1`, the most specific word in the
  task, is gone.

`graph lint` reports none of this.

**Suggested fix.** Keep length 2 tokens. They are an explicit vocabulary in this domain, and
determinism is kept. Match multi-word keywords as phrases against the normalised task string,
not token by token. Add a lint error: *keyword "x" can never match a tokenised task*, computed
as `tokenize(keyword).join(' ') !== keyword` with no phrase support.

**Acceptance.** `skills find "durable object"` and `skills brief --task "d1 migration"` both
report the `keyword:` reasons. Lint fails on a keyword the tokenizer can't reach.

### S04 — Stack overlap alone selects a skill (P1)

**Finding.** The stack overlap adds `W.stack` (15 per tag) to the score, and any score above
0 is selected (`resolve.mjs:113-118`, `192-195`). The stack gate is already a precondition,
so in practice every stack-compatible skill is "selected" whenever any task or path is given.
`skills brief --task "fix d1 migration"` in a bare Node repo selects `api-contract-sync`,
`api-feature-slice` and `api-security-review` on `stack:node` alone and reports
`(budget capped)`. The budget fills with irrelevant bodies, and `NOT SELECTED` (the block an
agent uses to override) is nearly empty.

**Suggested fix.** Make stack a tiebreaker. A skill is selected only with at least one
non-stack signal (path, keyword, name, capability, summary), or when it is forced or `--all`
is set. Keep stack in the score for ordering. This changes ranking, so it is a ruling and
needs an ADR. Add a small gold corpus of task → expected set (plan 0002 §11 step 5 claims an
"eval corpus" that does not exist; see S19).

**Acceptance.** Gold tests: `"fix d1 migration"` in a Workers repo selects `d1-safe-change`
and not `api-contract-sync`. A task with no matching words selects nothing and says why.

### S05 — MCP `rules_why` crashes on every call (P0)

**Finding.** `src/mcp/tools.mjs:316` does `const { rules } = await loadRules(null)`, but
`loadRules` returns an array, so `rules` is `undefined`:

```text
rules_why {what:"ADR-001"} -> "Cannot read properties of undefined (reading 'filter')"
rules_why {what:"core"}    -> "Cannot read properties of undefined (reading 'find')"
```

No test calls this tool. The description also says "restsates" (sic).

**Suggested fix.** `const rules = await loadRules(null);`. Add a test that calls every tool
in `TOOLS` with its minimal valid arguments and asserts `isError: false`.

### S06 — MCP and CLI disagree (P1)

**Finding.** `tools.mjs` says "two resolvers would be two answers to the same question", yet
three answers are reimplemented there and have already diverged:

- **`check`** (`tools.mjs:360-372`) counts `pointer-drift` as a failure, which the CLI treats
  as non-blocking (`sync.mjs:36`). It also omits `unrunnableGates`, which the CLI adds
  (`sync.mjs:196-199`). The same repo can be `ok: true` in one and `ok: false` in the other.
- **`skills_brief`** budget loop (`tools.mjs:131-144`) inlines a *deferred* skill when it is
  a dependency. The CLI (`skills.mjs:263-281`) always defers it. The no-task warning is
  CLI-only.
- **Memoised workspace** (`src/graph/load.mjs:40-44`). It is resolved once per process using
  the *first* caller's flags. That holds for a CLI run and is false for the long-lived MCP
  server: a later `workspace` argument, or an edited config file, is ignored.

**Suggested fix.** Extract `runCheck(root, flags)` from `checkCommand` and
`selectWithinBudget(expanded, budget, all)` from `briefCommand`. Have both front doors call
them and render separately. Remove the memo, or key it on the resolved inputs.

**Acceptance.** A parity test runs CLI `--json` and the MCP tool against the same fixture
for `check` and `skills brief` and asserts equal `ok` and equal selection names.

### S07 — Directory facts with a `/` in the path are never detected (P1)

**Finding.** `fingerprint.mjs:166-176`. For a fact of `kind: 'dir'`, a candidate containing
`/` is probed with `isFile`, which is always false for a directory. As a result
`has-decisions-dir` (`docs/decisions`, `docs/adr`, `docs/adrs`), `has-ci-workflows`
(`.github/workflows`), `has-migrations-dir` (`db/migrate`) and `has-schema-dir`
(`db/schema`) are never emitted through those paths. Verified: `doctor` on `simt-social-api`
(which has `.github/workflows`) and on simt-dev (which has `docs/decisions`) reports neither
fact. Any profile or skill gated on these facts silently never applies (ADR-013).

**Suggested fix.** Probe by kind, not by the presence of a slash: `file` → `isFile`,
`dir` → `isDir`.

**Acceptance.** A fixture with `.github/workflows/` and `docs/decisions/` emits both facts,
with the matching evidence path in `doctor`.

### S08 — Hook restage stages unstaged hunks; deletions break restage (P0)

**Finding.** After a passing `format` gate, `restage` (`src/hooks/dispatcher.mjs:149-159`)
runs `git add` on **every** path in `git diff --cached --name-only`. Two defects follow:

1. **Partial staging is destroyed.** A file staged with `git add -p` gets its unstaged hunks
   committed. The formatter also rewrote the whole working-tree file. This breaks the
   header's own promise (ADR-004: "would rewrite unstaged work the author did not ask to
   touch") on the one path that runs on every commit in every adopted repo.
2. **A staged deletion aborts the restage.** `--name-only` without `--diff-filter` includes
   deleted paths, so `git add -- <deleted>` fails. The `catch` returns `false`, and the
   commit records the unformatted bytes with no message.

Separately, `restage` reports "re-staged files the formatter rewrote" whenever anything is
staged, whether or not the formatter changed a byte.

**Suggested fix.** Restage only the files the formatter was given (`resolution.argv` already
holds them). Before formatting, detect files that also have unstaged changes
(`git diff --name-only` ∩ staged). Either fail the gate for those with a remedy ("stage the
whole file or format it yourself"), or stash the unstaged hunks around the formatter the way
lint-staged does. Failing is simpler and consistent with fail-closed. Compare the blob hash
before and after so the report is true.

**Acceptance.** Hook tests: a partially staged file leaves its unstaged hunk unstaged (or the
gate fails with the remedy). A commit containing a deletion plus a formattable file restages
the formatted file.

### S09 — `sync`/`init` crash on a mispointed pointer after partial writes (P1)

**Finding.** Reproduced with `CLAUDE.md -> README.md` and surfaces `opencode,claude`:

```text
wrote    .claude/rules/intake-questions.md
wrote    .claude/rules/test-gate.md
ERROR 1 EEXIST: file already exists, symlink 'AGENTS.md' -> '.../CLAUDE.md'
REMEDY run: simt-dev doctor
```

`sync.mjs:92-103` and `init.mjs:72-80` put `mispointed` (and `unreadable`) pointers in the
write plan, and `symlink()` then throws. The crash lands after other files were written,
which contradicts the "all-or-nothing" promise in the `sync.mjs` header. `check` gives
`run: simt-dev sync` as the remedy for the same state, so the two remedies loop.

`sync --check` also disagrees with `check` on pointers. `sync --check` fails on a missing
pointer, while `check` doesn't report missing pointers at all and treats `pointer-drift` as
non-blocking.

**Suggested fix.** Treat a mispointed **symlink** as replaceable: `unlink`, then `symlink`,
and report the old target. Keep refusing for a regular file (`foreign`). Validate every
planned write before the first one, matching the malformed-region guard. Use one pointer
policy in both gates.

**Acceptance.** Test: a mispointed pointer is repaired by `sync`, and `check` is then green.
An `unreadable` pointer blocks before any write.

### S10 — `--yes` / `--dry-run` / `--json` contract is inconsistent (P1)

**Finding.** Agents depend on these three flags more than anything else, and each command
implements them differently:

| Command | Defect | Where |
| --- | --- | --- |
| `upgrade --yes --dry-run` | **writes**; only `flags.yes` is checked | `upgrade.mjs:86` |
| `skills install --yes --json` | **never writes**; returns after emitting the plan, the exact bug `sync`/`upgrade` comments say was fixed | `skillsinstall.mjs:142-145` |
| `skills install --yes` | prints "dry-run nothing written" and then writes | `skillsinstall.mjs:186` |
| `skills install --yes --dry-run` | writes | `skillsinstall.mjs:188` |
| `skills brief --json` (no task, clean tree) | prints plain text; with `--all` prints text **then** JSON on stdout | `skills.mjs:237-250` |
| `doctor --json` | exits 0 on an unparseable workspace config that text mode fails with exit 3; omits `workspace` | `commands/index.mjs:166-169` |
| `hooks status --json` | always `ok: true`, exit 0; text mode exits 1 on problems | `hooks.mjs:232-255` |
| error paths under `--json` | `sync`/`init` emit a JSON error object; `hooks`, `skills`, `rules` emit only stderr text | various |

**Suggested fix.** Add one helper, `writeMode(flags) -> {apply, dryRun}` with
`apply = yes && !dryRun`, and route every mutating command through it. Define a JSON contract
in `output/index.mjs`: under `--json`, exactly one JSON document on stdout, its `ok` agrees
with the exit code, and failures are emitted as `{ok:false, error, remedy}` as well as the
stderr line.

**Acceptance.** A table-driven test runs every command under `--json` in a fixture, parses
stdout as exactly one JSON value, and asserts `ok === (exit === 0)`. A second table asserts
that no mutating command writes under `--dry-run` or without `--yes`.

### S11 — `slice-commit` can never be projected; the opt-in note is false (P1)

**Finding.** `rules/mdc/slice-commit.mdc` declares neither `applies:` nor `optIn:`.
`isEligible` (`rules.mjs:66-70`) only passes `optIn: true` rules through `__optIn`, and an
empty `applies` never matches. So the rule added in `66b5071` reaches no repo. The note
`mdcTargets` prints, "opt in with substitutions.__optIn" (`rules.mjs:127-129`), is false for
it. Verified: a manifest with `"__optIn": ["slice-commit"]` still projects nothing.

The rule text also carries an estate fact as if it were universal: "pushing a production
branch in this ecosystem also deploys it".

**Suggested fix.** Make the eligibility rule explicit. `loadMdcRules` should error on a rule
that has neither `applies` nor `optIn: true`, because it can never project. Give
`slice-commit` the selection it was meant to have, and move the deploy sentence into a
substitution with an empty default (the `preview-postflight` pattern). List only `optIn`
rules in the opt-in note.

**Acceptance.** A shipped-content test: every `.mdc` rule is eligible in at least one
fixture. The opt-in note names only rules that `__optIn` can actually enable.

### S12 — Folding + per-rule surfaces load every process rule twice (P1, decision)

**Finding.** ADR-021 ruling 3 folds every `.mdc` rule into `AGENTS.md` whenever *any*
selected surface folds, and still writes per-rule files for the other surfaces. Three of the
four pilot repos use `opencode,cursor`. Cursor reads `AGENTS.md` natively (the opencode row's
own `readers` list says so) **and** `.cursor/rules/*.mdc`, so `test-gate`,
`intake-questions` and `preview-postflight` load twice in every Cursor session in
`simt-social-api` and `simt-social-media`. The same happens for `opencode,claude`, where
Claude reads `CLAUDE.md -> AGENTS.md` plus `.claude/rules/`. This is the duplication the
projection exists to remove, and it costs context on every turn.

**Suggested fix.** This needs a decision recorded as an ADR that supersedes ADR-021 §3. The
recommended option is to add `readsPrimary` to each surface row. When folding is active,
skip per-rule files for surfaces whose reader also reads the primary file. Per-rule files
then exist only for readers that would otherwise miss the rule (Copilot editor and code
review). The alternative is to fold only when no selected surface writes per-rule files.
That gives opencode users nothing in mixed repos, which is ADR-021's original objection.

**Acceptance.** For `opencode,cursor`, `sync` writes the folded region and no
`.cursor/rules/<always-on>.mdc`. `compare` reports already-written duplicates as a note with
a remedy, never deleting them (ADR-021 §6).

### S13 — `rules list/show/why` cannot see the `.mdc` rules (P2)

**Finding.** `loadRules` (`rules.mjs:279-330`) reads `rules/*.md` and `rules/stacks/*.md`
only. `rules list` prints 8 rules, and `rules show test-gate` fails with "no rule with id",
although every adopted `AGENTS.md` carries a `### test-gate` section. MCP `rules_list` has
the same gap. `rules list --root` therefore under-reports what a repo receives, which is the
question that flag exists to answer.

**Suggested fix.** Include `loadMdcRules()` entries in the catalogue with
`origin: 'canonical'` and kind `process`, and select them with `isEligible` so `--root`
marks them correctly.

### S14 — Shipped text that fails "readable from the receiving repo" (P1)

The `AGENTS.md` checklist for this repository, applied to the rendered output:

| Text | Problem | Where |
| --- | --- | --- |
| "Every rule below carries the number of the decision that settled it." | False. Most core bullets, every stack profile and every folded `.mdc` section cite no ADR | `rules/core.md:9-10` |
| "or add the key to the rule in rules/mdc/" | A path in simt-dev's tree, offered to a consumer as a remedy | `sync.mjs:61`, `init.mjs:143` |
| `file: rules/${r.file}` / `rules/mdc/${rule.file}` in `check` findings | Same: a consumer cannot open these | `sync.mjs:189`, `project.mjs:132` |
| "pushing a production branch in this ecosystem also deploys it" | An estate fact projected as universal | `rules/mdc/slice-commit.mdc` |
| `rules why ADR-001` → "Autonomous push (garmin's current rule)", "as bunnyland's loop implies" | Estate repo names in `## Rejected`, printed to every reader | ADR bodies via `decisions/index.mjs:155-157` |
| `ESTATE` regex with SIMT repo names hardcoded in the engine | Product taxonomy in code, contrary to ADR-013; meaningless to any other org | `decisions/index.mjs:179-180` |
| Unknown-gate remedy "or run: simt-dev upgrade" | `upgrade` never changes gates | `hooks/gates.mjs:112` |
| `remove "${name}"] from` | Stray `]` | `hooks/gates.mjs:126` |
| Shim remedy `npm i -D @quazarmedia/simt-dev` | The package is `private: true`, so the command cannot succeed | `hooks/shim.mjs:101` |
| bin catch-all remedy "run: simt-dev doctor" | Unrelated to most crashes (S09's `EEXIST`) | `bin/simt-dev.mjs:27` |

**Suggested fix.** Reword or substitute each item. Then extend `test/shipped.test.mjs`:
no remedy or finding `file` may start with `rules/`; no rendered region or `rules why` output
may contain a name from a deny-list of estate repos; a test asserts the core.md claim (every
bullet cites an ADR) or the sentence is dropped.

### S15 — Help text and flags do not match the CLI (P2)

- Help omits `graph lint` and `hooks run`, and the flags `--check`, `--accept-conflicts`,
  `--list` and `--quiet` (`help.mjs:4-52`).
- `--surfaces` help says the default is "every surface". That was ADR-020; ADR-021 made it
  `opencode` (`help.mjs:42-44`).
- `--skill` is documented as "repeatable". The parser keeps only the last value
  (`argv.mjs:97-99`), and only comma separation works.
- `--quiet`, `--semantic` and `--mermaid` are accepted and read by nothing. That is the
  "silent ignore" `argv.mjs`'s header says must not happen.
- `--skill <unknown>` is silently ignored by `skills brief`. It should fail with a "did you
  mean" like `skills show` does.
- `-h` is parsed as a command name.
- `init --yes` creates the tag `backup-before-simt-dev` and **checks out** `simt-dev/adopt`
  in the consumer repo (`init.mjs:36`, `334`). Neither the dry-run output nor `--help`
  mentions it. An agent that runs `init --yes` finds itself on a new branch.
- `init` ends with "next simt-dev sync", which repeats work `init` just did.
- `package.json` `"lint": "node bin/simt-dev.mjs doctor"` is not a lint.

**Suggested fix.** Generate the help command list from the registry in `commands/index.mjs`
so it cannot drift. Delete the unread flags, or wire them. Support repeated `--skill`. Print
the git side effects in the `init` plan.

### S16 — Generated rule-file frontmatter never regenerates (P2)

**Finding.** `ruleTargets` keeps any existing frontmatter (`targets.mjs:51-52`), and `check`
compares only the region. If a rule's `description` or `alwaysApply` changes, the
Antigravity `trigger:` or Cursor `alwaysApply:` already on disk stays stale forever, and
`check` reports `current`. Antigravity documents that it silently drops a rule with a bad
`trigger`, which is the reason `surfaces.mjs` exists. The file is described everywhere as
"wholly generated".

**Suggested fix.** Regenerate frontmatter from the surface row on every `sync`, and include
it in the `check` comparison. If hand-added keys must survive, merge only keys outside the
row's `documentedKeys`.

### S17 — Declared gate commands split on whitespace (P2)

**Finding.** `hooks/resolve.mjs:98` runs
`declared.trim().split(/\s+/)`, so `./gradlew test --tests 'Foo Bar'` becomes
`'Foo` and `Bar'`, and `cd sub && make` cannot be expressed. The failure looks like the gate
failing, not like a parse problem.

**Suggested fix.** The tool is POSIX-only (ADR-012) and the manifest is repo-owned, so the
trust boundary is unchanged by running `['/bin/sh', '-c', declared]`. Amend ADR-019 to say
so, and print the exact command in `hooks status`.

### S18 — Public-release packaging (P0)

| Item | State | Suggested fix |
| --- | --- | --- |
| `"private": true`, `"license": "UNLICENSED"`, `"version": "0.0.0"` | Cannot be published or legally consumed | Choose a licence; start at `0.1.0`; add `CHANGELOG.md` |
| `files` lists `skills`, `agents`, `tooling`, `hooks` | None of these exist | Remove them |
| `docs/plans/` ships in the tarball | Internal history: wrong binary name `simt`, estate repo names, non-existent fixtures | Drop from `files`; `help.mjs` already avoids pointing at it |
| `graph/skills.graph.json` ships 38 SIMT-estate skills (817 KB of bodies the consumer does not have) | `skills index` from a clean install lists skills that cannot be read | **Decision:** ship an empty or example registry and load the estate one from config/workspace, or keep the tool estate-internal |
| No `README.md`, `LICENSE`, `.gitignore`, `CONTRIBUTING` | First-contact docs missing | Add a README: install, the five commands, exit codes, JSON contract |
| `git.config` tracked at the root with a personal name and email | Identity file in a public tree, read by nothing | Remove it from the tree |
| No CI, yet ADR-012 states "CI verifies on `macos-latest` and `ubuntu-latest`" | The claim is false | Add a workflow running `npm test`, `graph lint` and the S01 pack-install test on both OSes, or amend the ADR |
| Only gate is `.githooks/pre-push` (runs `shipped.test.mjs` twice, since `npm test` already includes it); no format/lint for simt-dev itself | — | Drop the duplicate; decide whether simt-dev gets a formatter |

### S19 — Docs and ADR consistency (P2)

- ADR-019, ADR-020 and ADR-021 are dated **2026-10-07**, after the latest commit
  (2026-10-06). `surfaces.mjs:88` likewise says "read 2026-10-07".
- ADR-021's status line is `Status: accepted` without the `**accepted**` bold the others use.
  `decisions/index.mjs:85` detects acceptance by that bold, so ADR-021 is reported
  `accepted: false`. Parse the status word instead of the markup.
- ADR-021's title is "One surface per repo", but its own Consequences have three of four
  pilots on `opencode,cursor`. Retitle to "one surface by default".
- `docs/decisions/README.md:71` says `simt init`, the wrong binary name. Its README title for
  ADR-021 differs from the record's heading.
- Plan 0002 §11 uses `simt --help`, `simt graph lint` and `simt check`. Step 5 claims "`eval`
  corpus passes" and §10 lists `test/fixtures/` and `test/gold/`, none of which exist. §10's
  "makes `npx` instant" contradicts ADR-010.
- Root `AGENTS.md` says both "Commit locally and report the SHA" and "Never commit or push on
  a user's behalf". Pick one; the estate rule is the first.
- Comments still cite moved locations: "Every command named in docs/plans/0002 ... section 5
  is registered here", "init pads 12 and sync 8" (sync passes 10), "ADR: principle 5".

### S20 — Test gaps (P1)

The 430 tests run the tool from its own source tree with synthetic inputs. The root
`AGENTS.md` names that as the failure mode ("a test suite that only exercises the tool from
its own source tree cannot detect that the tool only works from its own source tree"), and it
happened again in S01. Add:

1. **Pack-and-install e2e**: `npm pack`, install into a temp git repo, then `init --yes`,
   commit, `check`, `upgrade`, `hooks install`, and run one real commit through the shim.
2. **MCP matrix**: every tool called with minimal valid arguments (S05), plus CLI/MCP parity
   (S06).
3. **Registry-driven resolver tests**: every glob compiles and matches, and every keyword is
   reachable (S02, S03).
4. **JSON and write-mode contract table** (S10).
5. **Git-state hook tests**: partial staging, deletion, rename (S08).

### S21 — Dead code, duplicate parsers, stale comments (P3)

- Unused exports: `surfaceFrontmatter` (`targets.mjs:163`), `gateKind`, `gateWhy` and
  `gateAdr` (`hooks/resolve.mjs:24-34`), and `isTty` (`output/index.mjs:44`). `mdcFrontmatter`
  and `unresolved` are reached only from tests. `checkTarget` is a one-line wrapper. The
  `GATES as _G` import and `__internals.basename` are unused.
- `STEPS` and `KNOWN_SUBS` in `commands/index.mjs` are scaffolding for unimplemented commands
  that no longer exist; `KNOWN_SUBS` lists `doctor`, which is not a group.
- `resolveAlias` is imported by `skills.mjs` and never called, so `skills show <alias>` shows
  the alias node rather than resolving it. Either wire it or remove it.
- Unused locals: `byName` in `rankSkills`, `repo` in `emitAll`, `diff` import in
  `targets.mjs`, and `const md = files === 1 ? '' : ''` in `graph/load.mjs:482`.
- Misplaced doc comments: the `rulePath` comment sits on `frontmatterBlock`
  (`surfaces.mjs:271-276`), and the "ADR-006: coverage stays null" comment sits on
  `defaultGates` (`manifest.mjs:321`). `defaultLimits(stack)` takes no parameter.
- **Three frontmatter parsers** (`rules.mjs:426`, `mdc.mjs:123`, plus the `extractFrontmatter`
  and `wrapFlat` regexes). This repo's own rule calls a third copy a defect. None of them
  handle CRLF. Extract one into `projection/frontmatter.mjs`.

### S22 — Robustness at the edges (P3)

- The conflict scanner reads `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.cursor/rules` and
  `.github/instructions`, but not `GEMINI.md`, `.claude/rules/` or `.agents/rules/`, which
  are surfaces simt-dev itself writes (`conflicts.mjs:22-25`).
- The `connectiq` marker `manifest.xml` is generic enough to misclassify unrelated repos.
  `wear-os` inferred from a `wear/` directory is product taxonomy in the engine
  (`fingerprint.mjs:24`, `222-226`).
- `lintRegistry` throws on a non-array `capabilities` or `stack` instead of reporting it
  (`graph/load.mjs:173`, `255`).
- `measureSkill` reads a symlinked directory entry with `readFile` (`EISDIR`).
- `absolute('~')` does not expand a bare `~`. `nearMatches` treats any short candidate as a
  substring hit.
- `sync` ignores `surfaceProblems`, while `check` fails on them. `init` always writes an
  explicit `surfaces` list, which pins the repo off the global default and silently drops an
  unknown id from the manifest (`init.mjs:81`).
- `hooks install` leaves a previously installed shim in place for an event that no longer
  declares gates.
- The staged formatter passes every file on one argv, which can exceed `ARG_MAX` on very
  large commits. Chunk it.

---

## What is solid and should be kept

- The generated-region primitive (`markers.mjs`): fence-aware, malformed regions refused
  rather than appended to, idempotent, and formatter-shaped output. Its tests are the best in
  the suite.
- Fail-closed gates with a remedy on every refusal, and `hooks install` refusing to take over
  a foreign hook routing, including the default-location case from ADR-018.
- Workspace resolution precedence with a reported `source`, and the `off` sentinel.
- Byte-verified source location (ADR-015) and variant selection by content.
- Supersession handled correctly in `rules why`: a reversed ruling never prints as current.
- Zero dependencies and POSIX-only, both actually held.

## Not reviewed (residual risk)

- `src/compare/discover.mjs`, `src/compare/hooksstate.mjs` and the lower half of
  `src/compare/row.mjs`: skimmed, not traced.
- Skill bodies in sibling repositories: only their registry metadata was checked.
- `docs/plans/0001` and the full text of ADR-001 to ADR-018: checked for status, dates and
  consistency, not re-argued.
- Behaviour on Linux: everything here ran on macOS (darwin 25.6).
