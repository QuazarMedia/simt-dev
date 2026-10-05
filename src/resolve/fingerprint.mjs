// Classify a repo into stack tags from marker files alone.
//
// This is the fallback that makes a new repo classifiable with no configuration:
// detection gets you most of the way, and simt-dev.json exists to make the
// remainder explicit and reviewable (ADR: 0002 section 4.1).
//
// Design note (ADR-011, Windows v1): every path is normalised to forward slashes
// before comparison, so a Windows path never fails to match a marker.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

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
 * @param {string} root absolute path to a repository root
 * @returns {Promise<{stack: string[], evidence: string[], manifest: object|null}>}
 */
export async function fingerprint(root) {
  const stack = new Set();
  const evidence = [];
  let entries = [];

  try {
    entries = await readdir(root);
  } catch {
    return { stack: [], evidence: [], manifest: null, error: 'unreadable-root' };
  }
  const names = new Set(entries);

  for (const [tag, markers] of MARKERS) {
    const hit = markers.find((m) => names.has(m));
    if (hit) {
      stack.add(tag);
      evidence.push(hit);
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
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
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

  return { stack: [...stack].sort(), evidence: dedupe(evidence).sort(), manifest };
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

export const __internals = { MARKERS, EXTENSION_TAGS, DEP_TAGS, sep };
