#!/usr/bin/env node
// The IO half of one-release resolution (ADR-203).
//
//   node scripts/release-descriptor.mjs --out=release/descriptor.json
//   node scripts/release-descriptor.mjs --recheck=release/descriptor.json --tap=<formula url>
//   node scripts/release-descriptor.mjs --simulate=<dir> --out=/tmp/descriptor.json
//
// The workflow runs the first form once, uploads the JSON and hands the same file to
// every channel job, which runs the second form before promoting. That is the whole
// fix: one resolution per run, and promotion reads the resolved values rather than
// resolving them again.
//
// `--simulate` is the release rehearsal: it answers every probe from a directory
// instead of from npm, git, GitHub and the tap, so staged, latest, explicit, moving,
// mismatched and partially published releases are all things a test can produce. The
// layout is `<dir>/npm-version.txt`, `<dir>/npm.json` (`{"versions": [...]}`),
// `<dir>/tags.json` (`{"0.7.0": "<40 hex>"}`), `<dir>/tap.rb`, `<dir>/assets/<asset>`.
//
// Exit is 1 with `::error::` lines when this run cannot name one immutable release.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { assetName, releaseUrl } from '../src/distribute/release.mjs';
import { evidenceLines, resolveRelease, verifyRelease } from '../src/distribute/descriptor.mjs';

const exec = promisify(execFile);
const PACKAGE = 'simt-dev';

function die(lines) {
  for (const line of [].concat(lines)) console.error(`::error::${line}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { request: process.env.INPUT_VERSION ?? '', out: null, recheck: null, simulate: null, tap: null, print: false, commit: null };
  for (const arg of argv) {
    const value = (name) => arg.slice(`--${name}=`.length);
    if (arg === '--print') args.print = true;
    else if (arg.startsWith('--request=')) args.request = value('request');
    else if (arg.startsWith('--out=')) args.out = value('out');
    else if (arg.startsWith('--recheck=')) args.recheck = value('recheck');
    else if (arg.startsWith('--simulate=')) args.simulate = value('simulate');
    else if (arg.startsWith('--tap=')) args.tap = value('tap');
    else if (arg.startsWith('--commit=')) args.commit = value('commit');
    else die(`unknown argument "${arg}"`);
  }
  return args;
}

/** The live estate, read the way each channel reads it. */
function liveProbe({ tap }) {
  const run = async (file, argv, encoding = 'utf8') =>
    (await exec(file, argv, { maxBuffer: 256 << 20, encoding })).stdout;

  return {
    latestVersion: () => run('npm', ['view', PACKAGE, 'version']),
    npmHas: async (version) => {
      try {
        await run('npm', ['view', `${PACKAGE}@${version}`, 'version']);
        return true;
      } catch {
        return false;
      }
    },
    tagCommit: async (version) => {
      // `^{}` peels an annotated tag to the commit it names; a lightweight tag answers
      // on the plain ref. Both spellings are asked so the two tag kinds agree.
      const out = await run('git', ['ls-remote', 'origin', `refs/tags/v${version}^{}`, `refs/tags/v${version}`]);
      const peeled = /^([0-9a-f]{40})\trefs\/tags\/v[^\n]*\^\{\}$/m.exec(out);
      if (peeled) return peeled[1];
      const plain = /^([0-9a-f]{40})\trefs\/tags\/v([^\n^]*)$/m.exec(out);
      return plain ? plain[1] : null;
    },
    asset: (version, target) => run('curl', ['-fsSL', releaseUrl(version, target)], 'buffer'),
    tapFormula: async () => {
      if (!tap) return null;
      return run('curl', ['-fsSL', tap]);
    },
  };
}

/** The rehearsal: every answer comes from a directory. */
function simulatedProbe(dir) {
  const read = async (path) => readFile(join(dir, path), 'utf8');
  const json = async (path, fallback) => {
    try {
      return JSON.parse(await read(path));
    } catch {
      return fallback;
    }
  };
  return {
    latestVersion: () => read('npm-version.txt'),
    npmHas: async (version) => (await json('npm.json', { versions: [] })).versions.includes(version),
    tagCommit: async (version) => (await json('tags.json', {}))[version] ?? null,
    asset: (version, target) => readFile(join(dir, 'assets', assetName(version, target))),
    tapFormula: async () => {
      try {
        return await read('tap.rb');
      } catch {
        return null;
      }
    },
  };
}

async function publishResolution(descriptor, out) {
  if (out) {
    if (!existsSync(dirname(out))) await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(descriptor, null, 2)}\n`);
  }
  if (!process.env.GITHUB_OUTPUT) return;
  // One line on purpose: a job output is read back with `needs`, and the JSON is a
  // few kilobytes of characters with no newline in it (indented files are for humans
  // and for `--recheck`, the output is for the next job).
  const json = JSON.stringify(descriptor);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `version=${descriptor.version}`,
      `commit=${descriptor.commit}`,
      `id=${descriptor.id}`,
      `descriptor=${json}`,
    ].join('\n') + '\n',
  );
}

const args = parseArgs(process.argv.slice(2));
const probe = args.simulate ? simulatedProbe(args.simulate) : liveProbe({ tap: args.tap });

if (args.recheck) {
  let stored;
  try {
    stored = JSON.parse(await readFile(args.recheck, 'utf8'));
  } catch (error) {
    die(`could not read the release descriptor at ${args.recheck}: ${error.message}`);
  }
  const checked = await verifyRelease(stored, probe);
  if (!checked.ok) {
    die([
      ...checked.errors,
      'this release was resolved once and the world has moved; re-run the workflow from the start',
    ]);
  }
  if (args.print) for (const line of evidenceLines(stored)) console.log(line);
  console.log(`recheck     ${PACKAGE} ${stored.version} still resolves to ${stored.id}`);
  process.exit(0);
}

const { descriptor, errors } = await resolveRelease(args.request, probe);
if (errors.length > 0) die(errors);
// A caller that already knows the commit (publish.yml, before any tag read) still has
// to agree with the tag: the descriptor is the tag's answer, not the caller's.
if (args.commit && descriptor.commit !== args.commit) {
  die(`tag ${descriptor.tag} names ${descriptor.commit}, but this run is for ${args.commit}`);
}

await publishResolution(descriptor, args.out);
if (args.print) for (const line of evidenceLines(descriptor)) console.log(line);
console.log(`resolved    ${PACKAGE} ${descriptor.version} (${descriptor.id})`);
