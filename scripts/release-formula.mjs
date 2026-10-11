// Render the Homebrew formula for a release.
//
// The formula in `Formula/simt-dev.rb` is the source of truth: it is a readable
// file, it is reviewed like any other, and it is committed with the values of
// the last release. This script changes exactly two things in it - the version
// in the `url` and the `sha256` beside it - and nothing else.
//
// It does not regenerate the formula from a template. A template would mean the
// bytes a reader sees in this repository are not the bytes a tap serves, which
// is the defect ADR-023 rules out for the gate file: a second copy that can
// drift from the first while both look authoritative. Patching two lines keeps
// one copy.
//
// The checksum is the one number that cannot be known in advance, so it is
// passed in. Everything else about the formula is decided here, in reviewable
// prose, and not left to a release-time string builder.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FORMULA_FILE = join(HERE, '..', 'Formula', 'simt-dev.rb');

/** The npm tarball URL for a version. Homebrew downloads this at install time. */
export function tarballUrl(version) {
  return `https://registry.npmjs.org/simt-dev/-/simt-dev-${version}.tgz`;
}

function die(message) {
  process.stderr.write(`release-formula: ${message}\n`);
  process.stderr.write('  usage: node scripts/release-formula.mjs --version=0.1.2 --sha256=<64 hex chars>\n');
  process.exit(2);
}

/**
 * Read the `--version` / `--sha256` pair.
 *
 * Both are validated rather than trusted: a formula whose checksum belongs to
 * the previous release installs a stale tool while reporting the new version,
 * which is precisely the failure a checksum exists to make impossible - and it
 * would fail at `brew install` on somebody else's machine, days later.
 */
function parse(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) die(`unexpected argument ${JSON.stringify(raw)}`);
    const at = raw.indexOf('=');
    if (at < 0) die(`${raw} needs a value, as --version=0.1.2`);
    args[raw.slice(2, at)] = raw.slice(at + 1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.version ?? '')) {
    die(`--version must be x.y.z, got ${JSON.stringify(args.version)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(args.sha256 ?? '')) {
    die(`--sha256 must be a 64-character hex sha256, got ${JSON.stringify(args.sha256)}`);
  }
  return { version: args.version, sha256: args.sha256 };
}

/**
 * Replace the version and the checksum in the formula.
 *
 * Two lines, matched by their content rather than by line number. Line numbers
 * would make this script something that cannot be edited: inserting a comment
 * above the `sha256` line would silently write the checksum to the wrong place.
 *
 * @param {string} text the committed formula
 * @param {{version: string, sha256: string}} release
 * @returns {string}
 */
export function patch(text, { version, sha256 }) {
  const url = /^  url "https:\/\/registry\.npmjs\.org\/simt-dev\/-\/simt-dev-[\d.]+\.tgz"$/m;
  if (!url.test(text)) {
    die('`url` line not found - the formula has been edited in a way this script does not recognise');
  }
  const sum = /^  sha256 "[0-9a-f]{64}"$/m;
  if (!sum.test(text)) {
    die('`sha256` line not found - the formula has been edited in a way this script does not recognise');
  }
  return text.replace(url, `  url "${tarballUrl(version)}"`).replace(sum, `  sha256 "${sha256}"`);
}

/** Run as a script. */
function main() {
  const release = parse(process.argv.slice(2));
  const before = readFileSync(FORMULA_FILE, 'utf8');
  const after = patch(before, release);
  if (before === after) {
    process.stdout.write(`Formula/simt-dev.rb already describes ${release.version}; nothing to write\n`);
  } else {
    writeFileSync(FORMULA_FILE, after);
    for (const [i, line] of after.split('\n').entries()) {
      if (before.split('\n')[i] !== line) process.stdout.write(`  ${line}\n`);
    }
  }
  process.stdout.write(`  url: ${tarballUrl(release.version)}\n`);
}

// Guarded, because `import.meta.main` does not exist on the Node floor this
// package declares (>=22.20.0) and a second file that re-exports this one just
// for tests is a copy. Comparing the module's own URL against the process's
// entry point is the portable form of the same question, and without it a test
// that imports `patch` would run the script with `node --test`'s argv, fail
// validation, and exit 2 from inside the test runner.
const ENTRY_POINT = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (ENTRY_POINT) main();
