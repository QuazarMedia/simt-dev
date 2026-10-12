// The suite's only test that runs the tool as somebody who installed it.
//
// Every other file here imports from `../src`. That is the point of them: they are
// tests of units, and a unit test cannot see a file that `package.json` forgot to
// ship. S01 shipped a package whose `files` list and whose runtime reads disagreed,
// and 590 tests passed, because every one of them was reading the checkout rather
// than the artefact.
//
// So this file packs the working tree, installs the tarball into a consumer with
// nothing else in it, and drives `node_modules/.bin/simt-dev`. Everything it
// asserts is something the reader of this repository would only learn from the
// published package: the registry being absent from the published set and the
// command saying so, the decisions being present to read, and a full adoption
// surviving `init`, a commit, `check`, `upgrade`, `hooks install` and a second
// real commit.
//
// What it deliberately does not assert is that a file Prettier would reformat. The
// package has no dependencies (ADR-012), so there is no Prettier to reach for and
// `npm i` needs a network this suite must not require. The seam that Prettier used
// to catch is asserted structurally instead, in `markers.test.mjs`.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, test } from 'node:test';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { git, cmd } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const exec = promisify(execFile);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


/**
 * Nothing outside the consumer may answer a question in this file.
 *
 * The estate this checkout sits in can resolve a workspace, and a developer with
 * `SIMT_DEV_WORKSPACE` exported can resolve a different one. Either would make a
 * test pass for a reason that has nothing to do with the tarball, which is the
 * failure ADR-031 records happening three times in this repository.
 *
 * The second half is the same rule about a different inheritance, and it was found by
 * the gate rather than by a test: this file runs `npm install`, and `npm test` exports
 * npm's own RESOLVED configuration into every child it starts, as `npm_config_*`.
 * A developer whose `~/.npmrc` sets `allow-scripts` therefore had their child install
 * die with `EALLOWSCRIPTS` — npm treats a value arriving from the environment as a
 * command-line flag, and refuses it in a project-scoped install. The install is
 * perfectly good; the *inherited setting* is what npm will not accept there.
 *
 * So every `npm_config_*` variable is dropped. What is left is npm reading the same
 * config files a CI runner and a fresh shell read, which is the configuration this
 * test is supposed to be measuring under. Keeping them would make "does the tarball
 * install" a question about the developer's home directory — the same defect ADR-031
 * found three times, one level down and wearing a different hat.
 */
const NO_ESTATE = Object.fromEntries(
  Object.entries({ ...process.env, SIMT_DEV_WORKSPACE: 'off' }).filter(
    ([name]) => !/^npm_config_/i.test(name),
  ),
);

/**
 * execFile that reports rather than throws.
 *
 * `promisify` rejects on a non-zero exit, and half of what this file asserts is a
 * command refusing or failing on purpose. A helper that turned those into
 * exceptions would force every one of those assertions through a `catch`, where
 * the code being checked is easy to lose.
 */
async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(command, args, { maxBuffer: 32 << 20, ...options });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (failure) {
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      out: `${failure.stdout ?? ''}${failure.stderr ?? failure}`,
    };
  }
}

/** Drive the installed binary. The path is the one npm wrote, not this checkout's. */
function simt(root, args, env = NO_ESTATE) {
  return run(join(root, 'node_modules', '.bin', CLI), args, { cwd: root, env });
}

let stage = '';
let run1 = 0;

/**
 * One pack and one install, shared by every test below.
 *
 * `npm pack` reads the working tree, so a mutation in `src/` reaches this file
 * without being staged first. That is the only reason a mutation test can mutate
 * and run this suite at all.
 *
 * The seed is its own directory rather than the top of `stage`, so the copies each
 * test works in are siblings of it and not of each other.
 */
before(async () => {
  stage = await mkdtemp(join(tmpdir(), 'simt-dev-pack-'));
  const pack = join(stage, 'pack');
  await mkdir(pack);

  const packed = await run('npm', ['pack', '--pack-destination', pack], { cwd: PACKAGE_ROOT });
  assert.equal(packed.code, 0, `npm pack failed:\n${packed.out}`);
  // Not from stdout: npm interleaves `npm notice` lines with the filename, and
  // picking a line out of that is a guess that survives one npm version.
  const tarballs = (await readdir(pack)).filter((name) => name.endsWith('.tgz'));
  assert.deepEqual(tarballs.length, 1, `npm pack wrote ${tarballs.length} tarballs: ${tarballs}`);
  const tarball = join(pack, tarballs[0]);

  const seed = join(stage, 'seed');
  await mkdir(seed);
  await git(['init', '--quiet'], { cwd: seed });
  const installed = await run(
    'npm',
    ['install', '--save-dev', '--no-audit', '--no-fund', '--offline', tarball],
    { cwd: seed, env: NO_ESTATE },
  );
  assert.equal(installed.code, 0, `installing the tarball failed:\n${installed.out}`);

  const npm = (await run('npm', ['--version'])).out.trim();
  const pkg = await run(
    'npm',
    [
      'pkg', 'set',
      'private=true',
      'scripts.lint=node -e ""',
      'scripts.test=node -e ""',
      `packageManager=npm@${npm}`,
      // `check` reports UNDECLARED and UNFLOORED without these, which would put two
      // findings between the reader and the drift the lifecycle test is looking for.
      `engines.node=>=${process.version}`,
    ],
    { cwd: seed, env: NO_ESTATE },
  );
  assert.equal(pkg.code, 0, `staging package.json failed:\n${pkg.out}`);
  await writeFile(join(seed, 'README.md'), '# adopted\n');
  await git(['add', '-A'], { cwd: seed });
  await git(['commit', '--quiet', '-m', 'first'], { cwd: seed });
});

after(async () => {
  await rm(stage, { recursive: true, force: true });
});

/** A copy of the installed consumer, mutated and then adopted by the installed binary. */
async function adopted(mutate) {
  const root = join(stage, `run-${run1++}`);
  await cp(join(stage, 'seed'), root, { recursive: true });
  if (mutate) await mutate(root);
  const result = await simt(root, ['init', '--root', '.', '--yes']);
  assert.equal(result.code, 0, `init failed on a freshly installed package:\n${result.out}`);
  return root;
}

test('the installed tool ships no registry, and says so instead of reading the author\'s', async () => {
  const root = join(stage, 'seed');

  const lint = await simt(root, ['graph', 'lint', '--root', '.']);
  // ADR-061: the catalogue is workspace data, and the published set has none of it.
  // The honest answer is a named path and a specific exit code, not a confident
  // foreign list - the failure the old constant had was answering from this tree.
  assert.equal(lint.code, 4, lint.out);
  // Self-containment, stated as the two paths it has to disagree on: it looked where
  // an install puts the package, and it did not fall back to this checkout.
  assert.match(lint.out, /no skill registry at \S*node_modules\/.*graph\/skills\.graph\.json/);
  assert.equal(lint.out.includes(PACKAGE_ROOT), false, 'the installed tool reached into this checkout');
});

test('the installed tool finds the registry a configured workspace holds', async () => {
  // The tier the previous test's remedy points at (ADR-061 ruling 3): a tool installed
  // from node_modules resolves its workspace by configuration, and the registry is found
  // in the MEMBER that holds it. Without this tier the remedy above would send the reader
  // to a command that still answers "no registry" - a dead end, which is the failure
  // this repository's rules forbid.
  const root = join(stage, 'seed');
  const ws = join(stage, 'workspace-tier3');
  const registryPath = join(ws, 'registry-holder', 'graph', 'skills.graph.json');
  await mkdir(dirname(registryPath), { recursive: true });
  await cp(join(PACKAGE_ROOT, 'graph', 'skills.graph.json'), registryPath);

  const lint = await simt(root, ['graph', 'lint', '--root', '.'], { ...NO_ESTATE, SIMT_DEV_WORKSPACE: ws });
  assert.equal(lint.code, 0, lint.out);
  // It read the member's registry, not the author's: the named path is inside the
  // configured workspace and nowhere else.
  assert.match(lint.out, new RegExp(registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the decisions the tool explains itself with are in the tarball', async () => {
  const root = join(stage, 'seed');

  const why = await simt(root, ['rules', 'why', 'ADR-001']);
  assert.equal(why.code, 0, why.out);
  assert.match(why.out, /ADR-001/);
  // `rules/core.md` is what every command reads; the decisions are the one a
  // reader is told to go and read. A `files` entry that dropped `docs/decisions`
  // would leave the commands working and the explanation missing.
  assert.match(why.out, /commit|push|local/i);
});

test('a packed install survives the whole adoption, and no writer writes unasked', async () => {
  const root = await adopted();

  const first = await simt(root, ['check', '--root', '.']);
  assert.equal(first.code, 0, first.out);
  assert.equal(/UNDRIFTED|CURRENT/.test(first.out), true, first.out);

  // A pin this tool cannot have issued. There is no second digest to move to
  // without editing the rules in the tarball, and editing the rules under test is
  // how a test starts asserting on itself.
  const agents = join(root, 'AGENTS.md');
  const original = await readFile(agents, 'utf8');
  const stale = original.replace(/simt:sha=[0-9a-f]{40}/, `simt:sha=${'0'.repeat(40)}`);
  assert.notEqual(stale, original, 'the generated region carries no sha pin to move');
  await writeFile(agents, stale);

  const preview = await simt(root, ['upgrade', '--root', '.']);
  assert.equal(preview.code, 0, preview.out);
  assert.match(preview.out, cmd('apply with: {cli} upgrade --yes'));
  assert.equal(await readFile(agents, 'utf8'), stale, 'upgrade previewed and wrote the pin anyway');

  const applied = await simt(root, ['upgrade', '--root', '.', '--yes']);
  assert.equal(applied.code, 0, applied.out);
  assert.notEqual(await readFile(agents, 'utf8'), stale, 'upgrade --yes did not move the pin');

  const hooksPreview = await simt(root, ['hooks', 'install', '--root', '.']);
  assert.equal(hooksPreview.code, 0, hooksPreview.out);
  assert.match(hooksPreview.out, /nothing written/);
  const hooksPath = await run('git', ['config', '--get', 'core.hooksPath'], { cwd: root });
  assert.equal(hooksPath.out.trim(), '', 'a previewed hooks install pointed git at a path');
  const shim = await readFile(join(root, '.simt-hooks', 'pre-commit'), 'utf8').catch(() => '');
  assert.equal(shim, '', 'a previewed hooks install wrote a shim');

  const hooksApplied = await simt(root, ['hooks', 'install', '--root', '.', '--yes']);
  assert.equal(hooksApplied.code, 0, hooksApplied.out);
  assert.notEqual(
    (await run('git', ['config', '--get', 'core.hooksPath'], { cwd: root })).out.trim(),
    '',
    'hooks install --yes did not point git at the shim',
  );

  await git(['add', '-A'], { cwd: root });
  const commit = await git(['commit', '-m', 'second'], { cwd: root });
  // The hook is the last thing between the installed package and the claim that a
  // packed install works: a shim that does not fire would let this commit succeed
  // with nothing having run at all.
  assert.match(commit.stdout + commit.stderr, /PASSED\s+lint\s+npm run lint/);
  const log = await git(['log', '--oneline'], { cwd: root });
  assert.equal(log.stdout.trim().split('\n').length, 2, log.stdout);
});

test('a repo that cannot run a gate is not told it has one', async () => {
  const root = await adopted(async (r) => {
    const added = await run('npm', ['pkg', 'set', 'scripts.format:check=prettier --check .'], {
      cwd: r,
      env: NO_ESTATE,
    });
    assert.equal(added.code, 0, added.out);
  });

  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  // The gate is in package.json and the formatter is not installed, so declaring it
  // would hand the reader a `check` failure they cannot act on. Presence is not the
  // assertion here - the exact gate list is, because a manifest that declared
  // nothing at all would also satisfy a weaker one.
  assert.deepEqual(manifest.gates, { preCommit: ['lint'], prePush: ['test'] });
});

test('a consumer with no estate is told every way to point at one', async () => {
  const root = await adopted();

  const result = await simt(root, ['skills', 'install', 'graphify', '--root', '.', '--yes']);
  assert.notEqual(result.code, 0, 'a skill resolved with no workspace configured');
  // All three routes, because which one the reader has is not knowable from here and
  // naming two of them is the failure mode: the reader tries the third and reports
  // the tool as broken.
  assert.match(result.out, /--workspace/);
  assert.match(result.out, /SIMT_DEV_WORKSPACE/);
  assert.match(result.out, /config\.json/);
});