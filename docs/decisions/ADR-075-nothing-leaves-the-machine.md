# ADR-075 — Nothing leaves the machine: no telemetry, local transcripts, loopback models by default

Status: **accepted** · 2026-10-14 · filed as D7 (R06)
**Affects:** `src/measure/session.mjs`, `src/measure/context.mjs`, `src/commands/tokens.mjs`, `src/argv.mjs`, `test/tokens.test.mjs`

## Context

The context meter (`simt tokens`) now goes beyond static repository files to inspect
recorded agent transcripts (`simt tokens --session <path>`), and later slices in the
research programme connect optional local model servers for embeddings, distillation and
pre-review critique.

Session transcripts are among the most sensitive files on a developer's machine: they hold
every file an agent read, every command output it saw, uncommitted diffs, environment
diagnostics and prompts written in the middle of debugging. A tool that fetched remote
session URLs, phoned home usage metrics, or defaulted model calls to a hosted endpoint
would turn a local measurement command into an exfiltration surface.

## Rulings

1. **No command emits telemetry, analytics or background network traffic.** Every command
   operates over the local filesystem and stdio alone unless the user explicitly invokes a
   documented network flag in a later adapter.

2. **`simt tokens --session <path>` accepts local filesystem paths only and refuses URLs.**
   Any argument carrying a URI scheme (`http://`, `https://`, `ws://`, `ssh://` or any
   `<scheme>://`) is rejected at argument validation with a configuration exit code and a
   remedy naming a local file path, before any socket or filesystem read is attempted.

3. **Session attribution is computed deterministically in process with zero dependencies.**
   Transcript JSON and JSONL records from Claude Code and Codex are split into `rules`
   (system instructions, inline instruction blocks, and reads of instruction, rule or skill
   files), `fileReads` (reads of repository source and config files) and `toolOutput`
   (command and tool execution results) by inspecting the local file alone.

4. **Future local-model adapters default to loopback (`127.0.0.1` / `localhost`) and refuse
   remote hosts unless explicitly overridden.** When no local model is configured in
   `simt-dev.json`, no socket is opened at all.

## Consequences

`simt tokens --session <path>` can be run safely on production incident transcripts and
private repositories because the parser cannot open a network connection. And coupling the
static meter to the harness loader table (`R14`) means `simt tokens` now counts what each
reader actually loads at session start — flat `.agents/rules/` scans for Antigravity,
`alwaysApply: true` for Cursor, `@path` imports for Claude Code, and root-to-cwd chain
caps for Codex — without leaving the machine.

## Rejected

- **Fetching remote session URLs or cloud share links in `simt tokens --session`.** Convenience
  for a shared link is also an outbound request from a tool whose contract is that it
  only reads local state.
- **Anonymous opt-out telemetry for context budget numbers.** Even aggregate byte counts
  reveal repository names, adoption state and working hours, and an opt-out flag still
  ships a network client in the default path.
