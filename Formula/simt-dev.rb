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
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.1/simt-dev-0.6.1-darwin-arm64"
    sha256 "9e1f67a1fd11431700b8d2bfdc5e084ea9b367bbf2d6567a0de23a37b5cda14f"
  elsif OS.mac?
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.1/simt-dev-0.6.1-darwin-x64"
    sha256 "a69f4484c0c4ac6766956c2aacf684a5760dd00c629584db5d8810c4b24d3a19"
  else
    url "https://github.com/QuazarMedia/simt-dev/releases/download/v0.6.1/simt-dev-0.6.1-linux-x64"
    sha256 "37e02238b053ebcb75183e901dca35bde9a6acf05bb67bb460999c7a6701f108"
  end

  def install
    bin.install Dir["simt-dev-#{version}-*"].first => "simt"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simt --version")
    assert_match "ADR-018", shell_output("#{bin}/simt rules why ADR-018")
  end
end
