# The Homebrew formula: `brew install QuazarMedia/homebrew-tap/simt-dev`.
#
# The tap is a mirror of this file, and the two are rewritten by the publish
# workflow when a tag is pushed - the committed values are always those of the
# last release, never a placeholder.
#
# The formula installs the single-file binary: the same payload the npm package
# ships, wrapped in a pinned Node runtime (a Node Single-Executable Application).
# The binary materializes that payload to $XDG_CACHE_HOME/simt-dev (or
# ~/.cache/simt-dev) on first run, so no Node toolchain is required - this is
# the channel for repositories that do not use npm.

class SimtDev < Formula
  desc "Intelligence amplifier for AI coding agents, adopted by one command"
  homepage "https://github.com/QuazarMedia/simt-dev"
  license "Apache-2.0"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.3/simt-dev-0.6.3-darwin-arm64"
    sha256 "04497897f59c37e248d52d3710913633959e7fc840b5f6e63bbf2798be867352"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.3/simt-dev-0.6.3-darwin-x64"
    sha256 "94c2bd5ae726404324827af2265177324cc75625d3bc26634e66e2b69999a070"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.3/simt-dev-0.6.3-linux-x64"
    sha256 "fedbf10c3bf9e2618dbd6fdc7b0f7a1a89adbdfb6598653ab141fc1e2f02c1bc"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
