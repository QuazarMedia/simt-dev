# simt agent-hooks

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt agent-hooks install --yes` | `--yes`, `--diff`, `--harness` | write this repository's policies into each harness hooks file |
| `simt agent-hooks status` | `--diff`, `--harness` | what each harness will run, and what is not trusted yet |

Writes to the repository: `simt agent-hooks install`. Each prints its plan and writes nothing without `--yes`.