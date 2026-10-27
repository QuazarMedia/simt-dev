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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.0/simt-dev-0.6.0-darwin-arm64"
    sha256 "e035c84e4a37b6bc5167f4ec5bb644383aefaf9cb23022391660615d69af20a8"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.0/simt-dev-0.6.0-darwin-x64"
    sha256 "4d0715afcd84f38cb8b79ffd9e57cb35cc099bc186761257fb58f3ac0e3d368e"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.0/simt-dev-0.6.0-linux-x64"
    sha256 "b55bffc27b42c6413ea00ac6ec042ea9924cb09c8560813d79ab6c2fe84b59a9"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
