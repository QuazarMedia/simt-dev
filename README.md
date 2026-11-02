# simt-dev

![simt-dev, the intelligence amplifier for coding agents, and its four claims. One: say less, always — a kernel under 2 KB whose bytes stay stable so the prompt cache survives. Two: answers over exploration — a local code graph and a short task brief. Three: enforce, don't instruct — dual gates, before a tool call and at git time. Four: close the loop — benches and memory. Beneath them, the harnesses it works across and its three channels.](https://raw.githubusercontent.com/QuazarMedia/simt-dev/main/res/hero.jpg)

[![simt-dev own gate](https://github.com/QuazarMedia/simt-dev/actions/workflows/simt-dev-check.yml/badge.svg)](https://github.com/QuazarMedia/simt-dev/actions/workflows/simt-dev-check.yml)

`simt` adopts a repository for the agents that work in it, and builds an intelligence
amplifier around them: a brief that answers before the agent explores, gates that
validate before a tool call, benches that price every rule text, and memory that puts a
recorded failure to work on the next one.

It reads what the repository actually runs, projects the rules that are not already
obvious into the files those agents read, and installs only the gates that repository
can run. Around that projection it keeps the bytes stable, replaces an instruction with a
check where a check can decide, answers questions about the tree from a local index, and
records whether a run still applies to the tree on disk.

The aim is a higher share of tasks resolved, at a lower cost per resolved task. Those
targets are hypotheses: a change that touches what an agent reads ships with a
measurement, or its record says the measurement was not run.

The default path is deterministic: no model, no network, no runtime dependencies.
Anything that needs a parser grammar, a local model, or another server is a separate
package, off until the repository names it, and it proposes rows or text for a person to
merge. It does not write the projection.

## Install

Requires **Node >= 22.20.0** for the npm and PyPI channels; the release binary carries its
own runtime. Pin the release you install: the tool writes a content digest into the files
it generates, and an unpinned upgrade changes them under you.

```sh
npm i -D simt-dev        # or: npm i -g simt-dev
npx -y simt-dev check    # or once, with no install
brew install QuazarMedia/homebrew-tap/simt-dev
```

From PyPI (`pip install simt-dev`, plus the `[node]` extra for a machine with no Node), from
Homebrew, or as one checksum-verified binary per platform: see
[docs/getting-started.md](docs/getting-started.md).

## Start here

```sh
simt init --yes          # adopt: manifest, region, hooks, agent files
simt index               # build the local code graph
simt brief "fix the failing login test"
simt gate --changed      # the tests this change reaches, and only those
simt check               # stale or missing regions, and every check finding
```

Then, as the work needs them:

```sh
simt hooks install --yes        # the git-time gate
simt agent-hooks install --yes  # the before-a-tool-call gate
simt plan next                  # the next ready tracker row
simt map --task "<task>"        # the files a task is most likely to touch
simt why <path>                 # what governs a path
simt sync --yes                 # re-render the regions after a rule change
```

## Where to read next

| Page | What it answers |
| --- | --- |
| [docs/commands/README.md](docs/commands/README.md) | every command, generated from the spec — no hand-written list |
| [docs/getting-started.md](docs/getting-started.md) | install channels, the node locator, the checksum check, the first run |
| [docs/guides/agent-playbook.md](docs/guides/agent-playbook.md) | which command to run when, and how to orient, edit and close a slice |
| [docs/guides/workspace-shapes.md](docs/guides/workspace-shapes.md) | the optimal setup for each repository and workspace shape |
| [docs/reference/modules.md](docs/reference/modules.md) | the module, CLI and MCP surface, and when an agent should use it |
| [docs/reference/files-written.md](docs/reference/files-written.md) | every path it writes, every cache it keeps, and which are not content |
| [docs/reference/exit-codes.md](docs/reference/exit-codes.md) | the exit code each command returns, and why a report is not a failure |
| [docs/architecture/overview.md](docs/architecture/overview.md) | the module map, and the three rules that keep it that shape |
| [docs/architecture/pipeline.md](docs/architecture/pipeline.md) | detection, selection, projection and the gates |
| [docs/decisions-index.md](docs/decisions-index.md) | every ruling, numbered, with the layer it came from |
| [CONTRIBUTING.md](CONTRIBUTING.md) | hooks, the isolated test run, and the release checklist |

Writes print a plan and write nothing without `--yes`; only `slice finish` commits, and
it commits locally. `simt index` writes its cache without asking, because the file is
gitignored and `git ls-files` rebuilds it.

Declare `secret-scan` in `gates.preCommit` to block a commit whose staged diff carries a
probable secret: the scan runs inside the binary, needs no install, and its report never
prints the matched bytes. `check` runs the checkers a rule names, verifies structured ADR
supersessions, and flags expired lessons; `simt explain <CODE>` explains every finding it
can emit.

## Platform

**macOS and Linux.** The hooks are POSIX `sh`. There is no Windows build. `npm i` on
Windows fails with npm's `EBADPLATFORM`, which npm will not let a package explain, so the
answer is here: **use WSL2**, and the gate works inside it. A Windows checkout without
WSL2 can still read the projection — it is plain text — but the hooks and the CI gate need
the POSIX host.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Report a vulnerability through
[SECURITY.md](SECURITY.md).
