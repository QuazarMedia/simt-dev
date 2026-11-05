# Review 0004 — remediation of the five audits at `29f58e9`

Status: **queued** · 2026-11-05
Reviewed at: `29f58e9` on `main` (clean, level with `origin/main`). Package version `0.10.0`.
Sources: five read-only audits (packaging, CLI/MCP, plan 0004 work, index/brief/init, hooks/secrets/ledger). This review did not re-run those reproductions and did not run `npm test`. It re-read the cited lines and kept a finding only where the tree at `29f58e9` still matches it.

**§3 is the only tracker of slice state.** When a row changes state, record the SHA and the exact test command in it. A finding in §4 is closed here: it is not a row, and a later slice does not reopen it.

## Summary

The suite the audits ran is not the defect. The defects are places an agent gets a quiet wrong answer, or a check that does not mean what its name says.

1. **A clean parse can hide a push.** `applies()` trusts `parsed === true` and never falls back to the push regex, so `busybox git push` is allowed (A09). `git pull -r` is the same hole one flag wide (A10).
2. **Several readers treat a failure as an empty success.** A missing skill registry becomes an empty bench (A01). A changed CJK file leaves the old `fts_tri` rows searchable (A02). `knowledge why` prints an invalid claim and exits 0 (A06). A stale MCP cursor is an empty page (A15). A corrupt overlay reads as no overlay (A21).
3. **`run()` and the CLI do not emit the same JSON.** The process document carries `exitCode` and `deprecated`; the library document does not (A13). A `MAX_BYTES` document can still leave the process at exit 0 (A14).
4. **One lease token is reusable after the lease dies.** `acquire` stamps the caller's `fencing` (default `1`) on a new grant, and the test at `test/work-leases.test.mjs:62` pins that (A08).
5. **The 1000-line ceiling is one slice away** on `dispatcher.mjs` (980), `init.mjs` (957), `lessons.mjs` (952), and four test files at 982–997. The pre-push fix (A12) lands after the dispatcher split (A11), because the fix has to add lines.

57 slices. 1 P0, 13 P1, 27 P2, 16 P3. Lanes own disjoint files; a later row in the same lane names the earlier row under Depends on, so two agents never take both.

## 1. Scope and method

Read against `29f58e9`: the modules the audits named, plus the second copy of a sentence where the first copy was the finding (`manifest.mjs`, `compare/row.mjs` for the `simt-dev` remedies). Line counts below are `wc -l` on this tree, not the audits' counts; they matched.

Not done: the audits' reproduction scripts, `npm test`, `node scripts/verify-wheel.mjs`, a Homebrew render, a live MCP session. A slice's acceptance command is what the implementer runs. It is not a claim that this review ran it.

### 1.1 Rulings for every slice

- Nothing an adopted repository runs today changes spelling. New behaviour is a stricter refusal or a field the old clients ignore.
- A graph Q77 already split stays split. `gate` and `impact` walk the import closure; `tests` walks stored test edges; `tests --run` delegates to `gate`. A38 writes that down. It does not unify the walks.
- A lease stays advisory. ADR-101 ruling 1 already says `SIMT_SESSION` is the caller's name and the file is not a lock. §4 records the spoof and the hook TOCTOU as that ruling, not as new work.
- `hasTestEvidence` keeps the v1 reading its comment states (a passing line with no `kind` still counts). Rotation is the bound. §4.
- The output fallback stays the one-shot path that runs before `withOutputState()`. Replacing it with a fresh object per call drops warnings on that path. §4.
- `brief` without a new flag keeps today's packet. The proof packet is opt-in (A39).
- A policy change that the current comment chose — hooks-disable has no regex, alias lookup fails open — lands with a new decision record. `simt decide` assigns the number. Do not edit ADR-101 or ADR-104 in place.
- A split leaves every successor under 900 lines. The hard finding is `FILE-LINES` (over 1000). `FILE-LINES-WARN` (over 400) on a file this review does not name is not a slice.

## 2. Vocabulary

- **Severity**: **P0** a security hole a mediated agent can hit; **P1** a wrong answer an agent will act on; **P2** a contract or maintainability gap; **P3** hygiene.
- **Group**: **F** fix; **S** security; **D** docs or tests only; **C** a split or a dedupe with no behaviour change.
- **Effort** is the tier: **S** half a day, **M** up to three. `plan next --tier S` reads this column.
- **Lane** is the file set. Two lanes can run at once. Two rows of one lane cannot. `plan next --lane <name>` stays inside one.
- **State**: Queued, In progress, To review, Complete, Accepted.

## 3. Tracker

| ID | Slice | Sev | Grp | Lane | Effort | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01 | Bench run treats a missing skill registry as an empty one | P1 | F | bench | S | — | Complete | b61bbca8d805efcc2c1e9bb1c7236ed5c324aaf2 · test: node --test test/bench.test.mjs test/bench2.test.mjs test/bench3.test.mjs |
| A02 | Reindexing a changed file leaves stale `fts_tri` rows | P1 | F | index | S | — | Complete | ce8a7b411c56514d32580d5afe4da8ed65b3f887 · test: node --test test/index.test.mjs test/index-tri.test.mjs |
| A03 | `classifyTask` reads "failure" as a bugfix | P1 | F | brief | S | — | Complete | 1f5f987b5caeaba7e402b623fad0f6ac078c9834 · test: node --test test/work-intent.test.mjs |
| A04 | `evaluateIntent` throws when a corpus label is not an intent | P1 | F | brief | S | A03 | Queued | — |
| A05 | Impact scope ignores `claim.applicability.scope` | P1 | F | impact | S | — | Queued | — |
| A06 | `knowledge why` exits 0 on a claim `readClaim` refused | P1 | F | knowledge | S | — | Queued | — |
| A07 | A refused sibling claim still enters the why-graph | P1 | F | knowledge | S | A06 | Queued | — |
| A08 | A new lease grant reuses fencing token 1 | P1 | F | fencing | S | — | Queued | — |
| A09 | A parsed command with no git fact skips the push regex | P0 | S | agenthooks | M | — | Queued | — |
| A10 | `git pull -r` is not treated as a rewrite | P1 | S | agenthooks | S | A09 | Queued | — |
| A11 | Split `dispatcher.mjs` so the pre-push fix has room under 1000 | P2 | C | dispatcher | M | — | Queued | — |
| A12 | Pre-push runs the other gates on the dirty tree when test is skipped | P1 | F | dispatcher | M | A11 | Queued | — |
| A13 | `run()` JSON omits `exitCode` and superseded-flag `deprecated` | P1 | F | envelope | M | — | Queued | — |
| A14 | A `MAX_BYTES` document can still exit 0 | P1 | F | envelope | S | A13 | Queued | — |
| A15 | A numeric MCP cursor past the list is an empty page | P1 | F | paginate | S | — | Queued | — |
| A16 | MCP `knowledge_why` cannot page or ask a bitemporal question | P2 | F | mcpwork | S | — | Queued | — |
| A17 | MCP `knowledge_import` reports `ok: true` when the import failed | P2 | F | mcpwork | S | A16 | Queued | — |
| A18 | `knowledge why` prints the page limit as a page count | P3 | F | knowledge | S | A07 | Queued | — |
| A19 | `--limit` and `--page` accept a non-integer and silently default | P2 | F | knowledge | S | A18 | Queued | — |
| A20 | `openIndex().search` stringifies an error object | P2 | F | open | S | — | Queued | — |
| A21 | A corrupt SQLite overlay reads as an empty overlay | P2 | F | overlay | S | — | Queued | — |
| A22 | An FTS term containing `"` breaks the MATCH expression | P2 | F | fts | S | — | Queued | — |
| A23 | `hooks-disable` has no regex when the tokenizer fails | P2 | S | agenthooks | M | A10 | Queued | — |
| A24 | Git alias lookup fails open on timeout | P2 | S | agenthooks | S | A23 | Queued | — |
| A25 | The secret scan judges each added line alone | P2 | S | secrets | S | — | Queued | — |
| A26 | `slice start` can leave a lease or a worktree behind | P2 | F | slice | M | — | Queued | — |
| A27 | `slice finish` reports a SHA when the tracker write failed | P3 | F | slice | S | A26 | Queued | — |
| A28 | `read-channel-equivalence` ignores `before` and `after` | P2 | F | replay | S | — | Queued | — |
| A29 | `mine.mjs` keeps a second process timeout beside `spawnBounded` | P2 | C | mine | S | — | Queued | — |
| A30 | `lintRegistry` does not require registry `version` 1 | P2 | F | graph | S | — | Queued | — |
| A31 | The wheel assertion's failure text says the opposite of the match | P3 | D | shipped | S | — | Queued | — |
| A32 | `brew style` runs before the formula is rendered | P3 | D | publish | S | — | Queued | — |
| A33 | `test/pack.test.mjs` names a `simt-dev` bin the package does not install | P3 | D | pack | S | — | Queued | — |
| A34 | Shell completions omit alias tokens the dispatcher accepts | P3 | F | complete | S | — | Queued | — |
| A35 | A schema with `required` and no `type` accepts a non-object | P3 | F | schema | S | — | Queued | — |
| A36 | MCP cancel uses `===` on request ids | P3 | F | cancel | S | — | Queued | — |
| A37 | Check remedies tell a consumer to expect the name `simt-dev` | P2 | F | wording | S | — | Queued | — |
| A38 | Help does not say that gate, tests, and impact walk different graphs | P2 | D | spec | S | A16 | Queued | — |
| A39 | `brief` never builds the W20 proof packet | P2 | F | spec | M | A38 | Queued | — |
| A40 | Proof-packet budget counts a unit cost, not the encoded bytes | P3 | F | spec | S | A39 | Queued | — |
| A41 | Journal undo restore writes the destination in place | P3 | F | journal | S | — | Queued | — |
| A42 | `commitJournal` records `undefined` paths for git-config entries | P3 | F | journal | S | A41 | Queued | — |
| A43 | `GLOBAL_FLAGS` can drift from the spec flag rows | P3 | D | help | S | — | Queued | — |
| A44 | `doc-input.mjs` has no direct test | P3 | D | docinput | S | — | Queued | — |
| A45 | Door parity covers five MCP tools, not every spec door | P2 | D | doors | S | — | Queued | — |
| A46 | Rank stratum `queries` is never incremented | P3 | F | rank | S | — | Queued | — |
| A47 | Split `test/agenthooks.test.mjs` (982 lines) | P2 | C | t-hooks | M | — | Queued | — |
| A48 | Split `test/mcp.test.mjs` (985 lines) | P2 | C | t-mcp | M | — | Queued | — |
| A49 | Split `test/ci.test.mjs` (983 lines) | P2 | C | t-ci | M | — | Queued | — |
| A50 | Split `test/hooks2.test.mjs` (933 lines) | P2 | C | t-hooks2 | M | — | Queued | — |
| A51 | Split `test/shipped.test.mjs` (997 lines) | P2 | C | shipped | M | A31 | Queued | — |
| A52 | Split `src/commands/init.mjs` (957 lines) | P2 | C | t-init | M | — | Queued | — |
| A53 | Split `src/commands/hooks.mjs` (905 lines) | P2 | C | t-hookscmd | M | — | Queued | — |
| A54 | Split `src/memory/lessons.mjs` (952 lines) | P2 | C | t-lessons | M | — | Queued | — |
| A55 | Split `src/commands/slice.mjs` (858 lines) | P2 | C | slice | M | A27 | Queued | — |
| A56 | Split `src/knowledge/sections.mjs` (473 lines) | P3 | C | t-sections | S | — | Queued | — |
| A57 | Split `src/memory/decide.mjs` (513 lines) | P3 | C | t-decide | S | — | Queued | — |

Count: 57 slices — 1 P0, 13 P1, 27 P2, 16 P3.

| Wave | Slices | Exit criterion |
| --- | --- | --- |
| 0: wrong answers and the push bypass | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12 | A push wrapped as `busybox git push` is denied; a changed CJK file is not findable by its old body; an invalid claim does not exit 0; a second lease grant carries a new fencing token; pre-push gates see the committed tree when test is skipped |
| 1: one JSON document, honest pages | A13, A14, A15, A16, A17, A18, A19, A20, A21, A22 | `run()` and the CLI emit the same `exitCode` and `deprecated`; `MAX_BYTES` is a non-zero exit; a stale cursor is an error; MCP `knowledge_why` pages; a failed import is `ok: false` |
| 2: the remaining fail-open paths | A23, A24, A25, A26, A27 | An unparseable hooks-path command is denied; an alias-lookup failure cannot hide a push; a failed `slice start` leaves neither lease nor worktree |
| 3: contracts, wording, and the small bugs | A28, A29, A30, A31, A32, A33, A34, A35, A36, A37, A38, A39, A40, A41, A42, A43, A44, A45, A46 | A consumer's check remedy names `simt` or "this tool"; registry version 1 is enforced; channel equivalence reads the answers it is given; `brief --proof` can return a proof packet and plain `brief` is unchanged |
| 4: under the line ceiling | A47, A48, A49, A50, A51, A52, A53, A54, A55, A56, A57 | Every file this wave names is under 900 lines, its tests still pass, and `simt check` does not report hard `FILE-LINES` for those paths. A11 already split the dispatcher |

## 4. Closed here, no slice

These were in the audits. The tree or an accepted decision already settles them. A slice that "fixes" one of them is working against this review.

| Audit | Finding | Why it stays |
| --- | --- | --- |
| Packaging §1.1 | Versions | `package.json`, the formula, the changelog, and `simt.json` `projection.version` all read `0.10.0`. |
| Packaging §1.2 | npm and wheel byte parity | Static parity is `test/packaging.test.mjs`. Content hashing is `scripts/verify-wheel.mjs` on publish, which is the ADR-031 shape. |
| Packaging §1.3 | `graph/` absent from the package | ADR-061. `test/pack.test.mjs` asserts the exclusion. |
| Packaging §1.4 | Tag formula can lag `main` | `publish-channels.yml` re-renders from the release assets before the tap push. Homebrew installs the tap, not the tag tree. |
| Packaging §1.7, §2.1, §2.2 | SEA, the Python launcher, the formula | Audits found no defect. `MIN_NODE` matches `package.json` `engines.node`. |
| Packaging §2.6 | Archive cites `src/bench/process.mjs` | The live helper is `src/sys/proc.mjs` (A29). The archive stays a record of what was true when it was written. |
| Packaging §3.2–§3.6, §5.1–§5.3 | Plugins, federation, local, critic, packs, own CI, releasing docs, playbooks | Read as designed. Federation `CLIENT_INFO.version` is the protocol value `'1'`, and `CLIENT_INFO.name` stays the package name. |
| Packaging §4.3 | `publish.yml` is 448 lines | Warn threshold is 400. The hard failure is 1000. Splitting the release workflow hides one job. |
| CLI §10 | Shared output fallback | `run()` and `dispatch()` open `withOutputState()`. The module fallback is the path before that store exists. A fresh object on every `state()` call drops the warnings that path accumulates. |
| CLI, minor | `resources/list` `size` is disk bytes | The module comment already says so. |
| Plan 4 §4 vs ADR-101 | `SIMT_SESSION` is the caller's string | ADR-101 ruling 1: the session comes from `--session` or `SIMT_SESSION`, and the file is advisory data, not a credential. Spoofing the variable is that ruling. |
| Plan 4 / hooks §9 | Hook reads leases without `withLeaseLock` | Same ruling: "there is no lock on the file". The command's lock protects its own read-modify-write. Putting the hook under that lock would be a new decision, and this review does not open one. |
| Hooks §4 | `SIMT_ALLOW` stripped in git hooks, kept for agents | ADR-001. The agent override is the point of the variable. |
| Hooks §14 | v1 ledger lines satisfy `hasTestEvidence` | The function comment states the compatibility: a line with no `kind` still counts, so an old ledger does not go red. v2 writes `kind`. Rotation bounds the window. |
| Hooks §15 | Observe-only boundary allows unclassified shell | Mediated boundaries deny. Production harnesses that need the denial install the mediated hook. |
| Plan 4 §11 | `agent-hooks explain` is always JSON | ADR-190. `test/command-agenthooks-explain.test.mjs` pins it. |
| Index §12 | Overlay edge dedup keeps the first edge | Import edges do not carry metadata the overlay is supposed to replace. |
| Index §6 and §9, the behaviour half | Make `gate`, `tests`, and `impact` use one graph | Q77 already assigned the walks. The unread half is A38, which is the help text. |
| Index §14 | `plan/index.mjs` table-format comments | No defect found. The parser tests own that risk. |

## 5. Decisions a slice has to open

Only a change to what the tool believes needs a record. `node bin/simt.mjs decide "<title>" --yes` chooses the next number. Do not paste a number into this review.

| Slice | What the record has to say |
| --- | --- |
| A23 | A command the tokenizer cannot parse is still denied when its text matches the hooks-disable pattern. Other unparseable text stays allowed. This narrows the comment in `policy.mjs` that set `regex: null` so the new policy would not deny anything the old one allowed. |
| A24 | When `git config` fails or times out, a command whose text matches the push or rewrite regex is denied. A resolved builtin is still judged by the parsed fact. |

A09 and A10 implement the regex and the rewrite match that already exist. They do not need a record. A08 implements the monotonic token Q74 described and the current test contradicts. No new record: the test is wrong.

## 6. Wave 0 — wrong answers and the push bypass

### A01 — Bench run treats a missing skill registry as an empty one

- **Where:** `packages/bench/src/run.mjs` around the `loadRegistry()` call (line 181). `loadRegistry()` resolves `{ ok: false, registry: null, errors }` and does not throw. The `.catch` only covers a throw. The batch then scores against `skills: []`.
- **Fix:** When `regRes.ok` is not true, fail the batch. Each record carries `status: 'error'` and `regRes.errors`. An empty registry that loaded (`ok: true`, `skills: []`) stays a successful empty run.
- **Acceptance:** `node --test test/bench.test.mjs test/bench2.test.mjs test/bench3.test.mjs`, including a new case whose registry is missing. The case expects the error status and the loader's errors, and it expects no skill metric that pretends the run was empty on purpose.
- **Effort:** S. Lane `bench`.

### A02 — Reindexing a changed file leaves stale `fts_tri` rows

- **Where:** `src/index/persist.mjs`. `dropDependents` (line 329) deletes `fts` by node. `delete from fts_tri where ref = ?` runs only for `removed` (line 360). `addTri` (line 391) inserts the new body and never deletes the old one. A changed CJK file stays searchable by the text it no longer contains.
- **Fix:** Delete `fts_tri` rows for a path before reinserting them, on the same path the update rebuilds. Removal keeps the delete it has.
- **Acceptance:** `node --test test/index.test.mjs`. New case: index a file whose body contains `東京`, change the body so the term is gone, index again, and assert the trigram rows for that ref are only the new body.
- **Effort:** S. Lane `index`.

### A03 — `classifyTask` reads "failure" as a bugfix

- **Where:** `src/brief/kind.mjs` line 49, `/\bfail(?:s|ed|ing|ure)?\b/i`, tried before the feature default. `classifyTask('add failure test for checkout', …)` matches `failure`.
- **Fix:** Stop treating `failure` as a bugfix word. Keep `fail`, `fails`, `failed`, and `failing`. A task whose bugfix cue is `fix`, `bug`, `regression`, `flaky`, `crash`, `broken`, or `wrong` still classifies as a bugfix.
- **Acceptance:** `node --test test/work-brief.test.mjs`. New case: `add failure test for checkout` is `feature`. A case that says `fix the failing checkout` stays `bugfix`.
- **Effort:** S. Lane `brief`.

### A04 — `evaluateIntent` throws when a corpus label is not an intent

- **Where:** `src/brief/kind.mjs` `evaluateIntent` (line 366). `rows.get(intent)` is `undefined` when `expect` is outside `INTENTS`, and the next property read throws.
- **Fix:** Reject an unknown `expect` in the return value, with the task and the label named. Do not throw. Known labels keep today's counts.
- **Acceptance:** `node --test test/work-brief.test.mjs`. New case: `expect: 'not-an-intent'` returns a structured error and does not throw.
- **Depends on:** A03. Lane `brief`.

### A05 — Impact scope ignores `claim.applicability.scope`

- **Where:** `src/knowledge/impact.mjs` `scopeOfNode` (line 57). It reads `node.scope` and `node.claim.scope`. `readClaim` stores scope at `claim.applicability.scope`, and `buildClaimGraph` keeps that on `node.claim` without copying it to `node.scope`. A scoped claim then lands in `unknown` as `scope-missing`.
- **Fix:** Resolve scope from `node.claim?.applicability?.scope` after the two existing reads. Leave `buildClaimGraph`'s node shape alone unless a caller other than impact needs the lifted field; one reader is this function.
- **Acceptance:** `node --test test/work-impact.test.mjs`. New case built with `buildClaimGraph` and `applicability.scope`, not a hand-set `node.scope`. The claim is in `affected.claims` for a matching jurisdiction and is absent when the jurisdiction differs.
- **Effort:** S. Lane `impact`.

### A06 — `knowledge why` exits 0 on a claim `readClaim` refused

- **Where:** `src/commands/knowledge.mjs` `knowledgeWhyFacts` (lines 43–53). A failed read pushes `refused` and returns the raw record. The lookup by id then finds that record. `knowledgeCommand` sees no `error` and returns `EXIT.OK`. `renderWhy` prints `asserts undefined undefined = undefined`.
- **Fix:** When the requested id was refused, return `{ error }` before the graph is built. Name the id and the read problems.
- **Acceptance:** `node --test test/work-doors.test.mjs`. New case: a document whose only claim is `{ "id": "bad" }` makes `knowledge why bad` exit non-zero, and the JSON document carries `error` rather than an asserts line.
- **Effort:** S. Lane `knowledge`.

### A07 — A refused sibling claim still enters the why-graph

- **Where:** the same map in `knowledgeWhyFacts`. A document with one valid claim and one `{ "id": "x" }` still returns the raw sibling from the map, so `buildClaimGraph` and `findConflicts` see it.
- **Fix:** Drop a refused record from `claims`. Keep it in `refused` and in the problems list. The requested id's own refusal stays A06's error.
- **Acceptance:** `node --test test/work-doors.test.mjs`. New case: why on the valid id. The graph node count matches the valid claims, and no edge names the refused id.
- **Depends on:** A06. Lane `knowledge`.

### A08 — A new lease grant reuses fencing token 1

- **Where:** `src/coordination/leases.mjs` `acquire` (line 53). The issued `fencing` is the argument, default `1`. An expired lease is not `current` (`expiresAt > now` fails), so the takeover also stamps `1`. `checkFencing` then accepts the old token. `test/work-leases.test.mjs:62` asserts `taken.lease.fencing === 1`. That assertion is the bug.
- **Fix:** The issued token is one greater than the highest `fencing` already stored for that key, including an expired entry still in `held`. A first grant, with no history, is `1`. The caller's `fencing` argument does not rewind a token that was already issued. Same-owner renewal advances too.
- **Acceptance:** `node --test test/work-leases.test.mjs`. Extend the expired-takeover case: `taken.lease.fencing` is greater than the previous token, and `checkFencing` rejects the previous token. A same-owner renewal advances. A first grant is still `1`.
- **Effort:** S. Lane `fencing`. This file is `src/coordination/leases.mjs`, not `src/lease.mjs`.

### A09 — A parsed command with no git fact skips the push regex

- **Where:** `src/agenthooks/decide.mjs` `applies` (lines 64–70) and `src/agenthooks/policy.mjs` push `match` (line 72). When `facts.shell.parsed === true`, only `row.match` runs. A command that tokenises and never produces `kind === 'git'` (`busybox git push`, `docker run alpine git push`) matches nothing. The regex already denies the parse-failure path.
- **Fix:** If the parse produced no `kind === 'git'` fact and `row.regex` matches `facts.command`, the row applies. A real git fact keeps today's `match`. Do not unwrap every new prefix in this slice; the regex fallback is the closure.
- **Tests:** add cases to a new `test/agenthooks-audit.test.mjs`. `test/agenthooks.test.mjs` is 982 lines; this lane must not push it over 1000. Later rows in `agenthooks` append to the new file.
- **Acceptance:** `node --test test/agenthooks-audit.test.mjs test/agenthooks.test.mjs`. The new file denies `busybox git push origin main` and `docker run alpine git push`, and still allows a command the regex does not name.
- **Effort:** M. Lane `agenthooks`.

### A10 — `git pull -r` is not treated as a rewrite

- **Where:** `src/agenthooks/policy.mjs` rewrite `match` (line 88) requires `f.opts.has('--rebase')`. Short `-r` is stored as `r`. `git pull --rebase` is denied; `git pull -r origin main` is allowed.
- **Fix:** Treat `pull` with `-r` as the rebase form, in `match` or by mapping the short option where `parseGit` already maps the long one. Keep the existing `--rebase` denial.
- **Acceptance:** `node --test test/agenthooks-audit.test.mjs`. `git pull -r origin main` is denied. `git pull origin main` stays allowed.
- **Depends on:** A09. Lane `agenthooks`.

### A11 — Split `dispatcher.mjs` so the pre-push fix has room under 1000

- **Where:** `src/hooks/dispatcher.mjs`, 980 lines. The hard ceiling is 1000. A12 has to add a test and a branch in this file.
- **Fix:** Move the pre-push worktree block into a sibling module under `src/hooks/` without changing when the worktree is built. No behaviour change. Every successor file stays under 900 lines.
- **Acceptance:** `node --test test/hooks.test.mjs test/hooks2.test.mjs test/hooks3.test.mjs`. `node bin/simt.mjs check` does not report hard `FILE-LINES` for `src/hooks/dispatcher.mjs` or the new sibling.
- **Effort:** M. Lane `dispatcher`. A12 edits whatever file this row leaves the pre-push block in.

### A12 — Pre-push runs the other gates on the dirty tree when test is skipped

- **Where:** the pre-push block (today `src/hooks/dispatcher.mjs` lines 448–476; A11 may move it). A HEAD worktree is materialised only when `skipTest === null`. When ADR-120 or ADR-147 skips `test`, `runRoot` stays the working tree, and lint and format see uncommitted edits. The skip comment says the remaining gates run against the commit being pushed.
- **Fix:** Materialise the HEAD worktree for every pre-push, including a skipped test. `runGatesAt` still skips the test gate and still runs the others, on that tree. Clean up the worktree on the way out, as the current path does.
- **Tests:** put the new case in `test/hooks-push.test.mjs`. `test/hooks2.test.mjs` is 933 lines.
- **Acceptance:** `node --test test/hooks-push.test.mjs test/hooks2.test.mjs`. The new case: evidence that skips `test`, a dirty unstaged edit, and a lint gate. The lint gate's root is the HEAD worktree, not the dirty checkout.
- **Depends on:** A11. Lane `dispatcher`.

## 7. Wave 1 — one JSON document, honest pages

### A13 — `run()` JSON omits `exitCode` and superseded-flag `deprecated`

- **Where:** `src/run.mjs` `run` (lines 47–81) returns the sink's documents. `src/commands/index.mjs` `dispatch` (lines 456–499) is the only place that adds `exitCode`, `ok`, and `deprecated`. The superseded-flag loop never runs in `run()`. The comment at `index.mjs` lines 441–442 still says the JSON half of an undeclared-flag warning waits on the envelope; `warn()` already lands in `notices`.
- **Fix:** One finaliser both call. The single-document JSON shape gains `exitCode`, keeps `ok`, and gains `deprecated` when a superseded flag was set. `run('sync', { flags: { check: true, json: true } })` matches `simt sync --check --json` on those fields. Delete the stale sentence in the same edit. Multi-document output stays a stream with the process exit beside it, as `dispatch` does today.
- **Acceptance:** `node --test test/run.test.mjs test/envelope.test.mjs`. `renderJson` of a `run()` result carries `exitCode === result.code`. The sync `--check` case carries `deprecated.check === 'sync'`.
- **Effort:** M. Lane `envelope`.

### A14 — A `MAX_BYTES` document can still exit 0

- **Where:** `emitJson` returns false and the document is `{ ok: false, error: { code: 'MAX_BYTES' } }`. Command handlers return `EXIT.OK` without reading that. `dispatch` then sets `exitCode` from the handler (`index.mjs` lines 492–496), so the document says failure and the process says success.
- **Fix:** In the A13 finaliser, a sole document whose `error.code` is `MAX_BYTES` (or whose `ok` is false because of that code) returns `EXIT.FAIL`. Do not invent a second exit code. Handlers stay free to return `EXIT.OK`; the finaliser is the correction.
- **Acceptance:** `node --test test/unit.test.mjs test/envelope.test.mjs`. New case: `why` (or the unit pattern at `test/unit.test.mjs` lines 96–108) under `--max-bytes 120` exits non-zero when the document's `ok` is false.
- **Depends on:** A13. Lane `envelope`. Leave `src/output/index.mjs` alone unless the document does not already carry the code.

### A15 — A numeric MCP cursor past the list is an empty page

- **Where:** `src/mcp/paginate.mjs` `paginate` (lines 24–32). The comment at lines 20–22 says a cursor outside the list is not clamped. The code slices anyway. `start >= items.length` yields `{ items: [], nextCursor: null }`, and `server.mjs` (line 213) only calls `badCursor` when `paginate` returns null. A non-numeric cursor is already null.
- **Fix:** Return null when `start !== 0 && start >= items.length`. Cursor `0` on an empty list stays an empty page. `server.mjs` already maps null to the invalid-cursor error; do not edit it unless a list method forgot the null check.
- **Acceptance:** `node --test test/mcp-paginate.test.mjs`. `paginate` of 10 items at `'999'` is null. A `tools/list` call with cursor `'99999'` returns error code `-32602`. A cursor the server just issued still returns the next page.
- **Effort:** S. Lane `paginate`.

### A16 — MCP `knowledge_why` cannot page or ask a bitemporal question

- **Where:** `src/mcp/tools-work.mjs` (lines 40–48) calls `knowledgeWhyFacts(args.document, args.id)`. The CLI function already takes `limit`, `page`, `asOf`, and `knownAt` (`knowledge.mjs` line 30). `src/commands/spec.mjs` lists those CLI flags and sets the MCP flag list to empty.
- **Fix:** Add `limit`, `page`, `asOf`, and `knownAt` to the tool schema and pass them through. Update the spec's `mcp.flags` for that command so the spec test and the tool agree. Invalid values use the refusal the CLI already returns once A19 has landed; until then, pass through what `knowledgeWhyFacts` accepts today.
- **Tests:** `test/mcp-work.test.mjs` (new). Do not add to `test/mcp.test.mjs` (985 lines) or `test/work-doors.test.mjs` (the knowledge lane owns that file).
- **Acceptance:** `node --test test/mcp-work.test.mjs test/mcp-spec.test.mjs`. A call with `limit` and `page` returns a different `doc.page` than the unpaged call. A call with both `asOf` and `knownAt` returns an `at` field. One date without the other is the CLI's existing refusal.
- **Effort:** S. Lane `mcpwork`. This row is the last one that edits both `tools-work.mjs` and `spec.mjs`.

### A17 — MCP `knowledge_import` reports `ok: true` when the import failed

- **Where:** `src/mcp/tools-work.mjs` lines 110–111 always return `{ ok: true, doc }`. `knowledgeCommand` returns `EXIT.FAIL` when `payload.ok` is false (`knowledge.mjs` lines 179–181). An expired bundle is `doc.ok === false` inside an envelope that says the call succeeded.
- **Fix:** Set the envelope `ok` from `knowledgeImportFacts(...).ok`. Keep `doc` so a client can read the reasons. A thrown-shape `error` still goes through `refuse`, matching the other tools.
- **Acceptance:** `node --test test/mcp-work.test.mjs`. An expired bundle yields envelope `ok === false` and `doc.ok === false`. A valid bundle stays `ok === true`.
- **Depends on:** A16. Lane `mcpwork`. Edit `tools-work.mjs` only.

### A18 — `knowledge why` prints the page limit as a page count

- **Where:** `src/commands/knowledge.mjs` `renderWhy` line 205. `page.index of page.size` uses `size`, which is the limit (`knowledgeWhyFacts` line 33), and `page.total` is a node count (line 106). `page 0 of 50 (3 node(s))` reads as 50 pages.
- **Fix:** Print the index, the limit, and the node total in words that do not say "of N pages". One suggested line: `page 0 (limit 50, 3 node(s))`. Keep the machine fields `index`, `size`, and `total` stable.
- **Acceptance:** `node --test test/work-doors.test.mjs`. The paging case asserts the human line names a limit and a node total, and does not present the limit as a page count.
- **Depends on:** A07. Lane `knowledge`.

### A19 — `--limit` and `--page` accept a non-integer and silently default

- **Where:** `src/argv.mjs` validates `budget`, `max-bytes`, and `reps`, not `limit` or `page`. `knowledgeWhyFacts` (lines 33–36) uses `Number.isFinite`: `Number('notanumber')` falls through to `MAX_PAGE`, and a bad page becomes `0`.
- **Fix:** Reject a present `limit` or `page` that is not an integer in the range the command already documents, in `parse()`, with exit 2. Apply the same rejection inside `knowledgeWhyFacts` when a caller passes the strings through `run()` and never touches `parse()`. A missing flag keeps the default.
- **Acceptance:** `node --test test/unit.test.mjs test/work-doors.test.mjs`. `parse` of `--limit foo` and `--page -1` is a usage error. The why command exits 2 for those flags. An omitted flag still pages with the default.
- **Depends on:** A18. Lane `knowledge` (`knowledge.mjs` plus `src/argv.mjs`; no other row edits `argv.mjs`).

### A20 — `openIndex().search` stringifies an error object

- **Where:** `src/index/open.mjs` lines 108 and 124. `fail(INDEX_CODES.READ, rows.error)` receives the error object. The message becomes `[object Object]`.
- **Fix:** Pass `rows.error?.message ?? String(rows.error)`, and keep `rows.error.code` when the helper already has a code argument.
- **Acceptance:** `node --test test/index.test.mjs`. Extend the corrupt-index case to call `search` on an open handle and assert the message is the underlying string.
- **Effort:** S. Lane `open`.

### A21 — A corrupt SQLite overlay reads as an empty overlay

- **Where:** `src/index/overlay.mjs` `sqliteBackend.read` (lines 415–430). The `catch` returns `{ nodes: [], edges: [] }` for a missing file and for a truncated one.
- **Fix:** A missing file is an empty overlay. A file that exists and cannot be read raises, or returns `{ error }` in the shape `persist.mjs` uses for an index read error. Do not report both as empty.
- **Acceptance:** `node --test test/work-index.test.mjs`. New case: write a valid overlay database, truncate it, and assert `read` surfaces the failure. A path that does not exist is still an empty overlay.
- **Effort:** S. Lane `overlay`.

### A22 — An FTS term containing `"` breaks the MATCH expression

- **Where:** `src/index/store.mjs` `ftsBranch` (lines 518–520). Terms are wrapped as `"${t}"` and joined with ` OR `. A quote in a token breaks the phrase.
- **Fix:** Escape FTS5 phrase quotes inside the token, or drop `"` from tokens before they are quoted. A query with a quote returns rows or an empty list, not a SQLite syntax error presented as a read failure.
- **Acceptance:** `node --test test/index.test.mjs`. A task string containing `"` does not set `error` on the branch, and a token without a quote still matches.
- **Effort:** S. Lane `fts`.

## 8. Wave 2 — the remaining fail-open paths

### A23 — `hooks-disable` has no regex when the tokenizer fails

- **Where:** `src/agenthooks/policy.mjs` lines 100–107. `regex` is null on purpose, so an unparseable command is judged as it was before this policy existed. Push and rewrite still have a regex. A broken quote wrapped around `git config core.hooksPath` can pass.
- **Fix:** Add a conservative regex for this row only: `core.hooksPath` and the hooks directory the tool writes. Unparseable text that does not match stays allowed. Open the decision in §5 with `simt decide` before changing the comment that explains `regex: null`.
- **Acceptance:** `node --test test/agenthooks-audit.test.mjs`. An unbalanced-quote command that still contains `core.hooksPath` or the hooks directory is denied. An unbalanced quote that contains neither is allowed. A parseable `git config core.hooksPath` stays denied.
- **Depends on:** A10. Lane `agenthooks`.

### A24 — Git alias lookup fails open on timeout

- **Where:** `src/agenthooks/decide.mjs` `gitAliases` (around lines 268–297). A non-zero exit or the 1s timeout returns an empty map. `git p` with `alias.p=push` is then not expanded, and the push row may not see it.
- **Fix:** On lookup failure, if the command text matches the push or rewrite regex, deny it. A parsed builtin is unchanged. Open the §5 record in this slice. Do not deny every unknown subcommand.
- **Acceptance:** `node --test test/agenthooks-audit.test.mjs`. A stubbed alias lookup that times out still denies `git p` when the regex matches a push, and still allows `git status`.
- **Depends on:** A23. Lane `agenthooks`.

### A25 — The secret scan judges each added line alone

- **Where:** `src/secrets.mjs` `scanStaged` (around lines 344–350). Each added line is scanned on its own. A token split across two `+` lines in one hunk is invisible.
- **Fix:** Concatenate consecutive added lines inside a hunk before the pattern run, and keep the per-line finding path for a token that sits on one line. The report still omits the secret bytes.
- **Acceptance:** `node --test test/secrets.test.mjs`. New case: a staged hunk whose secret is split across two added lines is a finding. A single-line secret still is. The finding text does not contain the secret.
- **Effort:** S. Lane `secrets`.

### A26 — `slice start` can leave a lease or a worktree behind

- **Where:** `src/commands/slice.mjs` (around lines 384–421). The lease is claimed before `worktree add`. A failed `worktree add` leaves the lease. A failed tracker write after the worktree exists leaves both.
- **Fix:** On failure after the lease is claimed, release it. On failure after the worktree exists, remove the worktree and release the lease. A failure before either step writes nothing.
- **Acceptance:** `node --test test/slice.test.mjs`. Two cases: `worktree add` fails, and the tracker write fails. Neither leaves a lease or a directory under the worktree root.
- **Effort:** M. Lane `slice`.

### A27 — `slice finish` reports a SHA when the tracker write failed

- **Where:** `src/commands/slice.mjs` (around lines 655–668). The commit can succeed and the tracker update can fail. The message names the SHA and leaves the row queued, with no command to finish the row.
- **Fix:** Keep the commit. The error names the SHA and the exact `plan done` invocation that records it. Do not roll back a commit that succeeded.
- **Acceptance:** `node --test test/slice.test.mjs`. A forced tracker failure after a successful commit exits non-zero, prints the SHA, and prints a `plan done` command that contains that SHA.
- **Depends on:** A26. Lane `slice`.

## 9. Wave 3 — contracts, wording, and the small bugs

### A28 — `read-channel-equivalence` ignores `before` and `after`

- **Where:** `src/bench/replay.mjs` `metamorphic` (lines 88–98) spreads `{ before, after, ...options[relation] }` into `channelEquivalent`, which reads only `answers` (line 53). A call that passes the observations as `before` and `after` fails with "two answers from independent channels are needed".
- **Fix:** When the relation is `read-channel-equivalence` and `options` did not supply `answers`, build `answers` from the two observations the caller passed. An explicit `options['read-channel-equivalence'].answers` still wins.
- **Acceptance:** `node --test test/work-replay.test.mjs`. `metamorphic({ before: obs, after: obs, relations: ['read-channel-equivalence'] })` holds. A call with one observation still fails closed.
- **Effort:** S. Lane `replay`.

### A29 — `mine.mjs` keeps a second process timeout beside `spawnBounded`

- **Where:** `packages/bench/src/mine.mjs` `runProcess` (around lines 116–140) is a detached timeout. Adapters already use `spawnBounded` in `src/sys/proc.mjs`. The archive name `src/bench/process.mjs` is not a file; do not recreate it.
- **Fix:** Call `spawnBounded` from `mine.mjs` and delete `runProcess`. Match the current timeout, cwd, and kill-the-group behaviour the helper already provides. A second caller is the extraction ADR-002 asks for; do not wrap `spawnBounded` in a new adapter.
- **Acceptance:** `node --test test/bench.test.mjs test/sys-utils.test.mjs`. The mine cases still record a timeout, and `spawnBounded`'s existing cases stay green.
- **Effort:** S. Lane `mine`.

### A30 — `lintRegistry` does not require registry `version` 1

- **Where:** `graph/skills.graph.json` is `"version": 1`. `src/graph/load.mjs` `lintRegistry` (line 287) never reads `registry.version`. A future shape with the same arrays lints clean.
- **Fix:** Require `registry.version === 1`. Any other value is one error and the lint stops, the way a broken shape already stops. Do not generate a JSON Schema in this slice.
- **Acceptance:** `node --test` the graph lint tests (`test/rules.test.mjs` if that is where they live, plus the graph suite `node bin/simt.mjs tests src/graph/load.mjs` names). `node bin/simt.mjs graph lint` is clean on this tree. A fixture with `"version": 2` is an error that names the version.
- **Effort:** S. Lane `graph`.

### A31 — The wheel assertion's failure text says the opposite of the match

- **Where:** `test/shipped.test.mjs` line 945. The match requires the `docs/decisions` force-include. The message says the wheel no longer ships that tree.
- **Fix:** Change the message so a failure says the wheel must ship `docs/decisions` through force-include. Do not change the pattern.
- **Acceptance:** `node --test test/shipped.test.mjs`.
- **Effort:** S. Lane `shipped`. A51 splits this file afterwards.

### A32 — `brew style` runs before the formula is rendered

- **Where:** `.github/workflows/publish-channels.yml`. The step "the formula lints" (line 305) runs `brew style Formula/simt-dev.rb`. "render the formula for this release" (line 307) runs `scripts/release-formula.mjs` after that. Style never sees the checksums this release just wrote.
- **Fix:** Run `brew style` on the rendered formula after `release-formula.mjs`. Keep the comment that explains why this job uses `brew style` rather than `brew audit --strict`. Update that comment so it describes the new order.
- **Acceptance:** a test that reads the workflow and asserts the `brew style` step is ordered after `scripts/release-formula.mjs`. Put it in `test/packaging.test.mjs` (251 lines). `node --test test/packaging.test.mjs`.
- **Effort:** S. Lane `publish`.

### A33 — `test/pack.test.mjs` names a `simt-dev` bin the package does not install

- **Where:** `test/pack.test.mjs` line 10 says the test drives `node_modules/.bin/simt-dev`. `package.json` `"bin"` is `simt`, and the test's `CLI` constant is already correct.
- **Fix:** Correct the comment. No behaviour change.
- **Acceptance:** `node --test test/pack.test.mjs`.
- **Effort:** S. Lane `pack`.

### A34 — Shell completions omit alias tokens the dispatcher accepts

- **Where:** `src/completions.mjs` `shape()` builds the top level from `COMMANDS`. `src/commands/spec.mjs` `ALIASES` still dispatches `upgrade`, `compare`, and `shared plan`. `simt upgrade --help` works; `simt completions bash` does not offer `upgrade`.
- **Fix:** Add the alias first tokens to `shape().top`, deduped and sorted. Help stays free of aliases; this slice is completions only.
- **Acceptance:** `node --test test/completions.test.mjs`. The bash script contains `upgrade` and `compare` as top-level tokens.
- **Effort:** S. Lane `complete`.

### A35 — A schema with `required` and no `type` accepts a non-object

- **Where:** `src/mcp/schema.mjs` lines 49–50. The object branch runs when `properties` or `required` is set. A non-object hits `return null`, which means valid. Shipped tools set `type: 'object'`, so the early `typeMatches` check covers them. A schema that omits `type` does not.
- **Fix:** When `required` or `properties` is set and the value is not a plain object, return a type error. An object still falls through to the property checks. A schema that sets `type: 'object'` keeps the error it already produces one branch earlier.
- **Acceptance:** `node --test test/mcp-schema.test.mjs` (new; leave `test/mcp.test.mjs` for A48). The schema `{ required: ['x'], properties: { x: { type: 'string' } } }` rejects `"not-an-object"` and accepts `{ x: 'ok' }`.
- **Effort:** S. Lane `schema`.

### A36 — MCP cancel uses `===` on request ids

- **Where:** `src/mcp/server.mjs` line 507. `message.params.requestId === inflight.id` misses a string `"1"` against a numeric `1`.
- **Fix:** Compare `String(requestId)` with `String(inflight.id)` when both sides are a string or a finite number. Leave other types unmatched.
- **Acceptance:** `node --test test/mcp-cancel.test.mjs`. A cancel whose `requestId` is the string form of the in-flight numeric id aborts that call. A different id does not.
- **Effort:** S. Lane `cancel`.

### A37 — Check remedies tell a consumer to expect the name `simt-dev`

- **Where:** reader-facing sentences that name the project where they mean the tool:
  - `src/projection/project.mjs` line 558 (`simt-dev will not replace it`) and line 627 (`simt-dev will not remove a file it wrote`)
  - `src/commands/doctor.mjs` line 98 and `src/projection/manifest.mjs` line 411 (`what this simt-dev writes`)
  - `src/compare/row.mjs` line 203 (the same "will not remove" sentence)
- **Fix:** The subject is "this tool". A command in the same sentence is `${CLI}` (`simt`), which those files can already import from `src/name.mjs`. Update `test/surfaces.test.mjs` and `test/compare.test.mjs`, which match the old sentences. Leave `test/naming.test.mjs`'s fixture list: it is an example of prose the spelling guard must ignore, not the live remedy. Leave `CLIENT_INFO.name` in the federation client.
- **Acceptance:** `node --test test/surfaces.test.mjs test/compare.test.mjs test/naming.test.mjs test/doctor.test.mjs`. A rendered check finding for a foreign pointer and a stale manifest does not contain the project name. It contains "this tool" or `simt`.
- **Effort:** S. Lane `wording`.

### A38 — Help does not say that gate, tests, and impact walk different graphs

- **Where:** `src/commands/spec.mjs` summaries for `gate` (line 68), `impact` (line 76), and `tests` (line 133). Q77 assigned the walks: `gate` and `impact` use the import closure, `tests` uses stored test edges, and `tests --run` calls `gate`. The summaries do not say that, so an agent treats a disagreement as a bug.
- **Fix:** One clause on each summary stating which walk that command uses, and that `tests --run` is the gate's answer. Do not change `coverage.mjs`, `gate.mjs`, `tests.mjs`, or `impact.mjs`.
- **Acceptance:** `node --test test/help.test.mjs test/spec.test.mjs`. `help gate`, `help tests`, and `help impact` each name their walk. `node bin/simt.mjs tests src/index/persist.mjs` and `node bin/simt.mjs gate --changed` are not required to return the same list.
- **Depends on:** A16, which is the other edit to `spec.mjs`. Lane `spec`.

### A39 — `brief` never builds the W20 proof packet

- **Where:** `src/brief/proof.mjs` exports `buildProofPacket`. `src/brief/assemble.mjs` calls the byte-budget packet and never `proof.mjs`. `simt brief` has no `complete` or `omittedObligations` field.
- **Fix:** Add a `--proof` flag on `brief` in the spec and thread it to `buildProofPacket`. Without the flag, the packet bytes stay what they are today. With the flag, the JSON document includes the proof packet's `complete` and `omittedObligations`. Do not replace TESTS or DECISIONS in the default packet.
- **Acceptance:** `node --test test/work-brief.test.mjs`. A default brief fixture is byte-stable against the pre-change packet. `brief --proof --json` on the same task includes `complete`. `node --test test/spec.test.mjs` sees the new flag on `brief` only.
- **Depends on:** A38. Lane `spec` (`spec.mjs`, `assemble.mjs`, `proof.mjs`).

### A40 — Proof-packet budget counts a unit cost, not the encoded bytes

- **Where:** `src/brief/proof.mjs` (around lines 86–106 and 148). The running total adds a per-unit `cost`, then completion is judged against `byteLength` of the encoded text. A packet can report `complete` and `overBudget` for a difference of a few bytes.
- **Fix:** Charge the encoded byte length of the unit that was actually kept. `complete` and `overBudget` agree on that total.
- **Acceptance:** `node --test test/work-brief.test.mjs`, plus a direct case on `buildProofPacket` if the brief test does not construct a tight budget. A budget exactly equal to the encoded packet is `complete`. One byte under is not.
- **Depends on:** A39. Lane `spec`.

### A41 — Journal undo restore writes the destination in place

- **Where:** `src/journal.mjs` `restoreEntry` (around lines 539–557) uses `writeFile` and `unlink`. A crash mid-write leaves a torn file. The resume marker (`.undoing.json`) is what makes a retry possible; the write itself is not atomic. `journaledWriteFile` already uses a temp file and a rename.
- **Fix:** Restore through the same temp-and-rename pattern. A crash still leaves the resume marker, and a resumed undo does not observe a half-written destination.
- **Acceptance:** `node --test test/undo.test.mjs`. The existing resume case stays green. Add a case that interrupts after the temp file exists and before the rename, then resumes, and assert the destination is either the old bytes or the restored bytes.
- **Effort:** S. Lane `journal`.

### A42 — `commitJournal` records `undefined` paths for git-config entries

- **Where:** `src/journal.mjs` (around lines 414–419). `paths: entries.map((entry) => entry.path)` is `undefined` for a `git-config` row, which has no `path`.
- **Fix:** Record `entryLabel(entry)` for those rows, or omit the path field when the entry has none. A file entry still records its path.
- **Acceptance:** `node --test test/undo.test.mjs`. A journal commit that includes a git-config entry does not store `undefined` in `paths`.
- **Depends on:** A41. Lane `journal`.

### A43 — `GLOBAL_FLAGS` can drift from the spec flag rows

- **Where:** `src/commands/help.mjs` `GLOBAL_FLAGS` uses `'max-bytes'`. Spec rows use the same bare names today. Nothing fails when one side gains a flag.
- **Fix:** A test that every name in `GLOBAL_FLAGS` is a flag the spec declares as global, and every spec global appears in `GLOBAL_FLAGS`. No production change unless the test finds a real drift, in which case the spec is the source and the constant follows it.
- **Acceptance:** `node --test test/help.test.mjs` (or `test/spec.test.mjs` if the global list is asserted there). The new case fails if either side adds a name the other does not have.
- **Effort:** S. Lane `help`.

### A44 — `doc-input.mjs` has no direct test

- **Where:** `src/commands/doc-input.mjs`. Door tests reach it only through a command.
- **Fix:** A direct test. Cover the 4 MiB cap, stdin `-`, a missing path, and a path the caller passed (the tool does not invent a traversal check beyond that). No production change unless the test finds the cap or the stdin path lying.
- **Acceptance:** `node --test test/doc-input.test.mjs`.
- **Effort:** S. Lane `docinput`.

### A45 — Door parity covers five MCP tools, not every spec door

- **Where:** `src/knowledge/bundle.mjs` `READ_ONLY_DOORS` is a subset on purpose (`test/work-query-contract.test.mjs`). `test/work-doors.test.mjs` checks five MCP tools. `spec.mjs` and `tools-work.mjs` also expose export, import, and the verify doors.
- **Fix:** A test, in a new file, that every `spec.mjs` command under knowledge, verify, work, and action with an `mcp.name` has a tool of that name, and that the tool's required arguments match the spec. Do not widen `READ_ONLY_DOORS`. Do not edit `tools-work.mjs` (lane `mcpwork` owns it); if the test finds a missing tool, stop and add a row rather than patching that file here.
- **Acceptance:** `node --test test/work-door-parity.test.mjs test/work-query-contract.test.mjs`.
- **Effort:** S. Lane `doors`.

### A46 — Rank stratum `queries` is never incremented

- **Where:** `src/knowledge/rank.mjs` line 207. `row.queries += found ? 0 : 0`. The field stays 0 for every stratum.
- **Fix:** Increment `queries` once per corpus entry in that stratum. Leave `gold` and `hits` as they are.
- **Acceptance:** `node --test test/knowledge-rank.test.mjs`. For a corpus of N entries in one language, that stratum's `queries` is N.
- **Effort:** S. Lane `rank`.

## 10. Wave 4 — under the line ceiling

Each row is a move. Behaviour stays. Successor files stay under 900 lines so the next edit does not land on the ceiling. New test files follow `test/<name>.test.mjs`. The hard check is `FILE-LINES`. A warn on a file this wave does not own is not a failure of the row.

The agenthooks, MCP, envelope, and pre-push rows already add their cases in new files (`test/agenthooks-audit.test.mjs`, `test/mcp-work.test.mjs`, `test/mcp-schema.test.mjs`, `test/hooks-push.test.mjs`). This wave splits the files those rows were told not to grow.

### A47 — Split `test/agenthooks.test.mjs` (982 lines)

- **Acceptance:** `node --test` on the original file and its successors, all passing. `node bin/simt.mjs check` does not report hard `FILE-LINES` for those paths. Lane `t-hooks`.

### A48 — Split `test/mcp.test.mjs` (985 lines)

- **Acceptance:** same shape, for this file. Lane `t-mcp`.

### A49 — Split `test/ci.test.mjs` (983 lines)

- **Acceptance:** same shape. `node scripts/ci.mjs --check` still exits 0 if that script is what the file pins. Lane `t-ci`.

### A50 — Split `test/hooks2.test.mjs` (933 lines)

- **Acceptance:** `node --test test/hooks2.test.mjs` plus successors, and `node --test test/hooks-push.test.mjs` if A12 has landed. Lane `t-hooks2`. The pre-push case itself lives in `test/hooks-push.test.mjs` and is not part of this move.

### A51 — Split `test/shipped.test.mjs` (997 lines)

- **Acceptance:** `node --test` on the successors. The assertion A31 reworded is still present, with the corrected message.
- **Depends on:** A31. Lane `shipped`.

### A52 — Split `src/commands/init.mjs` (957 lines)

- **Acceptance:** `node --test test/init.test.mjs test/init2.test.mjs test/init-harness.test.mjs`, and hard `FILE-LINES` absent for the successors. Lane `t-init`.

### A53 — Split `src/commands/hooks.mjs` (905 lines)

- **Acceptance:** `node --test test/hooks.test.mjs test/hooks-context.test.mjs test/hooks3.test.mjs`, and hard `FILE-LINES` absent for the successors. Lane `t-hookscmd`. This is the command module, not `src/hooks/dispatcher.mjs` (A11).

### A54 — Split `src/memory/lessons.mjs` (952 lines)

- **Acceptance:** `node --test test/lessons.test.mjs`, and hard `FILE-LINES` absent for the successors. Lane `t-lessons`.

### A55 — Split `src/commands/slice.mjs` (858 lines)

- **Acceptance:** `node --test test/slice.test.mjs`. The rollback and the retry message from A26 and A27 still hold.
- **Depends on:** A27. Lane `slice`.

### A56 — Split `src/knowledge/sections.mjs` (473 lines)

- **Acceptance:** `node --test test/knowledge-sections.test.mjs`. The file is over the warn line only; the split is still the audit's named fix. Successors under 900, and this path is not a hard `FILE-LINES`. Lane `t-sections`.

### A57 — Split `src/memory/decide.mjs` (513 lines)

- **Acceptance:** `node --test test/work-memory.test.mjs test/decide.test.mjs`. Lane `t-decide`.

## 11. Taking a row

`node bin/simt.mjs plan next` returns the first queued row whose dependencies are Complete. `--wave 0` stays in the first wave. `--lane agenthooks` stays in that file set. `--tier S` stays in the half-day rows.

Start with `node bin/simt.mjs slice start <id> --yes` and finish with `node bin/simt.mjs slice finish <id> --yes`. Record the row with `node bin/simt.mjs plan done <id> <sha> --test "<the acceptance command>" --yes`. The acceptance command in the section is the `--test` value, run on this tree, every test passing.
