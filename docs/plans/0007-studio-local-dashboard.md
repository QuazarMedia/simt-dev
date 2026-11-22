# Plan 0007 — Studio: a local observatory for watching and steering simt

Status: **queued** · 2026-11-21

Implementation owner: simt-dev

Baseline: `bccca7d201cb819696f3669fec74602c1a211c49`

## Outcome

A maintainer runs one command, `simt studio`, and a browser opens onto a living picture of
what simt is doing in this repository: the checks that ran and the tree they prove, the
plans and slices in flight, the claims and their lineage, the harnesses that are wired and
the decisions their hooks made, the context budget every agent pays. From the same screen
they can ask any read-only question the CLI answers, and steer the tool through its own
writers — preview first, confirm second, journaled and undoable always.

1. **See it happen.** Gate runs, policy decisions, lease claims, slice transitions and
   writes arrive live, as they are appended to the event log the tool already keeps. A
   count on screen always names the defects it counts (ADR-045); a meter says what it did
   not measure (ADR-064).
2. **Understand the state.** One overview answers "is this repository healthy, what is in
   flight, and what is the next ready slice" without running five commands. The knowledge
   graph, the evidence chain and the harness wall are pictures of data the doors already
   return — never a second source of truth.
3. **Steer it safely.** The studio runs read-only doors freely. Every mutating action is
   the same writer the CLI runs, shown as a preview diff, confirmed against the digest of
   exactly those bytes, recorded in the journal, and reversible with `undo`. The studio
   invents no write path (ADR-126 stays intact: MCP remains a reader).

The studio is a window, not a database. It owns no canonical state: everything it shows
can be re-derived from the repository, the ledger, the event log and the doors. Closing
the browser changes nothing; killing the server loses nothing.

## What exists and what this plan builds on

| Existing capability | What the studio adds |
| --- | --- |
| `status` aggregates check, hooks, evidence, leases, plan and journal slots, each failing independently (`src/status-snapshot.mjs`) | The overview renders the same snapshot, names every finding, and links each to the command that resolves it |
| `.simt/local/events.jsonl` is append-only with a closed kind set (`gate.started/finished`, `policy.decided`, `lease.*`, `slice.transitioned`, `write.committed/undone/undo-refused`, `lesson.captured`), explicitly designed for a live follower (`src/state/events.mjs`) | One SSE route tails it; the Pulse view is the repository's heartbeat, replayed from the file on connect so a late viewer sees the recent past |
| The ledger binds every gate run to one tree with a digest chain (`src/ledger/index.mjs`, ADR-087/197) | The Custody view draws runs per tree, shows which evidence is current and which went stale when HEAD moved |
| Every door answers as one JSON object shared by CLI and MCP (ADR-035) | The API bridge serves those same fact functions; a parity test asserts the studio's JSON equals the CLI's `--json` output |
| Writers preview before `--yes`, journal their write sets, and `undo` restores them (ADR-037) | Control is preview → confirm-by-digest → the same writer; the studio never edits a file itself |
| `harness detect`, `agent-hooks status/explain`, the policy table (`src/agenthooks/policy.mjs`) | The Harness wall shows each detected harness, its hook state, and live `policy.decided` events with the rule that fired |
| `tokens` measures what the tool wrote, per loader and per session (ADR-064/075) | The Budget view is a treemap of that measurement; session transcripts are local paths only |
| Plans are markdown trackers the tool parses (`src/plan/index.mjs`); slices have worktrees, briefs and leases | The Board renders tracker rows with dependency arrows, worktree and lease chips, and the `plan next` answer highlighted |
| No HTTP surface exists anywhere in `src/`; MCP is stdio-only; ADR-187 ruled the rollout opens no socket | A new ADR-212 permits exactly one loopback socket, opened only by explicit invocation of `simt studio`, under ADR-075's privacy contract |

**Evidence.** Inventoried the command spec, the MCP tool tables, the event/ledger/lease
stores and the harness policy module at the baseline SHA. Confirmed by search that no
`node:http` server, HTML asset or socket listener ships today. The event log's closed kind
set and the snapshot's independent slots are the two seams this plan builds on; neither
needs a new producer.

## First-session contract

```sh
simt studio                 # prints the loopback URL with a one-time token; opens nothing else
simt studio --port 4318     # a fixed port when the default is taken
simt studio --no-open       # print the URL without launching a browser
```

The server binds `127.0.0.1` only, prints `http://127.0.0.1:<port>/?token=<token>`, and serves
the shell. The token is one-shot: the first load exchanges it for an HttpOnly, SameSite=Strict
cookie and redirects to `/`, so the token leaves the address bar; a replayed token query is
refused. Every later request is checked against the cookie. `Ctrl-C` stops the server and removes nothing.
An unconfigured repository is not refused: the overview shows the same actionable next
step `work inspect` gives, and the studio becomes useful as the repository adopts.

No flag binds a non-loopback address. No request the page makes leaves the machine: no
CDN, no web font, no analytics, no favicon fetch to a third party (ADR-075). The shell is
hand-written HTML, CSS and ES modules served from the package — zero dependencies, no
build step, POSIX-only like the rest of the tool (ADR-012).

## Design language — "mission control for a repository's nervous system"

The studio should feel like an instrument, not an admin panel.

- **One dark observatory theme and one light day theme**, switchable, honoring
  `prefers-color-scheme`. Deep ink backgrounds, one phosphor accent for live data, one
  warm accent for warnings, one cold accent for evidence. System font stack only;
  tabular numerals for every count.
- **The Pulse is the home heartbeat.** A horizontal time ribbon of events, newest at the
  right, each kind with its own glyph and color; gate runs draw as brackets that close
  when the finish event lands. Hovering an event names its subject; clicking opens the
  relevant view filtered to it. With `prefers-reduced-motion`, nothing animates.
- **The Constellation** draws the claim graph on a `<canvas>`: artifacts as stars sized
  by section count, claims as points, typed edges as lines whose style encodes the kind
  (`supports` solid, `derived-from` dashed, proposed edges faint). A deterministic
  layout (sorted ids, fixed seed derived from the corpus digest) so the same corpus
  always draws the same sky. Clicking a node opens the `why` panel: citation, byte range,
  revision, both time axes, conflicts on both sides.
- **The Custody chain** draws gate runs as links bound to tree SHAs; the current tree's
  chain is bright, superseded trees dim but inspectable. A failed link is never hidden
  behind a green summary (ADR-045).
- **The Board** is the tracker as a dependency graph of cards, lanes as columns, tier as
  card weight, the `plan next` answer wearing the accent. Worktree and lease chips tell
  the reader which slices are claimed by which session right now.
- **The Helm** is a keyboard-first command palette (`Cmd/Ctrl-K`): every read-only door,
  typed arguments, the same JSON the CLI prints, rendered as an inspectable tree with a
  "copy as CLI command" affordance so the screen always teaches the terminal.
- **Every picture is explainable.** Each view carries a "how this was computed" footer
  naming the door or file it read, and every count links to the named rows behind it.
  Determinism is the aesthetic: no random layout, no invented data, no spinner that
  hides a refusal — a refusal renders as itself, with its remedy.

Accessibility is a hard gate: full keyboard navigation, visible focus, ARIA live regions
for the event feed, contrast checked in both themes, and every canvas picture paired
with a table view that carries the same data.

## Architecture and security contract

- **One process, one socket.** `src/studio/server.mjs` owns the `node:http` listener;
  routes are a small table. Static assets live under `src/studio/public/` and are served
  with a strict CSP (`default-src 'self'`), `X-Content-Type-Options: nosniff`, and no
  CORS headers. Host and Origin headers are validated against the bound loopback
  address (DNS-rebinding defense); the token is compared in constant time.
- **The API is the doors.** `src/studio/api.mjs` maps routes to the same fact functions
  the commands call (ADR-035). No route recomputes what a door already answers. Path
  arguments go through `src/trust/paths.mjs` containment (ADR-205); denied and private
  paths are filtered exactly as the corpus filters them, before anything is serialized.
- **Live data is one file.** The SSE route tails `.simt/local/events.jsonl` from a byte
  offset, replays a bounded recent window on connect, and heartbeats. It never writes.
- **Control is the writer.** A new decision record settles the control path: an allowlist of
  mutating commands, each invoked first in preview mode; the confirm request carries the
  digest of the previewed write plan and is refused if the plan changed underneath it;
  the apply runs the same command function with `--yes` semantics, journals, and appears
  in the Pulse as `write.committed`. `undo` is offered from the same journal the CLI
  reads. No route executes arbitrary shell, and repo-declared validators are not run
  from the studio in this plan.
- **Surface disposition.** `simt studio` ships as `optional` in the surface inventory
  (ADR-207) until ST15 qualifies it; MCP gains no tools (ADR-126); no existing command's
  output changes (ADR-187's contract ruling stands — only its no-socket clause is
  amended, by ADR-212, for this explicitly invoked surface).
- **Budgets.** The whole shell (HTML + CSS + JS, uncompressed) stays under 120 KB; the
  server answers any read route in under 50 ms on the fixture repository; the test suite
  asserts both. No asset over the file-line ceiling; views split into small modules.

## Data ownership

- **Canonical state stays where it is.** Trackers in `docs/plans/`, claims in documents,
  evidence in the ledger, events in the event log. The studio writes none of these
  directly; only the tool's writers do, through the control path.
- **Local state.** The studio keeps nothing on disk between runs except what the writers
  journal. The token lives in process memory; the cookie dies with the browser session.
- **Privacy.** Ignored, denied and private paths never render raw content. Session
  transcript measurement accepts local paths only and refuses URLs (ADR-075). The event
  feed shows event metadata, not file contents.

## Tracker

| ID | Slice | Phase | Lane | Tier | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ST01 | One loopback socket: the studio server, token and command | Foundation | server | M | — | Complete | f819a7096fcb45eb86a1f55f39a807fbbf410874 · test: node --test test/studio-server.test.mjs test/spec.test.mjs test/docs.test.mjs test/help.test.mjs |
| ST02 | The API bridge serves the doors' own objects | Foundation | api | S | ST01 | Complete | 93c906755cd5bbc2d41fcf6c5ba1b459e07d883f · test: node --test test/studio-api.test.mjs test/studio-server.test.mjs |
| ST03 | The shell: design system, themes, navigation, zero external assets | Foundation | shell | M | ST01 | Complete | 8af3bcde8f8eba8cd56dbeca6dae367c373df7b5 · test: node --test test/studio-shell.test.mjs test/studio-server.test.mjs test/studio-api.test.mjs |
| ST04 | Overview: the snapshot with every defect named | Observe | views | S | ST02, ST03 | Complete | 67a9131297900196a8916624dd92b8160836c51f · test: node --test test/studio-overview.test.mjs test/studio-api.test.mjs |
| ST05 | The Pulse: live events over SSE, replayed on connect | Observe | views | M | ST02, ST03 | Complete | de07984 · test: node --test test/studio-events.test.mjs test/studio-server.test.mjs |
| ST06 | The Board: plans, slices, worktrees and leases | Observe | views | S | ST04 | Complete | e5b9afc · test: node --test test/studio-plans.test.mjs test/plan.test.mjs |
| ST07 | Custody: gate evidence bound to trees | Observe | views | S | ST02, ST03 | Complete | f79cfee · test: node --test test/studio-evidence.test.mjs test/ledger-evidence.test.mjs |
| ST08 | The Constellation: knowledge graph with the why panel | Observe | views | M | ST02, ST03 | Complete | dd68837 · test: node --test test/studio-knowledge.test.mjs test/work-query.test.mjs |
| ST09 | The Harness wall: detection, hooks and live policy decisions | Observe | views | S | ST05 | Complete | c11f580 · test: node --test test/studio-harness.test.mjs test/studio-events.test.mjs |
| ST10 | The Budget: token treemap and session split | Observe | views | S | ST02, ST03 | Complete | 5c67184 · test: node --test test/studio-tokens.test.mjs test/tokens.test.mjs |
| ST11 | The Helm: a command palette for every read-only door | Steer | control | M | ST02, ST03 | Complete | 621578c · test: node --test test/studio-helm.test.mjs test/studio-api.test.mjs test/mcp-spec.test.mjs |
| ST12 | Guarded control: preview, confirm by digest, journal, undo | Steer | control | L | ST11, ST05 | Complete | 2cd1816 · test: node --test test/studio-control.test.mjs test/undo.test.mjs test/studio-events.test.mjs |
| ST13 | The Library: lessons and skills browsers | Steer | views | S | ST02, ST03 | Complete | 06350cb · test: node --test test/studio-library.test.mjs test/lessons.test.mjs test/skill-coverage.test.mjs |
| ST14 | The Bench room: reports and comparisons as charts | Steer | views | S | ST02, ST03 | Complete | 45b5298 · test: node --test test/studio-bench.test.mjs |
| ST15 | Qualify the studio: installed fixtures, budgets, accessibility, surface | Release | release | M | ST04, ST09, ST12, ST13, ST14 | Complete | b1711fb · test: node --test test/studio-release.test.mjs test/pack.test.mjs test/shipped.test.mjs test/studio-server.test.mjs test/studio-control.test.mjs — 5823334 · test: node --test test/studio-release.test.mjs test/pack.test.mjs test/shipped.test.mjs test/studio-server.test.mjs test/studio-control.test.mjs — 4f120ab · test: node --test test/studio-shell.test.mjs — 0d769ae · test: node --test test/studio-release.test.mjs test/pack.test.mjs test/shipped.test.mjs test/studio-server.test.mjs test/studio-control.test.mjs — a764c8a · test: node --test test/studio-shell.test.mjs test/studio-control.test.mjs test/studio-library.test.mjs test/studio-bench.test.mjs |

ST15 qualification limits: the 50 ms read-route budget is met by every read route except
`/api/status` (~65–75 ms) and `/api/check` (~130–145 ms), which run the same command work
as their CLI doors and have recorded exception ceilings in the server test. The
keyboard-only walkthrough of every room in both themes is an excluded manual check; it
must be performed and recorded before claiming a complete accessibility pass. ADR-228
carries the same limits.

ST04 is the first useful screen. ST05 makes it live. ST12 makes it a cockpit. ST15 is the
release exit. Lanes own disjoint file sets: `server` owns `src/studio/server.mjs` and the
command row; `api` owns `src/studio/api.mjs`; `shell` owns `src/studio/public/` core
assets; each `views` slice owns its own view module; `control` owns the helm and the
control route; `release` owns qualification tests and docs.

## Slices

### ST01 — One loopback socket: the studio server, token and command

Write ADR-212 first: the studio opens exactly one socket, bound to `127.0.0.1`, only when
`simt studio` is invoked; it amends ADR-187's no-socket clause for this surface and keeps
ADR-075 intact. Add the `studio` command to the spec (`writes: 'none'`, no MCP row,
disposition `optional` per ADR-207), the flags (`--port`, `--no-open`) to argv, and
`src/studio/server.mjs`: bind loopback only (refuse any other address with a remedy),
pick the default port or the named one, mint a 256-bit token with `node:crypto`, print
the URL, exchange the token for an HttpOnly SameSite=Strict cookie, validate Host/Origin
on every request, compare the token in constant time, serve a placeholder shell with the
strict CSP, and shut down cleanly on SIGINT/SIGTERM. `--no-open` prints without launching
a browser; opening uses the platform opener and never blocks the server. No route writes
anything. Regenerate docs with `simt docs commands --yes`.

**Acceptance.** A test starts the server on an ephemeral port in a fixture repository and
asserts: the bind address is loopback; a request without the token is refused; the token
exchange sets the cookie and a replayed token query is refused; a foreign Host or Origin
header is refused; the CSP and nosniff headers are present; a non-loopback bind attempt
exits with a remedy; SIGINT closes the socket and leaves the repository byte-identical;
`simt studio --help` and the rendered docs name only shipped flags. Run
`node --test test/studio-server.test.mjs test/spec.test.mjs test/docs.test.mjs test/help.test.mjs`.

### ST02 — The API bridge serves the doors' own objects

Add `src/studio/api.mjs`: a route table mapping `GET /api/status`, `/api/check`,
`/api/plan`, `/api/plan/next`, `/api/work` to the same fact functions `status`, `check`,
`plan status`, `plan next` and `work inspect` call, serialized exactly as their `--json`
payloads. Unknown routes return the same refusal shape the doors use (`ok:false`, error,
remedy). Every path-bearing parameter goes through `assertWithin` containment; a request
for a denied path is refused before reading. The bridge holds no cache: each request
re-derives, so the screen cannot drift from the terminal.

**Acceptance.** For each route, the studio's JSON deep-equals the CLI's `--json` output
on the same fixture repository (the ADR-035 parity assertion, extended to a third
transport). A traversal attempt (`../` or absolute path) is refused with the containment
remedy; an unknown route answers the refusal shape, not a 404 page. Run
`node --test test/studio-api.test.mjs test/studio-server.test.mjs`.

### ST03 — The shell: design system, themes, navigation, zero external assets

Build `src/studio/public/`: `index.html`, one stylesheet with the two themes as CSS
custom properties, and small ES modules for the router, the fetch client (cookie auth,
refusal rendering), and shared components (card, table, badge, empty state, refusal
panel with remedy). System fonts only; every URL the shell references is same-origin —
a test scans the assets and fails on any external scheme, `url(` to another host, or
`@import`. Keyboard navigation, visible focus, `prefers-reduced-motion` and
`prefers-color-scheme` honored. The shell renders a navigation skeleton and a loading
state that never hides a refusal. Total asset bytes under 120 KB, asserted.

**Acceptance.** Asset tests assert: no external reference in any shipped asset; the byte
budget holds; every module is under the file-line ceiling; the refusal component renders
error and remedy from a door-shaped payload; theme and reduced-motion media queries are
present. A server test fetches every asset and checks content types and the CSP. Run
`node --test test/studio-shell.test.mjs test/studio-server.test.mjs`.

### ST04 — Overview: the snapshot with every defect named

The first real screen. Render the status snapshot as cards: check findings (each named,
with its remedy command), git and agent hook state, evidence state for the current tree,
active leases, plan progress, journal/undo availability. Every count links to the rows
behind it (ADR-045): clicking "3 findings" expands the three, not a summary. Each slot
fails independently, exactly as the snapshot does — one broken slot renders its error
while the rest answer. An unconfigured repository shows the `work setup` next step, not
an error page. A "how this was computed" footer names `simt status --json`.

**Acceptance.** View-model tests (pure modules, no DOM) assert: a fixture snapshot with a
failing slot renders the other slots; every finding appears with its remedy; counts equal
the named rows' length; the unconfigured fixture produces the setup next step. A server
test asserts the overview route's payload equals the snapshot. Run
`node --test test/studio-overview.test.mjs test/studio-api.test.mjs`.

### ST05 — The Pulse: live events over SSE, replayed on connect

Add `GET /api/events` (SSE): on connect, replay a bounded recent window of
`.simt/local/events.jsonl` (the last N events, byte-bounded), then tail from the recorded
offset, emitting each new line as an event with its ULID id; heartbeat comments keep the
connection honest; a rotated or truncated log is detected and the client told to re-sync.
The view module draws the time ribbon: kinds as glyphs, gate brackets that close on
`gate.finished`, click-through to the subject's view. The feed is an ARIA live region;
with reduced motion, new events append without animation. The route never writes and
never reads file contents — event metadata only.

**Acceptance.** A test appends events to the fixture's log while connected and asserts
they arrive in order with their ids; a late connector receives the replay window; a
simulated rotation produces the re-sync signal, not duplicate or lost events; the
payload carries no file content. View-model tests assert bracket pairing and kind
filtering. Run `node --test test/studio-events.test.mjs test/studio-server.test.mjs`.

### ST06 — The Board: plans, slices, worktrees and leases

Render `plan status` and `plan next` as a board: one column per lane, cards weighted by
tier, dependency arrows between cards, state as the card's spine color. The ready slice
`plan next` names wears the accent. Worktree presence (`.simt/local/worktrees/`) and
lease claims (`.simt/local/leases.json`) render as chips naming the holding session and
expiry — read through the same readers the commands use, never by parsing files twice.
Clicking a card shows its tracker row, its brief if one exists, and the exact
`slice start`/`slice finish` command (a hint in this slice; control arrives in ST12).

**Acceptance.** View-model tests on a two-plan fixture assert: dependency edges match the
tracker's `Depends on` cells; the highlighted card is the one `plan next` returns; a
leased path shows its session and expiry; a slice with a worktree shows it. The board's
payload deep-equals `plan status --json` plus the named readers' outputs. Run
`node --test test/studio-plans.test.mjs test/plan.test.mjs`.

### ST07 — Custody: gate evidence bound to trees

Render the ledger as chains: group runs by tree, draw the current tree's chain bright and
superseded trees dim, each link showing gate, outcome, duration and the ADR that declares
it. `evidence check`'s verdict for a typed claim renders beside the chain. A failed run
is a red link that stays visible; a stale chain says which tree it proved and that HEAD
moved (ADR-187's legacy-line ruling honored: v1 lines render as local-only). The gate
catalog with each gate's `why` is one click away.

**Acceptance.** Fixture ledger with passed, failed, stale and v1 lines: the view-model
groups by tree, marks exactly the current tree's evidence current, keeps the failed link
visible, and labels the v1 line local-only. The payload equals `evidence --json` for the
current tree. Run `node --test test/studio-evidence.test.mjs test/ledger-evidence.test.mjs`.

### ST08 — The Constellation: knowledge graph with the why panel

For a repository with a built corpus, draw the claim graph on canvas: the layout is
deterministic (sorted ids, positions derived from the corpus digest — the same corpus
draws the same sky on every machine). Edge style encodes kind; proposed edges are faint
and labeled; unknown-scope nodes sit in a separate band, never mixed in. Clicking a node
opens the why panel backed by `knowledge why --scope`: citation with byte range and
revision, authority basis, both time axes with date pickers, conflicts shown on both
sides. A rank box backed by `knowledge rank --scope` answers a question with cited hits.
A repository without a corpus shows the build next step, and a table view carries the
same graph data for keyboard and screen-reader users.

**Acceptance.** Layout tests assert determinism (two runs, identical coordinates) and
that proposed edges and unknown-scope nodes are separately classed. The why panel's
payload deep-equals the CLI's for the same claim and dates; a cold corpus produces the
build remedy, not an empty sky. Run
`node --test test/studio-knowledge.test.mjs test/work-query.test.mjs`.

### ST09 — The Harness wall: detection, hooks and live policy decisions

Render `harness detect` and `agent-hooks status` as a wall: one tile per detected harness
with its hook state (installed, drifted, untrusted, detection-only), the instruction
files it loads, and the policy table explained in the reader's terms. Live
`policy.decided` events from the Pulse stream land on the wall as they happen: the tool
call, the rule that fired, the verdict, and the `agent-hooks explain` reading one click
away. Denials are never softened into warnings.

**Acceptance.** View-model tests assert each harness state renders distinctly, a denial
event shows its rule id and verdict verbatim, and a detection-only harness is labeled as
such. The wall's payload equals `harness detect --json` and `agent-hooks status --json`.
Run `node --test test/studio-harness.test.mjs test/studio-events.test.mjs`.

### ST10 — The Budget: token treemap and session split

Render `tokens` as a treemap: rectangles sized by bytes, grouped by harness loader and
repository, the always-on budget drawn as a frame the rectangles must fit inside —
overflow is visible, not clipped (ADR-064: say what was not measured). `tokens --session`
accepts a local path typed into the view; a URL is refused client-side and server-side
with the same remedy the CLI gives (ADR-075). The split (rules, file reads, tool output)
renders as a stacked bar with shares.

**Acceptance.** View-model tests assert rectangle areas are proportional to the measured
bytes and the overflow case is flagged; a URL input is refused with the CLI's remedy
text; the treemap payload equals `tokens --json`. Run
`node --test test/studio-tokens.test.mjs test/tokens.test.mjs`.

### ST11 — The Helm: a command palette for every read-only door

A keyboard-first palette (`Cmd/Ctrl-K`) listing every read-only command from the spec,
with typed argument forms generated from each row's usage and flags — the spec is the
single source, so a new door appears in the helm without helm code changing. Results
render as an inspectable JSON tree beside a human rendering, with "copy as CLI command"
producing the exact terminal invocation. Refusals render as themselves with their
remedy. The helm executes through the API bridge's door routes only; it cannot reach a
writer (that boundary is tested, not assumed).

**Acceptance.** Tests assert the palette's command list equals the spec's read-only rows;
a generated invocation for `knowledge rank` round-trips to the same JSON the CLI prints;
a writer path is unreachable from the helm route (attempt refused); the copied CLI
string re-runs identically in the fixture. Run
`node --test test/studio-helm.test.mjs test/studio-api.test.mjs test/mcp-spec.test.mjs`.

### ST12 — Guarded control: preview, confirm by digest, journal, undo

Write the decision record: control is the writer's preview, confirmed by digest. Add the control
route with a fixed allowlist — `work setup`, `knowledge build`, `slice start`,
`slice finish`, `plan done`, `sync`, `undo` — each a two-step transaction: POST preview
runs the command in preview mode and returns the write plan plus its digest; POST apply
accepts that digest, re-runs the preview, refuses if the plan changed, then applies
through the same command function with `--yes` semantics. Every apply journals exactly
as the CLI does and emits `write.committed` to the event log; the UI offers `undo` from
the same journal, and an undo refusal renders as itself. The confirm UI shows the full
diff, names every file, and requires an explicit action — no default button, no
auto-apply, no batch. No arbitrary command execution exists on this route.

**Acceptance.** End-to-end in a fixture: preview changes no bytes; apply with the matching
digest writes exactly the previewed set and journals it; apply with a stale digest is
refused and writes nothing; a concurrent edit between preview and apply is detected;
`undo` restores the prior bytes; every step appears in the event log; an off-allowlist
command is refused. The applied write set deep-equals the CLI writer's for the same
arguments. Run `node --test test/studio-control.test.mjs test/undo.test.mjs test/studio-events.test.mjs`.

### ST13 — The Library: lessons and skills browsers

Render `lessons list` as two shelves — candidates and promoted — with each candidate's
fail-then-fix story and the `lessons review` command beside it (hint only; review stays
a CLI act in this plan). Render `skills index` as a card catalog with byte sizes and
deferred flags; `skills show` opens the body in a reading pane. Search filters both
shelves client-side over the fetched payload; nothing is re-ranked by a heuristic the
CLI does not own.

**Acceptance.** View-model tests assert candidate/promoted separation, byte labels match
the registry, and the reading pane's body equals `skills show --json`'s. Run
`node --test test/studio-library.test.mjs test/lessons.test.mjs test/skill-coverage.test.mjs`.

### ST14 — The Bench room: reports and comparisons as charts

Render `bench report` as charts over the vault's summary: recall and outcome
distributions, and `--compare a b` as paired bars with the delta named. The optional
package's absence is a labeled state with the install next step, not an error
(ADR-187: absent adapter leaves the default intact). Offline doc-input doors
(`bench replay`, `bench calibrate`) render their verdicts — including a calibration's
false-accept bound — as plainly as the CLI prints them. No chart averages a failure away:
failing tasks are named beneath every aggregate.

**Acceptance.** With the bench package present in the fixture, the report payload equals
`bench report --json` and failing tasks are named; without it, the room shows the labeled
absent state. A calibration payload renders its decision and bound verbatim. Run
`node --test test/studio-bench.test.mjs`.

### ST15 — Qualify the studio: installed fixtures, budgets, accessibility, surface

Prove the studio from a packed install in clean standalone clones of both fixture shapes
(document corpus and code repository), as a consumer runs it (ADR-031): `simt studio`
opens, the overview answers, the Pulse follows a gate run started from another terminal,
the helm answers a cited question, and one guarded control round-trip (setup → build →
ask) completes with journal and undo. Assert the byte and latency budgets, walk every
view by keyboard only, check both themes' contrast, and verify no request leaves loopback
(the server logs every request; the test asserts the set). Promote the surface disposition
per ADR-207 with the qualification evidence, regenerate docs, and record the two
transcripts as sanitized fixtures.

**Acceptance.** Run `node --test test/studio-release.test.mjs test/pack.test.mjs test/shipped.test.mjs test/studio-server.test.mjs test/studio-control.test.mjs`
from a packed install at a path with no siblings; both transcripts exist as fixtures;
the surface inventory names `studio` with its disposition and the qualification SHA.
Manual browser walkthrough named in the review: every view, keyboard-only, both themes.

## Out of scope

Remote access and multi-user sessions; running repo-declared validators or arbitrary
commands from the browser; editing documents or claims in the UI (the studio steers the
tool, not the content); a mobile layout beyond responsive basics; telemetry of any kind
(ADR-075); new MCP tools (ADR-126). Each would need its own ruling before it is planned.