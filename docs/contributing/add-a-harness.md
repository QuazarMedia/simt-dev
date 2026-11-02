# Add a harness

A harness is a coding agent whose files simt writes and whose tool calls it can decide. What
a harness reads, what it caps a file at, where its rules and hooks live, and which config
file it merges: all of that is a record, and the loader is the code that walks it.

1. **Add the record under `harnesses/`.** The record names the instruction files the harness
   loads, the skills directories it reads, the hooks file it merges, the MCP config file it
   reads, and the read cap for each file. `simt harness loaders --table` prints the table the
   records produce — if a new harness is missing from it, the record is not being read.
2. **Teach the loader only what the record cannot say.** `src/harness/` holds the merge and
   write logic; a harness whose files are described entirely by its record needs no code.
3. **Register the surface name if rules are projected into it.** `rules/mdc/*.mdc` are the
   canonical Cursor files; a surface that reads a per-rule directory needs its projection
   entry and its `surfaces` name in the manifest schema.
4. **Test the measurement, not the prose.** `simt harness detect` must report the harness on
   a fixture carrying its config, `simt harness loaders --at <dir>` must count what that
   harness would load, and `test/harness*.test.mjs` holds both.

A harness that cannot run anything is not installed: `hooks install` writes nothing for it
and says why, which is the same rule as a gate this repository cannot run (ADR-017).
