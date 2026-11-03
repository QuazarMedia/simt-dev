# simt agent-hooks

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt agent-hooks explain --harness <id> [--payload <file>] [--mediated]` | `--harness`, `--mediated`, `--payload` | what one harness payload is in the policy table terms, and how the boundary would judge it |
| `simt agent-hooks install --yes` | `--yes`, `--diff`, `--harness`, `--dry-run` | write this repository's policies into each harness hooks file |
| `simt agent-hooks status` | `--diff`, `--harness` | what each harness will run, and what is not trusted yet |

Writes to the repository: `simt agent-hooks install`. Each prints its plan and writes nothing without `--yes`.