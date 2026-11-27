---
simt-id: compose
simt-title: Docker Compose
simt-applies: [has-compose]
simt-priority: convention
simt-scope: ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml", "**/compose.yml", "**/compose.yaml"]
---

# Stack profile: Docker Compose

Applies to: repositories with a committed Compose file.

## Configuration

- Treat the Compose file as the local service topology: service names, build contexts,
  ports, volumes, environment and dependencies all belong to this repository.
- Validate with the repository's documented Compose invocation;
  `docker compose -f <file> config` is the current-plugin form. Do not seed a hook
  command until that CLI is available in the receiving repository.
- Use explicit `depends_on` conditions for startup order where a service needs another
  to be ready. List order alone does not prove health.
- Keep override files focused on local development. Production-only credentials or
  host paths do not belong in a file developers commit.

## Runtime safety

- Pin service images by digest or document why a floating tag is intentional. Rebuilding
  an unpinned image is not a reproducible operation.
- Never commit `.env` files, passwords, tokens or private keys. Commit an example with
  placeholders and inject real values through the repository's approved secret source.
- Bind published ports to the intended interface, normally `127.0.0.1` for local-only
  services. An unpublished debug port is still reachable on the container network.
- Use named volumes for data that must outlive a container. Do not hide persistent data
  in an anonymous volume or a writable container layer.
- Add health checks for services whose readiness matters, and keep them cheap and
  non-sensitive. Restart policies are not a substitute for a correct failure path.
- Rebuild and start services only for the task that needs them. Do not leave unrelated
  containers, volumes or port bindings running after validation.
