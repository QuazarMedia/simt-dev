// The CI gate, as bytes a repo owns.
//
// Two things are being tested here, and the second is the one that is easy to skip.
//
// The first is that the file works: the locator is the same one the hook shim uses,
// so the gate cannot pass locally and fail to start in CI. The hook shim has its own
// test for that; this one asserts they are the SAME function's output, because two
// copies of a three-step resolution chain diverge the first time one of them is fixed.
//
// The second is that the file is readable by the person who has to approve it. A
// workflow is the first thing simt-dev ships that a human has to argue with in a
// review rather than merely receive. It says what it runs, it says the gate fails
// rather than passes when the tool is missing, and it does not tell the reader to go
// edit something in a repository they do not have.

import assert from 'node:assert/strict';
import { cmd, keepTemp } from './fixture.mjs';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  renderWorkflow,
  planWorkflow,
  isOwnRepo,
  nodeFloor,
  ACTIONS,
  WORKFLOW_FILE,
  WORKFLOWS_DIR,
} from '../src/ci/workflow.mjs';
import { renderDependabot, planDependabot, DEPENDABOT_FILE } from '../src/ci/dependabot.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';
import { renderShim, EVENTS } from '../src/hooks/shim.mjs';
import { BIN_ENV, CLI, PACKAGE_NAME } from '../src/name.mjs';
import { renderLocator } from '../src/locate.mjs';
import { PACKAGE_ROOT } from '../src/workspace.mjs';

import { CI, BIN, exec, run, actionsRepo, plainRepo } from './ci-fixture.mjs';
import { EXIT } from '../src/output/index.mjs';
import { assertClean } from './leaks.mjs';
// Dependabot is a second `.github` file and not a third baseline, and the difference
// is structural rather than editorial: `updates:` is a YAML list, two lists cannot be
// concatenated, and so there is no region shape that could mean "these entries are
// mine and those are yours". ADR-025's region mechanism has nothing to merge here.
// Everything below is about that file being correct on its own terms.

test('every ecosystem in the config is one GitHub documents', async () => {
  // Names taken from the Dependabot options reference, not from memory. A config that
  // names an ecosystem Dependabot does not implement is rejected by GitHub with no
  // useful message, and the repo's dependency updates stop silently.
  const KNOWN = new Set([
    'github-actions', 'npm', 'pip', 'gomod', 'cargo', 'bundler', 'composer',
    'maven', 'docker', 'docker-compose', 'terraform', 'gradle', 'mix', 'nuget',
    'rust-toolchain', 'devcontainers', 'helm', 'elm', 'gitsubmodule', 'pub', 'swift', 'uv', 'bun',
  ]);
  const yaml = renderDependabot(
    ['has-pyproject', 'has-requirements', 'has-go-mod', 'has-cargo-toml', 'has-gemfile',
      'has-composer', 'has-maven-pom', 'has-dockerfile', 'has-compose', 'has-terraform'],
    { stack: ['node', 'typescript'] },
  );
  const values = [...yaml.matchAll(/package-ecosystem: "([^"]+)"/g)].map((m) => m[1]);
  for (const v of values) assert.ok(KNOWN.has(v), `${v} is not a documented package-ecosystem`);
  assert.match(yaml, /^version: 2$/m);
});

test('detection decides the entries, and a manifest nobody has is never listed', async () => {
  // The failure this prevents is an entry that looks configured and configures
  // nothing: Dependabot finds no manifest, opens no pull request, and the config
  // reads as though the repo's dependencies are watched.
  const none = renderDependabot([], { stack: [] });
  assert.match(none, /package-ecosystem: "github-actions"/);
  assert.doesNotMatch(none, /package-ecosystem: "npm"/);
  assert.doesNotMatch(none, /package-ecosystem: "pip"/);

  // A python repo with no package.json is not an npm repo.
  const py = renderDependabot(['has-pyproject'], { stack: [] });
  assert.match(py, /package-ecosystem: "pip"/);
  assert.doesNotMatch(py, /package-ecosystem: "npm"/);

  // And a repo that does have one is.
  const node = renderDependabot(['has-lockfile'], { stack: ['node'] });
  assert.match(node, /package-ecosystem: "npm"/);
});

test('two manifests for one ecosystem produce one entry, not two', async () => {
  // pyproject.toml and requirements.txt are two ways of declaring python deps and
  // Dependabot reads both under `pip`. Two `pip` entries is a duplicate the config
  // rejects or collapses, and the reader cannot tell which one won.
  const yaml = renderDependabot(['has-pyproject', 'has-requirements'], { stack: [] });
  const pips = [...yaml.matchAll(/package-ecosystem: "pip"/g)];
  assert.equal(pips.length, 1);
});

test('a Gradle repo with a submodule watches gradle and gitsubmodule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-dep-'));
  keepTemp(root);
  await writeFile(join(root, 'build.gradle'), 'plugins {}\n');
  await writeFile(join(root, '.gitmodules'), '[submodule "app-ui"]\n\tpath = app-ui\n');
  const found = await fingerprint(root);
  const yaml = renderDependabot(found.facts, { stack: found.stack });
  assert.match(yaml, /package-ecosystem: "gradle"/);
  assert.match(yaml, /package-ecosystem: "gitsubmodule"/);
});

test('a Makefile is not a dependency manifest and is not mapped to an ecosystem', async () => {
  // `has-build-system` covers Makefile, CMakeLists and meson.build. Dependabot has no
  // ecosystem that reads them, and mapping the fact to `maven` would produce a config
  // claiming to watch a build tool's "dependencies" - the detection-driven ruling
  // exists precisely to stop a plausible-looking line that watches nothing.
  const yaml = renderDependabot(['has-build-system'], { stack: [] });
  assert.doesNotMatch(yaml, /package-ecosystem: "maven"/);
  assert.match(yaml, /package-ecosystem: "github-actions"/);
});

test('entry order is the table order, not detection order', async () => {
  // Determinism is a feature: a pull request that adds a manifest must show one added
  // entry, not a reshuffle. Facts arrive from sets and file listings, so without a
  // fixed order the same repo renders differently across runs.
  const facts = ['has-terraform', 'has-pyproject', 'has-dockerfile'];
  assert.equal(renderDependabot(facts, { stack: [] }), renderDependabot(facts.slice().reverse(), { stack: [] }));
});

test('the dependabot bytes ship nothing a reader outside this repository cannot act on', () => {
  // The leak check, not the whole assertClean: naming `src/ci/dependabot.mjs` in this
  // repository's own copy is correct, because that is the one place it resolves. What
  // cannot be true anywhere is an instruction addressed to whoever maintains this tool.
  assertClean('dependabot (consumer)', renderDependabot(['has-pyproject'], { stack: ['node'] }));
  assertClean('dependabot (own)', renderDependabot(['has-pyproject'], { stack: ['node'], own: true }));
});

test('the config a repo gets lists exactly the ecosystems it has', async () => {
  const root = await actionsRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
  const plan = await planDependabot(root);
  assert.equal(plan.action, 'create');
  assert.deepEqual(plan.ecosystems, ['npm', 'pip']);
  const written = renderDependabot(plan.facts, { stack: plan.stack });
  assert.match(written, /package-ecosystem: "npm"/);
  assert.match(written, /package-ecosystem: "pip"/);
});

test('a repo with no .github gets no config, and is told why', async () => {
  // Same rule as the gate: creating `.github` silently would start opening dependency
  // pull requests nobody asked for.
  const root = await plainRepo();
  const plan = await planDependabot(root);
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /does not run GitHub Actions/);
  await assert.rejects(readFile(join(root, DEPENDABOT_FILE), 'utf8'));
});

test('the config is never inspected for drift in a repo that adopted simt-dev', async () => {
  // The write-once rule in the one form that can be got wrong quietly. Both `init` and
  // `ci` route their writes through this plan, so a repo's config that this tool
  // compared against the template would be a repo's file being rewritten on their
  // next adoption - and the assertion the workflow's twin test makes, which has to be
  // made here too or the rule is only tested once and for one of two files.
  const root = await actionsRepo();
  await writeFile(join(root, DEPENDABOT_FILE), 'version: 2\nupdates:\n# ours\n');
  const plan = await planDependabot(root);
  assert.equal(plan.own, false);
  assert.equal(plan.action, 'unchanged');
  assert.equal(plan.reason, null);
});

test("a repo's own edits to the config survive init, exactly as the workflow's do", async () => {
  // The ownership rule in behavioural form. A repo that adds a private registry, an
  // `ignore` rule or a weekly cadence has done the thing this file exists to let them
  // do, and a second writer would delete it.
  const root = await actionsRepo();
  await exec(process.execPath, [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  await writeFile(
    join(root, DEPENDABOT_FILE),
    `${renderDependabot([], { stack: ['node'] })}\n# our own security policy lives here\n`,
  );
  await exec(process.execPath, [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(await readFile(join(root, DEPENDABOT_FILE), 'utf8'), /our own security policy/);

  // And check does not inspect a file it did not write.
  const { stderr } = await exec(process.execPath, [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch((e) => e);
  assert.doesNotMatch(stderr, /dependabot/);
});

test('check offers the dependabot config to a repo that runs Actions, without failing it', async () => {
  // The gate file alone does not make a repo safe to merge into: a repo whose
  // dependencies are never updated finds out about a CVE from an advisory rather
  // than from a pull request. The config is offered with its remedy, and a repo
  // that declines it is making a decision, not carrying a defect.
  const root = await actionsRepo();
  await exec(process.execPath, [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  await rm(join(root, DEPENDABOT_FILE));
  // A resolved exec is the green: declining the config must not red the gate, and
  // execFile rejects on a non-zero exit.
  const { stdout } = await exec(process.execPath, [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(stdout, /OPTIONAL\s+\.github\/dependabot\.yml/);
  assert.match(stdout, /nothing watches its dependencies/);

  await exec(process.execPath, [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  const restored = await exec(process.execPath, [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.doesNotMatch(restored.stdout, /dependabot/);
});

test('simt-dev refreshes both of its own copies, and writes only what changed', async () => {
  const { stdout } = await exec(process.execPath, [CI], { cwd: PACKAGE_ROOT, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(stdout, /current\s+\.github\/workflows\/simt-dev-check\.yml/);
  assert.match(stdout, /current\s+\.github\/dependabot\.yml/);
});
