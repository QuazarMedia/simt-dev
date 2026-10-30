---
simt-affects: ["AGENTS.md", "rules/core.md", "rules/stacks/node.md", "rules/stacks/python.md", "rules/stacks/connectiq.md", "src/projection/project.mjs", "test/baselines.test.mjs", "test/upgrade.test.mjs"]
simt-supersedes: []
---

# ADR-109 — simt-dev is its own consumer, and the guards that kept it from being one are retired

Status: **accepted** · 2026-10-30

## Context

This repository ran `simt init` on itself, and the suite still believed the
opposite. Two tests asserted that simt-dev is *not* a consumer of itself — no
manifest, no region — and `AGENTS.md` explained why self-adoption was
impossible: the region's stamp records a SHA, so every commit would make the
file stale.

That explanation is no longer true. The `simt:sha=` stamp is a digest of the
rule *content* — `rules/` and the baselines — not of this repository's HEAD.
A commit here does not move it, so `check` stays green until the rule text
itself changes, and `simt sync --yes` re-renders it when that happens.

## Ruling

1. **This repository is a consumer of itself.** `simt.json` declares its
   gates, and the generated region in `AGENTS.md` carries the rules it
   projects. The two tests that asserted the opposite are rewritten to assert
   the new state: the baselines exist with the region first, and an `upgrade`
   from its own source is a no-op that moves no stamp.
2. **The rule text names the manifest by the name that resolves in every
   repository.** Four rule files said `simt-dev.json`, the pre-rename name;
   ADR-056 reads both and writes the new one, so a reader in any repository
   finds only `simt.json`. The text now says `simt.json`.
3. **A gate finding whose `detail` is absent is `null`, not `undefined`.** A
   key with an `undefined` value survives into the structured MCP surface but
   is dropped by `JSON.stringify`, so the two surfaces of one answer no longer
   deep-equal. The four constructions of a region verdict now share one helper
   that emits `null`.

## Consequences

- The suite's view of this repository is the adopted one: `check` here is
  green until the rule content changes, and the baselines test asserts the
  region-first placement that keeps a hand-written setting below it winning
  (ADR-025).
- `AGENTS.md`'s hand-written section now says what is true: the repository
  adopts itself, and the stamp is a content digest.
