# simt index

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt index [--open] [--embed]` | `--allow-remote`, `--embed`, `--open` | rebuild the local file index from git blobs, or report what it holds |
| `simt index overlay --input <file>` | `--input` | a working-tree or staged node labelled by its provenance, never both |

None of these write to the repository.