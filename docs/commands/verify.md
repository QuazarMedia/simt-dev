# simt verify

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt verify contracts --input <file>` | `--input` | evaluate obligations against observations, with the result states kept apart |
| `simt verify documents --input <file>` | `--input` | check a generated document against its template, sections and source scope |
| `simt verify procedures --input <file>` | `--input` | check procedures for missing imports, calls and impossible prerequisites |
| `simt verify plan --input <file>` | `--input` | the next observation worth making, and the point at which there is not one |
| `simt verify select (--input <file> \| (--changed \| --staged) --scope <id>)` | `--input`, `--changed`, `--staged`, `--scope` | the narrowest checks that prove a change, and whether a Git hook may run them |
| `simt verify run --changed --scope <id> [--yes]` | `--changed`, `--scope`, `--yes`, `--dry-run` | run selected local validators and record scoped evidence |
| `simt verify status (--input <file> \| --changed --scope <id> [--input <attestations>])` | `--input`, `--changed`, `--scope` | closure over recorded obligations, and what is unresolved |

Writes to the repository: `simt verify run`. Each prints its plan and writes nothing without `--yes`.