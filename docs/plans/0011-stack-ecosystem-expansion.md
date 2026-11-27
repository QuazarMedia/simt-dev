# Plan 0011 — stack and ecosystem expansion

Status: **complete** · 2026-11-27

## Scope

Complete the stack integrations recommended for simt-dev without adding
product-specific engine branches. One generic probe and vocabulary contract
supports every addition; ecosystems remain records and guidance remains
profiles.

## Tracker

| id | state | slice | evidence |
| --- | --- | --- | --- |
| SE01 | Complete | ADR-262, declarative probes, root-aware vocabulary | probe, vocabulary and exclusion tests |
| SE02 | Complete | Composer, Terraform/OpenTofu, Bun, containers and submodules | focused record/profile tests |
| SE03 | Complete | Flutter, Xcode, Kotlin Multiplatform and Compose Multiplatform | focused mobile/platform tests |
| SE04 | Complete | C/C++, F# and Erlang/OTP | focused language/platform tests |
| SE05 | Complete | Next.js, Vue/Nuxt, Svelte/SvelteKit and Angular | focused web framework tests |
| SE06 | Complete | documentation, rendered projections and full validation | 159 focused tests; check, lint, package and isolated full suite |

## SE01 — generic probes and vocabulary

Acceptance: validated probes prove file, text, JSON and glob facts with
file-level evidence; malformed records are quarantined; content reads are
bounded; shipped and local record facts validate in profiles, inferability
markers and graph lint; `unless` suppresses conflicting rows.

## SE02 — partial ecosystem integrations

Acceptance: Composer, Terraform/OpenTofu, Bun, Docker, Compose, Dev Containers
and Git submodules gain complete records, guidance, language/gate/card or
Dependabot metadata as applicable, and focused tests. No unrunnable gate is
seeded.

## SE03 — mobile and Apple platforms

Acceptance: Flutter, native Xcode, Kotlin Multiplatform and Compose
Multiplatform are detected from committed evidence, have readable profiles,
and reuse or declare only runnable tooling. Flutter suppresses duplicate Dart
commands.

## SE04 — C/C++, F# and Erlang/OTP

Acceptance: CMake/Meson, nested F# projects and Erlang build files are
detected; language resolution and focused-test conventions are present;
guidance uses declared repository commands rather than guessed runners.

## SE05 — JavaScript frameworks

Acceptance: Next.js, Vue/Nuxt, Svelte/SvelteKit and Angular are detected from
exact dependencies and receive framework guidance alongside the applicable
Node/TypeScript baseline without duplicate rules.

## SE06 — documentation and validation

Acceptance: the contributor and ecosystem references describe the contract
and support matrix; the decisions index is regenerated; focused tests, graph
lint, `simt check`, rendered-region review and the full suite run from an
isolated checkout with no sibling repositories, with no failures beyond the
clean-HEAD baseline.

## Validation

- Focused ecosystem, card, genericity, upgrade and Dependabot suites: 159/159.
- Full ESLint, graph lint, `simt check` and package dry run: passed; the package
  contains all 32 checked expansion assets.
- Full isolated suite: 3,079 passed, 17 failed, 1 skipped. All 17 failures are
  the clean-HEAD bench chain caused by the pre-existing missing `SURFACES`
  export; no stack-expansion test failed.
