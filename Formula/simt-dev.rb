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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.9.0/simt-dev-0.9.0-darwin-arm64"
    sha256 "c07ede692f6833a68ff8f575623d4d752ce39a6b2f02da98b9dd3f032fe96724"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.9.0/simt-dev-0.9.0-darwin-x64"
    sha256 "7710a851b5d745cf3f66c55ad08743a0aba8289fd2ffc0203ee1a01686c00dc4"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.9.0/simt-dev-0.9.0-linux-x64"
    sha256 "897081881ef1dd2f1384fdee5f1b0c71c307a3a358307d80dc86bd8a16f76e57"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
