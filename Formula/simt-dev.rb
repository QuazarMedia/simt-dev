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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.7.1/simt-dev-0.7.1-darwin-arm64"
    sha256 "4fc5ee991b58a7f68bf41933e11c4598510c31605efe98a61a3ef3d25becf027"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.7.1/simt-dev-0.7.1-darwin-x64"
    sha256 "a1c9e31a301c3e8a384a17897c3191dc2ac929f04c106fd1d3cfd03372799c0b"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.7.1/simt-dev-0.7.1-linux-x64"
    sha256 "c5a28002d48a0dc420dc6e0a174cf163565f346667d49b6fafd886afea7f7d5c"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
