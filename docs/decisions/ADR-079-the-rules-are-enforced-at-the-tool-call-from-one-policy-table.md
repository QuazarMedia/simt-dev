# ADR-079 — The rules are enforced at the tool call, from one policy table every harness renders

Status: **accepted** · 2026-10-16 · filed as R15 (plan 0003)

Affects: `src/agenthooks/policy.mjs`, `src/agenthooks/decide.mjs`, `src/agenthooks/render.mjs`,
`src/commands/agenthook.mjs`, `src/commands/index.mjs`, `src/commands/help.mjs`,
`bin/simt-dev.mjs`, `test/agenthooks.test.mjs`

## Context

The rules this tool projects reach an agent as text, and text is advice. Three of them are
broken by habit rather than by disagreement — a `git push`, a `--no-verify`, an edit inside a
region that is regenerated — and the reader breaking one is an agent that never sees the
commit that would have caught it. R15 turns those three into a decision at the tool call.

Four harnesses document a pre-tool hook that receives JSON on stdin and answers with a
decision (each page read 2026-10-16):

| Reader | File | What it does with a decision |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` | `hookSpecificOutput.permissionDecision: "deny"`, exit 2 also blocks |
| Cursor | `.cursor/hooks.json` | `{"permission": "deny"}`; exit 2 blocks; a permission hook blocks on invalid JSON even when `failClosed` is false |
| Codex | `.codex/hooks.json` | the same `hookSpecificOutput` shape as Claude Code, or the older `{"decision": "block"}` |
| Antigravity | `.agents/hooks.json` | `{"decision": "deny", "reason"}`; the page documents no exit code |

They agree on the mechanism and on nothing else. The path differs; Antigravity's file is keyed
by a hook *name* rather than by event; the event is `PreToolUse` or `preToolUse`; the tool name
for a shell call is `Bash`, `Shell`, `Bash` or `run_command`; the command sits in
`tool_input.command` for three of them and in `toolCall.args.CommandLine` for the fourth; the
write tool is `Edit`/`Write`, `apply_patch` (whose paths are inside the patch text),
`Write`/`Edit`, and `write_to_file`/`replace_file_content`; and the decision document is four
different shapes.

The plan was written on 2026-10-06 and named `.gemini/settings.json`. The reader table R14
shipped already carries the correction — the Antigravity page documents
`<workspace>/.agents/hooks.json` — so this record follows the table and not the plan. The table
is also the source of the four config paths here: a second list of the same paths is the copy
ADR-035 exists to prevent.

Measured on this machine (node v26, twenty runs each, every figure from a node parent that
pays the same fork the harness pays): `node -e 0` costs **85.4 ms** at p50 and **91.9 ms** at
p95, so the runtime's own start is 92% of the plan's budget before a line of this tool runs.
Loading the reader table adds 2.8 ms at p50 and the region detector 4.9 ms; the whole hook
path is **97.4 ms p50 / 101.6 ms p95**, down from 127.6 / 139.0 before `bin/` dispatched
`agent-hook` without loading the registry.

So the plan's criterion of a p95 under 100 ms is **not met end to end**, and a sample of
twenty straddling the line is a claim about this machine rather than about the tool. What
this slice owns is the part above the runtime, and that part is stated exactly: the decision
is **0.0023 ms** at p95, and the entry point loads no manifest, no fingerprint, no workspace
and no command registry — the two modules it takes from `src/projection/` (`markers.mjs` to
ask whether a file already holds a region, `loaders.mjs` for the reader table's paths) are
leaves that read nothing at import.

## Rulings

**1. One policy table, and one renderer per harness.** `policy.mjs` holds the rows and matches
them against *facts* — a shell command string, and the files a write touches — so a policy never
knows which harness asked. Each renderer owns one harness's payload-to-facts mapping, its
configuration shape and its decision document. The table is data; the dialects are code.

**2. Three policies ship: `push` (ADR-001), `rewrite` (ADR-017) and `generated` (ADR-036).**
Each names the record it enforces and the override that lifts it, in the message the reader
sees. `push` quotes the projected rule that cites ADR-001; `rewrite` cites the record whose
own Context is the `--no-verify` spiral a broken gate teaches; `generated` cites the record
that made the region note ("Do not edit by hand") ship into every consumer repository, and its
message names the command that regenerates.

**3. Every matching policy is reported, not the first.** `git push --force` matches two, and
the denial carries both messages and both records. A first-match rule would let
`SIMT_ALLOW=push` carry a force-push through on an override that never mentioned rewriting
history, which is the one thing an override must not do.

**4. `SIMT_ALLOW` lifts exactly the policies it names, and says so.** A lifted policy is
reported as lifted, so a session that granted something can be read back out of its own output.
A name that is not a policy is reported as unknown and changes no decision: a typo in an
override must not silently disable a policy, and it must not block either.

**5. Exit 2 means "block", and only a denial uses it.** A usage error — a missing `--harness`,
an unknown event — exits 1. Every harness reads 2 as a refusal, so a configuration mistake that
exited 2 would block every tool call in the session, which is a worse failure than the one the
hook is there to prevent.

**6. No facts is not a violation.** An unrecognised payload, an empty stdin or unparseable JSON
produces no decision: exit 0, nothing on stdout. A hook that blocked on a payload it did not
understand would turn every tool call into a wall, and the harness's own permission model still
applies. This is the deliberate direction of the failure, and it is why the facts a policy
needs are read from named fields rather than guessed.

**7. A missing hook is a state; an unreadable config is a defect.** `agent-hooks status` exits 0
when a harness has no entry and 1 when its config cannot be read, or parses to something that is
not an object. A harness's settings file is the harness's file, kept for reasons that have
nothing to do with this tool, so not being in it is a choice; a file this tool cannot parse is
one it must not write into, in either surface.

**8. `agent-hook` has no envelope of its own.** Its stdout is the dialect of the harness that
called it — no `ok`, no `schemaVersion`. It is the one command whose contract is four
documents instead of one, and the reason a JSON contract test does not enumerate it.

**9. The entry point loads neither the registry nor anything that reads the repository.** `bin/simt-dev.mjs`
dispatches the exact spelling the renderers write, and only that: `--help` still imports the
registry, so help remains the single list of commands. Nothing above the decision resolves a
manifest, fingerprints a tree or walks a workspace, because all three would put the cost of
answering "what is this repository" on every tool call. The two modules the path does take
from `src/projection/` are leaves that read nothing at import, and the test asserts the
modules that would read the repository are absent from the import list rather than asserting
a duration.

**10. Install merges, and identifies its own entry by the command it wrote.** Every other key
and every foreign handler survives; the entry is found by the command string, because JSON has
no comment to carry a marker. A config this tool cannot parse is left alone and reported, and
nothing else is written for that run.

**11. The readers this tool does not write are named.** `agent-hooks status` and `install`
report Copilot and the DeepSeek harness as "no hooks file is documented" and OpenCode as
"not ours" (its hooks are plugins), with the table's own note. A command that writes four files
and stays silent about the fifth reader in the repository reads as "that one is covered too".

## Consequences

**What has not landed.** Three policies the plan lists are not here: formatting and linting a
file after an edit, refusing reads of secrets (`.env*`, `*.pem`, `*.keystore`), and the Stop
policy that blocks once when code changed with no ledger entry for the tree — the last waits on
R17, the evidence ledger. Plan section 16 step 5 scopes this slice to exactly the three that
shipped. A policy that cannot name its evidence cannot name its remedy, which is why the
ledger one waits.

**The acceptance criterion's headless run has not been run, and cannot be from here.** R15's
accept says a headless Claude Code session on probe R05 shows the block. The probes and their
graders exist and the decision was verified per harness against fixtures; the run itself needs
a harness, and none is installed on this machine (`claude`, `codex`, `cursor-agent`, `gemini`
and `aider` are all absent from `PATH`, which is the check that says so rather than a memory of
one). So this record does not claim it, and the plan's note for the row names it as the one
piece of R15's accept that is outstanding.

**One field was inferred rather than read.** Cursor's page was read to line 1087 of 1490, which
does not include its write tool's input key, so its adapter reads `file_path ?? path`. If Cursor
names it otherwise, a generated-region edit through that harness is not caught — the failure is
silent, which is why it is written down here rather than left in a comment.

**Codex's trust step is printed, not performed.** Codex records trust against the hook's current
hash, so a hook nobody has trusted stays inert: `install` names the `/hooks` review and
`status` repeats it. Nothing this tool can do from a shell substitutes for it.

**The hook name Antigravity keys on is `simt-dev-policies`.** Antigravity's file is a map of
named hooks, so the entry needs a name; the project name is the one string already exempt from
the estate-name guard.

## Rejected

- **One shared config written for every harness.** They disagree on the path, the top-level
  shape, the event name, the matcher, the tool name, the command field, the write tool and the
  decision document. A shared file would be a fifth dialect none of them reads.
- **Blocking on a payload the hook did not understand.** Fail-closed is the dispatcher's rule for
  a gate it was asked to run; it is the wrong rule for a hook that runs on every tool call.
- **Exit 2 for a usage error.** It means "block" to every harness.
- **A `stop` policy that blocks without a ledger.** The evidence it would need is R17's.
- **An `ok`/`schemaVersion` envelope on `agent-hook`.** The harness parses its own dialect.
- **Reading the manifest for the policy decision.** The rules are the tool's, not the
  repository's gates; a hook that required adoption would not run in a repository that has not
  been adopted, which is where the rules matter most.
- **Guessing a payload shape it cannot recognise.** See ruling 6.
