---
simt-id: svelte-sveltekit
simt-title: Svelte and SvelteKit
simt-applies: [has-sveltekit, has-svelte]
simt-priority: convention
simt-scope: ["package.json", "tsconfig.json", "svelte.config.{js,mjs,ts}", "vite.config.{js,mjs,ts}", "src/**/*.{ts,js,svelte}", "tests/**/*.{ts,js}"]
---

# Stack profile: Svelte and SvelteKit

Applies to: an exact `@sveltejs/kit` or `svelte` dependency in `dependencies` or
`devDependencies`.

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
  with non-emitting typechecks where the bundler owns output generation.
- No `any`, unsafe casts, non-null boundary bypasses, floating promises or `console.*` in
  application code. Narrow untrusted values explicitly.

## Svelte or SvelteKit

- Distinguish a plain Svelte component app from SvelteKit before adding route code. A Kit
  dependency, Kit config or `src/routes/` establishes Kit conventions; a component library or
  Vite-mounted Svelte app does not gain `load`, actions or endpoints by assumption.
- Keep the installed Svelte and Kit versions' conventions. Do not import Kit server modules into
  a plain Svelte build.

## Reactivity and state lifetime

- Use runes such as `$state`, `$derived` and `$effect` when the repository declares rune mode.
  Keep stores and legacy `$:` reactive declarations in legacy code; do not mix reactivity models
  in one module without a migration reason.
- Derive values rather than mirroring them. Never mutate a derived value. Effects synchronise
  with external systems and return cleanup; they are not a second source of truth.
- Avoid stale closure state. A timer, subscription or async callback must read the current value
  through its reactive owner or be recreated when that value changes. Clean up listeners and
  effects on destruction.

## Load, actions and endpoints

- Universal `load` code runs on both server and client; `load` in a server module and server-only
  imports stay on the server. Type page data, return serializable values, fetch independent data
  in parallel and never expose a secret in load data.
- Form actions validate input, authenticate and authorise on the server, and return typed
  failures or intentional redirects. Progressive enhancement remains usable without JavaScript;
  pending, validation and error states are explicit.
- Use `+server` endpoints for non-page HTTP APIs. Apply the same domain services and validation
  as form actions, and return deliberate `Request`/`Response` statuses.

## SSR safety and accessibility

- Guard `window`, `document`, `localStorage` and other browser globals with `onMount` or an
  explicit browser check. Keep initial server and client markup identical, and never store
  per-request user state in module scope.
- Use semantic HTML, labelled controls, keyboard operation, managed focus and live announcements
  for async status. Do not silence an accessibility warning to make a build pass.

## Tests

- Test reactivity transitions, stale async work, load data, action authorization and endpoint
  statuses through the declared test script. Browser checks cover hydration and progressive
  enhancement when those boundaries change.
