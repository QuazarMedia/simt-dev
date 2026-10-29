---
simt-affects: ["src/commands/agenthook.mjs", "src/commands/help.mjs", "test/agenthooks.test.mjs"]
simt-supersedes: []
---

# ADR-107 — an install can be narrowed to one harness, and the skipped ones are named

Status: **accepted** · 2026-10-30

## Context

`agent-hooks install` wrote every harness that documents a hooks file. A
repository whose agents run in one of them received entries in the others'
files as well — files no agent there reads, which a later `status` then
reports PRESENT while nothing in that harness enforces anything. For a
one-harness repository the install wrote more files than it needed to, and
there was no way to ask for fewer.

ADR-079 ruling 11 settled that the readers this tool does not write are
*named* in the report — a command that writes four files and stays silent
about the fifth reads as covering it. A narrowed install creates a third
category that ruling did not anticipate: readers this tool *can* write and
did not.

## Ruling

1. **`agent-hooks install --harness <id>` writes that one reader.** The id is
   validated against the adapter table before anything is planned, and an
   unknown id is a usage error that names the valid ids — the same validation
   `agent-hook` applies, with the same remedy. The shim is written as before:
   every config points at it, and a one-harness install would leave a config
   pointing at a shim that is not there.
2. **The skipped adapters are named in both surfaces.** The text report
   prints a `SKIPPED` line per skipped reader with a note that says how to
   write them all, and the JSON document carries them in `notWritten` with
   `state: "skipped"`. A narrowed install that stays silent about the readers
   it left alone is the failure ADR-079 ruling 11 ruled out for the full one.
3. **`status` is unchanged.** It reports what each harness *will* run, and a
   file that was never written is `ABSENT` there — the true answer. The
   narrowing is a choice the install made, and the install's report is where
   that choice is recorded.

## Consequences

- A repository that installs for one harness and later adds a second runs
  install again — with the new id, or without any — and the merge creates the
  entry in the new file while the files it already wrote come back
  `UNCHANGED`. Nothing about a narrowed install has to be undone.
- The prompt opt-in hint prints only when the selected harness can receive a
  packet; a narrowed install to a harness with no prompt event does not ask
  for an opt-in it cannot use.
