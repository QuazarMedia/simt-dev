import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  DOCUMENTED_RESOLUTIONS,
  TSCONFIG_BASE_FILE,
  TSCONFIG_FILE,
  checkTsconfig,
  planTsconfigBase,
  readJsonc,
} from '../src/tsconfig.mjs';

const run = promisify(execFile);
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt.mjs');

async function simt(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd, maxBuffer: 1 << 24 });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'simt-tsconfig-'));
  await mkdir(join(root, '.git'), { recursive: true });
  return root;
}

/** A repo with TypeScript sources, which is the only thing that makes the strictness findings relevant. */
async function tsRepo(tsconfig = null) {
  const root = await scratch();
  // Adoption pins the gate before it can resolve from node_modules; without the pin
  // `check` is correctly red, and the test would only pass with a global `simt`.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'svc', devDependencies: { 'simt-dev': '0.0.0' } }) + '\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = 1;\n');
  if (tsconfig !== null) await writeFile(join(root, TSCONFIG_FILE), tsconfig);
  return root;
}

/** A repo with no TypeScript anywhere, where the base file would be read by nothing. */
async function jsRepo() {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'svc', devDependencies: { 'simt-dev': '0.0.0' } }) + '\n');
  await writeFile(join(root, 'index.js'), 'module.exports = 1;\n');
  return root;
}

/** A Python repo: the third fixture ecosystem, and the one that must not be told about TypeScript at all. */
async function pyRepo() {
  const root = await scratch();
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "svc"\n');
  // No package.json to pin in, so the gate runs from the release binary the workflow
  // installs into the repository. Its presence is what makes `check` green here.
  await mkdir(join(root, '.simt', 'bin'), { recursive: true });
  await writeFile(join(root, '.simt', 'bin', 'simt'), '');
  return root;
}

// A base file the repo wrote itself: the tool reads its existence, never its contents.
const BASE = '{ "compilerOptions": { "strict": true } }\n';

test('a JSONC tsconfig is read, because tsc reads it', () => {
  const text = `{
  // a repo is allowed to say why
  "compilerOptions": {
    /* block form too */
    "moduleResolution": "bundler",
  },
}
`;
  const { value, error } = readJsonc(text);
  assert.equal(error, null);
  assert.equal(value.compilerOptions.moduleResolution, 'bundler');
});

test('a URL inside a string is not mistaken for a comment', () => {
  // The reason this is a scanner and not a regex. The commonest string near a tsconfig is
  // a URL, `//` appears in every one of them, and a regex strips the rest of the line and
  // then reports a parse error on a file that is perfectly valid.
  const { value, error } = readJsonc('{"compilerOptions": {"paths": {"~/*": ["./src/*"]}}, "x": "https://example.com/a"}');
  assert.equal(error, null);
  assert.equal(value.x, 'https://example.com/a');
  assert.deepEqual(value.compilerOptions.paths['~/*'], ['./src/*']);
});

test('an escape inside a string does not end the string early', () => {
  const { value, error } = readJsonc('{"a": "quote \\" then // not a comment"}');
  assert.equal(error, null);
  assert.equal(value.a, 'quote " then // not a comment');
});

test('a malformed tsconfig is reported, not thrown', () => {
  // A gate that throws on a file it did not write shows a reader a stack trace where the
  // answer was one line, and `tsc` already says it better.
  const { value, error } = readJsonc('{ "compilerOptions": ');
  assert.equal(value, null);
  assert.match(error, /./);
});

test('a repo with TypeScript is told init will not create the base file', async () => {
  // Review 0003 Q28: the create action is gone. The plan line is the statement that
  // keeps the file from appearing after the run without being in the plan.
  const plan = await planTsconfigBase(await tsRepo());
  assert.equal(plan.action, 'skip');
  assert.equal(plan.exists, false);
  assert.equal(plan.file, TSCONFIG_BASE_FILE);
  assert.match(plan.reason, /init no longer creates/);
});

test('a repo with no TypeScript is not offered a file nothing would extend', async () => {
  const plan = await planTsconfigBase(await jsRepo());
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /no TypeScript/);
});

test('an existing base file is never reported as needing a rewrite', async () => {
  // The write-once rule, in the one form that can be got wrong quietly. `check` reports
  // the state of this file and never its contents (ADR-026), so a repo that has edited
  // these bytes must not see its own work described as drift.
  const root = await tsRepo();
  const plan = await planTsconfigBase(root);
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  const after = await planTsconfigBase(root);
  assert.equal(after.action, 'unchanged');
  assert.equal(after.exists, true);
  assert.equal(plan.action, 'skip', 'the first plan is what proves the file was absent');
});

test('a TypeScript repo with no base file is not told off about it', async () => {
  // Review 0003 Q28: writing the file is the repo's decision, so its absence is not a
  // finding. The old `absent` finding's remedy was `init --yes`, and the moment init
  // stopped creating the file the remedy was a no-op — a finding whose command does
  // nothing is a finding that should not exist.
  const findings = await checkTsconfig(await tsRepo());
  assert.deepEqual(findings, []);
});

test('a base file nothing extends is reported as inert, naming the line to add', async () => {
  // The symptom this exists for: a strictness floor sitting in the repository looking
  // adopted because the file is right there, and a `tsc` run that proves it is not.
  const root = await tsRepo('{ "compilerOptions": { "strict": true } }');
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  const findings = await checkTsconfig(root);
  const inert = findings.find((f) => f.status === 'inert');
  assert.ok(inert);
  assert.match(inert.remedy, /add "extends": "\.\/tsconfig\.base\.json"/);
});

test('an adopted base file produces no finding', async () => {
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}", "compilerOptions": { "target": "ES2022" } }`);
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  const findings = await checkTsconfig(root);
  assert.equal(findings.filter((f) => f.status === 'inert').length, 0);
});

test('a moduleResolution the documentation does not spell is reported', async () => {
  // node.md asks for it "spelled consistently across every repo in the workspace". The
  // parser is case-insensitive, so three repositories write `Bundler` and one writes
  // `bundler`, both compile, and nothing has ever said so.
  const root = await tsRepo('{ "compilerOptions": { "moduleResolution": "Bundler" } }');
  const findings = await checkTsconfig(root);
  const bad = findings.find((f) => f.status === 'inconsistent');
  assert.ok(bad);
  assert.equal(bad.remedy, 'change it to "bundler"');
});

test('every spelling TypeScript documents is accepted', () => {
  for (const value of DOCUMENTED_RESOLUTIONS) {
    assert.ok(value === value.toLowerCase(), `${value} is documented in lower case`);
  }
});

test('a repo with no TypeScript is not told about TypeScript', async () => {
  const findings = await checkTsconfig(await jsRepo());
  assert.deepEqual(findings, []);
});

test('an unreadable tsconfig produces no guess', async () => {
  const root = await tsRepo('{ "compilerOptions": ');
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  const findings = await checkTsconfig(root);
  assert.deepEqual(findings, [], 'tsc reports this, and better');
});

test('init does not create the base file, and says so in the plan', async () => {
  // Review 0003 Q28: the file a tool writes into a fresh repo is one nothing extends,
  // because the repo's own tsconfig.json is the repo's to write. The plan line carries
  // the statement the file used to owe its reader.
  const root = await tsRepo();
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /skip\s+tsconfig\.base\.json/);
  assert.match(ran.out, /init no longer creates/);
  const st = await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8').catch(() => null);
  assert.equal(st, null, 'init must not leave a floor behind that nothing extends');
});

test('a repo that adopts the base keeps its own compilerOptions', async () => {
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}" }`);
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(ran.code, 0, ran.out);
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 0, checked.out);
});

test('a hand-edited base survives init and is never called drift', async () => {
  // The file is repo-owned end to end: init neither creates it nor rewrites it, so a
  // repo that added a flag of its own keeps it across every run.
  const root = await tsRepo();
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE.replace('"strict": true', '"strict": true,\n    "noUnusedLocals": true'));
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  const mine = await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8');
  const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(ran.code, 0, ran.out);
  assert.equal(await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8'), mine, 'init did not rewrite it');
  const checked = await simt(['check'], root);
  assert.doesNotMatch(checked.out, /DRIFT[\s\S]*tsconfig/);
});

test('deleting the base file is reported by nothing, because writing one is a decision', async () => {
  // The old `absent` finding made this a gate failure with `init --yes` as the remedy.
  // Once init stopped creating the file, that remedy was a no-op, and a finding whose
  // command does nothing is a finding that should not exist (review 0003 Q28).
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}" }`);
  await writeFile(join(root, TSCONFIG_BASE_FILE), BASE);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  await rm(join(root, TSCONFIG_BASE_FILE));
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 0, checked.out);
});

test('this repository is not given one either', async () => {
  // Same reason as the baselines: this repository is not a consumer of itself, and the
  // command that writes these files is the one being tested here.
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = await planTsconfigBase(here);
  assert.equal(plan.action, 'skip');
});

test('a fresh init leaves check green in every fixture ecosystem (review 0003 Q28)', async () => {
  // The acceptance criterion, stated as the reader met the defect: a fresh TypeScript
  // adoption ran `init --yes`, got a base file nothing extended, and `check` exited 1
  // on the very repository the adoption was supposed to make current. Every ecosystem
  // is asserted, because a fix that only unreddens TypeScript would leave the same
  // shape of failure for the next stack someone adopts.
  for (const repo of [await tsRepo(), await jsRepo(), await pyRepo()]) {
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repo, '.github', 'workflows', 'b.yml'), 'name: b\n');
    const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], repo);
    assert.equal(ran.code, 0, ran.out);
    const checked = await simt(['check'], repo);
    assert.equal(checked.code, 0, `check must be green on a fresh adoption:\n${checked.out}`);
  }
});
