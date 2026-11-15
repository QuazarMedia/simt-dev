# simt lessons

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt lessons discover --input <file>` | `--input` | deduplicate discovery candidates and report their authority |
| `simt lessons capture` | `--diff`, `--expires`, `--paths`, `--task` | scan the ledger and history for new lesson candidates |
| `simt lessons list` | `--diff`, `--expires`, `--paths`, `--task` | deterministic lesson candidates and the promoted lessons |
| `simt lessons review <id> --yes` | `--diff`, `--expires`, `--paths`, `--task`, `--yes` | promote one lesson candidate into docs/lessons |

Writes to the repository: `simt lessons review`. Each prints its plan and writes nothing without `--yes`.