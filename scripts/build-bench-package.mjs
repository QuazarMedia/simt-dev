// Build the optional `@simt-dev/bench` package that pairs with a core simt-dev install.
//
// The checked-in source imports its shared core through relative paths, because a checkout
// runs both trees in place. An installed package cannot: it sits in its own
// node_modules/@simt-dev/bench, so those specifiers are rewritten to the core package's public
// `simt-dev/src/*` export. The generated manifest declares simt-dev as a peer, never a
// dependency, so installing the bench cannot silently install a second core.
//
// Usage: node scripts/build-bench-package.mjs [outDir]
// Then:  npm install <outDir>   (with simt-dev already installed)

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'dist', 'bench'));

async function modules(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await modules(path)));
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** Rewrite only the specifier line, never fixture text that happens to look like one. */
export function rewriteCoreImports(source) {
  return source
    .split('\n')
    .map((line) => (line.includes("from '../../../src/")
      ? line.replace("from '../../../src/", "from 'simt-dev/src/")
      : line))
    .join('\n');
}

const core = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const sourceManifest = JSON.parse(await readFile(join(ROOT, 'packages', 'bench', 'package.json'), 'utf8'));

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'src'), { recursive: true });
await cp(join(ROOT, 'packages', 'bench', 'src'), join(OUT, 'src'), { recursive: true });
await cp(join(ROOT, 'packages', 'bench', 'README.md'), join(OUT, 'README.md'));

for (const file of await modules(join(OUT, 'src'))) {
  const source = await readFile(file, 'utf8');
  const rewritten = rewriteCoreImports(source);
  if (rewritten !== source) await writeFile(file, rewritten);
}

await writeFile(
  join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      ...sourceManifest,
      private: false,
      version: core.version,
      // A scoped package is restricted by default. Without this, the first
      // `npm stage publish` publishes it to a private scope instead of the
      // public registry the documented install route names.
      publishConfig: { access: 'public' },
      // Provenance cross-checks this field against the OIDC repository claim.
      // The source lives in the core's repository under packages/bench; the
      // directory is the source location, not the generated dist/bench path.
      repository: { ...core.repository, directory: 'packages/bench' },
      main: 'src/commands.mjs',
      exports: { '.': './src/commands.mjs', './src/*': './src/*' },
      peerDependencies: { 'simt-dev': `^${core.version}` },
      files: ['src'],
    },
    null,
    2,
  )}\n`,
);

console.log(`built ${OUT} for simt-dev ${core.version}`);
