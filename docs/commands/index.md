# simt index

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt index [--open] [--search <task>] [--embed] [--retrieval v1\|v2\|v3]` | `--allow-remote`, `--embed`, `--limit`, `--open`, `--rank`, `--retrieval`, `--search` | rebuild the index, or ask the open cache for rows and ranks |
| `simt index overlay --input <file>` | `--input` | a working-tree or staged node labelled by its provenance, never both |

None of these write to the repository.