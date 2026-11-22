---
simt-affects: ["src/studio/control.mjs", "src/studio/api.mjs", "src/studio/server.mjs", "src/studio/public/control.js", "src/studio/public/control-room.js", "src/studio/public/control.css", "src/studio/public/app.js", "test/studio-control.test.mjs", "docs/plans/0007-studio-local-dashboard.md"]
simt-supersedes: [{ adr: "ADR-212", ruling: 4, kind: "narrowed" }]
---

# ADR-227 — Control is the writer's preview, confirmed by digest

Status: accepted · 2026-11-22

## Context

ADR-212 opened one loopback socket for the studio and left it read-only. Plan 0007's last
control slice needs the opposite of a socket that can run arbitrary commands: a person
should be able to steer the tool from the screen without a second write path, a second
diff, or a confirmation that can approve bytes they did not see. The writers already have
the shape this needs. Every one previews without `--yes`, journals its write set, and emits
`write.committed`; `undo` reads the same journal.

## Rulings

1. **The allowlist is fixed and narrow.** Only `work setup`, `knowledge build`, `slice
   start`, `slice finish`, `plan done`, `sync` and `undo` are accepted. The command is a
   string from that list, not a shell, and repo-declared validators are never run from the
   studio. An off-allowlist command is refused before a command function is called.

2. **Preview is the writer without `--yes`.** The preview runs the same command function
   the CLI dispatches, in its own preview mode, and returns the write plan it produced plus
   a digest of that plan. A preview writes no bytes and creates no journal.

3. **The digest covers the plan, including the before side.** Apply accepts the digest from
   the preview, re-runs the preview, and refuses if the re-derived digest differs. A file
   edited between the two requests changes the plan, so the apply is a stale-plan refusal,
   not a merge. A request that skips preview has no digest to confirm and is refused.

4. **Apply is the same writer with `--yes`.** The apply invokes the command function the CLI
   invokes, so its journal set, its `write.committed` event and its `undo` behavior are the
   CLI's. The response names the actual journal entries, not a second diff computed by the
   studio.

5. **The transport is two POST routes, nothing else.** `/api/control/preview` and
   `/api/control/apply` accept a bounded JSON body behind the session guard and are the only
   non-GET routes. No route executes arbitrary shell, and no read route becomes a writer by
   accident.

6. **The screen asks.** The confirm view names every file, shows the full before/after diff
   it received, displays the digest, and requires an explicit apply action. There is no
   default button, no auto-apply and no batch. `undo` is offered from the same journal.

## Consequences

- ADR-212 ruling 4 is narrowed: the studio writes only through these two routes and only
  through the listed writers. The rest of the socket remains a reader.
- A stale digest is visible as a refusal with the new digest and plan, so the reader can
  re-preview rather than guessing what changed.
- `test/studio-control.test.mjs` holds the allowlist, the digest refusal and the equal write
  set; `test/studio-events.test.mjs` holds the event surface the apply feeds.

## Rejected

- **A generic command endpoint.** It would turn a preview into a shell with a different
  name, and the allowlist is the boundary that makes the control path auditable.
- **Apply without re-preview.** The browser could hold a plan from minutes ago; re-deriving
  the digest is the only way to tell the reader their bytes moved.
- **A studio-owned journal.** The CLI's journal is the one `undo` reads; a second record
  would make the screen's undo disagree with the terminal's.
