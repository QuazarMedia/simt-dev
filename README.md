# simt-dev

![simt-dev, the intelligence amplifier for coding agents, and its four claims. One: say less, always — a kernel under 2 KB whose bytes stay stable so the prompt cache survives. Two: answers over exploration — a local code graph and a short task brief. Three: enforce, don't instruct — dual gates, before a tool call and at git time. Four: close the loop — benches and memory. Beneath them, the harnesses it works across and its three channels.](https://raw.githubusercontent.com/QuazarMedia/simt-dev/main/res/59e21e6d-6bf2-4d7d-b6ea-c7349a697d11.jpg)

`simt` adopts a repository for the agents that work in it, and builds an intelligence
amplifier around them: a brief that answers before the agent explores, gates that
validate before a tool call, benches that price every rule text, and memory that puts
a recorded failure to work on the next one.

It reads what the repository actually runs, projects the rules that are not already
obvious into the files those agents read, and installs only the gates that repository
can run. Around that projection it keeps the bytes stable, replaces an instruction
with a check where a check can decide, answers questions about the tree from a local
index, and records whether a run still applies to the tree on disk.

The aim of the whole design is a higher share of tasks resolved, at a lower cost per
resolved task. Those targets are hypotheses. A change that touches what an agent reads
ships with a measurement, or its record says the measurement was not run. `simt rules
why ADR-NNN` prints the record, including whether it is still in force.

The default path is deterministic: no model, no network, no runtime dependencies.
Anything that needs a parser grammar, a local model, or another server is a separate
package, off until the repository names it, and it proposes rows or text for a person
to merge. It does not write the projection.

## Today

```sh
# Adopt, inspect, and maintain a repository
simt init                           # adopt or scaffold; prints a plan; --yes writes
simt doctor                         # stack, facts, evidence, and config health
simt check [--frozen]               # projection drift, manifest, lock, and declared checkers
simt sync [--explain] --yes         # regenerate the projection
simt upgrade --yes                  # move every consumer in the workspace to this SHA

# Orient on a task and query the local code and governance graph
simt brief "<task>"                 # one <= 2 KB packet: kind, commands, files, tests, ADRs, skills, lessons
simt index [--embed]                # files, symbols, edges, FTS5 tokens (+ optional local embeddings)
simt map --task "<task>"            # hybrid BM25 + PageRank + resolver file ranking (outline|names|signatures)
simt impact <file|symbol>           # importers, covering tests, governance, and cross-repo consumers
simt tests <path> [--cochange]      # tests covering a file via imports, naming, coverage, or co-change
simt gate --changed                 # run only the tests the current diff reaches, with compacted output
simt why [path]                     # ADRs, rules, skills, gates, and lessons governing a path

# Rules, skills, decisions, and lessons
simt rules list [--root <path>]     # rule catalogue and what applies to a repository
simt rules show <id>                # read one rule body (including rules deferred in kernel mode)
simt rules why <id|ADR-NNN> [--all] # the decision that settled a rule, and whether it still stands
simt decide "<title>" --yes         # scaffold the next ADR with structured simt-affects / simt-supersedes
simt lessons list                   # fail-to-fix, revert, review-block, and hook-denial candidates
simt lessons review <id> --yes      # promote a candidate to docs/lessons/NNNN-<slug>.md
simt skills index                   # tier-0 catalogue: every skill, one line each
simt skills brief --task "<task>"   # tier-1 ranked skill selection within budget
simt skills show <name>             # tier-2 skill body on demand (respects --max-bytes)
simt skills why <name>              # the signal chain that selected or rejected a skill
simt skills find <query>            # search skills by capability and keyword
simt skills install <name> --yes    # pin a skill into the repository
simt skills compile [<name>]        # compile to Agent Skills layout, split > 5,000-token bodies, report triggers
simt skills eval [corpus]           # measure resolver precision and recall against a gold corpus
simt graph lint [--spec agentskills]# verify the skill registry against skills on disk

# Dual gates (git time and agent tool-call time) and execution evidence
simt hooks install --yes            # install the shared POSIX git hook dispatcher
simt hooks status                   # what each git event routes to, and whether it is wired
simt hooks run <event>              # run pre-commit or pre-push gates now, as git would
simt agent-hooks install --yes      # write pre/post-tool and prompt-submit hooks for active harnesses
simt agent-hooks status             # what each harness will run, and whether Codex trusts it
simt agent-hook <event> --harness   # evaluate pre-tool-use, post-tool-use, or prompt-submit
simt evidence                       # gate and test runs recorded against the current git tree
simt evidence check <msg-file>      # verify a commit message does not claim unrecorded passing runs

# Plans, context metering, workspace learning, benchmarks, local models, and MCP
simt plan status                    # count queued, in-progress, complete, and accepted tracker rows
simt plan next [<id>]               # print the next ready slice section (~1 KB)
simt plan done <id> [<sha>] --yes   # mark a tracker row complete with its commit SHA and test command
simt tokens [--repos] [--session]   # measure bytes loaded at session start or split a transcript
simt harness detect [--user]        # detect configured harnesses at repo and user level
simt harness loaders [--table]      # what each harness loads, in what order, and where its cap truncates
simt shared plan                    # rules repeated across a workspace and the bytes saved by sharing
simt shared install --yes           # write shared rules once at user level and record the repo delta
simt compare                        # workspace matrix, violated rules, noisy/slow gates, and ADR drafts
simt local doctor [--allow-remote]  # probe configured OpenAI-compatible local chat and embed endpoints
simt bench mine --yes               # mine verified fail-to-pass tasks from git history into the vault
simt bench run --yes                # evaluate arms (bare, current, kernel, brief) in isolated exports
simt bench report [--compare a b]   # resolved rate, quality, cost, CPI, bootstrap CIs, McNemar/Wilcoxon
simt bench ablate --yes             # leave-one-out rule ablation ranked by value per KB
simt bench probes --yes             # 12 deterministic rule-compliance probes
simt bench variants --yes           # evaluate simt-variants slots and lock winners in simt-dev.lock.json
simt mcp [--list]                   # serve the 13 read-only tools over stdio JSON-RPC
```

`init`, `sync`, `upgrade`, `hooks install`, `agent-hooks install`, `shared install`,
`skills install`, `plan done`, `lessons review`, `decide` and the `bench` writers print
a plan and write nothing without `--yes`. None of them commit or push. `simt index`
writes its cache without asking: the file is gitignored and `git ls-files` can rebuild it.

`check` runs the checkers a rule names (`max-file-lines`, `forbid-regex`,
`forbidden-path-edit`, `required-file`), verifies structured ADR supersessions
(`prose-partial-supersession`), and flags expired lessons (`LESSON-EXPIRED`). A marked
rule line leaves the projection as `Enforced:` and the checker's name. The file-length
line warns past 400 lines and fails past 1000. `simt evidence check` warns when a commit
message claims a passing run this tree does not have, and the commit fails when
`gates.evidence` is `block`.

## Agent playbook: how and when to use each module

An agent working in an adopted repository should use `simt` as its primary orientation,
retrieval, validation and memory layer rather than scanning the tree by hand. Every
read-only command supports `--json` (and `--max-bytes <n>`) or can be called over stdio
through `simt mcp`.

### Decision tree: which command to run when

| Situation | First command | If you need more |
| --- | --- | --- |
| New task, no context yet | `simt brief "<task>"` | `simt map --task "<task>"` for broader file ranking |
| About to edit a file | `simt why <file>` | `simt impact <file>` for blast radius |
| Need to know what tests to run | `simt tests <file>` | `simt gate --changed` to run them |
| Rule violation or error | `simt lessons list` | `simt rules why <rule-id>` for the decision |
| Working from a plan | `simt plan next` | `simt plan done <id> <sha> --yes` when finished |
| Before committing | `simt check` | `simt evidence` to verify test claims |
| Repository adoption | `simt init --yes` | `simt doctor` to verify stack detection |
| Multi-repo workspace | `simt compare` | `simt shared plan` to find deduplication opportunities |
| Local model available | `simt local doctor` | `simt index --embed` to build vector embeddings |

### 1. Start of task — orient in one call instead of broad exploration

1. **Assemble the task packet first.** Run `simt brief "<task>"` (or call MCP `brief`, or
   read the packet injected automatically when `agent-hooks install --yes` wired
   `prompt-submit`). Within `--budget 2048` bytes (pass `--budget 0` for unlimited or
   `--explain` to see why items were kept or cut), the packet gives:
   - `TASK`: the classified task kind (`bugfix`, `feature`, `refactor`, `test`, `docs`,
     `config`) and the evidence behind it.
   - `COMMANDS`: the exact `build`, `test`, `lint`, `format`, `typecheck`, and focused
     test templates for this repository.
   - `LIKELY FILES`: top files ranked by reciprocal-rank fusion (`RRF_K = 40`) across
     SQLite FTS5 `bm25()`, PageRank graph proximity, and resolver signals.
   - `TESTS`: the test files mapped to those likely files.
   - `DECISIONS`, `SKILLS`, `LESSONS`, `CAUTIONS`, and `FEDERATION`: governing ADRs,
     matched skills, promoted lessons for those paths, active worktree/hook cautions, and
     any structural answer from a declared external code-graph server.
2. **Pull the next tracker slice when working from a plan.** Instead of reading a multi-thousand-line
   plan in `docs/plans/` or `docs/reviews/`, run `simt plan next` (or MCP `plan_next`) to
   load only the next queued slice (~1 KB) whose dependencies are already `Complete` or
   `Accepted`.

**When to use `--json` format.** When piping output to other tools or when the agent needs
structured data, add `--json` to any read-only command. For example, `simt brief "<task>" --json`
returns a JSON object with `task`, `commands`, `files`, `tests`, `decisions`, `skills`,
`lessons`, `cautions`, and `federation` fields that can be programmatically consumed.

### 2. Before editing — query the graph, blast radius, and governance

1. **Rank files or symbols at the right granularity.** When `brief`'s file list is too
   narrow or the task evolves, run `simt map --task "<task>" --level outline` for paths,
   `--level names` for exported symbols, or `--level signatures` for declaration lines.
   Pass `--embed` when `local.embed` is configured in `simt.json` and clears the +10-point
   recall@10 bar.
2. **Check blast radius before changing a shared file or export.** Run
   `simt impact <file|symbol>` to see every direct and transitive importer, the tests
   covering them, the governing rules and ADRs, and any sibling repository in the
   workspace that imports that symbol.
3. **Read the governance on a path before changing its behaviour.** Run `simt why <path>`
   to list every ADR whose `simt-affects` matches the file, every scoped rule, skill,
   gate, and promoted lesson. Run `simt why` with no path to audit the repository for
   `UNRESOLVED-AFFECTS` tokens.
4. **Resolve deferred rules and citations on demand.** When `simt.json` sets
   `"mode": "kernel"`, only `hard` and `command` rules are loaded at session start;
   `convention` and `style` rules are listed by ID at the foot of the projection. Fetch a
   deferred rule with `simt rules show <id>`, and read any cited `ADR-NNN` with
   `simt rules why ADR-NNN` (or MCP `rules_why`) to see its rulings and whether any ruling
   was superseded or narrowed.
5. **Load skills progressively (Tier 0 → Tier 1 → Tier 2).** Never read every skill file
   upfront:
   - Tier 0: `simt skills index` (or MCP `skills_index`) lists one line per skill.
   - Tier 1: `simt skills brief --task "<task>"` (or MCP `skills_brief`) ranks compatible
     skills within budget (`--plan` emits a fetch plan without bodies).
   - Tier 2: `simt skills show <name> --max-bytes 8192` (or MCP `skills_show`) loads only
     the chosen skill's body.

**Optimal retrieval strategy.** For best performance, use this sequence:
1. `simt brief "<task>"` — gets the most relevant files and tests in one call
2. If more files are needed, `simt map --task "<task>" --level outline` — broader ranking
3. If you need to understand a specific file's impact, `simt impact <file>` — blast radius
4. If you need to understand governance, `simt why <file>` — ADRs and rules

### 3. During implementation — validate incrementally under dual gates

1. **Keep the local index current.** After adding, renaming, or changing exports/imports,
   run `simt index`. It hashes tracked blobs via `git ls-files --stage` and re-extracts
   only changed files in under 300 ms.
2. **Run only the tests your change reaches.** Use `simt tests <path>` to inspect which
   tests cover a file (via import edges, naming conventions, or coverage records; add
   `--cochange` to include historical co-change pairs). Run `simt gate --changed` (or
   `simt gate <path...>`) to execute only the tests reachable from the diff, with gate
   output compacted so every failure line survives while passing noise is trimmed.
3. **Respect agent-time hooks and learn from failures.** With `simt agent-hooks install --yes`,
   `pre-tool-use` blocks unapproved `git push`, history rewrites (`--no-verify`,
   `--amend`, `reset --hard`, `rebase`), and direct edits to generated regions before the
   tool executes. When a test or gate fails, `post-tool-use` hashes the normalised first
   error line against `docs/lessons/*.md` and injects the matching lesson into context.

**Incremental validation workflow.** After each meaningful code change:
1. Run `simt tests <changed-file>` to see which tests cover your changes
2. Run `simt gate --changed` to execute only the affected tests
3. If a test fails, check `simt lessons list` for known issues and their remedies
4. If the failure is new, fix it and consider promoting the lesson with `simt lessons review <id> --yes`

### 4. Before committing and closing a slice — verify drift, evidence, and memory

1. **Run the repository gate.** Run `simt check` (or MCP `check`). Fix any reported
   `DRIFT` with `simt sync --yes`, and resolve any rule checker or manifest findings.
2. **Verify execution evidence matches the current tree.** Run `simt evidence` to confirm
   that the tests and gates you plan to cite were recorded against the current
   `git write-tree` digest in `.simt-dev/ledger.jsonl`. Any file edit invalidates earlier
   evidence.
3. **Record decisions, lessons, and tracker state:**
   - If the change alters what the repository or tool believes, scaffold an ADR with
     `simt decide "<title>" [--supersedes ADR-NNN[:<ruling>]] --yes`.
   - If a failing gate or test was fixed during the session, inspect captured candidates
     with `simt lessons list` and promote reusable ones with
     `simt lessons review <id> --yes`.
   - After committing locally (never push without explicit approval per `ADR-001`), close
     the tracker slice with `simt plan done <id> <sha> --test "<cmd>" --yes`.

**Pre-commit checklist.** Before committing, run this sequence:
1. `simt check` — verify no drift and all rules pass
2. `simt evidence` — confirm test runs are recorded against current tree
3. `simt lessons list` — check for any unreviewed lesson candidates
4. `git commit` — commit locally (never push without explicit approval)
5. `simt plan done <id> <sha> --yes` — close the tracker slice if working from a plan

## Optimal setup for every project, repository, and workspace shape

| Shape | How to configure and run `simt` optimally |
| --- | --- |
| **Single-package repository** (Node, TypeScript, Python/`uv`, Go, Rust, JVM/Gradle/Maven, Android, Swift, .NET, Deno, Ruby, Dart, Elixir, Cloudflare Workers, React Web, React Native, ConnectIQ, Container) | Run `simt init --yes`, `simt hooks install --yes`, `simt agent-hooks install --yes`, and `simt index`. Stack profiles and runnable gates are selected from committed manifests and build files (`simt doctor` shows `stack`, `facts`, and `factEvidence`). Set `"mode": "kernel"` and `"budget": { "bytes": 12000 }` in `simt.json` to keep session-start tokens minimal while keeping convention/style rules reachable via `simt rules show <id>`. |
| **Custom stack or repo-specific house rules** | An ecosystem with no built-in profile is still adopted with `core` rules. Add repo-local profiles in `.simt-dev/profiles/<id>.md` with `simt-id`, `simt-title`, `simt-applies`, and `simt-priority` (`hard`, `command`, `convention`, `style`); local profiles project alongside or shadow central ones. Declare custom gates under `gates.commands` and placeholders under `substitutions` in `simt.json`. |
| **Single-language or polyglot monorepo** (`package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `Cargo.toml` `[workspace]`, `go.work`, `settings.gradle`, `settings.gradle.kts`) | `simt init --yes` and `simt sync --yes` discover every workspace member and write both the root `AGENTS.md` and nested `<package>/AGENTS.md` projections carrying only the profiles specific to each package. Set `gates.cwd` in `simt.json` for gates that execute inside a sub-package. Measure nested context load with `simt harness loaders --at <package-dir>`, and use `simt gate --changed` to run only tests for modified packages. |
| **Multi-repository workspace / estate** (sibling checkouts under a workspace directory or `SIMT_DEV_WORKSPACE`) | Run `simt compare` across the workspace root to inspect adoption, drift, pinned SHAs, hook routing, most-violated rules, noisy/slow gates (`NOISY-GATE`), zero-value rules, and proposed ADR drafts. Run `simt tokens --repos` and `simt shared plan`, then `simt shared install --yes` to move rules repeated across repos into user-level harness files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.). Vendor shared rule packs in `.simt-dev/packs/<name>/` pinned by digest in `simt.json`, and upgrade the entire estate atomically with `simt upgrade --yes`. |
| **Repositories with external code-graph MCP servers** | Declare external stdio MCP servers under `federation` in `simt.json` (`{ name, command, args, tool, argument, languages, timeoutMs }`). `simt brief "<task>"` and the MCP `federation_query` tool ask each server one bounded structural question and cite the server name in `FEDERATION`. |
| **Offline or local-model-assisted workflows** (Ollama, `llama-server`, LM Studio, MLX) | By default, `simt` uses zero models and opens zero sockets (`ADR-075`, `ADR-090`). To opt in, add `local: { chat: { url, model }, embed: { url, model } }` in `simt.json` pointing at `http://127.0.0.1:<port>/v1`. Verify with `simt local doctor`, and build/query SQLite vector embeddings with `simt index --embed` and `simt map --embed` (non-loopback URLs are refused without `--allow-remote`). |
| **Rule, skill, and benchmark maintainers** | Lint skills with `simt graph lint --spec agentskills`, compile and split > 5,000-token skills with `simt skills compile`, and score the resolver with `simt skills eval`. Mine git history tasks with `simt bench mine --yes`, run arms with `simt bench run --yes`, compare arms with `simt bench report --compare bare kernel`, run leave-one-out ablation with `simt bench ablate --yes`, run compliance probes with `simt bench probes --yes`, and lock winning `simt-variants` wordings with `simt bench variants --yes`. |

## Module and MCP reference

| Module | CLI commands | Read-only MCP tools | When an agent should use it |
| --- | --- | --- | --- |
| **Task Brief** | `simt brief "<task>" [--budget <n>] [--explain]` | `brief` | First call on every task to get task kind, commands, ranked files, tests, ADRs, skills, and lessons in <= 2 KB |
| **Code Graph & Retrieval** | `simt index [--embed]`, `simt map`, `simt impact`, `simt tests`, `simt gate` | `federation_query` | Before editing to rank files (`map`), trace blast radius (`impact`), or run only diff-affected tests (`gate --changed`) |
| **Governance & Provenance** | `simt why [path]`, `simt rules list`, `simt rules show <id>`, `simt rules why <id\|ADR-NNN>`, `simt decide` | `rules_list`, `rules_why` | Before touching governed files (`why`), when reading deferred kernel rules (`rules show`), or when checking/scaffolding ADRs (`rules why`, `decide`) |
| **Skills & Disclosure** | `simt skills index\|brief\|show\|why\|find\|install\|compile\|eval`, `simt graph lint` | `skills_index`, `skills_find`, `skills_brief`, `skills_show`, `skills_why` | When a task requires domain workflows or reference docs without blowing the session token budget |
| **Memory & Lessons** | `simt lessons list`, `simt lessons review <id> --yes` | — | After fixing a failing test/gate or hitting a hook denial, to inspect or promote reusable failure-to-fix lessons |
| **Plans & Trackers** | `simt plan status`, `simt plan next [<id>]`, `simt plan done <id> [<sha>] --yes` | `plan_next`, `plan_done` | When executing a phased implementation or review plan row by row |
| **Adoption & Projection** | `simt init`, `simt doctor`, `simt check [--frozen]`, `simt sync`, `simt upgrade`, `simt ci` | `doctor`, `check` | When adopting a repo, diagnosing stack/config health, or verifying zero drift before commit |
| **Dual Gates & Evidence** | `simt hooks install\|status\|run`, `simt agent-hooks install\|status`, `simt agent-hook`, `simt evidence [check]` | — | When installing git/agent hooks, running gates manually, or verifying test claims before committing |
| **Context & Harnesses** | `simt tokens [--repos] [--session]`, `simt harness detect\|loaders`, `simt shared plan\|install` | — | When auditing startup token cost across harnesses (`claude`, `codex`, `cursor`, `opencode`, `antigravity`, `copilot`, `deepseek`) or deduplicating workspace rules |
| **Workspace & Benchmarks** | `simt compare`, `simt bench mine\|run\|report\|ablate\|probes\|variants`, `simt local doctor` | `compare` | When auditing an entire multi-repo estate, measuring rule uplift/cost, or probing local model endpoints |

## Where the plan finishes

Slices `R01`–`R40` are complete and shipped in `0.5.0`. The remaining queued slices
(`R41`–`R55`) finish packaging and the small ergonomics:

- **Packaging and declarative harness data (`R41`–`R45`).** MCP 2026-07-28 revision
  tightening, declarative harness adapter files with provenance, single-command plugin
  packaging, a single-file binary alongside npm/PyPI/Homebrew, and benchmark-measured rule
  packs.
- **The small doors (`R46`–`R55`).** `simt explain <CODE>` for every finding code, safe
  idempotent `simt doctor --fix`, a `< 50 ms` `simt status --line`, a write journal with
  `simt undo`, `--diff` on every writer, shell completions, one cross-harness ignore list
  plus a staged-diff secret scan, `simt slice start/finish <ID>` worktrees, file leases
  for parallel agents, and `simt pr-body` assembled from the evidence ledger.

The local-model slices (`R38`–`R40`) shipped as they lab-written: `simt distill` proposes
budgeted summaries with line citations, `simt review` proposes an advisory ADR-008
verdict over the staged diff, and `simt brief` carries model/effort advice from bench
history. All remain off until named and propose rather than write projected text.

## Install

Requires **Node >= 22.20.0**. The current published release is **0.5.0**. Pin it.
The tool writes a content digest into the files it generates, and an unpinned upgrade
changes them under you.

```sh
npm i -D simt-dev@0.5.0

# or globally
npm i -g simt-dev@0.5.0

# or once, with no install
npx -y simt-dev@0.5.0 check
```

### From PyPI

The wheel carries the same bytes as the npm tarball. It does not fetch them from npm
at install time.

```sh
pip install simt-dev

# when this machine has no node
pip install "simt-dev[node]"
```

`simt` is the command on both channels. Node is resolved in this order, and the first
one that answers wins: `SIMT_DEV_NODE`, the node bundled with the `node` extra, then
`node` on `PATH`.

### From Homebrew

```sh
brew install QuazarMedia/homebrew-tap/simt-dev
```

The formula depends on `node`, so the command works on a machine that has never had
Node installed.

## What it writes

| Path | What |
| --- | --- |
| `AGENTS.md` (and `<package>/AGENTS.md` in monorepos) | the projection, between `<!-- simt:begin -->` and `<!-- simt:end -->`. The old `simt-dev:` markers are still read, and a region migrates on its next write |
| `simt.json` | the manifest: `gates`, `substitutions`, `budget`, `mode`, `shared`, `surfaces`, `plans`, `packs`, `federation`, `local` |
| `simt-dev.lock.json` | the digest of the inputs, the digest of the projection, and locked `variants` winners from `simt bench variants` |
| `.cursor/rules/*.mdc`, `.claude/rules/*.md`, `.agents/rules/*.md`, `.github/instructions/*.instructions.md` | one file per rule, and only for a harness that reads that directory |
| `.editorconfig`, `.gitattributes` | baseline regions, placed first so a later setting still wins |
| `.simt-hooks/` and `core.hooksPath` | the shared dispatcher. It fails closed |
| `docs/decisions/ADR-NNN-<slug>.md` | numbered decision records scaffolded by `simt decide --yes` with `simt-affects` and `simt-supersedes` frontmatter |
| `docs/lessons/NNNN-<slug>.md` | reviewed lessons promoted by `simt lessons review <id> --yes` with `simt-trigger`, `simt-evidence`, and `simt-expires` frontmatter |

Text outside the markers is left alone. A regeneration does not revert it.

`simt.json` also carries a `federation` block when the repository names external
code-graph servers, each with the command that starts it, and an optional `local` block
when the repository names loopback OpenAI-compatible `chat` or `embed` endpoints. A brief
may then ask a federated server one structural question for a task and cite the answer's
source, and the MCP `federation_query` tool asks one on demand, naming the server it
asked. The question goes to the tool and argument the manifest declared, so no foreign
tool is reachable that the repository did not name. Nothing is started and no socket is
opened unless the manifest declared it, and a server that does not answer costs the
packet a sentence, never the packet.

These are caches, gitignored, and rebuildable. They are not repository content:

| Path | What |
| --- | --- |
| `.simt-dev/index.sqlite` | files, symbols, import/call/test/governs/cochange edges, FTS5 `fts` tokens across `code`, `docs`, `skills`, `decisions` and `lessons`, and optional `embeddings` vector blobs. JSON-lines at `.simt-dev/index.jsonl` when this Node cannot open `node:sqlite` with FTS5 |
| `.simt-dev/ledger.jsonl` | one line per gate or test the dispatcher actually ran, against one git tree, plus normalised failure signatures |
| `.simt-dev/lessons.jsonl` | deterministic lesson candidates captured from fail-to-fix pairs, reverts, `BLOCK` reviews, and hook denials |
| `.simt-dev/bench/` | mined tasks (`tasks/`), test patch vault (`vault/`), and benchmark runs (`runs/`) |
| `.simt-dev/proposals/` | non-authoritative skill description proposals with `{model, promptHash, digest}` provenance |

`simt shared install --yes` writes a user-level copy of the rules a workspace
repeats, into the file that harness documents, and records the ids on each
repository's manifest. The next `sync` drops those rules from the region and names
them.

## How a rule is chosen

Detection reads dependency manifests, build files and CI workflows, and ranks rules
by path, keyword, name, capability and stack. The ranking is a score. A pull request
can diff it.

A repository whose ecosystem has no profile yet is still adopted: it gets the core
rules and no gates, until gate templates exist for it. A hook that would run nothing
is not installed.

Every behaviour that is a choice has a numbered record. `simt rules why <id>` is the
path from a rule you did not expect to the reason it is there.

## Platform

**macOS and Linux.** The hooks are POSIX `sh`. There is no Windows build. `npm i` on
Windows fails with npm's `EBADPLATFORM`, which npm will not let a package explain, so
the answer is here: **use WSL2**, and the gate works inside it.

A Windows checkout without WSL2 can still read the projection. It is plain text. The
hooks and the CI gate need the POSIX host.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Report a vulnerability through
[SECURITY.md](SECURITY.md).
