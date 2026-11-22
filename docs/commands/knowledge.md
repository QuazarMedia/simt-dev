# simt knowledge

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt knowledge why <claim-id> (--claims <file> \| --scope <id>) [--limit <n>] [--page <n>]` | `--as-of`, `--claims`, `--known-at`, `--limit`, `--page`, `--scope`, `--where` | what a claim derives from, what depends on it, what applied at a date, and where it conflicts |
| `simt knowledge export (--input <file> \| --scope <id>)` | `--input`, `--scope`, `--limit`, `--page` | a bounded, permission-filtered packet another repository can read offline |
| `simt knowledge import --input <file> [--scope <id>]` | `--input`, `--scope` | validate an exported packet as data, and never execute it |
| `simt knowledge rank (--input <file> \| --scope <id>) --query "<question>"` | `--input`, `--limit`, `--query`, `--scope`, `--where`, `--retrieval` | rank evidence units by authority and quality, and report what was excluded |
| `simt knowledge derivations --input <file>` | `--input` | which outputs a source, template or skill change puts in question |
| `simt knowledge debt (--input <file> \| --scope <id>)` | `--input`, `--weights`, `--scope` | rank stale and unsupported knowledge by consequence per effort |
| `simt knowledge impact (--input <file> --refs <ids> \| --changed --scope <id>)` | `--input`, `--limit`, `--refs`, `--changed`, `--scope` | what a change reaches over typed edges, and where the graph is unknown |
| `simt knowledge sections <file.md>` | `--limit` | the retrieval units a long document yields, with anchors and byte ranges |
| `simt knowledge build --scope <id> [--yes]` | `--yes`, `--diff`, `--scope` | build the scoped corpus of declared sections under the ignored local area |

Writes to the repository: `simt knowledge build`. Each prints its plan and writes nothing without `--yes`.