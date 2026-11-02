# Add an MCP tool

The MCP surface is read-only, and it answers from the same functions the CLI calls. A tool
that would write is not a tool here: a writer belongs behind a command with `--yes`.

1. **Declare it on the spec row.** A tool that mirrors an existing command is declared by the
   command's row: `mcp: { name: 'brief', flags: ['budget', 'paths', 'task'] }`. The `flags`
   list is the allowlist — a flag absent from it is not reachable over MCP, which is how a
   read-only surface stays read-only.
2. **Implement it in `src/mcp/tools-*.mjs`.** `tools-read.mjs` holds the reads, `tools-facts.mjs`
   the derived answers. A tool is a name, a description, a JSON schema and a handler that
   returns data; the handler may not print.
3. **Describe it for a model, not for a person.** The description says when to call it and
   what it answers; a description that restates the name is a tool no model chooses.
4. **Check the surface.** `simt mcp --list` prints every tool without reading stdin, and
   `test/mcp*.test.mjs` holds the list against the spec and exercises each handler on a
   fixture repository.

Prompts and resources live beside the tools (`src/mcp/prompts.mjs`, `src/mcp/resources.mjs`).
A resource is a document a client can attach; a prompt is a template the client renders. Both
are declared the same way, and both are read-only.
