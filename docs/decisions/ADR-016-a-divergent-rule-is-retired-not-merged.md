# ADR-016 — A divergent rule is retired, not merged

Status: **accepted** · 2026-10-06
Affects: `rules/mdc/*.mdc`, `projection/mdc.mjs`, `projection/project.mjs`, `projection/conflicts.mjs`, `sync`, `check`, `init`

## Context

The estate carried three always-on `.mdc` rule families across three repos, in eight
files, with no two byte-identical.

The worst pair differed by **one byte** (`simt-social/.cursor/rules/intake-questions.mdc`
at 1280 against `simt-social-api`'s at 1281) while hiding three semantically loaded line
changes: a plan-tracker path rewritten to point at the other repo, `migrations` added to the
list of decisions worth asking about, and a requirement silently dropped. No size-, hash-,
hash-adjacency- or line-count-based duplicate detector could ever have flagged that pair. The
reason is not that the detectors were weak: it is that **divergence here is not a formatting
difference, it is a semantic loss**, and the smaller copy is the one missing a rule.

Reading all eight produced three findings that a variant mechanism cannot represent:

1. `test-gate`'s fourth `BLOCK` bullet is **complementary across the pair, not alternative**.
   `simt-social` blocks a consumer that requires an API field with no backward-compatibility
   or deploy-order evidence; `simt-social-api` blocks a producer that ships without a test
   asserting the new invariant. Each repo's reviewer was told to check only its own half.
2. `preview-postflight`'s second Requirements bullet is likewise complementary, and looks
   like a conflict because the two files put different rules in the same slot: `simt-social`
   says set `SOCIAL_API_BASE_URL` in the Cloudflare Workers Builds preview environment;
   `simt-social-api` says credentials live in the operator keychain only, never in source,
   chat, D1 or logs.
3. Two deletions left no trace. `simt-social-api` dropped `simt-social`'s worked example
   (`Partial pass (e.g. 6/8 pass) is a hard blocker`) — the example is what does the work,
   and its removal is invisible in a diff review because the rule's normative force looks
   unchanged. `simt-social-media` dropped the entire `## Allowed Without Account` section, so
   it has no documented set of probes that are legal without credentials.

A variant mechanism models "these are the same rule, rendered per stack". None of these three
is that. Two are **unions**, and one is a **deletion that must be undone**.

## Rulings

### 1. Canonical `.mdc` rules are unions, never variants

`rules/mdc/*.mdc` holds one body per rule, carrying every clause any repo needs. Where two
copies disagreed, both clauses are present and both are unconditional. Concretely:

- `test-gate` keeps both `BLOCK` bullets and says explicitly that they are complementary, so
  a reader cannot tell that checking one is sufficient.
- `preview-postflight` keeps both Requirements bullets.
- `test-gate` keeps the `6/8 pass` example, and `preview-postflight` restores
  `## Allowed Without Account` with social-api's `D1 migration verification` addition.

**Why:** a variant preserves a choice. These files do not record a choice; they record three
independent accidents, and two of the eight copies are strictly weaker than the best one. A
mechanism that keeps choosing between them will keep choosing the weaker one.

### 2. Only substrate is a substitution; only what varies per repo is declared

What genuinely differs between the copies is paths and names: a plan-tracker glob, a test
file path, a path vocabulary, a production domain, a preview Worker name. Those become
`{{placeholders}}` with **declared defaults**, in `rules/mdc/*.mdc`:

```yaml
substitutions:
  - key: plansGlob
    default: docs/plans/*
    describe: glob for this repo's active plan tracker tables
```

Values live in the repo's `simt-dev.json` under `substitutions`, keyed by rule id. They are
facts about the repo, while a rule is shared by every repo that adopts it — putting them in
the rule would either hard-code one repo's paths for everyone or push the decision back into
prose, which is the drift this mechanism exists to remove.

An **empty** value, or an empty default, drops the line it sits on. That is how one canonical
file reaches `simt-social-media` (no plan-tracker note) and `simt-space` (not a Workers repo
at all) without printing a blank bullet. A placeholder with neither a default nor a
declaration is a **gate failure**, because a rule shipping a literal `{{key}}` reads as
finished and is not.

### 3. A rule that names one product's infrastructure is opt-in, not stack-detected

`preview-postflight` declares `applies: []` and `optIn: true`. It names specific preview
Workers, `AUTH_PROVIDER_POLICY`, `POSTFLIGHT_PASSWORD_UID` and specific production domains.
Selecting it on `cloudflare-workers` would hand it to `simt-space` and `simt-goto` — Workers
repos with no preview Workers and no Social identity — which is the same over-match bug that
`rules/stacks/react-web.md` had when it declared `typescript` and `vitest`.

Detection cannot distinguish a Workers repo that has this problem from one that does not, so
the repo declares it: `"substitutions": { "__optIn": ["preview-postflight"] }`. `intake-questions`
and `test-gate` are `applies: always`, because they are genuinely stack-agnostic.

This is the first place ADR-013's fact-based detection is deliberately **not** used. A fact
answers "what is this repo made of"; opt-in answers "does this repo have this problem", which
is a different question and detection cannot reach it.

### 4. A managed `.mdc` rule is a generated file, not a region inside a hand-owned one

`AGENTS.md` keeps its hand-written prose and receives a region. A `.mdc` rule does not: the
body after the frontmatter **is** the region, full stop. There is no hand-owned prose to
preserve, because any prose that was there is exactly the divergent copy being retired.

This was found by running it. The first implementation appended the region and produced a
file with two `## Requirements` sections and every bullet twice — the duplication the
estate's own review agent (`principal-slice-reviewer` checklist item 5) is explicitly
instructed to block, produced by the tool meant to remove it. Appending is the obvious
implementation and it is wrong here.

So `sync` keeps the existing frontmatter (the editor reads `description` and `alwaysApply`
before any rule text) and replaces everything below it. `check` compares against the same
reconstruction, or it would demand the divergent text still be present.

Because that is a destructive edit to a real file, `init` and `sync` report it:

```
note  .cursor/rules/test-gate.mdc: retiring 928 bytes of divergent hand-written rule text
```

Silent deletion is the one thing a reviewer cannot audit.

### 5. The conflict scanner must reach every rule surface, including ones added later

`RULE_FILES` named only `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md` for the whole life of
the tool. `simt-dev init` therefore reported **`CONFLICTS none detected`** on
`simt-social-api` — the repo holding the worst-drifted content in the estate — because it
never looked at the `.mdc` files at all.

A detector that only knows the filenames it was written for will quietly miss a whole rule
surface added later, and it will miss it *confidently*, reporting a clean result. Rule
discovery is now by name **and** by glob (`.cursor/rules/*.mdc`,
`.github/instructions/*.md`), and generated regions are stripped before scanning so that
quoting a ruling is never mistaken for contradicting it.

Writing that test found a second-order bug worth recording: the glob was split at its first
`*` and the tail matched as a name *prefix*, so `.cursor/rules/*.mdc` matched nothing. A
detector that silently matches zero files is indistinguishable from a repo with no rules —
the same failure, one level down.

### 6. An autonomous-push probe must match every phrasing the estate actually used

The probe matched `committed and pushed`, which is `simt-garmin`'s exact DoD wording. A
different author wrote `Always commit and pushed`; another would write `commit and push`. The
first version matched only the first form and reported a real autonomous-push rule as clean.

The general lesson is the one this repository keeps re-learning: **probes are tested against
the estate's real text, not against text written to match the probe.**

## Consequences

- `rules/mdc/{intake-questions,test-gate,preview-postflight}.mdc` are the canonical bodies.
  Eight files in three repos become generated output.
- `simt-dev.json` gains a `substitutions` object, and the manifest generator seeds it empty
  rather than leaving the key absent, so the shape is visible before anything needs it.
- `simt-dev sync` and `simt-dev check` handle four targets, not one. A malformed region in any target
  refuses the whole run **before the first write** — writing the good three and skipping the
  broken one would leave a repo half-adopted with no record of which half.
- `compare` continues to report one row per repo using `AGENTS.md` only, because a dashboard
  row cannot represent four files. The gate uses the full finding list, so the dashboard's
  coarser view is not inherited by the thing that must not be wrong.

## Rejected

- **A variant mechanism per stack** (one `test-gate.mdc` per repo). This is what produced the
  drift; modelling it as intended behaviour would make the drift permanent and legitimate.
- **Picking the "best" copy per family and adopting it as canonical.** `simt-social`'s
  `test-gate` is the better copy only by accident; it is missing the producer-side `BLOCK`
  bullet that social-api has. Choosing one per family would have discarded a real rule.
- **Deleting the 8 files outright** rather than generating over them. A repo with no
  `intake-questions.mdc` and one with a generated one must behave identically to an agent, and
  only the second is verifiable by `simt-dev check`.
- **Making `preview-postflight` apply to `cloudflare-workers`.** Hands an un-actionable rule
  to two repos, and is the same bug `react-web.md` had.
- **Leaving `RULE_FILES` as a fixed list** on the grounds that the three families are the only
  `.mdc` rules that exist. They are the ones that exist *today*; that is not a reason.