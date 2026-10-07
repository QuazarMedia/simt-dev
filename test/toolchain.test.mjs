import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { allows, checkToolchain, readPins, LOCKFILES } from '../src/toolchain.mjs';
import { checkTargets } from '../src/projection/project.mjs';

const run = promisify(execFile);
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt-dev.mjs');

async function simt(args, root) {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args, '--root', root], { cwd: root });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A node repository with a lockfile, described the way each test needs it described.
 * Defaults are the shape that produces no findings at all, so a test that asserts a
 * finding has to opt into the defect rather than inherit it from the fixture.
 */
async function repo({ pkg = {}, lock = 'package-lock.json', nvmrc = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-toolchain-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'api', ...pkg }, null, 2) + '\n');
  if (lock) await writeFile(join(root, lock), '{"lockfileVersion":3}\n');
  if (nvmrc !== null) await writeFile(join(root, '.nvmrc'), nvmrc);
  return root;
}

const statuses = (findings) => findings.map((f) => f.status).sort();

test('the six estate range forms are evaluated, not guessed at', async () => {
  // The values below are the ones actually written in this estate, plus the shapes a
  // reader will reach for next. Anything outside this list is silent on purpose.
  const cases = [
    ['>=22', '22.21.1', true],
    ['>=22', '24.19.0', true],
    ['>=24.19', '24.19.0', true],
    ['>=24.19', '24.18.0', false],
    ['>=22', '20.11.0', false],
    ['>=24.19', 'v24.19.0', true],
    ['^22.0.0', '22.5.0', true],
    ['^22.0.0', '23.0.0', false],
    ['~22.1.0', '22.1.9', true],
    ['~22.1.0', '22.2.0', false],
    ['20 || 22', '22.1.0', true],
    ['20 || 22', '21.0.0', false],
    ['>=22.0.0 <23.0.0', '22.5.0', true],
    ['22', '22.9.9', true],
    ['22', '23.0.0', false],
  ];
  for (const [range, version, want] of cases) {
    assert.equal(allows(range, version), want, `${range} should ${want ? '' : 'not '}allow ${version}`);
  }
});

test('a range this tool cannot evaluate produces no answer at all', async () => {
  // The alternative is an approximate reading reported with the same confidence as an
  // exact one, and a reader cannot tell which of our findings were guesses.
  assert.equal(allows('lts/*', '22.1.0'), null);
  assert.equal(allows('22.x', '22.1.0'), null);
  assert.equal(allows('workspace:*', '1.0.0'), null);
  assert.equal(allows('>=22', 'not-a-version'), null);
});

test('a repository that pins everything agrees with itself is left alone', async () => {
  const root = await repo({
    pkg: { packageManager: 'npm@10.9.1', engines: { node: '>=22' } },
    nvmrc: '22.21.1\n',
  });
  assert.deepEqual(await checkToolchain(root), []);
});

test('a missing packageManager is reported with a command that fills in the version', async () => {
  // The version cannot be read from package-lock.json — it carries only a lockfile format
  // number — so the remedy is a command run where the answer exists rather than a value
  // invented here. This is the finding that fires in nine repositories in this estate.
  const root = await repo({ pkg: { engines: { node: '>=22' } }, nvmrc: '22.21.1' });
  const [finding] = await checkToolchain(root);
  assert.equal(finding.status, 'undeclared');
  assert.equal(finding.file, 'package.json');
  assert.match(finding.detail, /package-lock\.json/);
  assert.match(finding.remedy, /^npm pkg set packageManager=npm@\$\(npm --version\)/);
});

test('a packageManager that names a different manager than the lockfile is reported', async () => {
  const root = await repo({ pkg: { packageManager: 'pnpm@9.12.0', engines: { node: '>=22' } } });
  const [finding] = await checkToolchain(root);
  assert.equal(finding.status, 'mismatched');
  assert.match(finding.detail, /pnpm@9\.12\.0/);
  assert.match(finding.detail, /package-lock\.json/);
});

test('two lockfiles are reported as the absence of a package manager, not resolved by picking one', async () => {
  const root = await repo({ pkg: { packageManager: 'npm@10.9.1', engines: { node: '>=22' } } });
  await writeFile(join(root, 'yarn.lock'), '');
  const findings = await checkToolchain(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, 'mismatched');
  assert.match(findings[0].detail, /package-lock\.json, yarn\.lock/);
  assert.match(findings[0].remedy, /delete the lockfile/);
});

test('no engines.node is reported as a floor nobody enforces', async () => {
  // rules/stacks/node.md puts it as a claim and then says why it matters; this is that
  // claim with a gate behind it. Four repositories in this estate have neither this nor a
  // .nvmrc.
  const root = await repo({ pkg: { packageManager: 'npm@10.9.1' } });
  const [finding] = await checkToolchain(root);
  assert.equal(finding.status, 'unfloored');
  assert.match(finding.detail, /comment/);
  assert.match(finding.remedy, /^node --version/);
});

test('a .nvmrc the declared floor forbids is the one contradiction reported', async () => {
  const root = await repo({
    pkg: { packageManager: 'npm@10.9.1', engines: { node: '>=24' } },
    nvmrc: '22.22.0\n',
  });
  const [finding] = await checkToolchain(root);
  assert.equal(finding.status, 'contradiction');
  assert.equal(finding.file, '.nvmrc');
  assert.match(finding.detail, /22\.22\.0/);
  assert.match(finding.detail, />=24/);
  assert.match(finding.remedy, /change \.nvmrc/);
});

test('a .nvmrc and floor that disagree across repositories is not this tool\'s business', async () => {
  // The plan called three .nvmrc files "disagreeing". Each agrees with its own engines
  // perfectly; what differs is a per-repository choice. A gate that reported it would be a
  // finding with no remedy, so it stays silent and this test says so out loud.
  const one = await repo({ pkg: { packageManager: 'npm@10.9.1', engines: { node: '>=22' } }, nvmrc: '22.21.1' });
  const two = await repo({ pkg: { packageManager: 'npm@10.9.1', engines: { node: '>=24.19' } }, nvmrc: '24.19.0' });
  assert.deepEqual(await checkToolchain(one), []);
  assert.deepEqual(await checkToolchain(two), []);
});

test('a repository that is not node is never asked about package managers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-toolchain-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "svc"\n');
  assert.deepEqual(await checkToolchain(root), []);
});

test('a node repository with no lockfile is not asked either', async () => {
  // A lockfile is the evidence that a package manager was chosen. Without one, declaring
  // one is a decision this tool has no standing to call missing.
  const root = await repo({ lock: null });
  assert.deepEqual(await checkToolchain(root), []);
});

test('readPins names the manager each lockfile implies, for all five', async () => {
  for (const { file, manager } of LOCKFILES) {
    const root = await repo({ pkg: { packageManager: `${manager}@1.0.0` }, lock: null });
    await writeFile(join(root, file), '');
    const pins = await readPins(root);
    assert.deepEqual(pins.map((p) => p.manager), [manager], `${file} should imply ${manager}`);
  }
});

test('the findings reach check and block the merge', async () => {
  const root = await repo({ nvmrc: '22.22.0', pkg: { engines: { node: '>=24' } } });
  const findings = await checkTargets(root, {});
  assert.ok(statuses(findings).includes('undeclared'));
  assert.ok(statuses(findings).includes('unfloored') === false, 'engines is declared here');
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /packageManager/);
  assert.match(checked.out, /\.nvmrc/);
  assert.match(checked.out, /remedy:/);
});

test('every finding names a file and a remedy a reader can act on', async () => {
  // AGENTS.md's table: a finding that names a location is a second problem stacked on the
  // first. Each of these statuses was written by hand and could have shipped without one.
  // Two fixtures, because `unfloored` and `contradiction` cannot co-occur by
  // definition: a contradiction needs a floor, and a missing floor is the other finding.
  const withFloor = await repo({ nvmrc: '22.22.0', pkg: { engines: { node: '>=24' } } });
  const withoutFloor = await repo({ nvmrc: '22.22.0' });
  const findings = [...(await checkToolchain(withFloor)), ...(await checkToolchain(withoutFloor))];
  assert.deepEqual(statuses(findings), ['contradiction', 'undeclared', 'undeclared', 'unfloored']);
  for (const finding of findings) {
    assert.ok(finding.file.length > 0, `${finding.status} names no file`);
    assert.ok(finding.remedy.length > 0, `${finding.status} names no remedy`);
    assert.doesNotMatch(finding.remedy, /simt-dev\/(docs|src|rules)\b/, `${finding.status} leaks this repository`);
  }
});

test('nothing here writes to the repository it judges', async () => {
  // The whole module reads. A write would make the gate able to green itself, which is
  // the failure ADR-024 rules out for the .github files and this extends to every check.
  const root = await repo({ nvmrc: '22.22.0', pkg: { engines: { node: '>=24' } } });
  const before = await Promise.all(
    ['package.json', '.nvmrc', 'package-lock.json'].map(async (f) => [f, await readFile(join(root, f), 'utf8')]),
  );
  await checkTargets(root, {});
  for (const [file, text] of before) {
    assert.equal(await readFile(join(root, file), 'utf8'), text, `${file} was modified`);
  }
});
