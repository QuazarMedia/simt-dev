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

## The three channels

A release is three artefacts, staged and promoted in order: npm (`publish.yml`,
triggered by the tag, staged until a maintainer approves it), then PyPI and
Homebrew (`publish-channels.yml`, run by hand after that approval).

```sh
gh workflow run publish-channels.yml                    # newest on npm
gh workflow run publish-channels.yml -f version=0.7.0   # a named release
```

One run resolves ONE release (ADR-203). The `resolve` job turns the input into
a descriptor — concrete version, the commit the tag names, and every release
asset's sha256 — and prints the evidence:

```
release     simt-dev 0.7.0
commit      4f1d… (40 hex)
tag         v0.7.0
asset       simt-dev-0.7.0-darwin-arm64 4214… 11000000 bytes https://…
…
descriptor  9c2e…
```

Every channel job reads that descriptor, re-checks that npm's newest version,
the tag and the asset bytes still agree with it, and only then promotes.
Serialisation is per destination on the resolved version, so `latest` and an
explicit version that name the same release cannot promote it concurrently.

Retries are safe and explicit: a destination that already serves the release is
a skip, a tap that already has the bytes commits nothing, and a destination
serving the version at different bytes is a conflict rather than a republish.
When PyPI and brew disagree about an asset hash, the recheck names the target
and both hashes.

### Rehearsing without a network

The resolver answers from a directory in `--simulate` mode, which is how the
failure cases are tested:

```sh
node scripts/release-descriptor.mjs \
  --simulate=/tmp/estate --request=latest --out=/tmp/descriptor.json --print
```

`/tmp/estate` holds `npm-version.txt`, `npm.json` (`{"versions":[…]}`),
`tags.json` (`{"0.7.0":"<40 hex>"}`), `assets/<asset name>` and optionally
`tap.rb`. Run it again with `--recheck=/tmp/descriptor.json` after moving
`npm-version.txt` to see the moving-release refusal.
