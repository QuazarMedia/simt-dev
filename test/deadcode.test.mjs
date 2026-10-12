import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

/**
 * Every `export`ed binding in `src/`, with its defining file.
 *
 * Includes `export { x }` and `export { x as y }`, because a re-export is just as
 * dead as an unexported function when nothing imports it — and more confusingly so,
 * because it reads as a published surface.
 */
async function exportedBindings(files) {
  const found = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      found.push({ name: m[1], file });
    }
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) found.push({ name, file });
      }
    }
  }
  return found;
}

/**
 * Occurrences of `name` outside its own file.
 *
 * Deliberately counting whole files rather than import statements. A dead export can
 * still be reachable — through a template, a spread, or a name a caller builds at
 * runtime — and a name this tool only ever passes to its own importer is what we are
 * trying to find. What this cannot see is an occurrence in a file the walk missed, so
 * the walk covers `src`, `test` and `bin` and nothing else; a binding reachable only
 * from a script outside the checkout is not a thing this package ships.
 */
async function usesOutside(name, file, corpus) {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
  const hits = [];
  for (const [other, text] of corpus) {
    if (other === file) continue;
    const count = [...text.matchAll(pattern)].length;
    if (count > 0) hits.push({ file: other, count });
  }
  return hits;
}

test('no exported binding in src/ has no caller', async () => {
  const [srcFiles, testFiles] = await Promise.all([walk(join(ROOT, 'src')), walk(join(ROOT, 'test'))]);
  const binFiles = (await readdir(join(ROOT, 'bin')))
    .filter((n) => n.endsWith('.mjs'))
    .map((n) => join(ROOT, 'bin', n));

  const corpus = [];
  for (const file of [...srcFiles, ...testFiles, ...binFiles]) {
    corpus.push([file, await readFile(file, 'utf8')]);
  }

  const dead = [];
  for (const { name, file } of await exportedBindings(srcFiles)) {
    // `__internals` is a testing seam, and every module that offers one spells it the
    // same way, so it cannot be counted by name: it is four different seams with one
    // name. Each is still required to have a caller; they are listed here because the
    // check below would otherwise pass a seam nobody imports.
    const hits = await usesOutside(name, file, corpus);
    if (hits.length === 0) dead.push(`${name} in ${file.replace(`${ROOT}/`, '')}`);
  }

  assert.deepEqual(
    dead,
    [],
    `exported but never imported. An export is a promise to a caller, and this package has no other callers:\n  ${dead.join('\n  ')}`,
  );
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
  const [srcFiles, testFiles] = await Promise.all([walk(join(ROOT, 'src')), walk(join(ROOT, 'test'))]);
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
    const base = basename(rel);
    const importer = new RegExp(
      `import\\s*\\{[^}]*\\b__internals\\b[^}]*\\}\\s*from\\s*'[^']*${base.replace('.', '\\.')}'`,
    );
    const callers = corpus.filter(([other, otherText]) => other !== file && importer.test(otherText));
    if (callers.length === 0) dead.push(rel);
  }

  assert.ok(offered.length > 0, 'no module offers a seam, so this test is asserting nothing');
  assert.deepEqual(dead, [], `a __internals seam nobody imports:\n  ${dead.join('\n  ')}`);
});

test('every declared-but-unimplemented command step is a real number', async () => {
  // `STEPS` is the registry that makes `simt-dev <cmd>` exit UNSUPPORTED rather than
  // silently succeed with empty output. It is empty today, which is correct — every
  // command in the plan shipped. It is checked rather than deleted because a command
  // declared without an implementation is the failure it exists to prevent, and the
  // remedy it prints ("implementation step N is not built yet") is only actionable if N
  // is a step a reader can look up.
  const text = await readFile(join(ROOT, 'src/commands/index.mjs'), 'utf8');
  const declared = /const STEPS = new Map\(\[([^\]]*)\]\)/.exec(text);
  assert.ok(declared, 'the STEPS registry is gone; a command declared without an implementation would then succeed silently');

  for (const entry of declared[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.match(entry, /^['"][a-z ]+['"]\s*:\s*\d+$/, `STEPS entry \`${entry}\` is not "command path": number`);
  }
});