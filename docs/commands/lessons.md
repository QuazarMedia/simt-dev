# simt lessons

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt lessons capture` | `--diff`, `--expires`, `--paths`, `--task` | scan the ledger and history for new lesson candidates |
| `simt lessons list` | `--diff`, `--expires`, `--paths`, `--task` | deterministic lesson candidates and the promoted lessons |
| `simt lessons review <id> --yes` | `--diff`, `--expires`, `--paths`, `--task` | promote one lesson candidate into docs/lessons |

None of these write to the repository.