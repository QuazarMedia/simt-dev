---
name: simt-commands
description: Command reference for simt-dev: which commands are mutating vs read-only, and a scenario-to-command mapping for the agent.
---

## Dry run

Most simt-dev commands that write to the repository default to **dry-run**:
they print what they would change and exit without writing. Add `--yes` to
apply. Read the dry-run output first — it is the plan — then re-run with
`--yes`. A dry-run that shows an unexpected file is a reason to stop, not to
add `--yes` and hope.

### Mutating commands (need `--yes` to write)

`init`, `sync`, `plan done`, `slice start`, `slice finish`, `slice abandon`,
`agents install`, `agent-hooks install`, `hooks install`, `doctor --fix`,
`ignore`, `ci`, `shared install`, `lessons review`, `decide`, `undo`,
`skills install`, `bench mine|run|ablate|probes|variants`, `pack new|publish`,
`lease`

### Read-only commands (no flag needed)

`brief`, `why`, `tests`, `gate`, `impact`, `map`, `check`, `status`,
`plan status|next`, `rules *`, `agents status`, `agent-hooks status`,
`hooks status`, `evidence`, `pr-body`, `explain`, `graph lint`,
`skills index|brief|show|why|find`, `index`, `review`, `tokens`,
`harness *`, `compare`, `distill`, `bench report|critic`, `pack lint`,
`mcp`, `completions`, `lessons list|capture`

## Command reference

Pick the command by what you need, not by what you remember:

| You need to… | Command | Notes |
|---|---|---|
| Understand a task before exploring | `simt brief "<task>"` | Kind, commands, files, tests, decisions |
| Know what governs a file | `simt why <file>` | Decisions, rules, skills, gates, lessons |
| Find tests for a file | `simt tests [path]` | Import, conventional, or coverage |
| Find tests a change reaches | `simt gate [path...]` | `--changed` reads the diff |
| See who a change affects | `simt impact <file\|symbol>` | Importers, tests, contracts |
| Find files a task touches | `simt map --task "<text>"` | `--level outline\|names\|signatures` |
| Read tracker state | `simt plan status` | Counts per tracker file |
| Get the next slice | `simt plan next [<id>]` | Smallest ready slice, ~1 KB |
| Mark a slice done | `simt plan done <id> <sha> --test "<cmd>" --yes` | Dry-run without `--yes` |
| Start a slice in a worktree | `simt slice start <id> --yes` | Branch `slice/<id>`, brief beside it |
| Finish a slice | `simt slice finish <id> --yes` | Gates, commit, record SHA |
| Abandon a slice | `simt slice abandon <id> --yes` | Removes worktree, returns row |
| Check the gate | `simt check` | Projection drift, manifest, policy |
| Regenerate projection | `simt sync --yes` | Idempotent; `--check` for drift only |
| Explain a finding | `simt explain <CODE>` | Decision, fix, trigger |
| Read a rule | `simt rules show <id>` | One rule body |
| Read a decision | `simt rules why <ADR-NNN>` | `--all` for every ruling |
| Scaffold an ADR | `simt decide [<title>] --yes` | Next number, skeleton, frontmatter |
| Adopt a repo | `simt init [path] --yes` | `--backup` tags the pre-adoption commit |
| Install the agent | `simt agents install --yes` | `--harness <id>` for one |
| Check agent status | `simt agents status` | Present, absent, drift, no-file |
| Install hooks | `simt hooks install --yes` | Shared dispatcher |
| Run a hook event | `simt hooks run <event>` | As git would |
| Install agent hooks | `simt agent-hooks install --yes` | Per-harness policies |
| Diagnose config | `simt doctor [--fix]` | `--fix` applies safe remedies |
| Pin a skill | `simt skills install <name> --yes` | `--variant` for multi-variant |
| Search skills | `simt skills find <query>` | Capability and keyword |
| Rebuild the index | `simt index` | From git blob hashes |
| Get PR body | `simt pr-body [--base <ref>]` | Evidence, decisions, gate state |
| Check evidence | `simt evidence` | Runs recorded against the tree |
| Review the staged diff | `simt review` | ADR-008 verdict skeleton |
| Undo last writes | `simt undo --yes` | Only if every file is untouched |
| Claim files for a session | `simt lease [<paths>...] --yes` | TTL; pre-edit hook refuses |
| Measure token cost | `simt tokens` | Bytes a reader loads at session start |
