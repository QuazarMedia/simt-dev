# simt rules

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt rules decisions` | `--yes`, `--all` | every known decision, and which layer each came from |
| `simt rules list [--root <path>]` | `--all` | the rule catalogue, marked with what applies to this repository |
| `simt rules show <id>` | `--all` | one rule body |
| `simt rules why <id\|ADR-NNN> [--all]` | `--all` | the decision that settled a rule, and whether it is still in force |

Writes to the repository: `simt rules decisions`. Each prints its plan and writes nothing without `--yes`.