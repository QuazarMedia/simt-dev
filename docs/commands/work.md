# simt work

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt work inspect` | — | what this repository's work consists of, and which validations are actually available |
| `simt work schedule --input <file>` | `--input` | which ready tasks can run together under capacity and resource constraints |
| `simt work handoff --input <file>` | `--input` | build a resume capsule from ids and provenance, never from a transcript |
| `simt work resume --input <file>` | `--input` | revalidate permission, target, dependencies, authorization and lease before reuse |
| `simt work graduate --input <file>` | `--input` | whether repeated traces can be proposed as a procedure, and what still blocks it |
| `simt work packet --input <file>` | `--input` | the proof-bearing task packet, inside its byte budget or explicitly incomplete |

None of these write to the repository.