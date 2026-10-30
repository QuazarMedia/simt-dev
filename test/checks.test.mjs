// A marked line becomes a checker, and the projection keeps the name (R19, ADR-088).
//
// The accept is the file-length rule: the prose leaves, the checker runs, and a
// file past the ceiling fails. Compliance of the probes is not measured here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { checkDefect, foldChecks, runDeclaredChecks } from '../src/kernel/checks.mjs';
import { desiredRegion, loadRules } from '../src/projection/rules.mjs';
import { buildManifest } from '../src/projection/manifest.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { checkCommand } from '../src/commands/sync.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-checks-'));
  await git(['init', '-q', root]);
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
  await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
  await writeFile(
    join(root, '.simt', 'profiles', 'house.md'),
    [
      '---',
      'simt-id: house-checks',
      'simt-title: House checks',
      'simt-applies: [python]',
      'simt-priority: hard',
      '---',
      '',
      '# House checks',
      '',
      '- Keep the licence. <!-- simt-check: required-file LICENSE -->',
      '- Do not edit the vendored tree. <!-- simt-check: forbidden-path-edit vendor -->',
      '- No TODO left in the change. <!-- simt-check: forbid-regex \\bTODO\\b -->',
      '- Imports point one way. <!-- simt-check: import-direction -->',
      '',
    ].join('\n'),
  );
  const manifest = buildManifest({ root, stack: ['python'], sha: 'abc', version: packageVersion() });
  await writeFile(join(root, 'simt.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('the file-length line leaves the projection and the neighbours stay', async () => {
  const sample = [
    '- No type-system escapes.',
    '- 400 lines is a review trigger; 1000 lines is a hard ceiling.',
    '  Generated files are exempt. <!-- simt-check: max-file-lines -->',
    '- Never weaken a control.',
  ].join('\n');
  const folded = foldChecks(sample);
  assert.equal(
    folded.body,
    [
      '- No type-system escapes.',
      '- Enforced: by `simt check`: more than 400 lines warns, more than 1000 fails (`limits.fileLines`)',
      '- Never weaken a control.',
    ].join('\n'),
  );

  const rules = await loadRules();
  const core = rules.find((r) => r.id === 'core');
  assert.equal(core.error, null);
  const shipped = foldChecks(core.body);
  assert.ok(shipped.changed);
  assert.match(shipped.body, /Enforced: by `simt check`: more than 400 lines warns/);
  assert.doesNotMatch(shipped.body, /400 lines is a review trigger/);
  assert.ok(Buffer.byteLength(shipped.body) < Buffer.byteLength(core.body));

  const root = await repo();
  const region = await desiredRegion(root, {});
  assert.match(region.body, /Enforced: by `simt check`: more than 400 lines warns/);
  assert.doesNotMatch(region.body, /400 lines is a review trigger/);
  assert.match(region.notes.join('\n'), /enforced: \d+ line/);
});

test('a checker that is not built keeps its instruction', () => {
  const body = '- Imports point one way. <!-- simt-check: import-direction -->\n';
  const folded = foldChecks(body);
  assert.match(folded.body, /Imports point one way/);
  assert.doesNotMatch(folded.body, /Enforced:/);
  assert.doesNotMatch(folded.body, /simt-check/);
});

test('a marker this tool cannot run is a broken rule', () => {
  assert.match(checkDefect('- x <!-- simt-check: invent -->'), /not a checker/);
  assert.match(checkDefect('- x <!-- simt-check: forbid-regex ( -->'), /not a regular expression/);
  assert.equal(checkDefect('- x\n'), null);
});

test('the ceiling fails, the trigger warns, and a named generator is exempt', async () => {
  const root = await repo();
  const rules = await loadRules(root);
  const selected = rules.filter((r) => r.error === null && (r.id === 'core' || r.id === 'house-checks'));

  const warn = `${'x\n'.repeat(401)}`;
  await writeFile(join(root, 'long.js'), warn);
  await git(['-C', root, 'add', 'long.js']);
  const warned = await runDeclaredChecks(root, selected, { limits: { fileLines: { warn: 400, error: 1000 } } });
  assert.ok(warned.some((f) => f.status === 'file-lines-warn' && f.file === 'long.js'));
  assert.ok(!warned.some((f) => f.status === 'file-lines' && f.file === 'long.js'));

  await writeFile(join(root, 'long.js'), `${'x\n'.repeat(1001)}`);
  await git(['-C', root, 'add', 'long.js']);
  const failed = await runDeclaredChecks(root, selected, { limits: { fileLines: { warn: 400, error: 1000 } } });
  assert.ok(failed.some((f) => f.status === 'file-lines' && f.file === 'long.js'));

  await mkdir(join(root, 'gen'), { recursive: true });
  await writeFile(join(root, 'gen', 'out.js'), `${'x\n'.repeat(1001)}`);
  await git(['-C', root, 'add', 'gen/out.js']);
  const exempt = await runDeclaredChecks(root, selected, {
    limits: { fileLines: { warn: 400, error: 1000, generated: ['gen'] } },
  });
  assert.ok(!exempt.some((f) => f.file === 'gen/out.js'));
  assert.ok(exempt.some((f) => f.file === 'long.js' && f.status === 'file-lines'));

  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'long.js'), `${'x\n'.repeat(1001)}`);
  await git(['-C', root, 'add', 'node_modules/pkg/long.js']);
  const vendored = await runDeclaredChecks(root, selected, { limits: { fileLines: { warn: 400, error: 1000 } } });
  assert.ok(!vendored.some((f) => f.file.startsWith('node_modules/')));

  await writeFile(join(root, 'region.md'), `<!-- simt:generated -->\n${'x\n'.repeat(1001)}`);
  await git(['-C', root, 'add', 'region.md']);
  const marked = await runDeclaredChecks(root, selected, { limits: { fileLines: { warn: 400, error: 1000 } } });
  assert.ok(!marked.some((f) => f.file === 'region.md'));
});

test('the diff checkers see a change and not the tree it started from', async () => {
  const root = await repo();
  const rules = (await loadRules(root)).filter((r) => r.id === 'house-checks');
  const manifest = { limits: { fileLines: { warn: 400, error: 1000 } } };

  const before = await runDeclaredChecks(root, rules, manifest);
  assert.ok(before.some((f) => f.status === 'required-file'));
  assert.ok(before.some((f) => f.status === 'check-unbuilt'));
  assert.ok(!before.some((f) => f.status === 'forbid-regex'));

  await writeFile(join(root, 'LICENSE'), 'mit\n');
  await writeFile(join(root, 'src.js'), 'const pending = "TODO";\n');
  await mkdir(join(root, 'vendor'), { recursive: true });
  await writeFile(join(root, 'vendor', 'lib.js'), 'x\n');
  const after = await runDeclaredChecks(root, rules, manifest);
  assert.ok(!after.some((f) => f.status === 'required-file'));
  assert.ok(after.some((f) => f.status === 'forbid-regex' && f.file === 'src.js'));
  assert.ok(after.some((f) => f.status === 'forbidden-path' && f.file === 'vendor/lib.js'));
});

test('check reports the ceiling', async () => {
  const root = await repo();
  await writeFile(join(root, 'huge.js'), `${'x\n'.repeat(1001)}`);
  await git(['-C', root, 'add', 'huge.js']);
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    out += chunk;
    return write(chunk, ...rest);
  };
  try {
    const code = await checkCommand([], { root });
    assert.equal(code, 1);
    assert.match(out, /FILE-LINES\s+huge\.js/);
  } finally {
    process.stdout.write = write;
  }
});
