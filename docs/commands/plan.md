# simt plan

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt plan done <id> [<sha>] --yes` | `--diff`, `--state`, `--test` | mark one tracker row complete, with its SHA and its evidence |
| `simt plan labels` | — | the header each tracker column matched, and the labels this repository configured |
| `simt plan next [<id>] [--tier <name>] [--wave <name>] [--lane <name>]` | `--diff`, `--state`, `--test`, `--tier`, `--wave`, `--lane` | one ready slice's section, or the one named, inside a tier, a wave or a lane |
| `simt plan status` | `--diff`, `--state`, `--test` | count the tracker rows, the share of the plan done, and its tiers, waves and lanes |

None of these write to the repository.