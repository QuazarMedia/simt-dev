// Plan 0004 W43: discovery, corrections and scoped memory.
//
// What the suite pins: a verified discovery is recallable without a failing command; an unverified
// repair is a warning and never a known remedy; repetition merges into a count and never raises
// authority; expired and target-specific entries are excluded from a generic packet, with the
// exclusion named.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AUTHORITIES,
  CANDIDATE_KINDS,
  authorityOf,
  candidate,
  dedupeCandidates,
  normaliseProposition,
  packetEntries,
  recallable,
} from '../src/memory/discovery.mjs';

const discovery = (over = {}) =>
  candidate({ kind: 'discovery', proposition: 'Rates live in the docs/rates file', support: ['docs/rates.md'], verified: true, ...over });

test('the kinds and authorities are named', () => {
  assert.deepEqual(CANDIDATE_KINDS, ['discovery', 'contradiction', 'repair', 'correction', 'unknown-outcome']);
  assert.deepEqual(AUTHORITIES, ['lesson', 'warning', 'candidate']);
});

test('a candidate needs a proposition and a known kind', () => {
  assert.throws(() => candidate({}), /needs a proposition/);
  assert.throws(() => candidate({ proposition: 'x', kind: 'rumour' }), /not a candidate kind/);
});

test('authority comes from how a candidate was established', () => {
  assert.equal(authorityOf({ kind: 'discovery', verified: true }), 'lesson');
  assert.equal(authorityOf({ kind: 'discovery', verified: false }), 'candidate');
  assert.equal(authorityOf({ kind: 'repair', verified: false }), 'warning');
  assert.equal(authorityOf({ kind: 'repair', verified: true }), 'lesson');
  assert.equal(authorityOf({ kind: 'unknown-outcome', verified: true }), 'candidate');
});

test('a verified discovery is recallable without a failing command', () => {
  const entry = discovery();
  assert.equal(entry.authority, 'lesson');
  assert.equal(recallable(entry, { now: '2026-11-03' }).usable, true);
  assert.equal(recallable(candidate({ proposition: 'unverified' }), {}).usable, false);
});

test('repetition merges into a count and never raises authority', () => {
  const once = candidate({ proposition: 'The flag is required' });
  const twice = candidate({ proposition: 'the flag is required!' });
  const deduped = dedupeCandidates([once, twice]);
  assert.equal(deduped.kept.length, 1);
  assert.equal(deduped.kept[0].count, 2);
  assert.equal(deduped.kept[0].authority, 'candidate', 'a repeated assertion gained authority');
  assert.deepEqual(deduped.merged, ['the flag is required|generic']);
});

test('normalisation ignores case, punctuation and spacing', () => {
  assert.equal(normaliseProposition('  Rates  LIVE in docs/rates.md '), 'rates live in docs rates md');
  assert.equal(normaliseProposition('Rates LIVE in docs/rates.md'), normaliseProposition('rates live in docs/rates.md'));
});

test('scope is part of the dedupe key, so two targets do not merge', () => {
  const a = candidate({ proposition: 'The flag is required', scope: 'rates/prod', verified: true });
  const b = candidate({ proposition: 'The flag is required', scope: 'rates/staging', verified: true });
  assert.equal(dedupeCandidates([a, b]).kept.length, 2);
});

test('expired and target-specific entries are excluded from a packet, and named', () => {
  const expired = discovery({ expiresAt: '2026-10-01T00:00:00Z' });
  const elsewhere = discovery({ scope: 'rates/staging' });
  const packet = packetEntries([expired, elsewhere, discovery()], { now: '2026-11-03', scope: 'rates/prod' });
  assert.equal(packet.usable.length, 1);
  assert.deepEqual(packet.excluded.map((entry) => entry.reason), ['expired at 2026-10-01T00:00:00Z', 'scoped to rates/staging, not rates/prod']);
});

test('a failed compensation and an unverified fix are warnings, not remedies', () => {
  const unverifiedFix = candidate({ kind: 'repair', proposition: 'Restart the worker' });
  assert.equal(unverifiedFix.authority, 'warning');
  assert.equal(recallable(unverifiedFix).reason, null);
  assert.equal(recallable(unverifiedFix).usable, true, 'a warning is shown, with its own label');
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(discovery(), discovery());
  const source = await readFile(new URL('../src/memory/discovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
