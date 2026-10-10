// What this file guards: a name that is written down in a hundred places instead of
// one. `CLI` exists so that renaming the command is a one-line edit, and that promise
// is worth nothing unless something fails when it is not kept - so this walks the
// source tree and fails on any command string that spells the name instead of
// interpolating it.
//
// The verb list is the same one the rewrite used. A looser pattern was tried and it
// flagged prose: `simt-dev will not remove a file it wrote` is the project talking
// about itself, not a command anyone can run, and the project keeps its name on
// purpose. Anything that reads as a command is spelled `CLI` instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BIN_ENV, BIN_REL, CLI, CONFIG_DIR, MANIFEST_FILE, MANIFEST_LEGACY, MARKER_PREFIX, MARKER_PREFIX_LEGACY, PACKAGE_NAME, PROJECT, WORKFLOW_FILE_NAME } from '../src/name.mjs';
import { manifestPath, writeManifest } from '../src/projection/manifest.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** A scratch directory holding the named files, removed when the test ends. */
async function scratch(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-naming-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
  process.once('exit', () => rm(root, { recursive: true, force: true }));
  return root;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const VERBS = [
  'init', 'doctor', 'check', 'sync', 'upgrade', 'ci', 'compare',
  'hooks', 'mcp', 'rules', 'skills', 'graph',
];
const SPELLED = new RegExp(`\\b${PROJECT} (?=(?:${VERBS.join('|')}|--)[\\s'"\`)}\\]]|$)`);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('no command string spells the command; every one interpolates CLI', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    // name.mjs is the definition, and naming the thing you are defining is the job.
    if (file.endsWith('name.mjs')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (SPELLED.test(line)) offenders.push(`${file.replace(`${SRC}/`, '')}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `these spell a command instead of interpolating CLI:\n${offenders.join('\n')}`);
});

test('package.json and name.mjs cannot disagree about the command', () => {
  // The single defect this arrangement invites: the bin map says one command and the
  // constant says another, and every remedy string then names a program that is not
  // installed. Cheap to assert, and it is the whole reason both live in one place.
  assert.deepEqual(Object.keys(pkg.bin), [CLI], `package.json bin must expose exactly the command: ${CLI}`);
  assert.equal(pkg.name, PACKAGE_NAME, 'the package name is defined once, in name.mjs');
});

test('the names already on an adopting repository do not move', () => {
  // These are on disk in repositories this tool does not own. They are pinned here as
  // literals precisely so that renaming one is a deliberate edit to this test rather
  // than a constant change that looks harmless.
  //
  // `MANIFEST_FILE` and `MARKER_PREFIX` are the exceptions, tracked separately below:
  // they moved, and they moved with a fallback. The other five did not, because nothing
  // on their reader's disk had a second spelling to fall back to.
  assert.equal(MANIFEST_LEGACY, 'simt-dev.json');
  assert.equal(MARKER_PREFIX_LEGACY, 'simt-dev');
  assert.equal(WORKFLOW_FILE_NAME, 'simt-dev-check.yml');
  assert.equal(CONFIG_DIR, 'simt-dev');
  assert.equal(BIN_ENV, 'SIMT_DEV_BIN');
  assert.equal(PROJECT, 'simt-dev');
  assert.equal(BIN_REL, 'bin/simt-dev.mjs');
});

test('a renamed manifest is read as both spellings, and the new one is written', async () => {
  // The manifest was the one identity that did move, `simt-dev.json` to `simt.json`, and
  // it moved only because the fallback below makes the move safe. Fourteen repositories
  // have the old name on disk: without the fallback, "no manifest" would have read as
  // "never adopted", which is the answer that offers to re-adopt a finished repo.
  //
  // The fallback is asserted rather than assumed, because the failure it prevents is
  // silent — the tool would simply stop seeing a repo it has been managing.
  const root = await scratch({
    'simt.json': `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    'ignored.txt': 'x\n',
  });
  assert.match(await manifestPath(root), /simt\.json$/, 'the new name wins when both exist');

  const legacy = await scratch({
    'simt-dev.json': `${JSON.stringify({ gates: { preCommit: [] } }, null, 2)}\n`,
  });
  assert.match(await manifestPath(legacy), /simt-dev\.json$/, 'the old name is still read, so an adopted repo is not reported as unadopted');

  const aged = await scratch({ 'package.json': '{"name":"a"}\n', 'simt-dev.json': `${JSON.stringify({ version: 1 }, null, 2)}\n` });
  const written = await writeManifest(aged, { version: 1, touched: true });
  assert.match(written, /simt\.json$/, 'the write goes to the new name');
  assert.equal(existsSync(join(aged, 'simt-dev.json')), false, 'the old file is moved, not left beside the new one as a shadow nobody reads');
});

test('the manifest is no longer the project name, and that is asserted', () => {
  // The other two groups can agree; this one cannot. A manifest name derived from the
  // project is what made the rename a migration, and this is the test that would notice
  // if someone re-derived it.
  assert.notEqual(MANIFEST_FILE, `${PROJECT}.json`);
  assert.equal(MANIFEST_FILE, `${CLI}.json`);
});

test('the region namespace is the command, and that is asserted', () => {
  // The marker is the second on-disk name to follow the command (ADR-056). Same argument
  // as the manifest: a region is the command's footprint in files the repo owns, and a
  // prefix re-derived from the project would turn the next rename into a silent
  // migration of every adopted repository. The read-both fallback that makes the move
  // safe is asserted in test/markers.test.mjs, where the mechanism lives.
  assert.notEqual(MARKER_PREFIX, PROJECT);
  assert.equal(MARKER_PREFIX, CLI);
});

test('the command is not the project name, and the package is not the command', () => {
  // Worth stating because it is the thing that makes this arrangement work. The command
  // moved; the project did not. A test that only passed while the two agreed would not
  // have noticed the rename.
  assert.notEqual(CLI, PROJECT, 'the reader-facing command and the project may differ, and today they do');
  assert.equal(PACKAGE_NAME, PROJECT, 'the package keeps the project name, so a rename does not orphan a reserved name');
});