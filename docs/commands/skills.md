# simt skills

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt skills brief --task "<task>"` | `--all`, `--plan`, `--task` | the packet for a task, read from the skill registry |
| `simt skills compile [<name>]` | — | compile a skill to the Agent Skills standard |
| `simt skills eval [corpus]` | `--all`, `--plan` | score the skill registry against transcripts |
| `simt skills find <query>` | `--all`, `--plan` | skills that match a query |
| `simt skills index` | `--all`, `--plan` | rebuild the skill index |
| `simt skills install <name> --yes` | `--yes`, `--diff`, `--from`, `--variant` | install skills into the workspace |
| `simt skills show <name>` | `--all`, `--plan` | one skill packet |
| `simt skills why <name>` | `--all`, `--plan` | which skill covers a task |

Writes to the repository: `simt skills install`. Each prints its plan and writes nothing without `--yes`.