# Agent hooks — what is enforced, and what is not

`simt agent-hooks install --yes` writes a hook entry into each harness it finds. This page
states the boundary precisely, because the behaviour differs per harness and the parts
that decide are smaller than the parts that deliver. ADR-205 records why it is published.

## What is wired

| Harness | Config the tool writes | Tool event | Prompt event |
| --- | --- | --- | --- |
| `claude` | `.claude/settings.json` | `PreToolUse` | `UserPromptSubmit` (adds context) |
| `codex` | `.codex/hooks.json` | `PreToolUse` | `UserPromptSubmit` (adds context) |
| `cursor` | `.cursor/hooks.json` | `preToolUse` (fails closed) | `beforeSubmitPrompt` (cannot inject) |
| `gemini` | `.gemini/settings.json` | `BeforeTool` | `BeforeAgent` (adds context) |
| `opencode` | `.opencode/plugins/` (a plugin the tool owns) | `execute.before` | `prompt` (prepends text) |

Every entry names `.simt/hooks/agent-hook`, never a bare `simt`: a devDependency install
does not put the binary on a harness's PATH, and the two harness behaviours below turn
that difference into either silence or a blocked call.

## What decides

`agent-hook pre-tool-use --harness <id>` reads the payload, derives facts (the command,
the git facts it can parse, the paths written) and returns a decision. A denial exits
with the adapter's `denyExit` (`2`, the convention the dialects share) and prints the
harness's own JSON shape. A repository that has adopted the tool also records the denial
as a lesson candidate; that write can fail without changing the decision.

- **An empty or unparseable payload is allowed** (exit `0`, with a note). Nothing to check
  is not evidence of a violation, and a hook that blocks on no evidence gets uninstalled.
- **An unknown harness or event is a usage failure**, not a denial: a typo in a hook
  config must not stop every tool call.
- **A parsed command with no git fact falls back to the policy regex.** This is what A09
  and the audit lane in `test/agenthooks-audit.test.mjs` pin; a push through a wrapper
  (`busybox git push`) is still denied.

## What only delivers

`prompt-submit` and `post-tool-use` never decide anything — they emit context and exit
`0` whatever happens, because a failure to inject the packet or a lesson must not stop
work. Cursor's prompt hook cannot inject at all and is block-only in its dialect, so that
row delivers nothing on `cursor`.

## What is not covered

- **No real harness binary is executed by the suite.** `test/agenthooks.test.mjs` and
  `test/agenthooks-audit.test.mjs` cover payload shapes, fact derivation, policy decisions
  and the rendered config shapes. Vendor dialog rendering (Cursor's fail-closed
  confirmation, Claude's treatment of non-`2` exits) is described here from the adapter
  contracts; it was not observed against an installed harness in this repository.
- **A change to a harness's payload shape degrades to no facts.** The command may still
  match a policy regex; anything else is allowed. The hook does not guess.
- **Anything outside the harness is outside the hook.** `git` run from a terminal, by CI,
  or by an editor integration that does not call the hook is not seen. The git-side shims
  in `.simt/hooks/` cover the git events they are installed for, not a binary invoked by
  absolute path.
- **Hooks can be removed or disabled by the user**, and a harness that fails closed will
  block calls when the shim itself cannot locate an interpreter. `agent-hooks status`
  reports what is installed, not a guarantee that the harness runs it.
