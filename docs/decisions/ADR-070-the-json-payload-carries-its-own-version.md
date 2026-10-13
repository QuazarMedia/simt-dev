# ADR-070 — The JSON payload carries its own version

Status: **accepted** · 2026-10-13 · filed as S51
**Affects:** `src/output/index.mjs`, `src/commands/index.mjs`, `src/commands/mcp.mjs`,
`src/commands/graph.mjs`, `src/commands/rules.mjs`, `src/commands/skills.mjs`,
`src/commands/skillsinstall.mjs`, `src/commands/init.mjs`, `src/argv.mjs`,
`src/commands/help.mjs`, `test/jsoncontract.test.mjs`

## Context

Review 0002 filed that `--json` output had no schema version and no compact form:
`emitJson` was `JSON.stringify(value, null, 2)` and every payload was four columns of
whitespace. Two consequences, both invisible until they mattered.

The first is that a reader could not detect a shape change. An agent that parses `--json`
gets a document that parses, and if a field is renamed the parse still succeeds and the
next lookup returns `undefined`. A version in a README does not help: nobody reads the
README, and it goes stale without failing anything. The version has to travel inside the
payload, because the payload is the only thing a reader is guaranteed to see.

The second is that indentation is paid for on every call. The reader of `--json` is
`JSON.parse`, not an eye; the same document is a third larger for nothing. The one case
where indentation is worth its bytes is a terminal, where a person is the reader.

Writing the contract test found the two things the review missed. `doctor` did not use
`emitJson` at all — it hand-rolled `emit(JSON.stringify(..., null, 2))` — and neither did
`mcp --list`, `graph lint`, `rules list`, `skills index`, `skills find`, `skills show` or
`skills install`, so seven surfaces answered `--json` in a shape no reader could rely on.
And `fail()` wrote only to stderr, which means a command that failed under `--json`
returned an empty stdout: the caller was told something went wrong and given no way to
learn what. A failure is a result — the question was asked and the answer is "no, and here
is why" — and it belongs where results go.

One note on how this was found, because it is the argument for the test existing at all:
the contract test itself passed a `mcp` entry whose argument list was silently dropped by
an `Array.isArray` mistake, so it ran `mcp --json` with no `--list`, and the command served
on stdio and waited forever. A contract that cannot fail loudly is not a contract.

## Rulings

1. **The version is in the payload, not in the documentation.**
   `schemaVersion` is written into every object payload that does not already carry one.
   Adding a field is not a bump; removing, renaming or retyping one is. A reader that
   wants to know what changed reads the field, not a changelog.

2. **Compact is the default and `--pretty` asks for indentation, with a terminal as the
   exception.** A pipe gets one document on one line because its reader is a program; a TTY
   gets indentation because its reader is a person. The flag exists to override the
   terminal case, not the pipe.

3. **One place decides the shape for every command.** `dispatch` sets the indent default
   and the failure mode once, from the parsed flags. Threading either through twenty-five
   call sites would mean twenty-five places to forget, and the one that forgot would be the
   one a reader pipes into a script.

4. **A failure under `--json` is a JSON document on stdout.** `ok: false`, the error, the
   remedy and the exit code. Without this, a scripted caller has an empty document and a
   non-zero exit and nothing else, which is the failure mode that makes an agent give up
   rather than retry.

5. **`emitJson` owns the byte ceiling too.** Every `emit(JSON.stringify(...))` call that
   also passed `maxBytes` becomes an `emitJson(payload, { maxBytes })` call, so the
   truncation announcement reads the same everywhere and no surface gets an unbounded
   document by being spelled differently.

6. **The contract test is generated from the command registry.** It iterates the commands
   that emit JSON, runs each through the real binary, and asserts one line, no leading
   whitespace, a parse, and the version. A command added to the registry is not
   automatically in the test — the test asserts the list is still real, and the list is the
   contract.

## Consequences

Every `--json` payload now begins with `schemaVersion`, and twelve commands no longer have
a private idea of what `--json` means. `doctor --json` went from seventeen indented lines
to one, and the failure of `skills install` in a bare directory now answers in the shape
its caller asked for.

What is not here: the README half of the review's fix — an exit-code table and a per-command
JSON contract generated from the registry. The exit codes are already named in `EXIT`, and
generating README prose from them is a documentation change that belongs to whoever owns
the README, so it is noted in the tracker rather than done silently here.

## Rejected

- **A version in a comment or the changelog only.** It is exactly the artefact that goes
  stale without failing anything.
- **Threading `--pretty` through the call sites.** Twenty-five chances to forget, to fix a
  problem that has one place to live.
- **Keeping failures on stderr under `--json`.** It leaves a scripted caller with an empty
  document and a number, which is a contract that cannot be acted on.
