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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.13.0/simt-dev-0.13.0-darwin-arm64"
    sha256 "2cca166a657fd845de392d982efb0fd826425bf2bb4466af32b978b955fe1993"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.13.0/simt-dev-0.13.0-darwin-x64"
    sha256 "c180610cfc0dd363b8c198c812377a4250dba271c6bcf53f94bcbc49c5f1002c"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.13.0/simt-dev-0.13.0-linux-x64"
    sha256 "24e5203a097ae9ef569b9b9f0d6f5f98b51dedd792e8b02fce8e4c75badb6054"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
