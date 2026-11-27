---
simt-id: devcontainer
simt-title: Dev Container
simt-applies: [has-devcontainer]
simt-priority: convention
simt-scope: [".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", ".devcontainer/**/*.json", "**/.devcontainer/devcontainer.json"]
---

# Stack profile: Dev Container

Applies to: repositories that define a development container under `.devcontainer`.

## Definition

- Keep the image, features and tool versions pinned to versions this repository has
  tested. A moving base image or feature tag makes every rebuild a different machine.
- Prefer the repository's declared package manager and setup scripts. Lifecycle commands
  must exist in the receiving repository and be safe to run again.
- Make `postCreateCommand` and `postStartCommand` idempotent. They run after rebuilds and
  reopens, so they must not duplicate entries, reset local work or require a terminal.
- Use the editor's rebuild command after changing the definition. Do not assume a global
  Dev Container CLI or invent a gate command the repository has not provisioned.

## Workspace and security

- Mount the workspace at the path the repository expects. Avoid absolute paths from a
  contributor's home directory or references to another checkout.
- Run as a non-root user where the toolchain permits it. If a setup step needs elevated
  privileges, scope that step rather than making the whole session root.
- Forward only ports the development workflow uses, and bind them to localhost unless
  remote access is an explicit requirement.
- Never place credentials in the definition, a Dockerfile layer or a committed env
  file. Inject secrets at runtime through the editor's approved secret mechanism.
- Keep dependency caches in named volumes or container-only paths. Do not commit cache,
  build or installation output produced inside the container.

## Verification

- After a rebuild, run the repository's declared install, lint and test scripts through
  its own package or tool runner. A successful container build alone does not prove the
  development environment works.
- Document any host prerequisite the definition cannot install. State the action the
  reader must take rather than assuming a tool is already available.
