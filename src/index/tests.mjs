// Which tests exercise a source file (R24, ADR-092).
//
// Three precise signals, and one historical one kept apart. An import from a
// test file, a conventional name beside that test, and a coverage record that
// names both sides are test edges. A stem that is unique somewhere else in
// the tree is not a guess. Co-change is a different kind: files that land in
// the same commit are not, by that fact, a test.

import { isTestPath } from '../bench/mine.mjs';
import { extract, resolveImports } from './extract.mjs';

export { scriptSpecifiers } from './extract.mjs';

const HISTORY = 200;
const COCHANGE_MIN = 2;
const COCHANGE_CAP = 8;
const WIDE_TESTS = 5;
const WIDE_SOURCES = 15;

export { HISTORY };

/**
 * @param {{files: {path: string}[]|string[], imports?: {src: string, dst: string, kind?: string}[], coverage?: string[], commits?: string[][]}} input
 * @returns {{src: string, dst: string, kind: string, weight: number}[]}
 */
export function testEdges({ files, imports = [], coverage = [], commits = [] }) {
  const paths = [...new Set(files.map((file) => (typeof file === 'string' ? file : file.path)))].sort();
  const have = new Set(paths);
  const edges = [];
  for (const edge of imports) {
    if (edge.kind && edge.kind !== 'import') continue;
    if (!isTestPath(edge.src) || isTestPath(edge.dst) || !have.has(edge.dst)) continue;
    edges.push({ src: edge.src, dst: edge.dst, kind: 'test', weight: 1 });
  }
  for (const test of paths) {
    if (!isTestPath(test)) continue;
    const source = namedSource(test, have);
    if (source) edges.push({ src: test, dst: source, kind: 'test', weight: 1 });
  }
  for (const text of coverage) edges.push(...coverageEdges(text, have));
  edges.push(...cochangeEdges(commits));
  return dedupe(edges);
}

/** Test files for one source file. Co-change is included only when asked. */
export function testsFor(source, edges, { cochange = false } = {}) {
  const direct = new Set();
  const history = [];
  for (const edge of edges) {
    if (edge.dst !== source) continue;
    if (edge.kind === 'test') direct.add(edge.src);
    else if (edge.kind === 'cochange') history.push(edge);
  }
  const found = [...direct].sort();
  if (!cochange) return found;
  history.sort((a, b) => b.weight - a.weight || cmp(a.src, b.src));
  for (const edge of history) {
    if (direct.has(edge.src)) continue;
    found.push(edge.src);
  }
  return found;
}

export function parseCoverage(text) {
  const body = String(text).replace(/^\uFEFF/, '');
  const start = body.trimStart();
  if (start.startsWith('TN:') || start.startsWith('SF:') || start.includes('\nSF:')) return parseLcov(body);
  if (start.startsWith('mode:')) return parseGoCover(body);
  if (start.startsWith('<')) return parseJacoco(body);
  if (start.startsWith('{')) return parseCoveragePy(body);
  return [];
}

export function parseLcov(text) {
  const pairs = [];
  let test = '';
  for (const line of String(text).split('\n')) {
    if (line.startsWith('TN:')) test = line.slice(3).trim();
    else if (line.startsWith('SF:') && test) pairs.push({ test, source: line.slice(3).trim() });
    else if (line === 'end_of_record') test = '';
  }
  return pairs;
}

export function parseJacoco(text) {
  const sources = [...String(text).matchAll(/<sourcefile\s+name="([^"]+)"/g)].map((match) => match[1]);
  const tests = [...String(text).matchAll(/<class\s+name="([^"]+)"/g)]
    .map((match) => match[1].split(/[./]/).pop())
    .filter((name) => /Tests?$/.test(name));
  const pairs = [];
  for (const source of sources) {
    const stem = source.slice(0, source.lastIndexOf('.'));
    const hit = tests.filter((name) => name === `${stem}Test` || name === `${stem}Tests`);
    if (hit.length === 1) pairs.push({ test: hit[0], source });
  }
  return pairs;
}

function parseCoveragePy(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const pairs = [];
  const files = parsed?.files;
  if (!files || typeof files !== 'object') return pairs;
  for (const [source, info] of Object.entries(files)) {
    const contexts = info?.contexts;
    if (!contexts || typeof contexts !== 'object') continue;
    for (const name of Object.keys(contexts)) {
      if (name) pairs.push({ test: name, source });
    }
  }
  return pairs;
}

export function parseGoCover(text) {
  const sources = new Set();
  for (const line of String(text).split('\n')) {
    const match = /^(.+):\d+\.\d+,\d+\.\d+ \d+ (\d+)/.exec(line);
    if (match && Number(match[2]) > 0) sources.add(match[1]);
  }
  return [...sources].map((source) => ({ test: '', source }));
}

/**
 * Pairs that changed together. A commit that touches the whole tree is not a
 * mapping, and a pair seen once is a coincidence. Each test keeps its strongest
 * pairs, so one wide test cannot point at every file it ever met.
 */
export function cochangeEdges(commits) {
  const counts = new Map();
  for (const commit of commits) {
    const tests = [];
    const sources = [];
    for (const path of commit) {
      if (isTestPath(path)) tests.push(path);
      else sources.push(path);
    }
    if (tests.length === 0 || sources.length === 0) continue;
    if (tests.length > WIDE_TESTS || sources.length > WIDE_SOURCES) continue;
    for (const test of tests) {
      for (const source of sources) {
        const key = `${test}\0${source}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const byTest = new Map();
  for (const [key, weight] of counts) {
    if (weight < COCHANGE_MIN) continue;
    const split = key.indexOf('\0');
    const edge = { src: key.slice(0, split), dst: key.slice(split + 1), kind: 'cochange', weight };
    const list = byTest.get(edge.src) ?? [];
    list.push(edge);
    byTest.set(edge.src, list);
  }
  const edges = [];
  for (const list of byTest.values()) {
    list.sort((a, b) => b.weight - a.weight || cmp(a.dst, b.dst));
    edges.push(...list.slice(0, COCHANGE_CAP));
  }
  edges.sort(byEdge);
  return edges;
}

function coverageEdges(text, files) {
  const edges = [];
  for (const pair of parseCoverage(text)) {
    const source = resolveToken(pair.source, files);
    if (!source || isTestPath(source)) continue;
    let test = pair.test ? resolveToken(pair.test, files) : '';
    if (!test && pair.test === '') test = goTestFor(source, files);
    if (!test || !isTestPath(test)) continue;
    edges.push({ src: test, dst: source, kind: 'test', weight: 1 });
  }
  return edges;
}

function goTestFor(source, files) {
  if (!source.endsWith('.go')) return '';
  const slash = source.lastIndexOf('/');
  const dir = slash < 0 ? '' : source.slice(0, slash);
  const stem = source.slice(slash + 1, -3);
  const exact = dir ? `${dir}/${stem}_test.go` : `${stem}_test.go`;
  if (files.has(exact)) return exact;
  const tests = [];
  const prefix = dir ? `${dir}/` : '';
  for (const file of files) {
    if (!file.startsWith(prefix) || file.slice(prefix.length).includes('/')) continue;
    if (file.endsWith('_test.go')) tests.push(file);
  }
  return tests.length === 1 ? tests[0] : '';
}

function namedSource(test, files) {
  // Same directory, or the main tree mirrored from src/test. A stem that is
  // unique somewhere else in the repo is still a guess: test/hooks.test.mjs
  // is not the test for src/commands/hooks.mjs.
  const exact = conventional(test);
  return exact && files.has(exact) ? exact : null;
}

function conventional(test) {
  const moved = test.match(/^(?:(.*)\/)?src\/test\/(java|kotlin)\/(.+?)Tests?\.(java|kt)$/);
  if (moved) {
    const prefix = moved[1] ? `${moved[1]}/` : '';
    return `${prefix}src/main/${moved[2]}/${moved[3]}.${moved[4]}`;
  }
  const slash = test.lastIndexOf('/');
  const dir = slash < 0 ? '' : test.slice(0, slash);
  const base = test.slice(slash + 1);
  let source = '';
  if (/_test\.go$/.test(base)) source = `${base.slice(0, -'_test.go'.length)}.go`;
  else if (/^test_.+\.py$/.test(base)) source = `${base.slice('test_'.length)}`;
  else if (/Tests?\.(java|kt)$/.test(base)) source = base.replace(/Tests?(\.(?:java|kt))$/, '$1');
  else if (/\.(?:test|spec)\.[A-Za-z0-9]+$/.test(base)) source = base.replace(/\.(?:test|spec)(\.[A-Za-z0-9]+)$/, '$1');
  if (!source || source === base) return '';
  return dir ? `${dir}/${source}` : source;
}

function resolveToken(token, files) {
  const norm = String(token).replaceAll('\\', '/').replace(/^\.\//, '');
  if (files.has(norm)) return norm;
  const parts = norm.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const suffix = parts.slice(i).join('/');
    const hits = [];
    for (const file of files) {
      if (file === suffix || file.endsWith(`/${suffix}`)) hits.push(file);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return '';
  }
  return '';
}

function dedupe(edges) {
  const byKey = new Map();
  for (const edge of edges) {
    const key = `${edge.kind}\0${edge.src}\0${edge.dst}`;
    const prior = byKey.get(key);
    if (!prior || edge.weight > prior.weight) byKey.set(key, edge);
  }
  return [...byKey.values()].sort(byEdge);
}

function byEdge(a, b) {
  return cmp(a.kind, b.kind) || cmp(a.src, b.src) || cmp(a.dst, b.dst);
}

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Imports in a file, resolved against the tracked tree. One path now: `extract`
 * reads scripts with `scriptSpecifiers`, so gate, impact and the index agree on
 * what a file imports (review 0003 Q41). */
export function importsOf(testPath, text, lang, files) {
  return resolveImports(testPath, extract(testPath, text, lang).imports, files, lang);
}
