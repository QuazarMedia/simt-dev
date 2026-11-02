# Add a command

A command is declared once, in `src/commands/spec.mjs`, and wired once, in
`src/commands/index.mjs`. Everything else is derived: help, completions, the MCP tool list,
and the generated reference in `docs/commands/`.

1. **Declare the row.** Add an entry to `SPEC`: `path` (the dispatch key — `status`, or
   `group subcommand`), `summary` (one phrase, no newline), and the optional `usage`,
   `flags`, `writes: 'repo'`, `aliases`, `mcp`, `defaultFor`. A field no code reads is a
   field that drifts, so add `tier`/`args` only with the consumer that reads them.
2. **Wire the dispatch.** Add the path to the map in `src/commands/index.mjs`, with the
   one-line comment the file's style asks for: why this path is bare, or which group default
   it serves.
3. **Describe a new flag.** A boolean flag goes in `BOOL_FLAGS` in `src/argv.mjs`; every
   flag needs a line in the `FLAGS` template of `src/commands/help.mjs`, because a test
   fails when the parser accepts a flag `--help` does not describe.
4. **Render the reference.** `node bin/simt.mjs docs commands --yes`, and commit the diff.
   `test/docs.test.mjs` fails when `docs/commands/` and the spec disagree.
5. **Test the behaviour, not the row.** `test/spec.test.mjs` keeps the registry and the spec
   in agreement; `test/help.test.mjs` keeps help honest; a writer needs its own test that
   proves the plan without `--yes` writes nothing and `--yes` writes those bytes.

If the command changes what the tool believes — a gate, a rule, a classification — it is a
ruling, and it ships with a decision record ([write-an-adr](write-an-adr.md)).
