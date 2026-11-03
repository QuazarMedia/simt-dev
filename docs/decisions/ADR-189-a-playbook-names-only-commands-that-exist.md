---
simt-affects: ["docs/playbooks.md", "test/work-release.test.mjs"]
simt-supersedes: []
---

# ADR-189 — a playbook names only commands that exist, and states what is not supported

Status: accepted · 2026-11-03

## Context

This repository exists to ship text a reader in another repository can act on. The failure that
recurred most often was a documented command or path that did not exist for the reader: `simt sync`
cited before it existed, remedy strings naming a binary that was not there, a path that resolved
only in this checkout.

## Rulings

1. **Every documented command is a row in the command spec.** The test extracts each `` `simt …` ``
   from the playbooks and fails if it is not a `SPEC_PATHS` entry. Documentation cannot drift from
   the dispatch table without failing the suite.

2. **Five supported paths, each with runnable commands.** Docs-only, mixed knowledge and scripts,
   API-authored, UI-only and SSH-operated. Each names the commands to run in order.

3. **What is not supported is written down.** No live pilot run, no remote rollback (`simt undo` is
   local files only), no exactly-once promise, no model that decides policy, and leases that may be
   advisory. A reader learns the boundary from the playbook rather than from a failure.

4. **A playbook is addressed to the consumer.** No path into this repository, no package runner, and
   every command invoked the way the consumer's own runner would invoke it.

## Consequences

- The playbooks are release evidence, not marketing: they describe what the shipped commands do and
  where the assurance stops.
- A new command is documented by adding its spec row first; the playbooks then have something true
  to name.
