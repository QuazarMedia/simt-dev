// The release fast lane, plan 0008 F01: a content-only release is the one whose
// diff since the last tag touches nothing the binary DOES.
//
// The rule under test is the classifier itself - closed set, deterministic,
// defaulting to full - not the git plumbing that feeds it. The script is thin
// on purpose: env override, previous-tag lookup, `git diff --name-only`, and the
// call into classifyReleaseKind. The first-release case (no previous tag) is a
// script concern: the kind is full before any path is looked at, and the pure
// function's empty-input answer - content-only, nothing changed - is tested
// here because the workflow trusts it for a tag range that is empty.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyReleaseKind, CONTENT_PATHS } from '../src/distribute/release.mjs';

test('a diff touching only a harness definition is content-only', () => {
  assert.equal(classifyReleaseKind(['harnesses/cursor.json']), 'content-only');
});

test('every declared content directory and bookkeeping file classifies content-only', () => {
  const paths = [
    ...CONTENT_PATHS.dirs.map((d) => `${d}inner/file.txt`),
    ...CONTENT_PATHS.files,
    'docs/plans/0008-release-fast-lane-and-install-staleness.md',
    'packages/bench/src/commands.mjs',
  ];
  assert.equal(classifyReleaseKind(paths), 'content-only');
});

test('one src/ file makes the release full', () => {
  assert.equal(classifyReleaseKind(['harnesses/cursor.json', 'src/agenthooks/render.mjs']), 'full');
});

test('each engine directory makes the release full on its own', () => {
  for (const p of ['src/hooks/shim.mjs', 'bin/simt.mjs', 'scripts/release-formula.mjs', '.github/workflows/publish.yml']) {
    assert.equal(classifyReleaseKind([p]), 'full', p);
  }
});

test('a package.json change alone is content-only - it is the release commit itself', () => {
  assert.equal(classifyReleaseKind(['package.json', 'CHANGELOG.md']), 'content-only');
});

test('an empty diff classifies content-only: nothing changed, so nothing the binary does changed', () => {
  assert.equal(classifyReleaseKind([]), 'content-only');
});

test('a path that merely starts like a content dir is not one: skills2/ is not skills/', () => {
  assert.equal(classifyReleaseKind(['skills2/tool.json']), 'full');
});
