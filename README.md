# simt-dev

![simt-dev, the intelligence amplifier for coding agents, and its four claims. One: say less, always — a kernel under 2 KB whose bytes stay stable so the prompt cache survives. Two: answers over exploration — a local code graph and a short task brief. Three: enforce, don't instruct — dual gates, before a tool call and at git time. Four: close the loop — benches and memory. Beneath them, the harnesses it works across and its three channels.](https://raw.githubusercontent.com/QuazarMedia/simt-dev/main/res/hero.jpg)

[![simt-dev own gate](https://github.com/QuazarMedia/simt-dev/actions/workflows/simt-dev-check.yml/badge.svg)](https://github.com/QuazarMedia/simt-dev/actions/workflows/simt-dev-check.yml)

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

## Install

Requires **Node >= 22.20.0** for the npm and PyPI channels; the release binary carries
its own runtime. Pin the release you install. The tool writes a
content digest into the files it generates, and an unpinned upgrade changes them under
you.

```sh
npm i -D simt-dev

# or globally
npm i -g simt-dev

# or once, with no install
npx -y simt-dev check
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

The formula downloads the single-file binary for this machine, which carries its own
runtime: the command works with no Node installed.

### As a single-file binary

Each release carries one executable per platform — macOS arm64 and x64, Linux x64 —
beside its `.sha256`. Pin the release you download,
and run this from the repository's top level:

```sh
version=<version>; os=$(uname -s | tr A-Z a-z); arch=$(uname -m | sed "s/x86_64/x64/")
base="https://github.com/QuazarMedia/simt-dev/releases/download/v$version"
asset="simt-dev-$version-$os-$arch"; tmp=$(mktemp -d)
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"
(cd "$tmp" && shasum -a 256 -c "$asset.sha256")
mkdir -p .simt/bin && mv "$tmp/$asset" .simt/bin/simt && chmod +x .simt/bin/simt
```

The locator checks `.simt/bin/simt` before `PATH`, so the repository's own copy is the
one its hooks and its CI run — this is the same command the hook shim prints as its
remedy. Both the snippet above and the generated CI workflow verify the asset against the
published `.sha256` before it runs: a digest that does not match stops the copy, so a
truncated or substituted download never becomes the command.

## What `simt` does

<!-- simt:commands:begin -->
<!-- Rendered from the spec by `simt docs readme --yes`; do not edit by hand. -->

```sh
# agent-hook
simt agent-hook <event> --harness                                      # the harness entry point: decide one tool call, or deliver the prompt packet

# agent-hooks
simt agent-hooks install --yes                                         # write this repository's policies into each harness hooks file
simt agent-hooks status                                                # what each harness will run, and what is not trusted yet

# agents
simt agents install --yes                                              # write the Simt-Agent into each harness agents file
simt agents status                                                     # what each harness carries, and what is not installed yet

# bench
simt bench ablate --yes                                                # measure one arm of the brief against its ablation
simt bench critic                                                      # score the review critic against the labelled bench set
simt bench export --yes                                                # write the sealed bench corpus as one signed document
simt bench import                                                      # verify a sealed corpus and load it into the vault
simt bench mine --yes                                                  # mine tasks out of a repository history
simt bench probes --yes                                                # run the deterministic probes against a workspace
simt bench report [--compare a b]                                      # summarise the runs recorded in the vault
simt bench run --yes                                                   # run agents against the mined tasks
simt bench variants --yes                                              # run one task across its variant prompts

# brief
simt brief "<task>"                                                    # the packet for a task: rules, skills and the files it names, within a budget

# check
simt check                                                             # report stale or missing generated regions and every check finding

# ci
simt ci                                                                # refresh simt-dev's own .github workflow and Dependabot files

# workspace
simt workspace compare                                                 # the adoption and drift matrix across every sibling repository
simt workspace install --yes                                           # carry those rules once per reader, at user level
simt workspace share                                                   # what repeated rules in a workspace cost to carry, and where they would go
simt workspace upgrade --yes                                           # replace this installation with the pinned release

# completions
simt completions <bash|zsh|fish>                                       # print a bash, zsh or fish completion script generated from this spec

# decide
simt decide lint                                                       # check every decision record for the structure a supersession needs
simt decide new "<title>" --yes                                        # scaffold a numbered decision record with its frontmatter

# distill
simt distill <skill|doc>                                               # turn a repository into a skill or rule proposal

# docs
simt docs readme                                                       # render the README command list from the spec

# doctor
simt doctor [--fix]                                                    # report what is wrong with this installation

# evidence
simt evidence                                                          # the runs recorded against the tree on disk
simt evidence check <msg-file>                                         # a commit message claiming a run this tree does not have

# explain
simt explain <CODE>                                                    # what one check finding code means, and how to fix it

# gate
simt gate --changed                                                    # the tests a change reaches, and only those

# graph
simt graph lint [--spec agentskills]                                   # check the skill registry against the skills on disk

# harness
simt harness detect [--user]                                           # which harness is installed, and what it carries
simt harness loaders [--table]                                         # the instruction files each harness loads, and what they cost

# hooks
simt hooks install --yes                                               # install the shared dispatcher; --agent writes each harness hooks file
simt hooks run <event>                                                 # run one git event's gates now, as git would
simt hooks status                                                      # what each git event routes to; --agent reports each harness instead

# ignore
simt ignore [--yes] [--diff]                                           # render the one ignore list into every harness ignore file

# impact
simt impact <file|symbol>                                              # who a change reaches: importers, their tests and the contract

# index
simt index [--embed]                                                   # rebuild the local file index from git blob hashes

# init
simt init [path]                                                       # adopt this repository: manifest, region, hooks, agents and agent-hooks

# lease
simt lease [<paths>] --session                                         # claim files for one session, or list the claims

# lessons
simt lessons capture                                                   # scan the ledger and history for new lesson candidates
simt lessons list                                                      # deterministic lesson candidates and the promoted lessons
simt lessons review <id> --yes                                         # promote one lesson candidate into docs/lessons

# local
simt local doctor [--allow-remote]                                     # the local model endpoints, and whether they answer

# map
simt map --task "<task>"                                               # the files a task is most likely to touch, within a byte budget

# mcp
simt mcp [--list]                                                      # serve the read-only MCP surface over stdio

# pack
simt pack lint [dir] [--require-measured]                              # lint a rule pack in the working directory
simt pack new <name> --source <spec>                                   # scaffold a rule pack
simt pack publish [dir] --yes                                          # publish a rule pack

# plan
simt plan done <id> [<sha>] --yes                                      # mark one tracker row complete, with its SHA and its evidence
simt plan labels                                                       # the header each tracker column matched, and the labels this repository configured
simt plan next [<id>] [--tier <name>] [--wave <name>] [--lane <name>]  # one ready slice's section, or the one named, inside a tier, a wave or a lane
simt plan status                                                       # count the tracker rows, the share of the plan done, and its tiers, waves and lanes

# plugin
simt plugin <claude|gemini|cursor|opencode>                            # generate a harness package from the same tables the hooks use

# pr-body
simt pr-body [--base <ref>]                                            # the pull request body: evidence, decisions, gate state and residual risk

# review
simt review [--local]                                                  # review the staged diff against the estate rules

# rules
simt rules decisions                                                   # every known decision, and which layer each came from
simt rules list [--root <path>]                                        # the rule catalogue, marked with what applies to this repository
simt rules show <id>                                                   # one rule body
simt rules why <id|ADR-NNN> [--all]                                    # the decision that settled a rule, and whether it is still in force

# skills
simt skills brief --task "<task>"                                      # the packet for a task, read from the skill registry
simt skills compile [<name>]                                           # compile a skill to the Agent Skills standard
simt skills eval [corpus]                                              # score the skill registry against transcripts
simt skills find <query>                                               # skills that match a query
simt skills index                                                      # rebuild the skill index
simt skills install <name> --yes                                       # install skills into the workspace
simt skills show <name>                                                # one skill packet
simt skills why <name>                                                 # which skill covers a task

# slice
simt slice abandon <id>                                                # remove a slice worktree, delete its branch, and return the row
simt slice finish <id> --yes                                           # run the gates, commit the slice and record its evidence
simt slice start <id> --yes  |  -- "<text>"                            # give a slice its worktree, branch and brief; -- starts one from a prompt, no row

# status
simt status [--line]                                                   # the repository snapshot, or one line of the last check

# sync
simt sync --yes                                                        # re-render the generated regions from the rule content

# tests
simt tests <path> [--cochange]  |  --run [--changed]                   # the tests that exercise a file, or - with --run - the ones a change reaches

# tokens
simt tokens [--repos] [--session]                                      # count tokens per instruction file and per skill

# undo
simt undo --yes                                                        # restore the last journaled set of writes, if untouched

# why
simt why [<subject>]                                                   # what governs a path, rule, decision, skill or finding code
```
<!-- simt:commands:end -->

`init`, `sync`, `upgrade`, `hooks install`, `agent-hooks install`, `shared install`,
`skills install`, `plan done`, `lessons review`, `decide`, `ignore`, `pack new`,
`pack publish`, `slice start`, `slice finish`, `lease` and the `bench` writers print
a plan and write nothing without `--yes`. None of them push, and only
`slice finish` commits — locally, through the pre-commit gates, and only what is
staged. `simt index`
writes its cache without asking: the file is gitignored and `git ls-files` can rebuild it.

Declare `secret-scan` in `gates.preCommit` to block a commit whose staged diff
carries a probable secret: the scan runs inside the binary (vendor patterns plus
Shannon entropy, over added lines only), needs no install, and its report never
prints the matched bytes.

`check` runs the checkers a rule names (`max-file-lines`, `forbid-regex`,
`forbidden-path-edit`, `required-file`), verifies structured ADR supersessions
(`prose-partial-supersession`), and flags expired lessons (`LESSON-EXPIRED`). A marked
rule line leaves the projection as `Enforced:` and the checker's name. The file-length
line warns past 400 lines and fails past 1000. `simt evidence check` warns when a commit
message claims a passing run this tree does not have, and the commit fails when
`gates.evidence` is `block`. Every finding `check` can emit is explained by `simt explain <CODE>` (DRIFT, UNMANAGED, PACK-DIGEST-MISMATCH, ...).

## Agent playbook

The full agent playbook — the decision tree for which command to run when, and the
workflow for orienting, editing, implementing and closing a slice — lives in
[PLAYBOOK.md](PLAYBOOK.md).

## Optimal setup for every project, repository, and workspace shape

| Shape | How to configure and run `simt` optimally |
| --- | --- |
| **Single-package repository** (Node, TypeScript, Python/`uv`, Go, Rust, JVM/Gradle/Maven, Android, Swift, .NET, Deno, Ruby, Dart, Elixir, Cloudflare Workers, React Web, React Native, ConnectIQ, Container) | Run `simt init --yes`, `simt hooks install --yes`, `simt agent-hooks install --yes`, and `simt index`. Stack profiles and runnable gates are selected from committed manifests and build files (`simt doctor` shows `stack`, `facts`, and `factEvidence`). Set `"mode": "kernel"` and `"budget": { "bytes": 12000 }` in `simt.json` to keep session-start tokens minimal while keeping convention/style rules reachable via `simt rules show <id>`. |
| **Custom stack or repo-specific house rules** | An ecosystem with no built-in profile is still adopted with `core` rules. Add repo-local profiles in `.simt/profiles/<id>.md` with `simt-id`, `simt-title`, `simt-applies`, and `simt-priority` (`hard`, `command`, `convention`, `style`); local profiles project alongside or shadow central ones. Declare custom gates under `gates.commands` and placeholders under `substitutions` in `simt.json`. |
| **Single-language or polyglot monorepo** (`package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `Cargo.toml` `[workspace]`, `go.work`, `settings.gradle`, `settings.gradle.kts`) | `simt init --yes` and `simt sync --yes` discover every workspace member and write both the root `AGENTS.md` and nested `<package>/AGENTS.md` projections carrying only the profiles specific to each package. Set `gates.cwd` in `simt.json` for gates that execute inside a sub-package. Measure nested context load with `simt harness loaders --at <package-dir>`, and use `simt gate --changed` to run only tests for modified packages. |
| **Multi-repository workspace / estate** (sibling checkouts under a workspace directory or `SIMT_DEV_WORKSPACE`) | Run `simt compare` across the workspace root to inspect adoption, drift, pinned SHAs, hook routing, most-violated rules, noisy/slow gates (`NOISY-GATE`), zero-value rules, and proposed ADR drafts. Run `simt tokens --repos` and `simt shared plan`, then `simt shared install --yes` to move rules repeated across repos into user-level harness files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.). Vendor shared rule packs in `.simt/packs/<name>/` pinned by digest in `simt.json`, and upgrade the entire estate atomically with `simt upgrade --yes`. |
| **Repositories with external code-graph MCP servers** | Declare external stdio MCP servers under `federation` in `simt.json` (`{ name, command, args, tool, argument, languages, timeoutMs }`). `simt brief "<task>"` and the MCP `federation_query` tool ask each server one bounded structural question and cite the server name in `FEDERATION`. |
| **Offline or local-model-assisted workflows** (Ollama, `llama-server`, LM Studio, MLX) | By default, `simt` uses zero models and opens zero sockets (`ADR-075`, `ADR-090`). To opt in, add `local: { chat: { url, model }, embed: { url, model } }` in `simt.json` pointing at `http://127.0.0.1:<port>/v1`. Each role accepts an optional `apiKey` (sent as `Authorization: Bearer <key>`) for servers that require a token. Verify with `simt local doctor`, and build/query SQLite vector embeddings with `simt index --embed` and `simt map --embed` (non-loopback URLs are refused without `--allow-remote`). |
| **Rule, skill, and benchmark maintainers** | Lint skills with `simt graph lint --spec agentskills`, compile and split > 5,000-token skills with `simt skills compile`, and score the resolver with `simt skills eval`. Mine git history tasks with `simt bench mine --yes`, run arms with `simt bench run --yes`, compare arms with `simt bench report --compare bare kernel`, run leave-one-out ablation with `simt bench ablate --yes`, run compliance probes with `simt bench probes --yes`, and lock winning `simt-variants` wordings with `simt bench variants --yes`. |

## Module and MCP reference

| Module | CLI commands | Read-only MCP tools | When an agent should use it |
| --- | --- | --- | --- |
| **Task Brief** | `simt brief "<task>" [--budget <n>] [--explain]` | `brief` | First call on every task to get task kind, commands, ranked files, tests, ADRs, skills, and lessons in <= 2 KB |
| **Code Graph & Retrieval** | `simt index [--embed]`, `simt map`, `simt impact`, `simt tests`, `simt gate` | `federation_query` | Before editing to rank files (`map`), trace blast radius (`impact`), or run only diff-affected tests (`gate --changed`) |
| **Governance & Provenance** | `simt why [path]`, `simt rules list`, `simt rules show <id>`, `simt rules why <id\|ADR-NNN>`, `simt decide` | `rules_list`, `rules_why` | Before touching governed files (`why`), when reading deferred kernel rules (`rules show`), or when checking/scaffolding ADRs (`rules why`, `decide`) |
| **Skills & Disclosure** | `simt skills index\|brief\|show\|why\|find\|install\|compile\|eval`, `simt graph lint` | `skills_index`, `skills_find`, `skills_brief`, `skills_show`, `skills_why` | When a task requires domain workflows or reference docs without blowing the session token budget |
| **Memory & Lessons** | `simt lessons list`, `simt lessons review <id> --yes` | — | After fixing a failing test/gate or hitting a hook denial, to inspect or promote reusable failure-to-fix lessons |
| **Plans & Trackers** | `simt plan status`, `simt plan next [<id>]`, `simt plan done <id> [<sha>] --yes`, `simt slice start\|finish <id>`, `simt lease`, `simt pr-body`, `simt status --line`, `simt undo` | `plan_next`, `plan_done`, `pr_body` | When executing a phased implementation or review plan row by row |
| **Adoption & Projection** | `simt init`, `simt doctor`, `simt check [--frozen]`, `simt sync`, `simt upgrade`, `simt ci` | `doctor`, `check` | When adopting a repo, diagnosing stack/config health, or verifying zero drift before commit |
| **Dual Gates & Evidence** | `simt hooks install\|status [--agent]\|run`, `simt agent-hooks install\|status`, `simt agent-hook`, `simt evidence [check]` | — | When installing git/agent hooks, running gates manually, or verifying test claims before committing |
| **Context & Harnesses** | `simt tokens [--repos] [--session]`, `simt harness detect\|loaders`, `simt shared plan\|install` | — | When auditing startup token cost across harnesses (`claude`, `codex`, `cursor`, `opencode`, `antigravity`, `copilot`, `deepseek`) or deduplicating workspace rules |
| **Workspace & Benchmarks** | `simt compare`, `simt bench mine\|run\|report\|ablate\|probes\|variants`, `simt local doctor`, `simt review [--local]`, `simt distill` | `compare` | When auditing an entire multi-repo estate, measuring rule uplift/cost, or probing local model endpoints |

## Where the plan finishes

Slices `R01`–`R55` are all complete. The small ergonomics (`R46`–`R55`) shipped
on top of `0.6.0`:

- **The small doors (`R46`–`R55`).** `simt explain <CODE>` for every finding code, safe
  idempotent `simt doctor --fix`, a `< 50 ms` `simt status --line`, a write journal with
  `simt undo`, `--diff` on every writer, shell completions, one cross-harness ignore list
  plus a staged-diff secret scan, `simt slice start/finish <ID>` worktrees, file leases
  for parallel agents, and `simt pr-body` assembled from the evidence ledger.

The last two rows of review `0002` (`S38` workspace token cost, `S39` estate policy
as a pack) are closed by ruling: the instrument, the declaration and the
non-blocking finding shipped, the blocking gate and the registry-carrying pack were
refused by ruling, and the estate-side move is recorded as whose commit it waits on.
Everything in plans `0001`–`0003` and reviews `0001`–`0002` is Complete or Accepted.

The local-model slices (`R38`–`R40`) shipped as they lab-written: `simt distill` proposes
budgeted summaries with line citations, `simt review` proposes an advisory ADR-008
verdict over the staged diff, and `simt brief` carries model/effort advice from bench
history. All remain off until named and propose rather than write projected text.

## What it writes

| Path | What |
| --- | --- |
| `AGENTS.md` (and `<package>/AGENTS.md` in monorepos) | the projection, between `<!-- simt:begin -->` and `<!-- simt:end -->`. The old `simt-dev:` markers are still read, and a region migrates on its next write |
| `simt.json` | the manifest: `gates`, `substitutions`, `budget`, `mode`, `shared`, `surfaces`, `plans`, `packs`, `federation`, `local` |
| `simt.lock.json` | the digest of the inputs, the digest of the projection, and locked `variants` winners from `simt bench variants`. The old `simt-dev.lock.json` is still read, and a lock migrates on its next write |
| `.cursor/rules/*.mdc`, `.claude/rules/*.md`, `.agents/rules/*.md`, `.github/instructions/*.instructions.md` | one file per rule, and only for a harness that reads that directory |
| `.editorconfig`, `.gitattributes` | baseline regions, placed first so a later setting still wins |
| `.simt/hooks/` and `core.hooksPath` | the shared dispatcher. It fails closed |
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
| `.simt/index.sqlite` | files, symbols, import/call/test/governs/cochange edges, FTS5 `fts` tokens across `code`, `docs`, `skills`, `decisions` and `lessons`, and optional `embeddings` vector blobs. JSON-lines at `.simt/index.jsonl` when this Node cannot open `node:sqlite` with FTS5 |
| `.simt/ledger.jsonl` | one line per gate or test the dispatcher actually ran, against one git tree, plus normalised failure signatures |
| `.simt/lessons.jsonl` | deterministic lesson candidates captured from fail-to-fix pairs, reverts, `BLOCK` reviews, and hook denials |
| `.simt/bench/` | mined tasks (`tasks/`), test patch vault (`vault/`), and benchmark runs (`runs/`) |
| `.simt/proposals/` | non-authoritative skill description proposals with `{model, promptHash, digest}` provenance |

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
