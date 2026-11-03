# simt index

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt index [--embed]` | `--allow-remote`, `--embed` | rebuild the local file index from git blob hashes |
| `simt index overlay --input <file>` | `--input` | a working-tree or staged node labelled by its provenance, never both |

None of these write to the repository.