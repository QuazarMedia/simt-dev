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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.10.0/simt-dev-0.10.0-darwin-arm64"
    sha256 "271a5c93d48b534a9e17e0d25d4432ff0517e5bf0852d8fc79208cc5d56bf5e0"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.10.0/simt-dev-0.10.0-darwin-x64"
    sha256 "163485e6f3ff3c434defdd2071a464303ad571d27c000f0d366a7fac160835a4"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.10.0/simt-dev-0.10.0-linux-x64"
    sha256 "70621ac8ef2b8587b6c34c7f79e1414c6fc63e0144e40504564878bcee5e3242"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
