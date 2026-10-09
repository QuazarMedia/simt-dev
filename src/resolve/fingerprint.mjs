// Classify a repo from what is actually in the working tree.
//
// This is the fallback that makes a new repo classifiable with no configuration:
// detection gets you most of the way, and simt-dev.json exists to make the
// remainder explicit and reviewable (ADR: 0002 section 4.1).
//
// Two kinds of signal come out, and the distinction is load-bearing
// (ADR-013). `stack` names a platform, and is keyed by curated product and
// library names - precise, and dead the day the library is swapped. `facts`
// name an observable property of the tree (`has-cargo-toml`), are derived from
// evidence rather than from a taxonomy, and therefore need no table growth when
// a new ecosystem arrives: the fact was already being observed. A profile may
// select on either, so supporting an unknown ecosystem is a profile file and
// not a code change.
//
// POSIX only (ADR-012). Marker paths are normalised to forward slashes anyway,
// because a marker set written by hand in the registry must match what readdir
// returns on any host.

import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { matchesGlob } from './resolve.mjs';

/** tag -> human-readable marker(s) that imply it. First match wins per tag. */
const MARKERS = [
  ['connectiq', ['monkey.jungle', 'manifest.xml']],
  // `wrangler.json` was missing here, so a Worker configured with the plain JSON
  // config and no `wrangler` dependency had no evidence of Workers at all - the
  // profile stopped applying to it (S28).
  ['cloudflare-workers', ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py']],
  ['gradle', ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts']],
  ['node-web', ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']],
  ['node', ['package.json']],
  ['less', ['styles.less']],
];

/**
 * Extensions are weaker evidence than marker files: a stray script must not
 * define a repo's stack. `python` is deliberately absent here because
 * simt-app carries .py tooling scripts inside a Gradle project - a marker file
 * is required for that tag. `kotlin` has no marker file, so it stays here.
 */
const EXTENSION_TAGS = new Map([
  ['.mc', 'connectiq'],
  ['.kt', 'kotlin'],
  ['.kts', 'gradle'],
  ['.java', 'java'],
  ['.ts', 'typescript'],
  ['.tsx', 'react'],
  ['.less', 'less'],
]);

const DEP_TAGS = new Map([
  ['react', 'react'],
  // `react-dom` is the renderer, so its presence is what says "a browser". Mapping it
  // onto `react` was what let a React Native app and a React web app arrive with the
  // same tag and receive the same profile (S28).
  ['react-dom', 'react-dom'],
  ['react-native', 'react-native'],
  ['expo', 'react-native'],
  ['@react-router/dev', 'react-router'],
  ['firebase', 'firebase'],
  ['firebase-admin', 'firebase'],
  ['maplibre-gl', 'maplibre'],
  // `hono` stays a tag: it is the discriminator between the API and the web half of a
  // deployment, and nine registry skills name it. It stopped being *evidence of
  // Workers* - that was a profile's choice, not the detector's (S28, ADR-013 r1).
  ['hono', 'hono'],
  ['wrangler', 'cloudflare-workers'],
  ['typescript', 'typescript'],
  ['less', 'less'],
  ['vitest', 'vitest'],
  ['playwright', 'playwright'],
]);

/**
 * How many directory levels below the root a `glob` fact may look, counted in
 * directories descended.
 *
 * Three, and the reason is a convention rather than a preference: the Android Gradle
 * Plugin puts a module's manifest at `<module>/src/main/AndroidManifest.xml`, and
 * simt-app's sits at `app/src/main/AndroidManifest.xml`. A bound shallower than the
 * convention makes `has-android-manifest` the shape S07 found - a fact no repository
 * could ever have. Deeper would be a scan rather than a probe, and ADR-013's promise
 * is that adding an ecosystem is data, so a fact must not cost a search.
 *
 * The extension sample below reads tracked paths rather than a bounded number of
 * directory levels, because depth was never the question. It asks "is this repo written
 * in Kotlin", and a language's sources sit where its build system puts them —
 * `app/src/main/kotlin/…` is already past two levels — so a walk bounded to two levels
 * never reached a standard source set. The bound that replaced it is a count of paths,
 * not a depth, and it is stated where it is enforced. A `glob` fact is different: it
 * asserts that a specific path exists, and a fact that cannot see the path is wrong
 * when the path is there.
 */
const GLOB_DEPTH = 3;

/**
 * Observable properties of the working tree, named `has-*`.
 *
 * Every entry is either a path that exists or a predicate over package.json, so
 * adding an ecosystem means writing a profile against facts that are already
 * emitted - not editing this table. Keep entries boring and opinion-free: a
 * manifest, a lockfile, a directory convention. If an entry starts encoding "and
 * therefore it is a Django project", it belongs in a profile instead.
 *
 * kind 'file' and 'dir' probe the repository root; 'path' stats one nested file
 * (including under a dot directory a glob walk skips); 'pkg' reads the parsed
 * manifest; `glob` walks at most `GLOB_DEPTH` directory levels looking for a shape.
 * `paths` is alternatives - first match wins and is reported as evidence, so `doctor`
 * can say which file proved the fact.
 *
 * A candidate is probed by its declared kind, so a `dir` may name a nested path.
 * A `file` candidate is matched against the root listing, which cannot see past
 * the root, so it must not contain a `/` - `test/genericity.test.mjs` fails if one
 * does, rather than letting it sit there never matching. A `dir` candidate that
 * was probed with `isFile` instead (S07) looked like a fact nobody's repo could
 * have: seven estate repositories have `.github/workflows/` and none of them
 * emitted `has-ci-workflows`.
 *
 * A `glob` candidate is the third kind, for the paths neither of the others can
 * reach: it names a shape at an unknown depth, so it must contain a star-star and
 * `test/genericity.test.mjs` fails if it does not. Evidence for a `glob` is the
 * file that matched, never the pattern - `doctor` answers "why did you think
 * that?", and a shape is not an answer.
 */
const FACTS = [
  { name: 'has-pyproject', kind: 'file', paths: ['pyproject.toml'] },
  { name: 'has-requirements', kind: 'file', paths: ['requirements.txt'] },
  { name: 'has-go-mod', kind: 'file', paths: ['go.mod'] },
  { name: 'has-cargo-toml', kind: 'file', paths: ['Cargo.toml'] },
  { name: 'has-gemfile', kind: 'file', paths: ['Gemfile'] },
  { name: 'has-composer', kind: 'file', paths: ['composer.json'] },
  { name: 'has-maven-pom', kind: 'file', paths: ['pom.xml'] },
  { name: 'has-build-system', kind: 'file', paths: ['Makefile', 'makefile', 'CMakeLists.txt', 'meson.build'] },
  { name: 'has-dockerfile', kind: 'file', paths: ['Dockerfile', 'Containerfile'] },
  {
    name: 'has-compose',
    kind: 'file',
    paths: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
  },
  { name: 'has-terraform', kind: 'file', paths: ['main.tf', 'versions.tf'] },
  { name: 'has-migrations-dir', kind: 'dir', paths: ['migrations', 'migrate', 'db/migrate'] },
  { name: 'has-schema-dir', kind: 'dir', paths: ['schema', 'schemas', 'db/schema'] },
  { name: 'has-tests-dir', kind: 'dir', paths: ['test', 'tests', '__tests__', 'spec', 'e2e'] },
  { name: 'has-decisions-dir', kind: 'dir', paths: ['docs/decisions', 'docs/adr', 'docs/adrs', 'adr'] },
  { name: 'has-ci-workflows', kind: 'dir', paths: ['.github/workflows', '.gitlab-ci.d'] },
  {
    name: 'has-lockfile',
    kind: 'file',
    paths: [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'uv.lock',
      'poetry.lock',
      'Cargo.lock',
      'go.sum',
      'Gemfile.lock',
    ],
  },
  { name: 'has-license', kind: 'file', paths: ['LICENSE', 'LICENSE.md', 'LICENCE', 'COPYING'] },
  { name: 'has-readme', kind: 'file', paths: ['README.md', 'README.rst', 'README'] },
  { name: 'has-node-workspace', kind: 'file', paths: ['pnpm-workspace.yaml'] },
  // The two facts below are what S28's profile split needs, and both name a shape at
  // an unknown depth. `has-uv-lock` matches the root `uv.lock` too, because the
  // star-star stands for zero directories as well as many.
  { name: 'has-uv-lock', kind: 'glob', paths: ['**/uv.lock'] },
  { name: 'has-android-manifest', kind: 'glob', paths: ['**/src/main/AndroidManifest.xml'] },
  { name: 'has-submodules', kind: 'file', paths: ['.gitmodules'] },
  { name: 'has-nuget', kind: 'glob', paths: ['**/*.csproj', '**/*.sln'] },
  { name: 'has-pubspec', kind: 'file', paths: ['pubspec.yaml'] },
  { name: 'has-swift-package', kind: 'file', paths: ['Package.swift'] },
  { name: 'has-mix', kind: 'file', paths: ['mix.exs'] },
  { name: 'has-bun-lock', kind: 'file', paths: ['bun.lock', 'bun.lockb'] },
  // A glob walk skips dot directories, and `.devcontainer` is one. Stat the path.
  { name: 'has-devcontainer', kind: 'path', paths: ['.devcontainer/devcontainer.json'] },
];

/** Facts derived from the parsed manifest rather than from the file listing. */
const PKG_FACTS = [
  // A fact that merely restates an existing stack tag is a second name for one
  // observation, which is the kind of duplication the estate blocks in review.
  // `typescript` is already a stack tag from DEP_TAGS, so no `has-typescript`.
  { name: 'has-node-workspace', test: (pkg) => Boolean(pkg.workspaces) },
];

/**
 * @param {string} root absolute path to a repository root
 * @returns {Promise<{stack: string[], facts: string[], factEvidence: Record<string,string>,
 *   evidence: string[], manifest: object|null, error?: string}>}
 */
export async function fingerprint(root) {
  const stack = new Set();
  const facts = new Set();
  const factEvidence = {};
  const evidence = [];
  let entries = [];
  let pkg = null;

  try {
    entries = await readdir(root);
  } catch {
    return {
      stack: [],
      facts: [],
      signals: [],
      factEvidence: {},
      evidence: [],
      manifest: null,
      error: 'unreadable-root',
    };
  }
  const names = new Set(entries);

  for (const [tag, markers] of MARKERS) {
    const hit = markers.find((m) => names.has(m));
    if (hit) {
      stack.add(tag);
      evidence.push(hit);
    }
  }

  // Facts first, because two of them need the manifest and parsing it twice
  // would be wasteful. A fact is recorded only on positive evidence; an
  // unparseable manifest yields a fact's absence, not a wrong answer.
  for (const fact of FACTS) {
    for (const candidate of fact.paths) {
      if (fact.kind === 'path') {
        try {
          await stat(join(root, candidate));
        } catch {
          continue;
        }
        facts.add(fact.name);
        factEvidence[fact.name] ??= candidate;
        break;
      }
      if (fact.kind === 'glob') {
        const hit = (await findNested(root, candidate))[0];
        if (hit) {
          facts.add(fact.name);
          factEvidence[fact.name] ??= hit;
          break;
        }
        continue;
      }
      const present = fact.kind === 'file' ? names.has(candidate) : await isDir(join(root, candidate));
      if (present) {
        facts.add(fact.name);
        factEvidence[fact.name] ??= candidate;
        if (fact.name === 'has-node-workspace' && fact.kind === 'file') {
          evidence.push(candidate);
        }
        break;
      }
    }
  }

  // Extensions. The bound, and why it is a count of paths rather than a depth, is
  // on sampleExtensions.
  const sampled = await sampleExtensions(root);
  for (const ext of sampled) {
    const tag = EXTENSION_TAGS.get(ext);
    if (tag) {
      stack.add(tag);
      evidence.push(ext);
    }
  }

  // package.json dependencies are the highest-signal source for a JS/TS repo.
  if (names.has('package.json')) {
    try {
      pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      for (const field of ['dependencies', 'devDependencies']) {
        for (const dep of Object.keys(pkg[field] ?? {})) {
          const tag = DEP_TAGS.get(dep);
          if (tag) {
            stack.add(tag);
            evidence.push(dep);
          }
        }
      }
    } catch {
      evidence.push('package.json:unparseable');
      pkg = null;
    }
  }

  for (const fact of PKG_FACTS) {
    if (pkg && fact.test(pkg)) {
      facts.add(fact.name);
      factEvidence[fact.name] ??= 'package.json';
    }
  }

  // simt-app and wakt-app both carry a wear/ module; wakt-app is the wearable.
  if (names.has('wear') && (await isDir(join(root, 'wear')))) {
    stack.add('wear-os');
    evidence.push('wear/');
  }

  const manifest = names.has('simt-dev.json')
    ? await readManifest(join(root, 'simt-dev.json'))
    : null;

  const stackList = [...stack].sort();
  const factList = [...facts].sort();
  return {
    stack: stackList,
    facts: factList,
    // The union, pre-merged, because every consumer gates on "does this repo have
    // this signal" and neither cares which half of the vocabulary it came from
    // (ADR-013).
    signals: dedupe([...stackList, ...factList]).sort(),
    factEvidence,
    evidence: dedupe(evidence).sort(),
    manifest,
  };
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { error: 'simt-dev.json unparseable' };
  }
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The paths below `root` that match a shape, in sorted order, to `GLOB_DEPTH`.
 *
 * The matcher is the registry's, so a fact's shape and a skill's `path:` are one
 * language rather than two - and a shape nobody can express as a glob fails here
 * rather than being special-cased in the probe. Dot-directories and `node_modules`
 * are skipped for the reason the extension sample skips them: detection is not a
 * scan of vendored output.
 */
async function findNested(root, pattern) {
  const found = [];
  const walk = async (dir, prefix, depth) => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth < GLOB_DEPTH) await walk(join(dir, item.name), rel, depth + 1);
      } else if (matchesGlob(rel, pattern)) {
        found.push(rel);
      }
    }
  };
  await walk(root, '', 0);
  return found.sort();
}

/**
 * Which extensions this repository is written in.
 *
 * Read from `git ls-files` where there is a repository, and by a bounded walk where
 * there is not.
 *
 * The walk used to be two levels deep, on purpose, so a monorepo of thousands of files
 * would not turn detection into a scan. The bound was the wrong shape. A language's
 * sources sit where its build system puts them: `app/src/main/kotlin/a/b/C.kt` is six
 * directories down, and the package segment after the source set has no maximum. A
 * depth that reaches that file misses the same file one package deeper, which is why
 * a depth-4 fallback cannot be the bound — the acceptance fixture is already past it.
 * That is how a Gradle repository came to be tagged `gradle` and not `kotlin`: the
 * sample stopped before the source set.
 *
 * `git ls-files --cached` is the question the sample was asking. It is the index, so an
 * untracked file and a gitignored one are not evidence; it is every depth, because depth
 * was never what was being asked; and the listing is sorted, so the first SAMPLE_BOUND
 * paths are the same list on every machine. The process is stopped at that count.
 * Buffering the whole listing and then discarding the tail is not a bound — a repository
 * large enough to overflow the buffer would have been answered by the walk instead,
 * which sees the files the index was asked about in order to ignore.
 *
 * Outside a repository there is no index. The walk is bounded by the same count, visits
 * each directory's entries in sorted order, and skips the output directories a
 * `.gitignore` would have skipped, because those are other people's bytes. A count gives
 * up the tail of a tree past SAMPLE_BOUND files. A depth gives up the file the question
 * was about.
 */
const SAMPLE_BOUND = 5000;

/** Output directories. They are not an answer to "what is this written in". */
const VENDORED = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'vendor', 'coverage']);

async function sampleExtensions(root) {
  const fromGit = await extensionsFromGit(root);
  // An empty index is an answer: `[]` is not `null`. Falling through on an empty list
  // would count the untracked files the index was consulted in order to exclude.
  if (fromGit !== null) return fromGit;
  return extensionsByWalk(root);
}

/** The suffix that selects a language, or '' when the name has none. A leading dot is not one. */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Extensions of the first SAMPLE_BOUND tracked paths under `root`.
 * `null` when `root` is not a git work tree — the caller walks instead.
 * @returns {Promise<string[]|null>}
 */
function extensionsFromGit(root) {
  return new Promise((resolve) => {
    // `-- .` keeps a fingerprint of a subdirectory from inheriting the rest of the
    // repository. `--cached` so a file not yet added is not evidence.
    const child = spawn('git', ['ls-files', '--cached', '-z', '--', '.'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = new Set();
    let seen = 0;
    let buf = Buffer.alloc(0);
    let settled = false;
    let failed = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // True once the bound is reached, having not recorded the path that crossed it.
    const consume = (path) => {
      if (path === '') return false;
      seen += 1;
      if (seen > SAMPLE_BOUND) return true;
      const ext = extensionOf(path.slice(path.lastIndexOf('/') + 1));
      if (ext) found.add(ext);
      return false;
    };
    child.on('error', () => {
      failed = true;
      finish(null);
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      let nul;
      while ((nul = buf.indexOf(0)) !== -1) {
        const path = buf.subarray(0, nul).toString('utf8');
        buf = buf.subarray(nul + 1);
        if (consume(path)) {
          child.kill();
          finish([...found]);
          return;
        }
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      // Non-zero is "not a repository" (or git is absent, which arrives as `error`
      // first). Either way there is no index, and the walk answers instead.
      if (failed || code !== 0) finish(null);
      else finish([...found]);
    });
  });
}

/** The no-index half. Same count as the index, because the question is the same. */
async function extensionsByWalk(root) {
  const found = new Set();
  let seen = 0;
  const walk = async (dir) => {
    if (seen >= SAMPLE_BOUND) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // `readdir` order is the filesystem's. Sorting makes the first SAMPLE_BOUND files
    // the same files on every machine.
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (seen >= SAMPLE_BOUND) return;
      if (item.name.startsWith('.') || VENDORED.has(item.name)) continue;
      if (item.isDirectory()) {
        await walk(join(dir, item.name));
        continue;
      }
      // A symlink is not followed: a link back at an ancestor would otherwise cycle
      // until the count ran out, and the count would then describe the cycle.
      if (!item.isFile()) continue;
      seen += 1;
      const ext = extensionOf(item.name);
      if (ext) found.add(ext);
    }
  };
  await walk(root);
  return [...found];
}

function dedupe(list) {
  return [...new Set(list)];
}

/**
 * Every tag `fingerprint()` can emit. The registry validator checks skill
 * `stack` arrays against this set: a tag the detector cannot produce would match
 * nothing, silently, forever. Keep it derived from the tables above rather than
 * restated by hand, so adding a marker file cannot desynchronise the two.
 */
export const STACK_TAGS = new Set([
  ...MARKERS.map(([tag]) => tag),
  ...EXTENSION_TAGS.values(),
  ...DEP_TAGS.values(),
  'wear-os', // derived from a wear/ module, not a marker file
]);

/** Every fact `fingerprint()` can emit, derived for the same reason as above. */
export const FACT_TAGS = new Set([...FACTS.map((f) => f.name), ...PKG_FACTS.map((f) => f.name)]);

/**
 * The full vocabulary a profile's `applies` may name: platform tags and facts.
 * ADR-013 makes these two interchangeable in a profile, so the profile loader
 * and the registry validator both validate against this one set.
 */
export const KNOWN_TAGS = new Set([...STACK_TAGS, ...FACT_TAGS]);

export const __internals = { MARKERS, EXTENSION_TAGS, DEP_TAGS, FACTS, PKG_FACTS, SAMPLE_BOUND };
