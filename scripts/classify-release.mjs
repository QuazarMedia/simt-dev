#!/usr/bin/env node
// The release kind, for the publish workflow's fast lane.
//
// Usage:
//   node scripts/classify-release.mjs
//
// Prints `content-only` or `full` on stdout and exits 0 either way; every
// failure is a die with a remedy, exit 2.
//
// The kind answers one question: does this release change what the binary
// DOES, or only what it SERVES? Content-only releases skip the three native
// binary builds and the formula sync - their bytes are the npm tarball - and
// state, in the release notes, that binary-channel consumers keep the previous
// content until the next full release. The classification is closed-set and
// deterministic: src/distribute/release.mjs owns the path set and the rule,
// this script only supplies the git facts.
//
// Three forces, in order of authority:
//   1. SIMT_RELEASE_KIND=full in the environment forces a full release -
//      the maintainer's escape hatch when the set is wrong, not the reverse.
//   2. No previous tag (the first release) is full: there is no range to
//      classify, and a binary channel that has never shipped needs its first
//      build.
//   3. The diff `git diff --name-only <prev>..HEAD`, classified by the pure
//      function in src/distribute/release.mjs, which the test imports.

import { execFileSync } from 'node:child_process';
import { classifyReleaseKind } from '../src/distribute/release.mjs';

function die(message) {
  process.stderr.write(`classify-release: ${message}\n`);
  process.exit(2);
}

// The environment override is read before anything else: it is the maintainer's
// way to say "build everything" without touching the classifier. Any value other
// than `full` is a typo, and a typo that silently skips the build is the failure
// this lane exists to prevent.
const override = process.env.SIMT_RELEASE_KIND;
if (override !== undefined) {
  if (override !== 'full') die(`SIMT_RELEASE_KIND is ${JSON.stringify(override)}; only "full" is a valid value`);
  process.stdout.write('full\n');
  process.exit(0);
}

// The previous tag, the range's start. `git describe` exits non-zero when no
// tag is reachable - the first release - and that is a kind, not an error:
// full, because the binary channel has nothing to serve yet.
let prev;
try {
  prev = execFileSync('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], { encoding: 'utf8' }).trim();
} catch (err) {
  // `git describe` exits 1 when no tag is reachable - the first release. That is
  // a kind, not an error: full, because the binary channel has nothing to serve.
  if (err.status === 1) {
    process.stdout.write('full\n');
    process.exit(0);
  }
  die(`git describe failed: ${err.message}`);
}

let changed;
try {
  changed = execFileSync('git', ['diff', '--name-only', `${prev}..HEAD`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  die(`git diff ${prev}..HEAD failed; check the tag with \`git describe --tags --abbrev=0 HEAD\``);
}

process.stdout.write(`${classifyReleaseKind(changed)}\n`);
