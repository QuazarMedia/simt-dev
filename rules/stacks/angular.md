---
simt-id: angular
simt-title: Angular
simt-applies: [has-angular]
simt-priority: convention
simt-scope: ["package.json", "tsconfig.json", "angular.json", "src/**/*.{ts,html,scss,css}"]
---

# Stack profile: Angular

Applies to: an exact `@angular/core` dependency in `dependencies` or `devDependencies`.

## Node and TypeScript baseline

- Commit one `packageManager` field and the lockfile belonging to that manager; keep both in
  step with dependency changes. Do not assume npm. Keep the declared Node version, CI and the
  repository's version file in agreement.
- Read `package.json` before running anything. Invoke declared scripts as
  `<manager> run <script>` through the repository's wrapper, never through an ad-hoc package
  executor or a global binary (ADR-010).
- Declare `format`, `format:check`, `lint`, `typecheck` and `test` scripts. CI and hooks run the
  check scripts; wrap the Angular CLI and other framework tools in those scripts rather than
  guessing commands at the shell.
- Keep TypeScript `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled,
  with non-emitting typechecks where the framework owns output generation.
- No `any`, unsafe casts, non-null boundary bypasses, floating promises or `console.*` in
  application code. Narrow untrusted values explicitly.

## Standalone and bootstrap architecture

- Bootstrap with `bootstrapApplication` and a standalone root component. Prefer standalone
  components, directives and pipes; introduce an `NgModule` only for a documented interop or
  legacy boundary.
- Keep application providers in the bootstrap config and feature providers at the lazy feature
  boundary. Routes use standalone lazy components or lazy routes rather than eager feature modules.

## Signals and change detection

- Use signals for local synchronous state, typed signal inputs for component inputs and
  `computed` for derived values. Update signals rather than mutating their values, and never
  mutate state from a template or computed expression.
- Use effects only to synchronise with external systems, with explicit cleanup. Do not use an
  effect to mirror one signal into another.
- Default components to `OnPush`. Treat inputs as immutable, update state through signals or
  immutable observable emissions, and never call change detection manually to conceal an update
  that the zone or signal graph did not explain.

## Typed reactive forms

- Use typed reactive `FormGroup`, `FormControl` and `FormArray` values. Add validators and
  `nonNullable` deliberately; do not bypass the form type with `any` or an unsafe cast.
- Read and submit the typed value only after validation. Keep validation and authorization on
  the server as well; a client validator grants nothing.

## Dependency injection and HTTP

- Prefer `inject()` at an injection context. `providedIn: 'root'` is for stateless singletons;
  request-, route- or user-scoped state belongs to the matching child injector.
- Keep services behind narrow interfaces, avoid circular dependencies and never inject a secret
  into browser-side application code.
- Use typed `HttpClient` response and error types. Put cross-cutting authentication, correlation
  and error translation in interceptors, preserve cancellation, and release subscriptions with
  the framework's destruction-aware operator.

## Routing and strict templates

- Define routes in the standalone route configuration, lazy-load feature areas and type route
  params and data. Guards control navigation; they do not replace server-side authorization.
- Keep `strictTemplates` and `strictInjectionParameters` enabled. No `$any`, unsafe template casts
  or non-null assertions. Narrow nullable values in the component and keep templates free of
  side effects and expensive repeated calls.

## Tests

- Use the repository's declared Angular test runner. Cover standalone bootstrap and providers,
  signal transitions, typed form validation, HTTP interception, routing guards and authorization
  failures; do not call change detection manually to make an under-specified component pass.
