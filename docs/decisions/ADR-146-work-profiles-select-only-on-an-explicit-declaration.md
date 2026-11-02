---
simt-affects: ["rules/work/knowledge.md", "rules/work/procedures.md", "rules/work/remote-operations.md", "src/resolve/fingerprint.mjs", "src/projection/rules.mjs", "test/work-profiles.test.mjs"]
simt-supersedes: []
---
# ADR-146 — work profiles select only on an explicit declaration

Status: accepted · 2026-11-02

## Context

A knowledge repository adopted with code-shaped rules gets advice it cannot act on: run the
test command (there is none), keep the build green (there is no build), read the runner
manifest (there is no runner). Adding a document profile that selects optimistically would
be worse in the other direction: a repository with a `docs/` directory would be told its
documents are the product and, worse, could infer that a missing software test is simply not
its concern.

The facts available before this record describe what a tree contains, not what its owner
declares. A directory named after a country, a `recipes/` folder and a `.md` file are all
shapes; none of them says "this repository's checks are these".

## Rulings

1. **Three optional profiles, selected by declaration only.** `work/knowledge`,
   `work/procedures` and `work/remote-operations` apply to `has-work-scopes`,
   `has-work-validators` and `has-work-targets`. Those facts come only from the `work`
   namespace in the manifest, and from nothing observed on disk.

2. **No declaration, no change.** A repository without `work` renders exactly the region it
   rendered before this record. The profiles are additive and cannot displace a code
   profile; a mixed repository keeps its runner and gains the knowledge rules beside it.

3. **A knowledge profile may not invent a runner.** It names the declared validators and
   says a scope without one is unrun. It never asserts that a software test command exists,
   and it forbids adding one to make a check appear.

4. **Declared checks are blocked, not skipped, when they cannot run.** A missing interpreter,
   fixture or service is reported as blocked; a partial pass remains a blocker. Editing a
   validator to make a change pass is refused.

5. **Remote rules are state-transition rules.** Target identity is namespace and type plus
   id; writes are compare-and-set with an idempotency key; approval is specific and does not
   expire into permission; a fallback that drops a required field is refused; verification is
   an independent read-back, and an unavailable verifier leaves the result unverified.

## Consequences

- A repository can adopt the work profiles with one manifest key, and remove them by
  removing it; there is no hidden detection path to reason about.
- The three fact names are part of the fact vocabulary, so `simt rules why` can explain why
  a work profile did or did not apply.
- Content stays data: a domain authority list, a local ticket policy or a recipe dialect
  belongs in the repository's own pack, not in these bodies, and a change to one repository's
  procedure is not a change to every repository's.
