# simt-dev

`simt` adopts a repository for the agents that work in it.

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
simt init                 # adopt or scaffold; prints a plan; --yes writes
simt doctor               # what this repo is, and whether its config is healthy
simt check                # projection drift, the manifest, and declared checkers
simt sync --yes           # regenerate the projection
simt upgrade --yes        # move every pin of this tool to this version

simt rules why ADR-042    # the decision behind a rule, and what was rejected
simt skills brief --task  # a short brief for one task
simt tokens               # bytes a reader loads at session start
simt shared plan          # rules a workspace repeats, and what carrying them once saves
simt harness loaders      # what each harness loads, and what its cap drops

simt hooks install --yes  # the git dispatcher, for gates this repo can run
simt agent-hooks install --yes   # the same policy before a tool call
simt evidence             # runs recorded against this tree
simt index                # files, exports and imports, from git blob hashes
simt plan next            # the next tracker row that is ready

simt bench report         # resolved rate, quality, cost, across arms
simt compare              # every sibling checkout that has adopted
simt mcp                  # the read-only surface, over stdio
```

`init`, `sync`, `upgrade`, `hooks install`, `agent-hooks install`, `shared install`
and `plan done` print a plan and write nothing without `--yes`. None of them commit
or push. `simt index` writes its cache without asking: the file is gitignored and
`git ls-files` can rebuild it.

`check` runs the checkers a rule names. A marked line leaves the projection as
`Enforced:` and the checker's name. The file-length line warns past 400 lines and
fails past 1000. `simt evidence check` warns when a commit message claims a passing
run this tree does not have, and the commit fails when `gates.evidence` is `block`.
The commit-msg hook is installed only when that setting is `warn` or `block`.

## Where the plan finishes

The work above is the part that runs. The plan still adds the rest of the loop, in
this order of purpose:

- **Gates on the change.** A check selects the tests that cover the diff, and the
  tool's own gate output is shortened without dropping a failure line.
- **Answers instead of exploration.** A ranked map of the repository, the impact of
  a file or a symbol, the tests that cover a change, and the decisions, rules and
  skills that govern a path. An external code graph can answer for a language it
  covers, and the answer names that source.
- **A brief for the task in front of the agent.** At most 2 KB, pulled at submit or
  pushed by a hook, built from the map, the tests and the governing records.
- **A memory that has to earn its place.** A lesson is a candidate when a failing run
  is followed by a fix. It is recalled on a later task that looks like it, and it
  expires. Variant wording of a rule ships only when the bench says it won.
- **Local models, off unless asked.** Distillation and a critic propose. They do not
  write projected text. With no model configured, nothing opens a socket.
- **The small doors.** One finding code explained, a safe `doctor` fix, a one-line
  status, an undo journal, a diff of every planned write, shell completions, one
  ignore list for every harness plus a secret scan, a worktree per slice, a file
  lease when two agents would edit the same path, and a pull-request body taken from
  the evidence.

## Install

Requires **Node >= 22.20.0**. The current published release is **0.3.0**. Pin it.
The tool writes a content digest into the files it generates, and an unpinned upgrade
changes them under you. This checkout is ahead of that release; the changelog's
Unreleased section is the difference.

```sh
npm i -D simt-dev@0.3.0

# or globally
npm i -g simt-dev@0.3.0

# or once, with no install
npx -y simt-dev@0.3.0 check
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
| `AGENTS.md` | the projection, between `<!-- simt:begin -->` and `<!-- simt:end -->`. The old `simt-dev:` markers are still read, and a region migrates on its next write |
| `simt.json` | the manifest: gates, substitutions, budget, shared rules, surfaces |
| `simt-dev.lock.json` | the digest of the inputs and the digest of the projection |
| `.cursor/rules/*.mdc`, `.claude/rules/*.md`, `.agents/rules/*.md`, `.github/instructions/*.instructions.md` | one file per rule, and only for a harness that reads that directory |
| `.editorconfig`, `.gitattributes` | baseline regions, placed first so a later setting still wins |
| `.simt-hooks/` and `core.hooksPath` | the shared dispatcher. It fails closed |

Text outside the markers is left alone. A regeneration does not revert it.

These are caches, gitignored, and rebuildable. They are not repository content:

| Path | What |
| --- | --- |
| `.simt-dev/index.sqlite` | files, symbols, import edges. JSON-lines at `.simt-dev/index.jsonl` when this Node cannot open `node:sqlite` with FTS5 |
| `.simt-dev/ledger.jsonl` | one line per gate the dispatcher actually ran, against one git tree |
| `.simt-dev/bench/runs/` | benchmark runs |

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
