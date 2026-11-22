# simt skills

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt skills brief --task "<task>"` | `--all`, `--budget`, `--paths`, `--task` | the packet's SKILLS section: names, sizes and why, without bodies |
| `simt skills compile [<name>]` | `--yes` | compile a skill to the Agent Skills standard |
| `simt skills eval [corpus]` | `--all` | score the skill registry against transcripts |
| `simt skills find <query>` | `--all` | skills that match a query |
| `simt skills index` | `--all` | rebuild the skill index |
| `simt skills install <name> --yes` | `--yes`, `--diff`, `--from`, `--variant`, `--dry-run` | install skills into the workspace |
| `simt skills show <name>` | `--all` | one skill packet |
| `simt skills why <name>` | `--all`, `--task` | which skill covers a task |

Writes to the repository: `simt skills compile`, `simt skills install`. Each prints its plan and writes nothing without `--yes`.