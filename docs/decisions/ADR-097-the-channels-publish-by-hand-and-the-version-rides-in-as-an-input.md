# ADR-097 — the channels publish by hand, and the version rides in as an input

Status: **accepted** · 2026-10-25

**Affects:** `.github/workflows/publish.yml`,
`.github/workflows/publish-channels.yml`, `scripts/publish-local.mjs`,
`docs/decisions/ADR-058-one-tool-three-channels-and-the-order-is-forced.md`

## Context

ADR-058 ruled the three channels and the order between them — npm first, PyPI and
Homebrew only once the npm version is live — and its ruling 7 also pinned the
mechanics: the two channel jobs lived inside `publish.yml`, next to the staging job,
and a maintainer re-ran them through "Re-run failed jobs" once `npm stage approve` had
landed. The same ruling recorded why no `workflow_dispatch` could replace that:
on a dispatch, `github.ref_name` is the branch, and the version guard would compare a
tag against a branch.

Running it that way taught something the ruling did not predict. The channel jobs fail
on every release **by design** — the stage is not approvable until a human decides, so
a healthy release hours in is a release whose run is red. A run that is red when
nothing is wrong is the argument ADR-058 itself used against a gate that is red on the
day it lands: it teaches the reader to ignore red. And the only supported recovery is
re-running part of an old run, an action buried in the run page's retry menu rather
than in anything a maintainer can name.

The branch problem stays, but it points at a different fix. A dispatch cannot carry a
tag in `ref_name`, but it doesn't have to: the version is one string, it is already
written in exactly one place (`package.json`), and the maintainer who just approved
the stage knows it — they typed or copied it to get here.

## Ruling

1. **`publish.yml` owns npm staging and stops there.** The tag workflow keeps the
   version guard and the staging job, and no longer carries a job designed to sit red
   for hours. A green publish run means "staged", and nothing in it promises more.

2. **The channels run from `.github/workflows/publish-channels.yml`, a
   `workflow_dispatch` whose `version` input is the release (e.g. `0.5.0`).** The
   version is the *input*, not the ref, which is what dissolves the branch-vs-tag
   failure ADR-058 recorded: the input travels into the guard, and the guard refuses
   to run unless tag `v<version>` exists on the default branch's history and its
   checkout's `package.json` agrees with it. A dispatch cannot guess; the input makes
   guessing impossible.

3. **The ordering ruling is unchanged.** Both channel jobs still begin with the check
   that `npm view` serves the version (PyPI) and that the tarball is downloadable
   (Homebrew), and both still name the remedy — `npm stage approve <stage-id>` —
   when it is not. What moved is who runs the steps and how the version travels;
   what did not move is that npm is live before either channel publishes.

4. **The channel jobs keep their identity unchanged.** PyPI still publishes with
   trusted publishing against the `pypi` environment; Homebrew still audits, renders
   and pushes the formula to the tap. Nothing about the artefacts changed, so ADR-058
   rulings 1–6 read as written.

## Consequences

A maintainer's release tour is two named actions instead of one retry:

```
npm stage approve <stage-id>
gh workflow run publish-channels.yml -f version=<VER>
```

Red is honest again: a red channel run means a channel defect, and the release page
carries no run whose expected end state is red. `scripts/publish-local.mjs` keeps its
role as the not-CI twin — it mirrors `publish.yml` for npm and
`publish-channels.yml` for the two channels, and its header now says exactly that,
because a twin of a file whose name no longer holds what it did is a comment that
misdescribes the artefact (the estate's own rule against decoration that lies).
