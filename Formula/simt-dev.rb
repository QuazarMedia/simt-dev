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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.11.0/simt-dev-0.11.0-darwin-arm64"
    sha256 "4115516e2b28199c22476536dc1739676330d4004afbe9ccc76eb0670b89cc55"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.11.0/simt-dev-0.11.0-darwin-x64"
    sha256 "a5b9d8bbfe44994f1e340aea58c69abd60d6875e2e4e50eb3a27aa1b346bec4b"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.11.0/simt-dev-0.11.0-linux-x64"
    sha256 "006448a6ad772143f4281094c09416d4b7f468026c2a9ad1ab01c555984fe7e0"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
