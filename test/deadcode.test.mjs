import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** The source set this test reads: the core tree and the optional packages. */
async function walkSources() {
  return [...(await walk(join(ROOT, 'src'))), ...(await walk(join(ROOT, 'packages')))];
}

/** Strip comments before asking whether a name occurs, so a mention is not a use. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function isProductionPath(file) {
  return !file.split(sep).includes('test') && !file.endsWith('.test.mjs');
}

/**
 * Production files that mention `name` after comments are removed.
 *
 * Test files are deliberately not part of the answer: a binding a test names and a
 * production entry point never imports is not reachable. ADR-191 makes reachability a
 * review step rather than a demand that every prototype binding have a command.
 */
function productionUses(name, corpus) {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
  const declaration = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|class|let)\\s+${name}\\b[^\\n]*`, 'gm');
  const hits = [];
  for (const [file, text] of corpus) {
    if (!isProductionPath(file)) continue;
    const body = withoutComments(text).replace(declaration, '');
    if ([...body.matchAll(pattern)].length > 0) hits.push(file);
  }
  return hits;
}

/** Literal static and dynamic imports, including lazy routes. */
function importSpecifiers(text) {
  const clean = withoutComments(text);
  const specs = [];
  for (const match of clean.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    specs.push(match[1]);
  }
  for (const match of clean.matchAll(/^\s*export\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/gm)) {
    specs.push(match[1]);
  }
  for (const match of clean.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return [...new Set(specs)];
}

/** Resolve a relative or self-reference specifier to a shipped file, or null. */
function resolveSpecifier(from, specifier) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base, `${base}.mjs`, join(base, 'index.mjs')]) {
      if (existsSync(candidate) && candidate.endsWith('.mjs')) return candidate;
    }
    return null;
  }
  if (specifier === 'simt-dev') return join(ROOT, 'src', 'api.mjs');
  if (specifier.startsWith('simt-dev/')) {
    const target = join(ROOT, specifier.slice('simt-dev/'.length));
    return existsSync(target) ? target : null;
  }
  return null;
}

test('every production module edge resolves, including lazy routes', async () => {
  const files = [
    ...(await walkSources()),
    ...(await walk(join(ROOT, 'bin'))),
    ...(await walk(join(ROOT, 'scripts'))),
  ];
  const missing = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(await readFile(file, 'utf8'))) {
      if (!specifier.startsWith('.') && !specifier.startsWith('simt-dev')) continue;
      if (resolveSpecifier(file, specifier) === null) {
        missing.push(`${file.replace(`${ROOT}${sep}`, '')} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(missing, [], `an import names a file this package does not ship:\n  ${missing.join('\n  ')}`);
});

test('a test-only or comment-only occurrence cannot certify production reachability', () => {
  const corpus = new Map([
    ['src/owner.mjs', 'export function retiredThing() {}\n'],
    ['src/comment.mjs', 'const untouched = 1; // retiredThing is named here but never imported.\n'],
    ['test/owner.test.mjs', "import { retiredThing } from '../src/owner.mjs';\nretiredThing();\n"],
  ]);
  assert.deepEqual(productionUses('retiredThing', corpus), [], 'a test or comment certified reachability');

  corpus.set('src/caller.mjs', "import { retiredThing } from './owner.mjs';\nretiredThing();\n");
  assert.deepEqual(productionUses('retiredThing', corpus), ['src/caller.mjs']);
});

test('the bindings retired by PR32 are gone from their module namespaces', async () => {
  const [lock, retry, observe] = await Promise.all([
    import('../src/projection/lock.mjs'),
    import('../src/actions/retry.mjs'),
    import('../src/actions/observe.mjs'),
  ]);
  assert.equal('writeLockVariants' in lock, false, 'the retired variant writer is still exported');
  assert.equal('simulateSchedule' in retry, false, 'the test-only scheduler is still exported');
  assert.equal('jobState' in observe, false, 'the observation helper is still exported instead of private');
});

/** Every named binding `text` exports, in declaration or list position. */
function exportedNames(text) {
  const body = withoutComments(text);
  const names = new Set();
  for (const m of body.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of body.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of body.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      // `local as exported` exports the right-hand name.
      names.add(token.split(/\s+as\s+/).pop().trim());
    }
  }
  return names;
}

test('the retired bindings are not exported by any file the package ships', async () => {
  // The namespace test imports three modules from the checkout; this asks the same
  // question of the set npm packs, because a channel can ship a file the checkout no
  // longer reads: `files` names directories, so a resurrected variant writer under
  // src/ ships with nothing in the checkout importing it. The set is expanded the way
  // scripts/build-sea.mjs and scripts/verify-wheel.mjs expand it — directories
  // recursively, plus package.json — so one assertion covers the tarball, the wheel
  // (asserted byte-identical to it) and the SEA payload. The last dist/ binary was
  // built from a pre-PR32 tree and carried all three as exports: nothing asserted
  // their absence from the payload until this test.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const shipped = ['package.json'];
  for (const entry of pkg.files) {
    const abs = join(ROOT, entry);
    if ((await stat(abs).catch(() => null))?.isDirectory()) {
      const stack = [abs];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) stack.push(p);
          else if (/\.(mjs|cjs|js)$/.test(entry.name)) shipped.push(p.slice(ROOT.length + 1));
        }
      }
    } else if (/\.(mjs|cjs|js)$/.test(entry)) shipped.push(entry);
  }
  // The three modules that used to export the names must be in the set: if `files`
  // stops naming src/, the assertion below passes vacuously, which is the drift this
  // test exists to catch.
  for (const mod of ['src/projection/lock.mjs', 'src/actions/retry.mjs', 'src/actions/observe.mjs']) {
    assert.ok(shipped.includes(mod), `the shipped set no longer names ${mod}`);
  }
  const retired = ['writeLockVariants', 'simulateSchedule', 'jobState'];
  const leaked = [];
  for (const rel of shipped) {
    const names = exportedNames(await readFile(join(ROOT, rel), 'utf8'));
    for (const name of retired) if (names.has(name)) leaked.push(`${rel} exports ${name}`);
  }
  assert.deepEqual(leaked, [], `a retired binding is exported by a shipped file:\n  ${leaked.join('\n  ')}`);
});

test('every __internals seam is actually imported', async () => {
  // The four modules that offer one used to be indistinguishable by name, so "no dead
  // export" could not be checked for any of them without this list — and two of the four
  // (`hooks/gates.mjs`, `hooks/dispatcher.mjs`) turned out to have no importer at all.
  // `hooks/resolve.mjs` had a third. If this test names a module that no longer offers a
  // seam it fails, which is the point: a seam removed by accident is a real regression,
  // not tidiness.
  //
  // Matching the import *from this module* is the whole test. A first cut only asked
  // whether the word `__internals` appeared anywhere else, which passed for all four:
  // three other files import their own seam, so the word is always present. The mutant
  // that put a seam back in `hooks/gates.mjs` sailed through it.
  const [srcFiles, testFiles] = await Promise.all([walkSources(), walk(join(ROOT, 'test'))]);
  const corpus = [];
  for (const file of [...srcFiles, ...testFiles]) {
    corpus.push([file, await readFile(file, 'utf8')]);
  }

  const offered = [];
  const dead = [];
  for (const file of srcFiles) {
    const text = await readFile(file, 'utf8');
    if (!/^export const __internals/m.test(text)) continue;
    offered.push(file);

    const rel = file.replace(`${ROOT}/src/`, '');
    const base = rel.split('/').pop();
    const importer = new RegExp(
      `import\\s*\\{[^}]*\\b__internals\\b[^}]*\\}\\s*from\\s*'[^']*${base.replace('.', '\\.')}'`,
    );
    const callers = corpus.filter(([other, otherText]) => other !== file && importer.test(otherText));
    if (callers.length === 0) dead.push(rel);
  }

  assert.ok(offered.length > 0, 'no module offers a seam, so this test is asserting nothing');
  assert.deepEqual(dead, [], `a __internals seam nobody imports:\n  ${dead.join('\n  ')}`);
});
