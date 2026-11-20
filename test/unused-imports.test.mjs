// The import-side twin of test/deadcode.test.mjs: an import nobody reads is
// drift, and the guard that catches it is scripts/unused-imports.mjs, a
// zero-install detector. This test holds that guard in two directions — the
// checkout must come back clean, and the detector must still be able to flag a
// dead import — so a change that makes it go quiet (or loud) is caught here
// rather than discovered on a reader's machine.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'unused-imports.mjs');

test('the tree ships no unused imports', async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT], { cwd: ROOT });
  assert.match(stdout, /clean: \d+ files?, no unused imports/);
});

test('an import nobody reads is named, and a read one is not', async () => {
  // One file with a dead import and one that uses its import, checked through
  // the same detector the tree check uses. The dead one must exit non-zero and
  // be named; the live one must come back clean.
  const dir = await mkdtemp(join(tmpdir(), 'unused-imports-'));
  try {
    const dirty = join(dir, 'dirty.mjs');
    await writeFile(dirty, "import { readFile } from 'node:fs/promises';\nexport const x = 1;\n");
    const dirtyResult = await exec(process.execPath, [SCRIPT, dirty]).catch((e) => e);
    assert.equal(dirtyResult.code, 1, 'a dead import must exit non-zero');
    assert.match(dirtyResult.stdout, /dirty\.mjs: readFile/);

    const clean = join(dir, 'clean.mjs');
    await writeFile(clean, "import { readFile } from 'node:fs/promises';\nexport async function read(p) { return readFile(p, 'utf8'); }\n");
    const cleanResult = await exec(process.execPath, [SCRIPT, clean]);
    assert.match(cleanResult.stdout, /clean: 1 file, no unused imports/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
