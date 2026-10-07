import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { assertClean } from './leaks.mjs';
import {
  DOCUMENTED_RESOLUTIONS,
  STRICTNESS_FLOOR,
  TSCONFIG_BASE_FILE,
  TSCONFIG_FILE,
  checkTsconfig,
  planTsconfigBase,
  readJsonc,
  renderTsconfigBase,
} from '../src/tsconfig.mjs';

const run = promisify(execFile);
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt-dev.mjs');

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

/** A repo with TypeScript sources, which is the only thing that earns the base file. */
async function tsRepo(tsconfig = null) {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'svc' }) + '\n');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a: number = 1;\n');
  if (tsconfig !== null) await writeFile(join(root, TSCONFIG_FILE), tsconfig);
  return root;
}

/** A repo with no TypeScript anywhere, where the base file would be read by nothing. */
async function jsRepo() {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'svc' }) + '\n');
  await writeFile(join(root, 'index.js'), 'module.exports = 1;\n');
  return root;
}

test('the base file is valid JSON carrying the strictness floor', () => {
  const text = renderTsconfigBase();
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.compilerOptions, STRICTNESS_FLOOR);
  assert.equal(STRICTNESS_FLOOR.strict, true);
  assert.ok(text.endsWith('}\n'), 'LF-terminated so the file has no phantom last-line diff');
});

test('the floor is exactly the flags the estate already agrees on', () => {
  // Named rather than counted, because "twelve" is a number that survives a flag being
  // swapped for a different one and a reader would never notice the swap.
  assert.deepEqual(
    Object.keys(STRICTNESS_FLOOR).sort(),
    [
      'allowJs',
      'exactOptionalPropertyTypes',
      'isolatedModules',
      'noFallthroughCasesInSwitch',
      'noImplicitOverride',
      'noImplicitReturns',
      'noUncheckedIndexedAccess',
      'resolveJsonModule',
      'skipLibCheck',
      'strict',
      'useUnknownInCatchVariables',
      'verbatimModuleSyntax',
    ],
  );
});

test('the base carries no key a child has to override to be correct', () => {
  // Each of these is absent on purpose and the reason is in the module. A "helpful" future
  // addition that breaks a repository's build is the failure this prevents, so the absence
  // is asserted by name: a tidy-up that adds one fails here instead of in somebody's CI.
  const keys = Object.keys(STRICTNESS_FLOOR);
  for (const absent of [
    'noEmit',
    'moduleResolution',
    'target',
    'lib',
    'module',
    'include',
    'exclude',
    'paths',
    'jsx',
    'types',
  ]) {
    assert.equal(keys.includes(absent), false, `${absent} must stay per-repo`);
  }
});

test('the shipped bytes ship nothing only this repository could act on', () => {
  assertClean(renderTsconfigBase(), 'tsconfig.base.json');
});

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

test('a repo with TypeScript is offered the base file', async () => {
  const plan = await planTsconfigBase(await tsRepo());
  assert.equal(plan.action, 'create');
  assert.equal(plan.exists, false);
  assert.equal(plan.file, TSCONFIG_BASE_FILE);
  assert.equal(plan.reason, null);
});

test('a repo with no TypeScript is not offered a file nothing would extend', async () => {
  const plan = await planTsconfigBase(await jsRepo());
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /no TypeScript/);
});

test('an existing base file is never reported as needing a rewrite', async () => {
  // The write-once rule, in the one form that can be got wrong quietly. `check` reports
  // absence for this file and never contents (ADR-026), so a repo that has edited these
  // bytes must not see its own work described as drift.
  const root = await tsRepo();
  const plan = await planTsconfigBase(root);
  await writeFile(join(root, TSCONFIG_BASE_FILE), '{ "compilerOptions": { "strict": true } }\n');
  const after = await planTsconfigBase(root);
  assert.equal(after.action, 'unchanged');
  assert.equal(after.exists, true);
  assert.equal(plan.action, 'create', 'the first plan is what proves the file was absent');
});

test('a TypeScript repo with no base file is told so, with a command', async () => {
  const findings = await checkTsconfig(await tsRepo());
  const absent = findings.find((f) => f.status === 'absent');
  assert.ok(absent, 'absence is the one thing a file cannot report about itself');
  assert.equal(absent.file, TSCONFIG_BASE_FILE);
  assert.equal(absent.remedy, 'simt-dev init --yes');
});

test('a base file nothing extends is reported as inert, naming the line to add', async () => {
  // The symptom this exists for: a strictness floor sitting in the repository looking
  // adopted because the file is right there, and a `tsc` run that proves it is not.
  const root = await tsRepo('{ "compilerOptions": { "strict": true } }');
  await writeFile(join(root, TSCONFIG_BASE_FILE), renderTsconfigBase());
  const findings = await checkTsconfig(root);
  const inert = findings.find((f) => f.status === 'inert');
  assert.ok(inert);
  assert.match(inert.remedy, /add "extends": "\.\/tsconfig\.base\.json"/);
});

test('an adopted base file produces no finding', async () => {
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}", "compilerOptions": { "target": "ES2022" } }`);
  await writeFile(join(root, TSCONFIG_BASE_FILE), renderTsconfigBase());
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
  await writeFile(join(root, TSCONFIG_BASE_FILE), renderTsconfigBase());
  const findings = await checkTsconfig(root);
  assert.deepEqual(findings, [], 'tsc reports this, and better');
});

test('init writes the file and says the one thing the file cannot', async () => {
  // JSON has no comments, so the shipped bytes cannot carry the instruction that makes
  // them do anything. The obligation moves to the tool's output, and this is the only
  // place it is met.
  const root = await tsRepo();
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /wrote\s+tsconfig\.base\.json/);
  assert.match(ran.out, /add "extends": "\.\/tsconfig\.base\.json"/);
  const written = JSON.parse(await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8'));
  assert.deepEqual(written.compilerOptions, STRICTNESS_FLOOR);
});

test('a repo that adopts the base keeps its own compilerOptions', async () => {
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}" }`);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  const ran = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(ran.code, 0, ran.out);
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 0, checked.out);
});

test('a hand-edited base survives init and is never called drift', async () => {
  const root = await tsRepo();
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  const mine = `${renderTsconfigBase().trimEnd()}\n`.replace(
    '"skipLibCheck": true',
    '"skipLibCheck": true,\n    "noUnusedLocals": true',
  );
  await writeFile(join(root, TSCONFIG_BASE_FILE), mine);
  const again = await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  assert.equal(again.code, 0, again.out);
  assert.equal(await readFile(join(root, TSCONFIG_BASE_FILE), 'utf8'), mine, 'init did not rewrite it');
  const checked = await simt(['check'], root);
  assert.doesNotMatch(checked.out, /DRIFT[\s\S]*tsconfig/);
});

test('deleting the base file is a gate failure', async () => {
  const root = await tsRepo(`{ "extends": "./${TSCONFIG_BASE_FILE}" }`);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'b.yml'), 'name: b\n');
  await simt(['init', '--surfaces', 'opencode', '--yes'], root);
  await rm(join(root, TSCONFIG_BASE_FILE));
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /tsconfig\.base\.json/);
  assert.match(checked.out, /simt-dev init --yes/);
});

test('this repository is not given one either', async () => {
  // Same reason as the baselines: this repository is not a consumer of itself, and the
  // command that writes these files is the one being tested here.
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = await planTsconfigBase(here);
  assert.equal(plan.action, 'skip');
});
