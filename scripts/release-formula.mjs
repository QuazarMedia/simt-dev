#!/usr/bin/env node
// The release step that rewrites the formula for a tagged version.
//
// Usage:
//   node scripts/release-formula.mjs --version=0.5.0 \
//     --sha256-darwin-arm64=<hex> --sha256-darwin-x64=<hex> --sha256-linux-x64=<hex>
//
// The formula downloads the release binary for the platform it runs on, so a
// release has three url/sha256 pairs to patch - one per target. The sha256s
// must be computed from the published release assets, not from a local build:
// this script is the one place where "what the tap will install" is decided,
// and it must decide from what GitHub actually serves.
//
// The patch is content-anchored, the same way the npm channel's was: it finds
// each url line by its target suffix and the sha256 line that follows it, so
// a formula whose layout has drifted fails loudly instead of being patched
// blind.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TARGETS, releaseUrl } from '../src/distribute/release.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMULA = join(ROOT, 'Formula', 'simt-dev.rb');

function die(msg) {
  console.error(`release-formula: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { version: null, sha256s: {} };
  for (const arg of argv) {
    if (arg.startsWith('--version=')) args.version = arg.slice('--version='.length);
    else if (arg.startsWith('--sha256-')) {
      const eq = arg.indexOf('=', '--sha256-'.length);
      if (eq === -1) die(`--${arg.slice(2, eq === -1 ? arg.length : eq)} needs a value`);
      const target = arg.slice('--sha256-'.length, eq);
      const value = arg.slice(eq + 1);
      if (!TARGETS.includes(target)) die(`unknown target "${target}" (expected one of ${TARGETS.join(', ')})`);
      if (!/^[0-9a-f]{64}$/.test(value)) die(`--sha256-${target} is not a 64-hex sha256`);
      args.sha256s[target] = value;
    } else die(`unknown argument "${arg}"`);
  }
  if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) die('--version=<semver> is required');
  for (const target of TARGETS) {
    if (!args.sha256s[target]) die(`--sha256-${target}=<hex> is required`);
  }
  return args;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the url line that ends in -<target>" and the sha256 line that
// follows it. Both anchors must match or the formula's layout has drifted.
function patchPair(text, target, url, sha256) {
  const urlRe = new RegExp(`^    url "https://github\\.com/QuazarMedia/simt-dev/releases/download/v[0-9][^"]*-${target}"$`, 'm');
  if (!urlRe.test(text)) die(`the formula has no url line for ${target}`);
  text = text.replace(urlRe, `    url "${url}"`);
  const shaRe = new RegExp(`^(    url "${escapeRegExp(url)}"\n    )sha256 "[0-9a-f]{64}"$`, 'm');
  if (!shaRe.test(text)) die(`the formula has no sha256 line after the ${target} url`);
  return text.replace(shaRe, `$1sha256 "${sha256}"`);
}

const { version, sha256s } = parseArgs(process.argv.slice(2));
let text = readFileSync(FORMULA, 'utf8');
for (const target of TARGETS) {
  text = patchPair(text, target, releaseUrl(version, target), sha256s[target]);
}
if (text === readFileSync(FORMULA, 'utf8')) {
  console.log(`release-formula: Formula/simt-dev.rb already at v${version}`);
} else {
  writeFileSync(FORMULA, text);
  console.log(`release-formula: Formula/simt-dev.rb updated to v${version}`);
}
