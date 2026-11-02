# simt workspace

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt workspace compare` | `--learn` | the adoption and drift matrix across every sibling repository |
| `simt workspace share` | `--yes`, `--diff` | what repeated rules in a workspace cost to carry, and where they would go |
| `simt workspace install --yes` | `--yes`, `--diff` | carry those rules once per reader, at user level |
| `simt workspace upgrade --yes` | `--yes`, `--all`, `--diff`, `--workspace` | replace this installation with the pinned release |

Writes to the repository: `simt workspace share`, `simt workspace install`, `simt workspace upgrade`. Each prints its plan and writes nothing without `--yes`.