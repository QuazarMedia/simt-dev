// The test-path convention: is this repository-relative path a test?
//
// The directories are structural (`test/`, `tests/`, `spec/`, `__tests__/`, `src/test/`)
// and the suffixes are file conventions. A language's own convention arrives as data —
// the ecosystem records' `testConventions` (ADR-013) — so a new language lands in a
// record, not in this file.
//
// This module lives outside `src/bench/` because the index, the gate and the map all ask
// this question. Production code importing it from the bench made the bench a
// requirement for commands that never run a benchmark.
import { testConventions } from '../ecosystem/records.mjs';

/**
 * The `testConventions` records' `base` sources, compiled once.
 *
 * De-duplicated because a language may share a pattern with a sibling (the JVM pattern
 * matches both `.java` and `.kt`); a duplicate RegExp is the same check run twice.
 */
const LANG_TEST_PATTERNS = [...new Set(testConventions().flatMap((record) => record.base ?? []))].map(
  (src) => new RegExp(src),
);

const TEST_DIRECTORIES = ['test', 'tests', 'spec', '__tests__', 'src/test'];

/**
 * Classify whether a repository-relative path is a test file.
 *
 * @param {string} relPath forward-slash repository-relative path
 * @returns {boolean}
 */
export function isTestPath(relPath) {
  const norm = String(relPath).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!norm) return false;
  const segments = norm.split('/');
  const base = segments[segments.length - 1];

  if (
    TEST_DIRECTORIES.some((dir) => norm.startsWith(`${dir}/`)) ||
    segments.some((segment) => ['__tests__', 'test', 'tests', 'spec'].includes(segment))
  ) {
    return true;
  }

  if (/\.(?:test|spec)\.[A-Za-z0-9]+$/.test(base)) return true;
  if (/_(?:test|spec)\.[A-Za-z0-9]+$/.test(base)) return true;
  if (LANG_TEST_PATTERNS.some((re) => re.test(base))) return true;

  return false;
}
