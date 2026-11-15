# simt knowledge

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt knowledge why <claim-id> --claims <file> [--limit <n>] [--page <n>]` | `--as-of`, `--claims`, `--known-at`, `--limit`, `--page` | what a claim derives from, what depends on it, what applied at a date, and where it conflicts |
| `simt knowledge export --input <file>` | `--input` | a bounded, permission-filtered packet another repository can read offline |
| `simt knowledge import --input <file>` | `--input` | validate an exported packet as data, and never execute it |
| `simt knowledge rank --input <file> --query "<question>"` | `--input`, `--limit`, `--query` | rank evidence units by authority and quality, and report what was excluded |
| `simt knowledge derivations --input <file>` | `--input` | which outputs a source, template or skill change puts in question |
| `simt knowledge debt --input <file>` | `--input`, `--weights` | rank stale and unsupported knowledge by consequence per effort |
| `simt knowledge impact --input <file> --refs <ids>` | `--input`, `--limit`, `--refs` | what a change reaches over typed edges, and where the graph is unknown |
| `simt knowledge sections <file.md>` | `--limit` | the retrieval units a long document yields, with anchors and byte ranges |

None of these write to the repository.