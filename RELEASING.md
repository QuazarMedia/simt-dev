# Releasing simt-dev

## Burned versions (review 0003 Q06)

`0.0.0-stage` and `1.0.0` on the npm registry are placeholders from before
this package published: 272 bytes, no `bin`, nothing installable. They can
never be reused, and any `^1` range resolves to the unusable `1.0.0`.

- Both are deprecated on the registry (owner action, once):

  ```sh
  npm deprecate simt-dev@1.0.0 "placeholder — use 0.x"
  npm deprecate simt-dev@0.0.0-stage "placeholder — use 0.x"
  ```

- `1.0.0` stays burned: the first stable release is `1.0.1` or later, never
  a reuse of `1.0.0`. `test/packaging.test.mjs` guards the `package.json`
  version against both placeholders.
