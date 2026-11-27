---
simt-id: vue-nuxt
simt-title: Vue and Nuxt
simt-applies: [has-nuxt, has-vue]
simt-priority: convention
simt-scope: ["package.json", "tsconfig.json", "nuxt.config.{js,mjs,ts}", "vite.config.{js,mjs,ts}", "app.vue", "src/**/*.{ts,js,vue}", "app/**/*.{ts,js,vue}", "pages/**/*.vue", "components/**/*.vue", "server/**/*.{ts,js}"]
---

# Stack profile: Vue and Nuxt

Applies to: an exact `nuxt` or `vue` dependency in `dependencies` or `devDependencies`.

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

## Vue SPA or Nuxt

- Identify the mode before editing. A Nuxt config, Nuxt dependency, `app.vue`, `pages/` or
  `server/` means Nuxt; a Vite entry such as `src/main.ts` mounting a Vue app is a SPA unless
  Nuxt evidence says otherwise.
- Do not assume Nuxt auto-imports, server routes, SSR or `useFetch` exist in a plain Vue SPA.
  Conversely, do not replace Nuxt conventions with a hand-built SPA shell.

## Components and reactivity

- Prefer the Composition API and `<script setup lang="ts">`. Type props with
  `defineProps<Props>()`, events with typed `defineEmits`, and exposed values explicitly.
  External component contracts retain runtime validation where the framework requires it.
- Use `ref` for primitive state, `reactive` for cohesive object state and `computed` for derived
  values. Do not mutate props or duplicate derived state. Destructuring a reactive object
  requires `toRefs` when the bindings must stay reactive.
- Cancel or ignore superseded async work. An older request must not overwrite newer component
  state, and a computed must not perform a side effect.

## SSR safety

- Access `window`, `document`, `localStorage` and other browser globals only after mount or
  behind an explicit client guard. Server rendering and hydration must produce the same initial
  markup.
- Never keep per-request user state in module scope. Pass request state through Nuxt's request
  context and use SSR-safe storage APIs for values shared between server and client.

## Nuxt server routes and data

- Put server endpoints under `server/api/`; validate input and authenticate and authorise every
  operation there. Server-only secrets come from private runtime configuration and never enter
  `public` runtime config, rendered HTML or a serialized payload.
- Use `useFetch` or `useAsyncData` with stable, unique keys and explicit revalidation where data
  changes. Share one request instead of fetching the same payload in every component.
- Auto-import framework composables only as configured. Import domain services, shared types
  and utilities explicitly; resolve naming collisions rather than relying on a hidden global.

## Accessibility and tests

- Use semantic elements, labelled controls, keyboard operation, visible focus and announced
  async errors. Test component behaviour and Nuxt server routes with the declared runner, and
  hydration-sensitive journeys in the declared browser runner.
