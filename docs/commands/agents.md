# simt agents

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt agents install --yes` | `--yes`, `--diff`, `--harness` | write the Simt-Agent into each harness agents file |
| `simt agents status` | `--diff`, `--harness` | what each harness carries, and what is not installed yet |

Writes to the repository: `simt agents install`. Each prints its plan and writes nothing without `--yes`.