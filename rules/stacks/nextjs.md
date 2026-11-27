---
simt-id: nextjs
simt-title: Next.js
simt-applies: [has-next]
simt-priority: convention
simt-scope: ["package.json", "tsconfig.json", "next.config.{js,mjs,ts}", "middleware.{ts,js}", "src/middleware.{ts,js}", "app/**/*.{ts,tsx,js,jsx}", "src/app/**/*.{ts,tsx,js,jsx}", "pages/**/*.{ts,tsx,js,jsx}", "src/pages/**/*.{ts,tsx,js,jsx}"]
---

# Stack profile: Next.js

Applies to: an exact `next` dependency in `dependencies` or `devDependencies`.

## Node and TypeScript baseline

- Commit one `packageManager` field and the lockfile belonging to that manager; keep both in
  step with dependency changes. Do not assume npm. Keep the declared Node version, CI and the
  repository's version file in agreement.
- Read `package.json` before running anything. Invoke declared scripts as
  `<manager> run <script>` through the repository's wrapper, never through an ad-hoc package
  executor or a global binary (ADR-010).
- Declare `format`, `format:check`, `lint`, `typecheck` and `test` scripts. CI and hooks run the
  check scripts; wrap framework CLIs in those scripts rather than guessing commands at the shell.
- Keep TypeScript `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled,
  with non-emitting typechecks where the framework owns output generation.
- No `any`, unsafe casts, non-null boundary bypasses, floating promises or `console.*` in
  application code. Narrow untrusted values explicitly.

## Router and component boundaries

- Establish whether the App Router (`app/`) or Pages Router (`pages/`) owns the routes,
  including their `src/` variants. Do not mix their layouts, data APIs or conventions for the
  same route; a migration between routers is an explicit plan.
- App Router components are server components by default. Add `use client` only at the smallest
  interactive leaf that needs state, effects or browser APIs; never client-ify the whole app.
- Keep server-only objects and secrets out of client props. Pass serializable data across the
  boundary and validate it again at the receiving boundary.

## Secrets and server execution

- Secrets belong only in server components, server actions, route handlers or server middleware.
  Mark shared server modules with `server-only`; never import them into the client graph.
- A `NEXT_PUBLIC_` value is public by design. Never put a credential there, and never log a
  secret or return one in a response, metadata field or client payload.

## Data and cache semantics

- Follow the installed Next.js version's documented defaults and make the cache policy explicit
  at each data boundary. Mutations revalidate or purge every affected path and tag.
- Authenticated and user-specific data is private and `no-store`; never place it in a shared
  cache. Do not keep request or user state in mutable module scope.
- Server actions and route handlers authenticate and authorise on the server. Validate params,
  search values and bodies; return intentional status codes and `Response` values. UI calls the
  same domain service rather than duplicating policy in a client component.

## Metadata and accessibility

- Define metadata statically or with `generateMetadata`. Escape untrusted titles and
  descriptions, keep canonical and social metadata consistent, and never derive public metadata
  from a secret.
- Use semantic HTML, labelled controls, keyboard operation and managed focus. A client boundary
  is not a reason to drop server-rendered content or accessible names.

## Tests

- Exercise router selection, server/client boundaries, authorization, cache revalidation and
  metadata through the repository's declared test script. Browser journeys use the declared
  browser runner; do not introduce a second runner without a recorded reason.
