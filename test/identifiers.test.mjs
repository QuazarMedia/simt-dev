import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { foldIdentifierText, tokenizeIdentifiers } from '../src/text/identifiers.mjs';

const tokens = (value) => tokenizeIdentifiers(value).map(({ token }) => token);

test('emits whole identifiers and constituent parts without splitting technical digits', () => {
  const examples = [
    ['readSqliteBatch', ['readsqlitebatch', 'read', 'sqlite', 'batch']],
    ['HTMLParser', ['htmlparser', 'html', 'parser']],
    ['APIs', ['apis']],
    ['refresh_token', ['refreshtoken', 'refresh', 'token']],
    ['rate-limit', ['ratelimit', 'rate', 'limit']],
    ['src/api.schema', ['srcapischema', 'src', 'api', 'schema']],
    ['xValue', ['xvalue', 'value']],
    ['utf8 sha256 d1 kv r2 ci db ui id', ['utf8', 'sha256', 'd1', 'kv', 'r2', 'ci', 'db', 'ui', 'id']],
  ];
  for (const [input, expected] of examples) assert.deepEqual(tokens(input), expected, input);
  assert.deepEqual(tokenizeIdentifiers('rate-limit'), [
    { token: 'ratelimit', role: 'exact' }, { token: 'rate', role: 'part' }, { token: 'limit', role: 'part' },
  ]);
  assert.deepEqual(tokens(null), []);
});

test('folds compatibility forms and diacritics without losing Japanese voicing', () => {
  assert.equal(foldIdentifierText('ＭünchenÉdit ﾄﾞ A\u0301'), 'MunchenEdit ド A');
  assert.deepEqual(tokens('ＭünchenÉdit'), ['munchenedit', 'munchen', 'edit']);
  assert.deepEqual(tokens('東京大学 ﾄﾞ ぱ 한국어 𠮷野'), ['東京', '京大', '大学', 'ド', 'ぱ', '한국', '국어', '𠮷野']);
  assert.deepEqual(tokens('read東京Buffer'), ['read', '東京', 'buffer']);
  assert.deepEqual(tokens('Straße'), ['straße']);
});

test('keeps exact tokens while emitting conservative plural variants symmetrically', () => {
  assert.deepEqual(tokens('policies classes statuses refreshes orders class status alias process'), [
    'policies', 'policy', 'classes', 'class', 'statuses', 'status', 'refreshes', 'refresh', 'orders', 'order',
    'class', 'status', 'alias', 'process',
  ]);
  const indexed = new Set(tokens('export function readSqliteBatch(cachePolicies) {}'));
  for (const term of tokens('read sqlite batch cache policy')) assert.ok(indexed.has(term), term);
  assert.ok(indexed.has(tokens('readSqliteBatch')[0]));
  assert.deepEqual(tokens('ÉtapeDeTest'), tokens('EtapeDeTest'));
});

test('tokenizes representative source at least 10 MB/s on a warm process', (t) => {
  const input = 'export function readSqliteBatch(refresh_token, HTMLParser) { return cachePolicies.utf8; }\n'.repeat(2_048);
  tokenizeIdentifiers(input);
  const elapsed = Array.from({ length: 5 }, () => {
    const start = performance.now();
    const result = tokenizeIdentifiers(input);
    const duration = performance.now() - start;
    assert.equal(result.length, 18 * 2_048);
    return duration;
  }).sort((a, b) => a - b);
  const rate = Buffer.byteLength(input) / elapsed[2] / 1000;
  t.diagnostic(`${rate.toFixed(1)} MB/s median throughput`);
  assert.ok(rate >= 10, `expected 10 MB/s, measured ${rate.toFixed(1)} MB/s`);
});
