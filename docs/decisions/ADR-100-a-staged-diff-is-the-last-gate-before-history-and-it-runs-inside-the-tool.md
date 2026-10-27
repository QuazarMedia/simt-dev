---
simt-affects: ["src/hooks/gates.mjs", "src/hooks/resolve.mjs", "src/hooks/dispatcher.mjs", "src/projection/manifest.mjs", "src/secrets.mjs"]
simt-supersedes: []
---

# ADR-100 — a staged diff is the last gate before history, and it runs inside the tool

Status: **accepted** · 2026-10-27

Affects: `src/hooks/gates.mjs`, `src/hooks/resolve.mjs`,
`src/hooks/dispatcher.mjs`, `src/projection/manifest.mjs`, `src/secrets.mjs`

## Context

Git history is append-only: a secret committed is a rotation exercise, not a
revert, and the one moment it can still be kept out is the commit. Every other
leak path in this tool is already gated — the projection, the manifest, the
evidence claim — but nothing gated the staged diff.

The three existing gate kinds cannot express this check. `staged` hands files
to a formatter binary in `node_modules/.bin`, `script` runs a `package.json`
script, and `command` runs a line the manifest declares: each resolves
something ON DISK, and each therefore has a way to be missing. A secret scan
has nothing to resolve — the implementation is the question being asked — and
making it a `command` gate would mean a repository declares `simt secrets`
(or installs a third-party scanner) before the check exists at all. That is
backwards for the repositories most at risk, which are frequently the ones with
the least toolchain to install into.

Plan 0003 R52 asks for both halves from one list and one binary: a
zero-dependency staged-diff scan (vendor patterns plus entropy), and no
repository needing anything to run it.

## Ruling

1. **A fourth gate kind, `builtin`, runs inside this binary.** It is declared
   in the manifest like any other gate, a `gates.commands` entry overrides it
   exactly as it overrides every other kind (the dispatcher's precedence is
   unchanged), and its result flows through the same ledger line, the same
   fail-closed reporting and the same `hooks status` view. What it never does
   is resolve anything on disk: there is no script to miss, no formatter to
   install and no command to declare, so `gateRunnable` reports it runnable and
   `check` counts it as such. A `builtin` name with no implementation fails the
   event with the name of the gate rather than passing.

2. **`secret-scan` reads only the added lines of `git diff --cached`.** Two
   detectors, both local: a pattern library for the shapes vendors publish
   (AWS key ids, private key blocks, GitHub/Slack/Stripe/Google/OpenAI-style
   tokens, JWTs, assigned secrets) and Shannon entropy (≥ 4.5 bits per
   character over runs of ≥ 32 base64-ish characters) for the blobs no vendor
   named. Values carrying placeholder markers (`example`, `changeme`,
   `your_`, …) are documentation, not findings. Context lines are not
   scanned: blocking a commit over bytes the author did not stage reproduces
   the prohibition `format`'s staged-only rule exists for. If git cannot
   answer, the gate fails rather than reading silence as a clean diff.

3. **A finding never prints the matched bytes.** The report carries the
   pattern id, the file, the line and a four-character prefix — the part a
   vendor publishes as a type (`AKIA`, `sk-`, `ghp_`). Hook output lands in a
   terminal, a CI log and often an agent's own transcript, and echoing the
   secret into the report about the secret is the leak with extra steps.

4. **The gate is opt-in, not an `init` default.** Entropy has a false-positive
   rate no threshold eliminates, and a gate that blocks a first commit over a
   sha256 digest teaches exactly the `--no-verify` habit the dispatcher exists
   to prevent. A repository opts in by adding `secret-scan` to
   `gates.preCommit`; from then on it is reported, counted and fail-closed like
   every other declared gate.

## Consequences

- A repository gets the scan by declaring the gate; nothing is installed,
  nothing is fetched at hook time, and a fresh clone runs it identically.
- `unresolved()` and `gateRunnable()` know `builtin` as a runnable kind, so
  `check` no longer has a gate it must call unrunnable-but-isn't; `hooks
  status` prints `run builtin` for the entry.
- A `gates.commands["secret-scan"]` declaration replaces the built-in scan
  with whatever line the repository names — the escape hatch every other kind
  has, preserved for this one.
- The matcher lives in `src/secrets.mjs` and is unit-tested against sentinel
  values, including the negative cases (hex digests, UUIDs, placeholders) that
  decide whether the threshold is usable rather than merely strict.

## Rejected

- **Shipping a third-party scanner (gitleaks, trufflehog).** It violates the
  zero-dependency rule outright, and a hook that downloads a scanner at commit
  time is a hook that fails on an offline machine — the failure mode ADR-010's
  no-fetch-at-hook-time rule already refuses for `npx`.
- **Scanning the working tree or the whole repository.** That flags secrets
  already in history on every subsequent commit (unfixable by the author of
  this commit) and scans unstaged work nobody was about to record. The staged
  diff is precisely the bytes the next commit would make permanent, and it is
  the only bytes this gate claims to judge.