# simt mcp

Rendered from the command spec by `simt docs commands --yes`; do not edit by hand.

| Command | Flags | What it does |
| --- | --- | --- |
| `simt mcp [--list]` | `--list` | serve the read-only MCP surface over stdio |
| `simt mcp status --harness <id>` | `--harness`, `--registry` | which servers the selected harnesses have configured, entry-level |
| `simt mcp install --harness <id> --yes` | `--harness`, `--registry`, `--yes` | write the registry servers into the selected harnesses project configs |

Writes to the repository: `simt mcp install`. Each prints its plan and writes nothing without `--yes`.