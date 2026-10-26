# The Homebrew formula: `brew install QuazarMedia/tap/simt-dev`.
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
  desc "An intelligence amplifier for AI coding agents, adopted by one command"
  homepage "https://github.com/QuazarMedia/simt-dev"
  license "Apache-2.0"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.5.0/simt-dev-0.5.0-darwin-arm64"
    sha256 "0f0987345d8864fc2006f047bd47451f5af5bf21cbe98dddf81992ae0f79669b"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.5.0/simt-dev-0.5.0-darwin-x64"
    sha256 "fc99e4232000e6593dd31838738c069b0b2f34124bf0e121159d2966fc67bea7"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.5.0/simt-dev-0.5.0-linux-x64"
    sha256 "75a712fe543d8b85da19f0f4434416a5bc94d673cf982763aee9ef7377e39571"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
