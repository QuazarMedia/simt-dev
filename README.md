# simt-dev

Shared agent rules, skills and git hooks for a repository.

One command adopts a repository: it reads what the repo actually runs, projects the
matching rules into the files your agent already reads, and installs a pre-commit hook
that refuses a commit which breaks a gate that repo can genuinely run.

- **Nothing is declared that cannot run.** Every gate is probed against the working tree
  before it is written. A gate whose tool is absent is dropped, with a remedy naming the
  package to install — never silently present, never silently absent.
- **Nothing an agent reads is written twice.** Each rule goes to exactly one place, chosen
  by what the harness actually reads.
- **The rules are a projection, not a copy.** They carry markers, so `check` can tell
  drift from a deliberate edit, and `sync` can regenerate.
- **The tool explains itself.** `rules why` answers "why did I get told this?" from a
  numbered record of the decisions behind the rules, with the rejected alternatives
  attached.

## Install

Requires **Node >= 22.20.0**.

```sh
# pinned, per repository - what CI and a teammate both get
npm i -D simt-dev@0.1.0

# or globally, if you would rather not add a dependency
npm i -g simt-dev@0.1.0

# or with no install at all, for a one-off
npx -y simt-dev@0.1.0 check
```

Pin the version. The tool writes a content digest into the files it generates, and an
unpinned upgrade changes them under you.

## Use

```sh
simt init            # adopt or scaffold this repository (dry-run; --yes to write)
simt doctor          # what this repo is, and whether its config is healthy
simt check           # the gate: projection drift, manifest validity, policy
simt sync --yes      # regenerate the projection
simt upgrade --yes   # move every consumer of this tool to this version
simt rules why ADR-042   # why a rule says what it says, and what was rejected
simt compare         # what changed across every repository that adopted it
```

`init` and `sync` print a plan and write nothing without `--yes`. Neither commits or pushes.

## What it writes

| Path | What |
| --- | --- |
| `AGENTS.md` | the projection, between `<!-- simt:begin -->` and `<!-- simt:end -->` (renamed from `simt-dev:`; the old markers are still read, and a region migrates on its next write) |
| `simt.json` | your manifest: which gates to declare, which substitutions to fill (renamed from `simt-dev.json`; the old name is still read, and moves on the next write) |
| `.cursor/rules/*.mdc`, `.claude/rules/*.md`, `.agents/rules/*.md`, `.github/instructions/*.instructions.md` | one file per rule, written only for the harnesses that read their own directory |
| `.editorconfig`, `.gitattributes` | baseline regions |
| `.simt-hooks/` and `core.hooksPath` | the shared dispatcher, fail-closed |

Anything outside the markers is yours. simt-dev never edits it and never reverts it.

## Platform

**macOS and Linux.** The hooks are POSIX `sh`; there is no Windows build and no plan for
one. `npm i` on Windows fails with npm's `EBADPLATFORM`, which npm will not let a package
explain — so the answer is here: **use WSL2**, and the gate works normally inside it.

A Windows checkout without WSL2 can still read every rule this tool generates, because the
projection is plain text in `AGENTS.md` and the per-harness rule files. Only the hooks and
the CI gate need the POSIX host.

## How the rules are chosen

Detection reads what the repository runs — its dependency manifests, its build files, its
CI workflows — and resolves that against a registry of capabilities. Resolution is a
scored ranking over path, keyword, name, capability and stack: no model, no network, no
guessing, so a pull request can meaningfully diff the answer.

**Not every ecosystem has a profile yet.** A Go, Rust, .NET, Ruby, Swift, Dart or Elixir
repository is detected and gets facts, but it is adopted with the core rules and no gates
until its gate templates are written. A repository with no gates is a repository with an
agent and no pre-commit hook — better than one with a hook that runs nothing, but not full
support, and this README will not pretend otherwise.

Every behaviour that is a choice rather than a detail has a numbered record, and the
records are readable with `simt rules why <id>`. If the tool ever does something you
did not expect, that command is the shortest path from the symptom to the reason.

## Licence

Apache-2.0. See [LICENSE](LICENSE).