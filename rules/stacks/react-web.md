---
simt-id: react-web
simt-title: React web
# Browser evidence only, and the evidence is the renderer. `react` alone does not
# distinguish a browser app from React Native or Expo — `react-dom` does — and
# listing the bare language tags (`typescript`, `vitest`, `node-web`, `less`) put
# this profile on backend and static repositories that share them (S28, ADR-047).
simt-applies: [react-dom, react-router, maplibre, firebase]
simt-priority: convention
simt-scope: ["src/**/*.{ts,tsx,js,jsx}", "index.html"]
---

# Stack profile: React web

Applies to: `react-dom`, `react-router`, `maplibre`, `firebase` — a repository whose
UI is rendered in a browser.

## Types

- `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`,
  `isolatedModules`. Generated API DTOs only; never hand-write a duplicate of a
  type the API already produces.
- No `any`, no unsafe casts, no non-null boundary bypasses, no floating promises, no
  `console.*`.

## State

- Server state lives in the query layer, keyed by the query key the API defines. Do not mirror
  it into a second store.
- URL holds shareable state; component state holds transient state; nothing else.
- Any global client state pattern requires a recorded decision explaining why the query layer
  and URL are insufficient.

## CSS

- Logical properties (`margin-inline-start`, `padding-block`) rather than physical ones, so RTL
  is a consequence of the stylesheet rather than a patch.
- Semantic element names. A `div` with a click handler is a button.
- Match tokens from the design system. Raw hex, `rgb()` and `hsl()` are a review finding.

## RTL and localisation

- RTL locales mirror application chrome only. North, coordinate order, geographic pan and
  zoom, map symbols, media and universal status meaning do not mirror.
- Every user-visible string exists in every supported locale in the same change.

## Accessibility

- WCAG 2.2 AA. Keyboard reachable, screen-reader named, 400% reflow without loss of function,
  `prefers-reduced-motion` honoured.
- Run a full browser-compatibility matrix only for browser APIs, SSR or hydration, shared
  layout, MapLibre/WebGL, media, storage, crypto, a known engine divergence, or a release gate.
  Engine-neutral changes take focused checks.

## Testing

- `vitest` for unit and component; `playwright` for journeys that cross a real boundary.
- Assert behaviour, not implementation. Never weaken an assertion, an accessibility check or a
  fixture to match current behaviour.
- No arbitrary sleeps. No `.only`. No committed `.skip`. No flaky reruns.
- Inject sentinel values (a token, an id, a coordinate, a URL) and prove their absence
  from unauthorised UI, storage, cache, telemetry, URL history and artifacts.