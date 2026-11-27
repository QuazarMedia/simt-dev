---
simt-id: git-submodules
simt-title: Git submodules
simt-applies: [has-submodules]
simt-priority: convention
simt-scope: [".gitmodules", "**/.gitmodules"]
---

# Stack profile: Git submodules

Applies to: repositories that record dependencies in `.gitmodules`.

## Ownership and pins

- A submodule's working tree belongs to its own repository. Fix dependency code there,
  review and commit it upstream, then update the superproject's gitlink.
- The superproject gitlink pins the commit. The branch field in `.gitmodules` is only a
  convenience for updates; it is not a reproducible dependency pin.
- Update a submodule intentionally with `git submodule update --init --recursive` after
  cloning or when adopting the superproject's recorded revisions. Do not float every
  submodule to its remote default branch as routine setup.
- Before handing off, run `git submodule status` and inspect both repositories. A dirty
  submodule or an unexpected gitlink diff is unfinished work, not background noise.

## URLs, changes and automation

- Use the dependency's canonical remote and an access method available to this
  repository's contributors and CI. Never embed credentials in a submodule URL.
- Review `.gitmodules` URL or path changes as dependency changes. Confirm the path stays
  inside the receiving repository and the remote is the intended owner.
- When a dependency update is part of the task, commit its new revision in the
  submodule first and stage the resulting gitlink in the superproject in the same
  change. Never hand-edit a gitlink to name a commit that was not reviewed.
- CI initializes only the submodules the job needs, recursively when their own manifests
  require it. Cache checkout directories, not mutable dependency working trees.
- Do not edit vendored submodule files merely to make the superproject build. If the
  dependency cannot be consumed as pinned, change the pin or fix the dependency in its
  own repository.
