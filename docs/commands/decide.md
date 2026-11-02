# simt decide

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt decide lint` | `--check`, `--diff` | check every decision record for the structure a supersession needs |
| `simt decide new "<title>" --yes` | `--yes`, `--check`, `--diff`, `--dry-run`, `--paths`, `--supersedes`, `--task` | scaffold a numbered decision record with its frontmatter |

Writes to the repository: `simt decide new`. Each prints its plan and writes nothing without `--yes`.