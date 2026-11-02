# simt hooks

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt hooks install --yes` | `--yes`, `--agent`, `--diff`, `--dry-run` | install the shared dispatcher; --agent writes each harness hooks file |
| `simt hooks run <event>` | `--yes`, `--diff`, `--dry-run` | run one git event's gates now, as git would |
| `simt hooks status` | `--agent`, `--diff`, `--dry-run` | what each git event routes to; --agent reports each harness instead |

Writes to the repository: `simt hooks install`, `simt hooks run`. Each prints its plan and writes nothing without `--yes`.