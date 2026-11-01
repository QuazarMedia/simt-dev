---
simt-affects: ["src/mcp/server.mjs", "src/mcp/tools.mjs", "docs/reviews/0003-pre-plan-0004-review.md"]
simt-supersedes: []
---

# ADR-126 — the MCP surface stays a reader, so there is no write path to build

Status: **accepted** · 2026-11-01

## Context

Review 0003's Q66 lists "the two-step write path" among the clauses still open for the
MCP surface. The clause reads as work to do; the file says otherwise. `src/mcp/server.mjs`
opens with three decisions, the third of which is that no mutating tool is exposed —
`init`, `sync`, `hooks install`, `skills install` and `upgrade` are absent on purpose,
because an editor that can call a tool can call it without a human reading a diff first.

Those two statements have stood in the same repository for months without meeting. The
question the row asks and the rule the file states are the same question, and the answer
was written down where the row's reader would not look.

The argument for exposure is real and worth stating: a client that can read a repository
can also want to fix it, and a plan-then-apply pair would let it see what would change
before changing anything. What it would not do is make the change reviewed. `--yes` on
the command line is a human decision with a preview in front of it; the same flag arriving
inside a tool call is a model deciding to pass it.

## Ruling

### 1. No tool on this surface writes

Every tool returns a value and changes nothing. The capability block advertises no write
capability, and this is not a gap to be filled later: a tool that writes is a different
surface with a different review obligation, and it is not this one.

### 2. A caller that wants to write runs the command

The commands already do plan-then-apply properly: they print a preview, refuse without
`--yes`, journal what they write, and `undo` restores it. A client that wants that power
runs `simt <command>` as a subprocess, where the human who opened the editor sees the
preview and passes the flag — or does not.

### 3. Exposing a writer needs a superseding record, not a patch

If a future surface must write, it arrives with its own decision: what the plan token
proves, who approves the apply, how a half-applied run is undone, and what the journal
says. Approving a diff in an editor is a claim the server cannot verify, and a
confirmation prompt is a user interface the server does not own.

## Consequences

- Q66's write-path clause closes as withdrawn, not deferred. The row names this record so
  the next reader does not reopen it as unfinished work.
- The read-only guarantee in the server's header, the capability block and the tests now
  have one record behind them instead of three comments.
- A tool that returns `{ written: false }` for every input is not a compromise: it is the
  shape that makes a client believe a write happened.

## Rejected

- **A plan/apply pair behind a confirmation prompt.** The prompt is rendered by the client,
  which may not render one, and the server cannot tell an approved apply from an unapproved
  one. A safety property that depends on another program's UI is not a property.
- **A write tool gated on `--yes` passed through the arguments.** The flag would be asserted
  by the same model that decided to write; the preview would be read by nobody.
- **Exposing `sync` alone because it is idempotent.** It rewrites the generated region of
  every repository in a workspace. Idempotence says a second run changes nothing, not that
  the first run was reviewed.
