---
simt-id: work/knowledge
simt-title: Knowledge work
simt-applies: [has-work-scopes]
simt-priority: convention
simt-scope: ["**/*.md", "**/*.mdx", "**/*.html"]
---

# Work profile: knowledge

Applies to a repository whose product is a document, not a program: it declares scopes
under `work` in `{manifest}` and may carry no package runner at all. The rules here sit
beside the code profiles; they never replace them, so a repository that also carries source
keeps its test and lint obligations.

## What is checked

- Read the declared scopes and their validators from `{manifest}` before claiming anything
  is checked. A scope with no validator has no automated check, and the honest report is
  "unrun", not "passing".
- Run the declared validator for the scope the change touches, through the repository's own
  runner when the validator names one. A validator that cannot run is a blocked check, not
  a skipped one.
- Do not invent a runner. If the repository declares no test command, there is no test
  command to run, and no `package.json`, `pyproject.toml` or build step may be added to make
  one appear.

## Claims and sources

- A document that is well formed is not a document that is correct. Structure and link
  checks prove structure and links; they are not evidence about the subject.
- Every factual claim names its source and the date the source was read. A claim with no
  source is an assertion, and an assertion presented as a verified outcome is the defect
  this profile exists to prevent.
- Respect scope: a fact established for one country, topic or effective date is not
  evidence for another. Where the applicable scope or date is unknown, say so.
- When two sources disagree, report the contradiction with both citations rather than
  choosing one silently.

## Generated artifacts

- Fix the generator, not the rendering. A hand edit to a generated page is overwritten on
  the next run and leaves the source of truth wrong.
- A change to a generator is a change to every document it produces: run the validator for
  each affected scope before claiming the change is complete.
- Keep media and other binary outputs out of review unless the diff needs them; describe
  what regenerated them instead.

## Reporting

- Name the artifact id or path, the validator, and what it proved. "Docs updated" is not a
  result; "ran the Germany validator, 12 documents checked, 0 structural failures, subject
  claims reviewed against sources snapshot 2026-10-20" is.
