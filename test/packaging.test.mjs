// Three release channels, one set of bytes: the invariants that keep them honest.
//
// simt-dev ships to npm, to PyPI and to Homebrew, and each channel is a
// different artefact - a tarball, a wheel, and a formula that downloads the
// single-file release binary. The thing they all have in common is the ~1.3 MB
// of `.mjs` files under `bin/` and `src/`, and the whole risk in this
// arrangement is that the three stop carrying the same ones.
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

import { TARGETS } from '../src/distribute/release.mjs';
import { CHANNELS, GIT_FLOOR, PYTHON_FLOOR, SUPPORT_DOC, SUPPORTED_OS, supportRows } from '../src/distribute/support.mjs';
import { MIN_NODE } from '../src/node-version.mjs';

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

test('packaging: the published support table is the support matrix', async () => {
  // Four channels used to describe their own prerequisites in four paragraphs, one of
  // which promised a binary for a platform the release does not build. The table is
  // data now; this is the test that makes the page a publication of it rather than a
  // fifth copy (ADR-206).
  const doc = await readFile(new URL(`../${SUPPORT_DOC}`, import.meta.url), 'utf8');
  const rows = [...doc.matchAll(/^\| (npm|PyPI|Homebrew|release binary) \| (.+) \|$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows.map(([channel]) => channel), supportRows().map((row) => row.channel));

  for (const row of CHANNELS) {
    // Backticks are markdown, not content: the row is read as the reader sees it.
    const line = rows.find(([channel]) => channel === row.channel)?.[1]?.replaceAll('`', '');
    assert.ok(line, `no support row for ${row.channel}`);
    for (const cell of [row.install, row.needs, row.platforms, row.fallback]) {
      assert.ok(line.includes(cell), `${row.channel} row does not state: ${cell}`);
    }
  }

  // The floors and the platforms are the module's, not numbers typed into prose.
  assert.ok(doc.includes(`Node >= ${MIN_NODE}`), 'the page does not state the node floor');
  assert.ok(doc.includes(`Python ${PYTHON_FLOOR}`), 'the page does not state the python floor');
  assert.ok(doc.includes(`Git ${GIT_FLOOR}`), 'the page does not state the git floor');
  for (const target of TARGETS) assert.ok(doc.includes(target), `the page does not name ${target}`);
  assert.match(doc, /Linux arm64 is not published today/, 'the deferred target must be stated, not omitted');

  // The channel prerequisites are also the package metadata a registry shows.
  assert.deepEqual(pkg.os, SUPPORTED_OS, 'package.json os and the support matrix disagree');
  assert.match(pyproject, new RegExp(`^requires-python = ">=${PYTHON_FLOOR.replace('.', '\\.')}"$`, 'm'));
  for (const os of SUPPORTED_OS) {
    const classifier = os === 'darwin' ? 'Operating System :: MacOS' : 'Operating System :: POSIX :: Linux';
    assert.ok(pyproject.includes(classifier), `pyproject.toml does not classify ${os}`);
  }

  // The two pages a reader lands on name the matrix rather than restating a subset.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(SUPPORT_DOC), 'the README does not link the support matrix');
  const start = await readFile(new URL('../docs/getting-started.md', import.meta.url), 'utf8');
  assert.ok(start.includes('reference/support.md'), 'the installation guide does not link the support matrix');
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

  // `subprocess` is the Q54 version query (`subprocess.run` before the execv);
  // it is stdlib, and the spawn path itself remains `os.execv`, so the import
  // does not change what the launcher is.
  const allowed = new Set(['os', 'shutil', 'sys', 'json', 'subprocess', 'nodejs_wheel']);
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

test('packaging: the formula points at the release binaries and checksums them', () => {
  // Homebrew downloads what GitHub Releases serves. If the formula ever pointed
  // at the repository source instead, `brew install` would gain a build step
  // this package does not have, to install a program that ships prebuilt.
  for (const target of TARGETS) {
    const url = new RegExp(
      `^    url "https://github\\.com/QuazarMedia/simt-dev/releases/download/v[0-9][^"]*-${target}"$`,
      'm',
    );
    assert.match(formula, url, `no url line for ${target}`);
  }
  const sums = [...formula.matchAll(/^    sha256 "[0-9a-f]{64}"$/gm)];
  assert.equal(sums.length, TARGETS.length, 'Homebrew refuses a formula with no checksum; one per target is expected');

  // The class name must lowercase-and-dash to the filename. Brew rejects a
  // formula that does not, and the rejection names neither the file nor the class.
  const className = /^class (\w+) < Formula$/m.exec(formula)?.[1];
  assert.ok(className, 'the formula must declare a class');
  const snake = className.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  assert.equal(snake, 'simt-dev', `${className} does not match Formula/simt-dev.rb`);
});

test('packaging: the formula declares no runtime dependency', () => {
  // The binary carries its own pinned Node runtime. A `depends_on "node"` would
  // make brew install a toolchain the binary does not use, and would fail on a
  // machine where brew's node is newer or older than the one the binary pins.
  const code = formula
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(!/depends_on/.test(code), 'the formula must not declare a dependency');
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
  const version = /simt-dev-(\d+\.\d+\.\d+)-darwin-arm64/.exec(formula)?.[1];
  assert.ok(version, 'the formula names no version');
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

test('packaging: the formula description passes the tap\u2019s lint', () => {
  // `brew style` failed the v0.6.0 channels run on `FormulaAudit/Desc`:
  // a description starting with an article. The tap is pushed by automation
  // after a human approved the release, so a lint failure there fails late and
  // loudly — this asserts the rule (`brew style` runs the same RuboCop engine)
  // where a red gate is cheap.
  const desc = /^  desc "([^"]+)"$/m.exec(formula)?.[1];
  assert.ok(desc, 'Formula/simt-dev.rb has no desc line for the lint to read');
  assert.ok(!/^(a|an|the)\s/i.test(desc), `the formula description starts with an article: ${desc}`);
});

test('packaging: the release script patches only the lines it must', () => {
  // A line-number-based patch would make the script something that cannot be
  // edited: inserting a comment above a `sha256` line would silently write the
  // checksum to the wrong place. The patterns below are anchored on content,
  // and this asserts they still match the committed file - one url/sha256 pair
  // per target, exactly as scripts/release-formula.mjs patches them.
  for (const target of TARGETS) {
    const pair = new RegExp(
      `^    url "https://github\\.com/QuazarMedia/simt-dev/releases/download/v[0-9][^"]*-${target}"\n    sha256 "[0-9a-f]{64}"$`,
      'm',
    );
    assert.match(formula, pair, `the release script's ${target} anchor no longer matches the formula`);
  }
});

test('packaging: the brew channel lands on the tap main and one tap name', async () => {
  // Review 0003 Q04: release branches that were never merged left `brew install`
  // serving 0.4.0 while the workflow reported success. The workflow must push to
  // the tap `main` and then verify the tap serves the released version, and the
  // tap name must be the same in the workflow default, the formula comment and
  // the README install line.
  const channels = await readFile(new URL('../.github/workflows/publish-channels.yml', import.meta.url), 'utf8');
  assert.match(channels, /git push --quiet origin main/, 'the brew job must push to the tap main, not a release branch');
  assert.ok(!/release\/simt-dev-/.test(channels), 'no release-branch push may remain in the channels workflow');
  assert.match(channels, /verify-brew:/, 'the channels workflow needs a tap-verification job');
  assert.match(channels, /does not name simt-dev-/, 'the verification must fail when the tap lags the release');
  assert.match(channels, /QuazarMedia\/homebrew-tap/, 'the workflow tap default is QuazarMedia/homebrew-tap');
  assert.match(formula, /brew install QuazarMedia\/homebrew-tap\/simt-dev/, 'the formula comment must name the same tap');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /brew install QuazarMedia\/homebrew-tap\/simt-dev/, 'the README install line must name the same tap');
});

test('packaging: the release builds, stages and verifies the optional bench (ADR-211)', async () => {
  // The core deliberately does not carry the bench, so the only thing that can
  // make `npm install simt-dev @simt-dev/bench` work is the release staging the
  // second package. These are the three points that have to stay connected:
  // build it at the released version, stage it as its own package, and install
  // the published pair to run a command through the core's dynamic import.
  const publish = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const built = publish.indexOf('node scripts/build-bench-package.mjs dist/bench');
  assert.ok(built !== -1, 'publish.yml does not build @simt-dev/bench');
  assert.ok(publish.includes('BENCH_SKIP'), 'publish.yml has no independent bench idempotency check');
  assert.match(publish, /npm view "\$\{bench_name\}@\$\{version\}"/, 'publish.yml does not check the bench registry version');
  assert.match(publish, /pkg\.version !== version/, 'publish.yml does not check the built bench version');
  const staged = publish.indexOf('working-directory: dist/bench');
  assert.ok(staged > built, 'publish.yml stages the bench before building it');
  assert.ok(publish.indexOf('npm stage publish', staged) > staged, 'publish.yml does not stage from dist/bench');

  const channels = await readFile(new URL('../.github/workflows/publish-channels.yml', import.meta.url), 'utf8');
  assert.match(channels, /^  verify-bench:/m, 'publish-channels.yml has no released-pair check');
  assert.match(
    channels,
    /npm install --prefix "\$prefix"[\s\S]*?"simt-dev@\$\{VERSION\}" "@simt-dev\/bench@\$\{VERSION\}"/,
    'the release check does not install both published packages',
  );
  assert.match(channels, /bench replay --input/, 'the release check does not run a bench command');
  assert.match(
    channels,
    /steps\.expected\.outputs\.run == 'true'/,
    'the bench check must skip tags whose publish workflow predates the bench release',
  );
});

test('packaging: the version is not a burned placeholder (Q06)', () => {
  // 1.0.0 and 0.0.0-stage on npm are pre-publish placeholders with no bin.
  // Publishing (or versioning into) either reuses a burned number; see RELEASING.md.
  assert.ok(!['1.0.0', '0.0.0-stage'].includes(pkg.version), `package.json version is a burned placeholder: ${pkg.version}`);
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

test('packaging: the channels resolve one release and serialise per destination (PR27)', async () => {
  // The defect: each channel expanded `latest` itself, so a release landing between
  // them split one run across versions, and `0.7.0` and `latest` named the same
  // artifact under two concurrency keys. One resolve job now answers once, each
  // destination queues on the RESOLVED version, and no channel reads npm itself.
  const channels = await readFile(new URL('../.github/workflows/publish-channels.yml', import.meta.url), 'utf8');
  assert.match(channels, /^  resolve:/m, 'there must be one resolution job');
  // A job output is `steps.<id>.outputs.<name>`: without the id the resolve job
  // succeeds and every channel receives the empty string (actionlint catches this,
  // and so does this line).
  assert.match(channels, /- id: d\n\s+name: resolve and validate the whole release/);
  assert.match(channels, /descriptor: \$\{\{ steps\.d\.outputs\.descriptor \}\}/);
  assert.ok(!/npm view simt-dev version/.test(channels), 'a channel still resolved `latest` on its own');
  assert.match(channels, /group: publish-pypi-\$\{\{ needs\.resolve\.outputs\.version \}\}/);
  assert.match(channels, /group: publish-brew-\$\{\{ needs\.resolve\.outputs\.version \}\}/);
  assert.equal(
    (channels.match(/--recheck=release\/descriptor\.json/g) ?? []).length,
    2,
    'each channel must verify the descriptor before promoting',
  );
  assert.match(channels, /release-formula\.mjs --descriptor=release\/descriptor\.json/);
  assert.match(channels, /formulaChecksums/, 'the tap verification must compare hashes, not just the version');
});

test('packaging: the dispatch value never reaches a shell through interpolation (PR27)', async () => {
  // `${{ inputs.version }}` inside a `run:` block is text from a form reaching shell
  // before anything validated it. It is passed as an environment variable exactly
  // once, to the script whose first act is to refuse anything but a concrete x.y.z.
  const channels = await readFile(new URL('../.github/workflows/publish-channels.yml', import.meta.url), 'utf8');
  // Comments may quote the expression - the explanation of why it is not interpolated
  // names it - so only live lines count.
  const uses = channels
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && line.includes('${{ inputs.version }}'))
    .map((line) => line.trim());
  assert.deepEqual(uses, ['INPUT_VERSION: ${{ inputs.version }}']);
});

test('packaging: brew style lints the formula this release rendered (A32)', async () => {
  const channels = await readFile(new URL('../.github/workflows/publish-channels.yml', import.meta.url), 'utf8');
  const rendered = channels.indexOf('scripts/release-formula.mjs');
  const styled = channels.indexOf('brew style Formula/simt-dev.rb');
  assert.ok(rendered !== -1, 'the formula render step is missing');
  assert.ok(styled !== -1, 'the brew style step is missing');
  assert.ok(styled > rendered, 'brew style must run after the formula is rendered for this release');
});
