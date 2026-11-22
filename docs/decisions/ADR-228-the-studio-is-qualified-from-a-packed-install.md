---
simt-affects: ["src/surface.mjs", "src/studio/server.mjs", "src/docs/reference.mjs", "docs/reference/surface.md", "test/studio-release.test.mjs", "test/studio-server.test.mjs", "test/fixtures/studio", "docs/plans/0007-studio-local-dashboard.md"]
---

# ADR-228 — the studio is qualified from a packed install

Status: accepted · 2026-11-22 · the `/api/check` 200 ms value is superseded by ADR-242 (300 ms); the method stands

## Context

ST01–ST14 proved each studio room against the checkout. That is not how a consumer runs
it: the shell, control route and optional bench package have to survive `npm pack`, an
install with no siblings, and a clean repository. The release slice also has to leave two
sanitized transcripts a maintainer can compare against, and ADR-207 requires the surface
inventory to say what was qualified and at which code SHA.

## Rulings

1. **Qualification runs from the artefact.** `test/studio-release.test.mjs` packs the
   working tree, installs the tarball into a standalone consumer, and drives the installed
   `studio` binary. It does not import the checkout's server to answer the install claims.
2. **Both fixture shapes share the same contract.** A document corpus and a code repository
   each open a loopback studio; the overview answers, the helm reads a cited row, and one
   guarded `work setup` preview/apply/undo round-trip completes with journal and event
   evidence. A fixture that only works because the checkout is adjacent is not qualified.
3. **The transcripts are fixtures, not prose.** `test/fixtures/studio/qualification-document.json`
   and `qualification-code.json` record the commands, status, asset bytes and the
   loopback request set, with paths sanitized. They are compared for structure and
   provenance, never for live timing.
4. **The surface row carries the evidence.** `src/surface.mjs` keeps studio `optional` —
   it is supported when used, but it is not part of the adoption path — and records the
   qualification SHA `f6760f1`, the read-route latency commit these transcripts measure.
   The first qualification was `b1711fb`; the SHA names the commit whose studio behavior
   the transcripts measure, so a test-only change that leaves that behavior intact does
   not move it. The generated `docs/reference/surface.md` renders that row, so a reader
   can go from the promise to the evidence without a second inventory.
5. **The manual walkthrough is excluded, not claimed.** Keyboard-only traversal of every
   view in both themes is a manual check the suite cannot perform. The shell test asserts
   the stylesheet's theme selectors, focus styles, reduced-motion rule and asset budget,
   not rendered tab order or contrast. The server test asserts the loopback URL and the
   foreign Host and Origin refusals; the qualification transcripts record no external
   requests. A human must perform and record the walkthrough before a complete
   accessibility pass is claimed, and this record does not claim it was performed.
6. **Read-route ceilings are measured, not inherited.** The server test covers every GET
   path in `STUDIO_READ_ROUTES`; the SSE feed is measured to first byte because it does
   not complete. The status snapshot is one git call instead of three. Under four-way
   suite concurrency every read except the full gate gets a 75 ms ceiling; `/api/check`
   gets 200 ms. The 50 ms warm budget and the measurements below remain the target, not a
   second assertion. A new GET path fails coverage until the test names it.

## Read-route latency limits

`test/studio-shell.test.mjs` asserts the 120 KB asset budget, and the server test asserts
the loopback URL and the foreign Host and Origin refusals. `test/studio-server.test.mjs`
measures every GET path in the server's `STUDIO_READ_ROUTES` inventory; the SSE feed is
measured to first byte because it never completes, and the shell entry, stylesheet and app
module are measured with the routes. A new GET path reaches the inventory through the
route table and fails the coverage assertion until the latency test names it.

In the warm run, only `/api/check` exceeds the 50 ms budget. Under four-way suite
concurrency the test holds every read except the gate to a 75 ms ceiling, so CPU contention
does not turn a correct read into a failure; `/api/check` is the substantive exception at
200 ms. A warm seven-sample fixture run on 2026-11-22 measured:

- `/api/status` at **42.8 ms median** (41.4–44.5 ms) after collapsing three
  `git rev-parse` spawns into one `HEAD HEAD^{tree}` call; its recorded ceiling is 75 ms.
- `/api/check` at **105.1 ms median** (101.6–124.6 ms), because it runs the full gate;
  its recorded ceiling is 200 ms.
- `/api/helm?path=status` at **44.1 ms median** (43.4–50.9 ms), because the Helm executes
  the same status door; its recorded ceiling is 75 ms.
- `/api/evidence/chains?claim=…` at **53.9 ms median under full-suite concurrency**
  (under 50 ms in a quiet run), because the claim verdict runs `git write-tree` on a
  private index; its recorded ceiling is 75 ms.

The other routes measured 0.2–31.6 ms, with the plain evidence-chain reads at the high end.
These are suite ceilings, not silent passes: 75 ms is headroom over the 50 ms warm budget,
and the claim walk is the one other read that measured above that budget when the suite
was loaded. `/api/check` remains the substantive exception at 200 ms. The test asserts a
warm three-sample median under `--test-concurrency=4`.

The full keyboard-only walkthrough of every room in both themes is excluded from
automation: the suite has no browser dependency, and the shell tests assert theme
selectors, focus styles and reduced-motion rules rather than rendered tab order or
contrast. A human must perform and record that walkthrough before claiming a complete
accessibility pass; ST15 records it as an excluded manual check, not as a completed one,
and this decision does not claim it was performed.

## Consequences

- A studio behavior change after `f6760f1` must regenerate the qualification SHA and the two
  transcripts; the release test fails when the surface page and the fixtures drift.
- The optional bench is not required for qualification; its absence is exercised as the
  labelled state in ST14, and the transcripts record whether it was present.
- No new dependency, port or external origin arrives with the release slice.
