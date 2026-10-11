// Three release channels, one set of bytes: the invariants that keep them honest.
//
// simt-dev ships to npm, to PyPI and to Homebrew, and each channel is a
// different artefact - a tarball, a wheel, and a formula that downloads the
// tarball. The thing they all have in common is the ~1.3 MB of `.mjs` files
// under `bin/` and `src/`, and the whole risk in this arrangement is that the
// three stop carrying the same ones.
//
// So most of what follows compares two files and asserts they agree. That is
// deliberate: every invariant here is a *static* one, checkable from this
// checkout with no network and no interpreter install, because a test that
// needed `pip` would not run for the next person who clones this repository
// (and would run differently on the machine that wrote it, which is the exact
// failure ADR-031 is about).
//
// The one check that cannot be static - the wheel's bytes against the
// tarball's, file by file and hash by hash - is `scripts/verify-wheel.mjs`. It
// runs in the release workflow, where a Python and a registry are available by
// construction, rather than in here where they are not.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pyproject = await readFile(new URL('../pyproject.toml', import.meta.url), 'utf8');
const formula = await readFile(new URL('../Formula/simt-dev.rb', import.meta.url), 'utf8');

/** The `force-include` table, as the list of source paths the wheel carries. */
function wheelSources() {
  return [...pyproject.matchAll(/^"([^"]+)" = "simt_dev\/vendored\//gm)].map((m) => m[1]);
}

test('packaging: the wheel carries the same paths the tarball carries', () => {
  // The one invariant the whole design rests on. `files` in package.json is
  // what npm puts in the tarball; `force-include` in pyproject.toml is what
  // the wheel carries. They are two lists in two files in two formats, and
  // nothing forces them to agree - so this does.
  const wheel = wheelSources();
  const tarball = pkg.files;

  // `package.json` is in the wheel and not in `files`, because npm puts it
  // there whether or not it is listed. Stated rather than filtered, so a future
  // addition to `files` fails here instead of being quietly missing.
  assert.deepEqual(
    wheel.filter((p) => p !== 'package.json'),
    tarball,
    'force-include and files name different paths; the two channels would ship different code',
  );

  assert.ok(wheel.includes('package.json'), 'the wheel must carry package.json - the tool reads its own engines.node');
});

test('packaging: the version is read, not written twice', () => {
  // The version is npm's and Python's at once. A second literal would drift,
  // and the drift would be invisible until somebody ran `pip show` next to
  // `simt --version` and got two answers.
  assert.match(pyproject, /^dynamic = \["version"\]$/m, 'pyproject.toml must declare version dynamic');

  const section = pyproject.slice(pyproject.indexOf('[project]'));
  assert.ok(
    !/^version = /m.test(section),
    'pyproject.toml has a literal [project].version, which can disagree with package.json',
  );
});

test('packaging: the version pattern reads package.json, not a guess', () => {
  // hatchling's `path` + `pattern` is a regex over a file. If it pointed at the
  // wrong file the build would fail loudly; if it pointed at the right file
  // with a pattern that never matched, it would fail with a message about
  // `__version__` and send the reader looking in the wrong place.
  assert.match(pyproject, /\[tool\.hatch\.version\]\npath = "package\.json"\npattern = /);
});

test('packaging: the console script is the command npm installs', () => {
  // One command name across both channels. `bin` in package.json and
  // `[project.scripts]` in pyproject.toml are the two places a command name is
  // invented, and a reader who learns the word from one channel has to be able
  // to type it in the other.
  const npmBin = Object.keys(pkg.bin);
  const pythonScripts = [...pyproject.matchAll(/^(\w[\w-]*) = "simt_dev\.cli:main"$/gm)].map((m) => m[1]);
  assert.deepEqual(pythonScripts, npmBin, 'the command name differs between npm and PyPI');
  assert.deepEqual(npmBin, ['simt'], 'npm should install exactly one command');
});

test('packaging: the launcher imports nothing outside the standard library', async () => {
  // The `[node]` extra is optional and is imported inside a `try`, so it must
  // not appear at module level - and a module-level one would make the default
  // install fail on a package it never asked for.
  const entry = /^simt = "([\w.]+):main"$/m.exec(pyproject);
  assert.ok(entry, '[project.scripts] must name the launcher');

  const source = await readFile(new URL(`../python/${entry[1].replaceAll('.', '/')}.py`, import.meta.url), 'utf8');
  assert.match(source, /^def main\(/m, `${entry[1]} must define main()`);

  const allowed = new Set(['os', 'shutil', 'sys', 'json', 'nodejs_wheel']);
  const found = [...source.matchAll(/^import (\w+)|^from (\w+) import /gm)].map((m) => m[1] ?? m[2]);
  const surprising = found.filter((name) => !allowed.has(name));
  assert.deepEqual(surprising, [], `the launcher imports a third-party module: ${surprising.join(', ')}`);
});

test('packaging: no second build system sits at the repository root', () => {
  // `pyproject.toml` is a distribution file. A `setup.py` or a
  // `requirements.txt` beside it would make this look like a python project
  // that also ships node, and `simt init` would project python rules into
  // repositories that have no python in them - which is the detection-driven
  // ruling in ADR-013 refusing to do on its own.
  for (const name of ['setup.py', 'setup.cfg', 'requirements.txt']) {
    assert.ok(!existsSync(new URL(`../${name}`, import.meta.url)), `${name} exists; the python distribution is pyproject.toml and nothing else`);
  }
});

test('packaging: the formula points at the npm tarball and checksums it', () => {
  // Homebrew downloads what npm published. If the formula ever pointed at the
  // repository source instead, `brew install` would gain a build step this
  // package does not have, and a node build-time dependency, to install a
  // program the source runs without either.
  assert.match(formula, /^  url "https:\/\/registry\.npmjs\.org\/simt-dev\/-\/simt-dev-[\d.]+\.tgz"$/m);
  assert.match(formula, /^  sha256 "[0-9a-f]{64}"$/m, 'Homebrew refuses a formula with no checksum');

  // The class name must lowercase-and-dash to the filename. Brew rejects a
  // formula that does not, and the rejection names neither the file nor the class.
  const className = /^class (\w+) < Formula$/m.exec(formula)?.[1];
  assert.ok(className, 'the formula must declare a class');
  const snake = className.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  assert.equal(snake, 'simt-dev', `${className} does not match Formula/simt-dev.rb`);
});

test('packaging: the formula declares the runtime it needs', () => {
  // Without this the formula installs a program that cannot run, and the
  // failure arrives as `node: command not found` from a depth that has nothing
  // to do with anything the reader can fix.
  assert.match(formula, /^  depends_on "node"$/m, 'the formula must declare its node dependency');
});

test('packaging: the formula does not use std_npm_args', () => {
  // That helper invokes npm at build time, which needs the registry at build
  // time. This package has zero dependencies and no build step, so it would add
  // a network fetch to installing the one thing here that provably needs none.
  //
  // Matched against the formula with its comments removed, because the comment
  // that explains why the helper is NOT used names the helper - and a test that
  // reads the comment has just made the explanation un-writable.
  const code = formula
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(!/std_npm_args/.test(code), 'the formula must not build with npm at install time');
});

test("packaging: the formula's version is a real release, not a placeholder", () => {
  // The committed formula is the last release. A `1.0.0` placeholder would
  // install a version that does not exist, with a checksum matching nothing,
  // and would do it silently until somebody tried to install it.
  const version = /simt-dev-([\d.]+)\.tgz/.exec(formula)?.[1];
  assert.ok(version, 'the formula names no version');
  assert.match(version, /^\d+\.\d+\.\d+$/, `formula version is not x.y.z: ${version}`);
  assert.ok(!['0.0.0', '1.0.0'].includes(version), `formula version looks like a stub: ${version}`);
});

test('packaging: the sdist carries what the wheel build needs', () => {
  // A wheel built from the sdist must be able to find every `force-include`
  // source. Without the explicit list, hatchling's sdist would include some of
  // the tree and not the rest, and building from it would produce a wheel
  // missing the tool - which installs cleanly and then fails on every command.
  const listed = [...pyproject.matchAll(/^\s*"(\/[^"]+)",?$/gm)].map((m) => m[1]);
  for (const source of wheelSources()) {
    assert.ok(
      listed.includes(`/${source}`),
      `${source} is in the wheel but not in the sdist; a build from the sdist would omit it`,
    );
  }
  assert.ok(listed.includes('/package.json'), 'the sdist must carry package.json for the version to be read');
});

test('packaging: the release script patches only the two lines it must', () => {
  // A line-number-based patch would make the script something that cannot be
  // edited: inserting a comment above the `sha256` line would silently write
  // the checksum to the wrong place. The patterns below are anchored on
  // content, and this asserts they still match the committed file.
  const url = /^  url "https:\/\/registry\.npmjs\.org\/simt-dev\/-\/simt-dev-[\d.]+\.tgz"$/m;
  const sum = /^  sha256 "[0-9a-f]{64}"$/m;
  assert.match(formula, url, 'the release script\'s url anchor no longer matches the formula');
  assert.match(formula, sum, 'the release script\'s sha256 anchor no longer matches the formula');
});

test('packaging: nothing in python/ is shipped to npm', async () => {
  // The two distributions are separate. `python/` is the wheel's launcher and
  // the tarball has nothing to do with it; shipping it would give npm users a
  // Python file that is never run, and give every channel a second thing to
  // keep current.
  const files = await readdir(new URL('../python/simt_dev/', import.meta.url));
  assert.ok(files.includes('cli.py'), 'the launcher has moved; the packaging test needs updating');
  assert.ok(!pkg.files.includes('python'), 'python/ must not be in the npm tarball');
});
