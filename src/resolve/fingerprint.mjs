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
import { join } from 'node:path';

/** tag -> human-readable marker(s) that imply it. First match wins per tag. */
const MARKERS = [
  ['connectiq', ['monkey.jungle', 'manifest.xml']],
  ['cloudflare-workers', ['wrangler.jsonc', 'wrangler.toml']],
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
  ['.ts', 'typescript'],
  ['.tsx', 'react'],
  ['.less', 'less'],
]);

const DEP_TAGS = new Map([
  ['react', 'react'],
  ['react-dom', 'react'],
  ['@react-router/dev', 'react-router'],
  ['firebase', 'firebase'],
  ['firebase-admin', 'firebase'],
  ['maplibre-gl', 'maplibre'],
  ['hono', 'hono'],
  ['wrangler', 'cloudflare-workers'],
  ['typescript', 'typescript'],
  ['less', 'less'],
  ['vitest', 'vitest'],
  ['playwright', 'playwright'],
]);

/**
 * Observable properties of the working tree, named `has-*`.
 *
 * Every entry is either a path that exists or a predicate over package.json, so
 * adding an ecosystem means writing a profile against facts that are already
 * emitted - not editing this table. Keep entries boring and opinion-free: a
 * manifest, a lockfile, a directory convention. If an entry starts encoding "and
 * therefore it is a Django project", it belongs in a profile instead.
 *
 * kind 'file' and 'dir' probe the repository root; 'pkg' reads the parsed
 * manifest. `paths` is alternatives - first match wins and is reported as
 * evidence, so `doctor` can say which file proved the fact.
 *
 * A candidate is probed by its declared kind, so a `dir` may name a nested path.
 * A `file` candidate is matched against the root listing, which cannot see past
 * the root, so it must not contain a `/` - `test/genericity.test.mjs` fails if one
 * does, rather than letting it sit there never matching. A `dir` candidate that
 * was probed with `isFile` instead (S07) looked like a fact nobody's repo could
 * have: seven estate repositories have `.github/workflows/` and none of them
 * emitted `has-ci-workflows`.
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

  // Extensions: only the repository root and one level deep, so a monorepo with
  // 4000 files does not turn detection into a scan (ADR: 0002 section 12.2).
  const sampled = await sampleExtensions(root, entries, 2);
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

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sampleExtensions(root, entries, depth) {
  const found = new Set();
  const walk = async (dir, level) => {
    let items;
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.startsWith('.') || item === 'node_modules') continue;
      const full = join(dir, item);
      const dot = item.lastIndexOf('.');
      if (dot > 0) found.add(item.slice(dot).toLowerCase());
      if (level < depth && (await isDir(full))) await walk(full, level + 1);
    }
  };
  await walk(root, 1);
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

export const __internals = { MARKERS, EXTENSION_TAGS, DEP_TAGS, FACTS, PKG_FACTS };
