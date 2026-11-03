# simt slice

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt slice abandon <id> --yes` | `--yes`, `--session`, `--test`, `--type` | remove a slice worktree, delete its branch, and return the row |
| `simt slice finish <id> --yes` | `--yes`, `--session`, `--test`, `--type` | run the gates, commit the slice and record its evidence |
| `simt slice start <id> --yes  \|  -- "<text>"` | `--yes`, `--id`, `--session`, `--test`, `--type` | give a slice its worktree, branch and brief; -- starts one from a prompt, no row |

Writes to the repository: `simt slice abandon`, `simt slice finish`, `simt slice start`. Each prints its plan and writes nothing without `--yes`.