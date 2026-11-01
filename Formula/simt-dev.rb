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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.8.0/simt-dev-0.8.0-darwin-arm64"
    sha256 "ce72ce0af38f76671ca92f8ef8b065c8cb27a21015e871c1d33ab4a5e745188f"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.8.0/simt-dev-0.8.0-darwin-x64"
    sha256 "4242d8e68b0c6112c5970ed0f23266010ee6869146b949bff8fa5f600a053d41"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.8.0/simt-dev-0.8.0-linux-x64"
    sha256 "e8828091807e7bb6245303cb6ba0d9264bcf913d1cd6d98d08f305792cdaf04f"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
