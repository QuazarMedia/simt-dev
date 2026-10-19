# The Homebrew formula: `brew install QuazarMedia/tap/simt-dev`.
#
# Two things about this file are deliberate and the alternatives are both worse.
#
# **It installs the npm tarball, not the source.** simt-dev has no build step
# and no dependencies: the entire tool is ~1.3 MB of `.mjs` files and a
# `package.json`, which is already exactly what the npm tarball contains. So
# there is nothing to compile, and downloading the tarball is the whole install.
# The alternative - cloning the repository and running `npm install` - would
# make `brew install` depend on a build that a lockfile-less zero-dependency
# package does not need, and would put the machine's homebrew node on PATH
# during the build to accomplish what one `cp -r` could.
#
# **It does NOT use `std_npm_args`.** That helper is for packages that need
# `npm install` to run at build time: it invokes npm, and npm needs the registry
# at build time and a lockfile to be reproducible. Neither applies here, so it
# would add a build-time dependency on a network fetch, on npm, and on a
# package manager for a package that has no dependencies.
#
# The version and the `sha256` below are for the release this formula
# corresponds to. Both are rewritten by the publish workflow when a tag is
# pushed, so the committed value is always the last release and never a
# placeholder.

class SimtDev < Formula
  desc "Shared agent rules, skills and git hooks, adopted by one command"
  homepage "https://github.com/QuazarMedia/simt-dev"
  url "https://registry.npmjs.org/simt-dev/-/simt-dev-0.4.0.tgz"
  sha256 "8ba319a172682db5e1f66d032d781e90ffe8ecde2664eb9e4baec462ec7f0d17"
  license "Apache-2.0"

  # The runtime is Node, and it is declared rather than found. Without this the
  # formula installs a program that cannot run, and the failure surfaces as
  # `node: command not found` from a depth that has nothing to do with this
  # formula or with anything the reader can fix here.
  depends_on "node"

  # npm's tarball layout is a single `package/` directory, and Homebrew stages
  # a single-directory archive by moving that directory aside and running the
  # install inside it. So the working directory here is ALREADY the tool's own
  # root - `bin/`, `src/`, `graph/`, `rules/`, `docs/decisions/` - which is
  # exactly the layout the entry point resolves against. `Dir["*"]` therefore
  # installs the tool, not a directory containing the tool.
  #
  # The glob is `*` and not `.`: `Dir["*"]` does not match dotfiles, which
  # incidentally excludes the `.brew_home` scaffolding Homebrew creates in here.
  def install
    libexec.install Dir["*"]

    # The entry point's shebang is `#!/usr/bin/env node`, which would work
    # because of the dependency above - but only while `node` is on PATH, and
    # PATH is not something a formula owns. Rewriting it to the node this
    # formula depends on means the command works from a cron job, from a GUI
    # launcher, and from a shell that has moved node out of the way, all of
    # which are real and all of which look like a broken install.
    # `formula_opt_bin` returns the directory, so the binary is a step further
    # in. Written as the directory plus `/node` rather than as one call, because
    # a helper that returns half a path invites the reader to assume it returned
    # the whole thing - which is exactly the bug this comment is beside: with the
    # `/node` missing the shebang named a directory, and the symptom was
    # `permission denied` on the command rather than anything about a path.
    node = formula_opt_bin("node")/"node"
    inreplace "#{libexec}/bin/simt-dev.mjs",
            "#!/usr/bin/env node",
            "#!#{node}"

    # `simt`, and only `simt`. The command is the name on both channels; a
    # second script under the package name would be a fork in the docs waiting
    # to happen.
    bin.install_symlink libexec/"bin/simt-dev.mjs" => "simt"
  end

  test do
    # The version is read from the manifest that shipped, not from a string
    # baked in here. It fails if the tarball's root was unpacked in the wrong
    # place, which is the one mistake this formula's install step could make.
    assert_match version.to_s, shell_output("#{bin}/simt --version")

    # A command that actually reads a data file out of the installation.
    # `--version` can succeed off a broken tree that happens to contain one
    # entry point; this cannot succeed without `docs/decisions/` in libexec,
    # and `docs/decisions/` is what `rules why` reads.
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
