import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPRECATION_RELEASE, refusesAt } from '../src/commands/index.mjs';

test('the tolerance ends at its release, compared as versions and not as strings', () => {
  // The string comparison everyone writes first says 0.10.0 < 0.9.0, which would have
  // this window open a release after it closed.
  assert.equal(refusesAt('0.8.0', '0.7.9'), false, 'the release before still warns');
  assert.equal(refusesAt('0.8.0', '0.8.0'), true, 'the release itself refuses');
  assert.equal(refusesAt('0.8.0', '0.10.0'), true, 'and every later one does too');
  assert.equal(refusesAt('0.10.0', '0.9.0'), false);
});

test('a version it cannot read refuses nothing', () => {
  // `packageVersion()` returns 'unknown' when the package.json cannot be read. Refusing
  // on a version nobody can name would break a working install to prove a point.
  assert.equal(refusesAt('0.8.0', 'unknown'), false);
  assert.equal(refusesAt('0.8.0', ''), false);
  assert.equal(refusesAt('not-a-version', '9.9.9'), false);
});

test('the release is named, so a reader can see when the window closes', () => {
  assert.match(DEPRECATION_RELEASE, /^\d+\.\d+\.\d+$/);
});
