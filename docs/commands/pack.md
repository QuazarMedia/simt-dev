# simt pack

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt pack lint [dir] [--require-measured]` | `--diff`, `--require-measured`, `--source` | lint a rule pack in the working directory |
| `simt pack new <name> --source <spec>` | `--diff`, `--require-measured`, `--source`, `--yes`, `--dry-run` | scaffold a rule pack |
| `simt pack publish [dir] --yes` | `--diff`, `--require-measured`, `--source`, `--yes` | publish a rule pack |

Writes to the repository: `simt pack new`. Each prints its plan and writes nothing without `--yes`.