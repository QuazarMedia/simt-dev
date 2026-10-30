// Monorepo projection - one root projection plus one per package.
//
// The claim under test is that a package's rules are PROJECTED somewhere. Before this
// a monorepo received exactly one AGENTS.md, fingerprinted from the root, so every
// package was held to the root's stack: a React app in a node workspace was told it was
// a node repository, and nothing in the output said the more specific rules existed.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { discoverPackages } from '../src/monorepo.mjs';
import { plan, checkTargets } from '../src/projection/project.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { buildManifest, manifestText } from '../src/projection/manifest.mjs';
import { provenanceDigest } from '../src/projection/rules.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-mono-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Both paths: `execFile` never reports a code on success. */
async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

const pkg = (name, extra = {}) => `${JSON.stringify({ name, version: '1.0.0', ...extra }, null, 2)}\n`;

/** Write a file, creating the directories above it. `writeFile` will not. */
async function put(dir, rel, body) {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), body);
}

/**
 * The acceptance fixture: an npm workspace with one React package and one Workers
 * package. `react-dom` rather than `react` on purpose - the react-web profile selects
 * on `react-dom`, `react-router`, `maplibre` and `firebase`, and a fixture that declared
 * bare `react` would select nothing and pass for the wrong reason.
 */
async function npmWorkspace({ withWorkers = true } = {}) {
  const root = join(await scratch(), 'mono');
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), pkg('mono', { workspaces: ['apps/*'], scripts: { test: 'node -e ""' } }));
  await writeFile(join(root, 'apps', 'web', 'package.json'), pkg('web', { dependencies: { react: '^18', 'react-dom': '^18' } }));
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(join(root, 'apps', 'web', 'src', 'index.js'), 'export const x = 1;\n');
  if (withWorkers) {
    await mkdir(join(root, 'apps', 'api', 'src'), { recursive: true });
    await writeFile(
      join(root, 'apps', 'api', 'package.json'),
      pkg('api', { dependencies: { '@cloudflare/workers-types': '^4' }, scripts: { test: 'node -e ""' } }),
    );
    await writeFile(join(root, 'apps', 'api', 'wrangler.toml'), 'name = "api"\n');
  }
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  const manifest = buildManifest({ root, stack: ['node'], sha: 'abc1234', version: '0.2.1' });
  manifest.gates = { preCommit: ['test'], prePush: [], commands: { test: 'npm test' } };
  manifest.projection = { simtDevSha: await provenanceDigest(), version: packageVersion() };
  await writeFile(join(root, MANIFEST_FILE), manifestText(manifest));

  const { targets } = await plan(root);
  for (const t of targets) await writeFile(t.path, t.text);
  await run(['hooks', 'install', '--yes', '--root', root]);
  return root;
}

test('a workspace projects the root once and each package that selects something else once', async () => {
  const root = await npmWorkspace();
  const { packages } = await plan(root);

  const byPath = new Map(packages.map((p) => [p.path, p.profiles]));
  assert.deepEqual([...byPath.keys()].sort(), ['apps/api', 'apps/web']);
  assert.ok(byPath.get('apps/web').includes('react-web'), `web selected ${byPath.get('apps/web')}`);
  assert.ok(
    byPath.get('apps/api').some((id) => id.includes('cloudflare') || id.includes('workers')),
    `api selected ${byPath.get('apps/api')}`,
  );

  // The root keeps the core plus the fallback, and the root region must NOT restate the
  // package rules: a reader of the root file is reading the repository's rules, and a
  // duplicate is the same text loaded twice.
  const { body } = await desiredRegion(root, {});
  const web = await readFile(join(root, 'apps', 'web', 'AGENTS.md'), 'utf8');
  assert.notEqual(body, web, 'the package region must not be the root region');
  for (const file of ['AGENTS.md', 'apps/web/AGENTS.md', 'apps/api/AGENTS.md']) {
    assert.match(await readFile(join(root, file), 'utf8'), /simt:sources/, `${file} carries no source list`);
  }
});

test('check reports every package region, and fails on any one of them', async () => {
  const root = await npmWorkspace();
  const clean = await run(['check', '--root', root]);
  assert.equal(clean.code, 0, clean.out);

  const findings = await checkTargets(root);
  const nested = findings.filter((f) => f.file?.endsWith('/AGENTS.md')).map((f) => f.file).sort();
  assert.deepEqual(nested, ['apps/api/AGENTS.md', 'apps/web/AGENTS.md']);
  assert.ok(nested.every((f) => findings.find((x) => x.file === f).status === 'current'));

  // One package drifts; the gate must fail. A gate that only covered the root would
  // leave every monorepo's package rules ungated, which is the whole defect.
  await writeFile(join(root, 'apps', 'web', 'AGENTS.md'), '# hand written\n');
  const drifted = await run(['check', '--root', root]);
  assert.equal(drifted.code, 1, drifted.out);
  assert.match(drifted.out, /apps\/web\/AGENTS\.md/);

  // ...and a deleted package region is `absent`, not silent.
  await rm(join(root, 'apps', 'api', 'AGENTS.md'));
  const missing = await checkTargets(root);
  assert.equal(missing.find((f) => f.file === 'apps/api/AGENTS.md').status, 'absent');
  assert.equal((await run(['check', '--root', root])).code, 1);
});

test('a package that selects nothing the root does not already have writes no file', async () => {
  // Two node packages under one workspace select the same profiles, so the delta is
  // empty. A file saying "these are the rules this package selects on its own" with no
  // rules in it is a file that costs bytes and says nothing.
  const root = join(await scratch(), 'flat');
  await mkdir(join(root, 'packages', 'a'), { recursive: true });
  await mkdir(join(root, 'packages', 'b'), { recursive: true });
  await writeFile(join(root, 'package.json'), pkg('flat', { workspaces: ['packages/*'], scripts: { test: 'node -e ""' } }));
  await writeFile(join(root, 'packages', 'a', 'package.json'), pkg('a'));
  await writeFile(join(root, 'packages', 'b', 'package.json'), pkg('b'));
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  const { packages, targets } = await plan(root);
  assert.deepEqual(packages, []);
  assert.ok(!targets.some((t) => t.file.includes('/AGENTS.md')), 'no package region should be planned');
});

test('the other workspace declarations are read: go.work, Cargo members, pnpm globs and exclusions', async () => {
  const go = join(await scratch(), 'go');
  await put(go, 'go.work', 'go 1.22\n\nuse (\n\t./api\n\t./cmd/x\n)\n');
  await put(go, 'api/go.mod', 'module api\n\ngo 1.22\n');
  await put(go, 'cmd/x/go.mod', 'module x\n\ngo 1.22\n');
  assert.deepEqual((await discoverPackages(go)).packages.map((p) => p.path).sort(), ['api', 'cmd/x']);

  const cargo = join(await scratch(), 'cargo');
  await put(cargo, 'Cargo.toml', '[workspace]\nmembers = [\n  "crates/a",\n  "crates/b",\n]\n');
  for (const c of ['a', 'b']) await put(cargo, `crates/${c}/Cargo.toml`, '[package]\nname = "x"\n');
  assert.deepEqual((await discoverPackages(cargo)).packages.map((p) => p.path).sort(), ['crates/a', 'crates/b']);

  const gradle = join(await scratch(), 'gradle');
  await put(
    gradle,
    'settings.gradle',
    'rootProject.name = "mono"\ninclude(":apps:web", ":libs:core")\ninclude(\n  ":services/api",\n)\n',
  );
  for (const p of ['apps/web', 'libs/core', 'services/api']) {
    await put(gradle, `${p}/build.gradle`, 'plugins { id "java" }\n');
  }
  // Gradle project paths are colon-separated; the directory is the same path in slashes.
  assert.deepEqual(
    (await discoverPackages(gradle)).packages.map((p) => p.path).sort(),
    ['apps/web', 'libs/core', 'services/api'],
  );

  const pnpm = join(await scratch(), 'pnpm');
  await put(pnpm, 'pnpm-workspace.yaml', 'packages:\n  - "services/**"\n  - "apps/*"\n  - "!apps/legacy"\n');
  for (const d of ['services/api', 'services/deep/inner', 'apps/web', 'apps/legacy']) {
    await mkdir(join(pnpm, d, 'node_modules', 'junk'), { recursive: true });
    await writeFile(join(pnpm, d, 'package.json'), pkg('x'));
  }
  // `node_modules` is never a package, however the glob reached it.
  assert.deepEqual(
    (await discoverPackages(pnpm)).packages.map((p) => p.path).sort(),
    ['apps/web', 'services/api', 'services/deep/inner'],
  );
});

test('a pattern that reaches outside the repository is a note, never a package', async () => {
  const root = join(await scratch(), 'escape');
  await put(root, 'package.json', pkg('escape', { workspaces: ['apps/*', '../outside/*'] }));
  await put(root, 'apps/a/package.json', pkg('a'));
  await put(root, '../outside/b/package.json', pkg('b'));

  const { packages, notes } = await discoverPackages(root);
  assert.deepEqual(packages.map((p) => p.path), ['apps/a']);
  assert.ok(notes.length > 0, 'a pattern the detector refused must say so');
});

test('a repository that is not a workspace projects exactly what it did before', async () => {
  const root = join(await scratch(), 'single');
  await put(root, 'package.json', pkg('single', { dependencies: { express: '^4' } }));
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  assert.deepEqual((await discoverPackages(root)).packages, []);
  const { targets, packages } = await plan(root);
  assert.deepEqual(packages, []);
  // One AGENTS.md, the two baseline files every repository gets, and the lock file
  // plan() writes. A non-workspace must be byte-identical to what it got before the
  // workspace feature, which is the only way to know the detector does not fire where
  // it should not.
  assert.deepEqual(targets.map((t) => t.file), ['AGENTS.md', '.editorconfig', '.gitattributes', 'simt.lock.json']);
});

test('compare reports each package region, and a drifted one as a problem', async () => {
  const root = await npmWorkspace();
  const { rows } = JSON.parse((await run(['compare', '--root', root, '--json'])).out);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].packages.map((p) => p.path), ['apps/api/AGENTS.md', 'apps/web/AGENTS.md']);
  assert.deepEqual(rows[0].packageProblems, []);

  await writeFile(join(root, 'apps', 'api', 'AGENTS.md'), '# hand written\n');
  const drifted = JSON.parse((await run(['compare', '--root', root, '--json'])).out);
  assert.equal(drifted.rows[0].packageProblems.length, 1);
  assert.equal(drifted.rows[0].packageProblems[0].path, 'apps/api/AGENTS.md');
  assert.equal(drifted.summary.stalePackages, 1);
  assert.equal(drifted.summary.packageRegions, 2);
  // The repository must not be reported as current while a gate it shares with CI exits 1.
  assert.ok(drifted.rows[0].problems.some((p) => p.includes('apps/api/AGENTS.md')));
  assert.equal(drifted.ok, false);
});
