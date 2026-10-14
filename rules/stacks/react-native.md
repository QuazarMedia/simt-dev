---
simt-id: react-native
simt-title: React Native
# Selected on the runtime, not on the component library. React Native and Expo
# arrived with the tag `react` and therefore received the React *web* profile —
# CSS logical properties, a browser matrix, WCAG reflow at 400 % — none of which a
# native surface has (S28, ADR-047).
simt-applies: [react-native]
simt-priority: convention
simt-scope: ["app.json", "metro.config.js", "ios/**", "android/**"]
---

# Stack profile: React Native

Applies to: `react-native` — a `react-native` or `expo` dependency. A repository whose
UI is rendered in a browser gets the `react-web` profile instead; see that profile for
the rules this one does not repeat.

## What does not apply here

- **No CSS.** There is no cascade, no `media` query and no logical property. Layout is
  Yoga; a stylesheet is a `StyleSheet` object. Do not port a web stylesheet.
- **No DOM and no browser matrix.** No `document`, no `window`, no engine-compatibility
  run. The platform is native.
- **No URL as shared state.** Navigation state lives in the navigator; deep links are
  the one shareable form, and they are read as parameters.

## Platform boundaries

- A native module is a dependency, not a `npm install`. Adding one changes the
  prebuild output, and the app must be rebuilt to run — `reload` is not enough.
- Permissions come from the platform manifest (`app.json` / `Info.plist`), not from a
  runtime prompt a library raises for itself. State the reason string; a bare
  "allow" teaches nobody anything.
- Secrets never reach the bundle. A value in JavaScript is a value in the app store's
  copy of the app.

## Accessibility

- WCAG 2.2 AA where the platform can express it, and the platform's own semantics where
  it cannot: `accessibilityLabel`, `accessibilityRole` and `accessibilityHint` carry
  what `alt` and `aria` carry on the web.
- Respect the OS text size, bold text and reduced-motion settings. A fixed `fontSize`
  breaks all three.
- Touch targets meet the platform minimum, and the minimum is asserted rather than
  eyeballed.

## Types

- `strict` plus the full strictness set. No `any`, no unsafe casts, no non-null
  boundary bypasses, no floating promises, no `console.*`.

## Testing

- Unit and component tests with `jest` or the repo's declared runner; journeys that
  cross a real boundary — a deep link, a permission, a native module — are the ones
  that need a device or an emulator, and they say so.
- Assert behaviour, not implementation. Never weaken an assertion, an accessibility
  check or a fixture to match current behaviour.
- No arbitrary sleeps. No `.only`. No committed `.skip`. No flaky reruns.