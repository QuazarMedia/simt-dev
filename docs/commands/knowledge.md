# simt knowledge

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt knowledge why <claim-id> --claims <file> [--limit <n>] [--page <n>]` | `--claims`, `--limit`, `--page` | what a claim derives from, what depends on it, and where it conflicts |
| `simt knowledge export --input <file>` | `--input` | a bounded, permission-filtered packet another repository can read offline |
| `simt knowledge import --input <file>` | `--input` | validate an exported packet as data, and never execute it |

None of these write to the repository.