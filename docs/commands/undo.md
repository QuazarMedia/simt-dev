# simt undo

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt undo --yes` | `--yes`, `--diff` | restore the last journaled set of writes, if untouched |

Writes to the repository: `simt undo`. Each prints its plan and writes nothing without `--yes`.