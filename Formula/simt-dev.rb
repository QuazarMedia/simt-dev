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
  desc "Intelligence amplifier for AI coding agents, adopted by one command"
  homepage "https://github.com/QuazarMedia/simt-dev"
  license "Apache-2.0"

  if OS.mac? && Hardware::CPU.arm?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.2/simt-dev-0.6.2-darwin-arm64"
    sha256 "d0e46f599b277ed9a01295fccab25f6c24c2adce4d54103d96117a3997ddd608"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.2/simt-dev-0.6.2-darwin-x64"
    sha256 "543cd16d9027beece74feab1c9043146f4715323488bc8bf6cb513e49836bc78"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.2/simt-dev-0.6.2-linux-x64"
    sha256 "a8ebb761e2c2cc1aa3ffe1789aa0467f2e31569e7dc79045f4cb739029d7f0f2"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
