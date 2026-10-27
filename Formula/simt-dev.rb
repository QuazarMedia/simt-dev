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
    sha256 "8bc6c64d079d7b7b3d4a50202abf8a2f817db6f008c24a504827856bdfcef51f"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.2/simt-dev-0.6.2-darwin-x64"
    sha256 "22981e6f83b5c4004fc00414e441bb6f42e338bd94fd024b5cf2c58fbc124e53"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.2/simt-dev-0.6.2-linux-x64"
    sha256 "e1b2a7c0c9a474c48ffc47df79f2a4b49d54c86833295bfb802eb75eae36f9c7"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
