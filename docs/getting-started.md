# Getting started

## Requirements

Node **>= 22.20.0** for the npm and PyPI channels. That floor is not a preference: the
index needs `node:sqlite` with FTS5, and a Node that cannot build those tables is refused
by name rather than given a second format to read. The release binary carries its own
runtime, so a machine with no Node can still run the command.

Pin the release you install. The tool writes a content digest into the files it generates,
and an unpinned upgrade changes them under you.

## npm

```sh
npm i -D simt-dev

# or globally
npm i -g simt-dev

# or once, with no install
npx -y simt-dev check
```

## PyPI

The wheel carries the same bytes as the npm tarball. It does not fetch them from npm at
install time.

```sh
pip install simt-dev

# when this machine has no node
pip install "simt-dev[node]"
```

`simt` is the command on both channels. Node is resolved in this order, and the first one
that answers wins: `SIMT_DEV_NODE`, the node bundled with the `node` extra, then `node` on
`PATH`.

## Homebrew

```sh
brew install QuazarMedia/homebrew-tap/simt-dev
```

The formula downloads the single-file binary for this machine, which carries its own
runtime: the command works with no Node installed.

## As a single-file binary

Each release carries one executable per platform — macOS arm64 and x64, Linux x64 —
beside its `.sha256`. Pin the release you download, and run this from the repository's top
level:

```sh
version=<version>; os=$(uname -s | tr A-Z a-z); arch=$(uname -m | sed "s/x86_64/x64/")
base="https://github.com/QuazarMedia/simt-dev/releases/download/v$version"
asset="simt-dev-$version-$os-$arch"; tmp=$(mktemp -d)
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"
(cd "$tmp" && shasum -a 256 -c "$asset.sha256")
mkdir -p .simt/bin && mv "$tmp/$asset" .simt/bin/simt && chmod +x .simt/bin/simt
```

The locator checks `.simt/bin/simt` before `PATH`, so the repository's own copy is the one
its hooks and its CI run — this is the same command the hook shim prints as its remedy.
Both the snippet above and the generated CI workflow verify the asset against the
published `.sha256` before it runs: a digest that does not match stops the copy, so a
truncated or substituted download never becomes the command.

## The first run

```sh
simt init --yes                 # adopt: manifest, region, hooks, agent files
simt hooks install --yes        # the git-time gate
simt agent-hooks install --yes  # the before-a-tool-call gate
simt index                      # the local code graph, from git blobs
simt check                      # what is stale, missing, or a finding
```

`simt init` writes only what the repository can run: an ecosystem with no profile yet gets
the core rules and no gates, and a hook that would run nothing is not installed. Add
`--baselines` if you want the `.editorconfig` and `.gitattributes` regions; a repository
that already carries one keeps it maintained without the flag.

Every command, with its flags and whether it writes, is in
[commands/index.md](commands/index.md).
