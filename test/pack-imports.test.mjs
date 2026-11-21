// Everything the shipped sources import has to be inside the shipped files (W01/W48 parity).
//
// The bench is deliberately the exception: its commands load an optional package instead of a
// relative module, so the core tarball stays small and the same binary works with or without
// it. These checks keep that boundary honest in both directions - no core source may import
// the bench statically, and the tarball must not carry it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** Every top-level directory a relative import reaches into, other than `src/` itself. */
async function outside(importers) {
  const roots = new Map();
  for (const file of importers) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const target = relative(ROOT, resolve(dirname(file), match[1]));
      if (target.startsWith('..')) continue;
      const top = target.split('/')[0];
      if (top === 'src' || top === '') continue;
      if (!roots.has(top)) roots.set(top, []);
      roots.get(top).push(relative(ROOT, file));
    }
  }
  return roots;
}

const covered = (files, top) => files.some((entry) => entry === top || entry.startsWith(`${top}/`));

test('every directory the shipped sources import is in the published files list', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const roots = await outside([...(await sources(join(ROOT, 'src'))), ...(await sources(join(ROOT, 'bin')))]);
  const missing = [...roots.entries()]
    .filter(([top]) => !covered(files, top))
    .map(([top, importers]) => `${top}/ (imported by ${[...new Set(importers)].join(', ')})`);
  assert.deepEqual(missing, [], `imported at runtime and absent from "files": ${missing.join('; ')}`);
});

test('the optional bench package builds with its core imports rewritten', async () => {
  const out = await mkdtemp(join(tmpdir(), 'bench-build-'));
  try {
    await exec(process.execPath, [join(ROOT, 'scripts', 'build-bench-package.mjs'), out]);
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    const core = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@simt-dev/bench');
    assert.equal(pkg.private, false);
    assert.equal(pkg.peerDependencies['simt-dev'], `^${core.version}`);
    // A scoped package is restricted unless it says otherwise, and provenance
    // refuses a release whose repository does not match the source repository.
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.equal(pkg.repository?.url, core.repository.url);
    assert.equal(pkg.repository?.directory, 'packages/bench');

    const coreSpecifiers = new Set();
    for (const file of await sources(join(out, 'src'))) {
      const source = await readFile(file, 'utf8');
      assert.equal(source.includes("'../../../src/"), false, `${relative(out, file)} still reaches into the checkout`);
      for (const match of source.matchAll(/from 'simt-dev\/(src\/[^']+)'/g)) coreSpecifiers.add(match[1]);
    }
    assert.match(await readFile(join(out, 'src', 'commands.mjs'), 'utf8'), /from 'simt-dev\/src\//);

    // The rewritten specifiers are the package's exact legacy exports. A wildcard would
    // let this pass while exposing every internal module, so the key is compared too.
    const missing = [...coreSpecifiers].filter((specifier) => core.exports[`./${specifier}`] === undefined);
    assert.deepEqual(missing, [], `the bench imports paths package.json does not export: ${missing.join(', ')}`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the bench is outside the core tarball and outside its static imports', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(covered(pkg.files ?? [], 'packages/bench/src'), false, 'packages/bench/src is in the core "files"');

  const importers = [...(await sources(join(ROOT, 'src'))), ...(await sources(join(ROOT, 'bin')))];
  const staticImport = /^\s*(?:import|export)\b.*\bfrom\s+['"][^'"]*packages\/bench\//m;
  const offenders = [];
  for (const file of importers) {
    if (staticImport.test(await readFile(file, 'utf8'))) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `core sources import the optional bench statically: ${offenders.join(', ')}`);
});
