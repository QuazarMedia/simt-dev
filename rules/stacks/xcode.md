---
simt-id: xcode
simt-title: Xcode
simt-applies: [has-xcode]
simt-priority: convention
simt-scope: ["*.xcodeproj/**", "*.xcworkspace/**", "**/*.xcscheme", "**/*.swift", "**/*.m", "**/*.mm", "**/*.xcassets/**", "**/Info.plist", "**/*.xcconfig"]
---

# Stack profile: Xcode

Applies to: a root Xcode project or workspace. A Swift package by itself is not
an Xcode application.

## Schemes and workspaces

- Read the project or workspace and its shared schemes before changing build
  settings. A scheme names targets, configurations and launch arguments; the
  workspace groups projects and resolves their dependencies.
- Use the repository's declared `xcodebuild` invocation from its scripts, CI
  workflow or contributor documentation. Confirm the same project or workspace,
  scheme and destination with `xcodebuild -list` before running it. If no build
  command is declared, inspect those declarations instead of inventing a gate.
- Keep shared schemes under version control when CI or another developer depends
  on them. A local scheme in `xcuserdata` is not a reproducible build definition.
- Edit `project.pbxproj` deliberately. Resolve object and file-reference
  conflicts in Xcode where possible; do not mass-regenerate identifiers or remove
  build phases to make a conflict disappear.
- Pin the Xcode and SDK versions where the repository declares them. A newer
  toolchain on one developer's machine is not evidence that CI can build it.

## Signing and secrets

- Keep team identifiers, bundle identifiers, provisioning choices and
  entitlements in the repository's declared configuration. Do not solve a
  signing failure by disabling code signing or broadening entitlements.
- Never commit signing private keys, certificates, provisioning profiles, API
  keys or service-account files. CI retrieves secrets from its secret store and
  imports signing material into an ephemeral keychain.
- Give every entitlement a user-facing reason. Remove a capability when its code
  and purpose disappear; a dormant permission is still shipped to users.
- Keep machine-specific paths and account names out of shared build settings.
  Use an `xcconfig` include or CI substitution for values that vary by runner.

## Simulator and device builds

- Treat simulator and device destinations as different evidence. A simulator
  pass does not prove signing, device architecture, camera, push notifications,
  background execution or performance on hardware.
- Choose the destination from the repository's declared scheme and CI matrix.
  Do not replace a required device with a simulator merely because it is faster.
- When a failure is destination-specific, record the device or simulator, OS
  version, architecture and scheme with the result. Keep a reproducible command
  for the destination that actually ran.

## Assets and property lists

- Add images, colours, data assets and app icons through asset catalogs. Preserve
  logical names, preserve vector data where supported, and provide every required
  icon and launch-image scale.
- Asset accessibility descriptions are user-facing content. Localise them with
  the strings they describe; a decorative asset is marked decorative rather than
  given a misleading description.
- Keep the source-controlled `Info.plist` authoritative for the values it owns.
  Do not duplicate a key in both the plist and build settings and then depend on
  merge order.
- Purpose strings for location, camera, microphone, contacts, photos and other
  protected data must explain the actual feature. Never add a generic permission
  description to silence an approval failure.
- Review background modes, URL schemes and exported type declarations as public
  attack surface. Remove declarations that no shipped feature uses.

## Validation

- Run the repository-declared build and test commands for each required scheme
  and destination. Do not claim a target passed because a different target built.
- Unit tests cover logic; UI tests cover journeys on the declared destination.
  Accessibility and snapshot checks run where the repository maintains them, and
  their baselines are reviewed rather than blindly regenerated.
- A Swift package target still uses its package commands. Xcode markers add the
  Apple application rules; they do not turn `swift test` into an application test.
