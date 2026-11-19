# simt init

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt init [path]` | `--yes`, `--accept-conflicts`, `--backup`, `--baselines`, `--diff`, `--harness`, `--agents`, `--surfaces` | adopt this repository: manifest, region, agents and agent-hooks; git hooks are a separate install |

Writes to the repository: `simt init`. Each prints its plan and writes nothing without `--yes`.