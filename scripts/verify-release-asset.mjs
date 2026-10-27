#!/usr/bin/env node
// The upload-integrity half of a release: the served bytes are the built bytes.
//
// Usage:
//   node scripts/verify-release-asset.mjs --version=0.6.1 --target=linux-x64
//
// Downloads the release asset GitHub serves for this version and target and
// compares its sha256 against the `.sha256` the build wrote beside it. A torn
// or clobbered upload graduates into a release nobody can detect any other way:
// the tap would install bytes whose checksum refuses them, and the failure
// would arrive on somebody else's machine.
//
// Node does the hashing so the step reads identically on macOS and ubuntu
// runners (`sha256sum` is linux-only, `shasum` is not guaranteed on either).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { TARGETS, assetName, releaseUrl } from '../src/distribute/release.mjs';

const exec = promisify(execFile);

function die(msg) {
  console.error(`verify-release-asset: ${msg}`);
  process.exit(1);
}

const args = { version: null, target: null };
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--version=')) args.version = arg.slice('--version='.length);
  else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
  else die(`unknown argument "${arg}"`);
}
if (!args.version || !/^\d+\.\d+\.\d+$/.test(args.version)) die('--version=<semver> is required');
if (!TARGETS.includes(args.target)) die(`--target must be one of ${TARGETS.join(', ')}`);

const url = releaseUrl(args.version, args.target);
let served;
try {
  ({ stdout: served } = await exec('curl', ['-fsSL', url], { encoding: 'buffer', maxBuffer: 256 << 20 }));
} catch {
  die(`${url} is not downloadable; the build jobs did not finish their uploads`);
}
const servedHash = createHash('sha256').update(served).digest('hex');

let built;
try {
  built = (await readFile(`dist/${assetName(args.version, args.target)}.sha256`, 'utf8')).split(/\s+/)[0];
} catch {
  die(`dist/${assetName(args.version, args.target)}.sha256 is missing; build this target first`);
}

if (servedHash !== built) {
  die(`served ${assetName(args.version, args.target)} hashes to ${servedHash}, but the build wrote ${built}`);
}
console.log(`served ${assetName(args.version, args.target)} matches the build (${built})`);
