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
  'hooks', 'mcp', 'rules', 'skills', 'graph', 'tokens', 'harness', 'bench', 'plan', 'shared', 'evidence', 'index',
  'map', 'tests', 'why', 'gate', 'impact',
];

// What follows the project name when the project name is standing in for a PROGRAM
// someone would type, rather than for the project talking about itself.
//
// The verb list was the original rule, and it was too narrow in a way that let four
// shipped strings through - all four live: `simt-dev --help` on every bad invocation,
// `simt-dev <command>` in the usage line, `Yours from here: simt-dev` at the end of a
// line, and `simt-dev on PATH` in the shim every adopting repository reads. Not one of
// them is followed by a verb, and that is exactly why the verb list never saw them: it
// asked one shape of the question and treated every other shape as prose.
//
// `on PATH` is here because a resolution list is the one place these artifacts put a
// program name inside prose. It is narrow on purpose - the alternative is flagging
// "Written by simt-dev when this repo was adopted" and every other sentence where the
// project is the subject, which is prose this file already learned not to flag.
// Narrow and explainable beats broad and noisy, and a guard nobody tolerates is a
// guard that gets deleted.
//
// What is deliberately NOT here is "ends the sentence". `Canonical X rule managed by
// simt-dev` and `this repository, not simt-dev` are grammatical, and so is `Yours from
// here: simt-dev` - which means a suffix rule cannot separate the two, and a rule that
// flags the prose flags a legitimate spelling. The one shipped string in that shape is
// caught by a different assertion below, and for the reason it actually went wrong:
// it disagreed with the other template, not because it spelled the project.
const AFTER_PROGRAM = `(?=(?:${VERBS.join('|')})\\b|--\\S|<|on PATH\\b)`;

/** The project name occupying the position of a command, in source or in a shipped artifact. */
const SPELLED = new RegExp(`\\b${PROJECT}(?:\\s${AFTER_PROGRAM}|\\s*$)`);

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
test('the guard above catches the shapes that shipped, and only those shapes', () => {
  // A guard is a claim about a set, and a set held only in a regex is a value nobody
  // executes. These three are the ones that shipped inside a sentence a reader could
  // only read as a command: each was live in 0.2.0, and each named a program the
  // package does not install, so a reader typing it got `unknown command` - from the
  // very help that printed it.
  //
  // The fourth is not here because SPELLED cannot catch it and should not pretend to;
  // `Yours from here: simt-dev` is a grammatical sentence about the project. It has
  // its own test below, on the ground it actually broke.
  const caught = [
    `REMEDY run: ${PROJECT} --help`,
    `usage: ${PROJECT} <command> [args] [flags]`,
    `#   3. ${PROJECT} on PATH    a global install`,
  ];
  for (const line of caught) assert.ok(SPELLED.test(line), `the guard misses its own case: ${line}`);

  // And the prose it must NOT flag, because the project as the subject is the
  // legitimate spelling. A guard that flags these gets deleted rather than widened.
  const allowed = [
    'Written by simt-dev when this repo was adopted. Yours from here:',
    'simt-dev will not remove a file it wrote',
    'projection is current but this simt-dev is newer',
    'whether a simt-dev manifest is present',
  ];
  for (const line of allowed) assert.ok(!SPELLED.test(line), `the guard flags prose: ${line}`);
});

test('no shipped artifact names the package as a program to run', async () => {
  // The source scan above reads src/ one line at a time. It cannot see a string that
  // arrives from two places, and it cannot read a rendered artifact as the reader
  // will. These four bytes go into files an adopting repository keeps and a CI job
  // executes, so they are checked as the bytes they become.
  const { renderShim } = await import('../src/hooks/shim.mjs');
  const { renderWorkflow } = await import('../src/ci/workflow.mjs');
  const { renderDependabot } = await import('../src/ci/dependabot.mjs');
  const { help } = await import('../src/commands/help.mjs');

  const artifacts = {
    'the hook shim': renderShim('pre-commit'),
    'the adopting gate': renderWorkflow(),
    'the dependabot file': renderDependabot([], { stack: ['node'] }),
  };

  // Help goes through the process because it is assembled from argv, and the question
  // it has to answer is the one a reader answers on a bad invocation: what now?
  const helpText = await new Promise((resolve_) => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (c) => { chunks.push(c); return true; };
    help(['--help']).then(() => { process.stdout.write = original; resolve_(chunks.join('')); });
  });
  artifacts['the help'] = helpText;

  const offenders = Object.entries(artifacts)
    .filter(([, text]) => SPELLED.test(text))
    .map(([what]) => what);
  assert.deepEqual(offenders, [], `these ship the package name as a command:\n${offenders.join('\n')}`);
});

test('both .github templates hand the same command to the reader', async () => {
  // The fourth string was not a wrong word in a sentence; it was the two templates
  // disagreeing. `.github/workflows/simt-dev-check.yml` said "Yours from here: simt"
  // and `.github/dependabot.yml` said "Yours from here: simt-dev", from the same
  // commit, in the same position, to the same reader - and the package installs
  // exactly one of them.
  //
  // No spelling rule can separate that from "Canonical X rule managed by simt-dev",
  // which is correct prose, so the assertion is on the agreement instead: both files
  // are written into repositories this tool does not own, and a sentence they share
  // is one contract with two implementations until something executes it.
  const { renderWorkflow } = await import('../src/ci/workflow.mjs');
  const { renderDependabot } = await import('../src/ci/dependabot.mjs');

  const handover = (text) => {
    const match = /Yours from here: (\S+)/.exec(text);
    assert.ok(match, 'both templates hand the file over to a reader, and this one does not');
    return match[1];
  };

  assert.equal(handover(renderWorkflow()), CLI);
  assert.equal(
    handover(renderDependabot([], { stack: ['node'] })),
    CLI,
    'the dependabot file names a different program than the gate next to it',
  );
});
