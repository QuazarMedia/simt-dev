# Ecosystem and stack support

simt-dev detects a repository from committed files and dependency manifests. Detection,
language metadata, command cards, gate seeds and Dependabot entries come from records under
`ecosystems/`; readable guidance comes from profiles under `rules/stacks/`. Adding an
ecosystem does not add a product branch to the detector or projector (ADR-013).

A profile is guidance, not proof that a tool is installed. Fresh adoption seeds a gate only
when the repository carries the ecosystem evidence and the machine can run the declared tool
(ADR-017, ADR-062). Command cards read committed evidence only; a card entry does not claim
that its toolchain is installed.

## Support matrix

| Area | Committed evidence | Profile | Automation |
| --- | --- | --- | --- |
| Node.js and TypeScript | `package.json`, source extensions, lockfile | `node`, `typescript` | Declared package scripts drive gates and cards; npm, pnpm or Yarn Dependabot follows the lockfile |
| React web | `react` and `react-dom` dependencies | `react-web` | Node script gates and card |
| React Native / Expo | `react-native` or `expo` dependency | `react-native` | Node script gates and card |
| Cloudflare Workers | Wrangler configuration | `cloudflare-workers` | Node script gates and card |
| Hono on Node | `hono` dependency | Node fallback | Node script gates and card; not classified as Workers |
| Bun | `bun.lock` or `bun.lockb` | `bun` | Package scripts run through `bun run`; Bun Dependabot replaces npm rows |
| Deno | `deno.json` | `deno` | Format, lint, test and typecheck gates; card and Dependabot |
| Next.js | exact `next` dependency | `nextjs` | Framework profile; existing Node gates, card and Dependabot |
| Vue / Nuxt | exact `vue` / `nuxt` dependency | `vue-nuxt` | Framework profile; existing Node gates, card and Dependabot |
| Svelte / SvelteKit | exact `svelte` / `@sveltejs/kit` dependency | `svelte-sveltekit` | Framework profile; existing Node gates, card and Dependabot |
| Angular | exact `@angular/core` dependency | `angular` | Framework profile; existing Node gates, card and Dependabot |
| Python | `pyproject.toml` and the repository's lockfile | `python`, `uv` where proven | Runner-aware card; repository-declared gates; Dependabot |
| Rust | `Cargo.toml` | `rust` | Format, lint and test gates; focused-test card; Dependabot |
| Go | `go.mod` | `go` | Format, lint and test gates; focused-test card; Dependabot |
| Ruby | `Gemfile` | `ruby` | Bundler format and test gates; focused-test card; Dependabot |
| Gradle / Kotlin / Java | Gradle build files and `gradlew` | `jvm` | Gradle build card; repository-declared gates; Dependabot |
| Maven | `pom.xml` and Maven wrapper | `jvm` | Wrapper-aware test gate and card; Dependabot |
| Android | Android manifest and Gradle module | `android` | Android-specific focused-test card; Gradle tooling |
| ConnectIQ | ConnectIQ project evidence | `connectiq` | Repository-declared memory and codegen gates |
| .NET C# / F# | `*.csproj`, `*.fsproj` or solution | `dotnet`, plus `fsharp` for F# | Root project or solution seeds format, test and typecheck gates and card; nested projects keep profile and NuGet coverage |
| Swift package | `Package.swift` | `swift` | Format, test and typecheck gates; card |
| Native Apple / Xcode | root `*.xcodeproj` or `*.xcworkspace` | `xcode` | Profile only until the repository declares runnable `xcodebuild` commands |
| Dart | `pubspec.yaml` without a Flutter SDK dependency | `dart` | Format, lint and test gates; card; pub Dependabot |
| Flutter | `pubspec.yaml` with `flutter: { sdk: flutter }` | `flutter` | Analyze and test gates; focused-test card; Dart commands are suppressed |
| Kotlin Multiplatform | Kotlin Multiplatform Gradle marker | `kotlin-multiplatform` | Reuses Gradle build tooling; no JVM-only focused-test assumption |
| Compose Multiplatform | Compose Multiplatform Gradle marker | `compose-multiplatform` | Reuses Gradle build tooling; no JVM-only focused-test assumption |
| Elixir | `mix.exs` | `elixir` | Format and test gates; build/focused card; Dependabot |
| PHP / Composer | `composer.json` | `php` | Strict Composer validation gate; project-local PHPUnit card; Dependabot |
| C / C++ with CMake | `CMakeLists.txt` | `cpp` | CMake build and CTest card; no guessed compiler gate |
| C / C++ with Meson | `meson.build` | `cpp` | Meson build and test card; no guessed compiler gate |
| Erlang / OTP | `rebar.config` or `erlang.mk` | `erlang` | Runner-specific build and focused-test card; no speculative gate |
| Terraform | `*.tf` | `terraform` | Root configuration seeds format and validate-as-lint gates and card; nested modules keep profile and Dependabot coverage |
| OpenTofu | `*.tofu` | `terraform` | Root configuration seeds format and validate-as-lint gates and card; nested modules keep profile and shared Terraform Dependabot coverage |
| Docker | `Dockerfile` | `container` | Profile and Dependabot; repository-declared image gates |
| Docker Compose | Compose file | `compose` | Profile and Dependabot; repository-declared Compose gates |
| Dev Containers | `.devcontainer/devcontainer.json` | `devcontainer` | Profile and Dependabot; repository-declared tooling |
| Git submodules | `.gitmodules` | `git-submodules` | Profile and Dependabot; repository-declared submodule checks |

## Detection contract

A record can prove a fact with:

- `markers`: root filenames or root directory patterns;
- `probes[].files`: repository-relative file existence;
- `probes[].regex`: bounded text matching in a declared file;
- `probes[].json.paths`: exact object-key existence in a declared JSON file;
- `probes[].globs`: root patterns or the detector's depth-bounded repository walk;
- `probes[].stripComments`: optional C-style comment removal before regex matching.

Text probes read at most 256 KiB per file and do not follow symlinks outside the owning
repository. Unsafe paths, invalid regular expressions, ambiguous matchers and malformed
exclusions quarantine a local record rather than applying part of it. Every detected fact
carries file-level evidence. Broad ecosystem facts can select guidance and Dependabot for
nested projects; root gates and root-command card lines require root-scoped evidence.

`unless` excludes a condition, gate row or Dependabot row when another fact is present. It is
how Flutter suppresses duplicate Dart commands and how a Bun lockfile suppresses npm
Dependabot rows without naming either product in engine code. See
[ADR-262](../decisions/ADR-262-ecosystem-probes-and-root-aware-signal-vocabulary.md).

## Adding support

Follow [add an ecosystem](../contributing/add-an-ecosystem.md) and
[add a stack profile](../contributing/add-a-stack-profile.md). Add positive and negative
fixtures, assert the evidence path, and check the resulting gates, card and Dependabot rows.
A new product name belongs in data and guidance, not in `fingerprint.mjs` or the projector.
