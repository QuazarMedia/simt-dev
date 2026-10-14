---
simt-id: container
simt-title: Containers
simt-applies: [has-dockerfile]
simt-priority: convention
simt-scope: ["Dockerfile", "*.dockerfile"]
simt-fallback: false
---

## Containers

A Dockerfile is the build. If a rule here and the repo's own instructions disagree, the
repo wins — but the disagreement is worth raising, because these are the mistakes that
survive to production.

- **Pin the base image by digest.** A floating `FROM node:22` means last night's build is
  not reproducible and a compromised upstream tag is your problem. If the repo deliberately
  tracks a tag, do not "fix" it silently.
- **Never bake a secret.** No `ARG` that holds a token, no `ENV` holding a key, no `COPY
  .env`. Build args are recorded in image history, which is world-readable in most
  registries. Read secrets from the runtime environment.
- **Copy as little as possible.** Copy manifests first, install, then copy source: a
  dependency layer invalidates on every source edit otherwise. And never `COPY . .` when a
  `.dockerignore` exists to be honoured.
- **Run as a non-root user**, and do not need root to write to the application directory.
- **One process per container.** Signals, restart policy and log collection all assume the
  entrypoint is the app, not a shell wrapping it.
- **Expose only what is served.** An unpublished port is still reachable on the container
  network; an `EXPOSE` is documentation, not a control.
- **Health endpoints are not debug endpoints.** A health check runs often, automatically,
  and on every replica. It must not leak counts, versions, or stack traces.
- **The image is the unit of rollback.** A change you cannot rebuild byte-identically is a
  change you cannot roll back, which is a worse position than not shipping it.