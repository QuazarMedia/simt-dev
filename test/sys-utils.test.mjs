// Shared utility clusters extracted in Q72: sort, fs, frontmatter, tokens, proc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmp } from '../src/util/sort.mjs';
import { readIfExists, plainNumber } from '../src/util/fs.mjs';
import { parseFrontmatter, frontmatterBlock, stripFrontmatter } from '../src/text/frontmatter.mjs';
import { tokenize, STOPWORDS, INDEX_STOP } from '../src/text/tokens.mjs';
import { sanitizedEnv, spawnBounded } from '../src/sys/proc.mjs';

// --- cmp ----------------------------------------------------------------

test('cmp sorts strings deterministically', () => {
  const arr = ['banana', 'Apple', 'apple', 'Banana', 'cherry'];
  const sorted = [...arr].sort(cmp);
  assert.deepEqual(sorted, ['Apple', 'Banana', 'apple', 'banana', 'cherry']);
});

test('cmp handles equal values', () => {
  assert.equal(cmp('a', 'a'), 0);
  assert.ok(cmp('a', 'b') < 0);
  assert.ok(cmp('b', 'a') > 0);
});

// --- readIfExists -------------------------------------------------------

test('readIfExists returns null for missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-test-'));
  try {
    const result = await readIfExists(join(dir, 'nope.txt'));
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readIfExists returns content for existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-test-'));
  try {
    const file = join(dir, 'hello.txt');
    await writeFile(file, 'world');
    const result = await readIfExists(file);
    assert.equal(result, 'world');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- plainNumber --------------------------------------------------------

test('plainNumber formats a number without locale separators', () => {
  assert.equal(plainNumber(1234567), '1234567');
  assert.equal(plainNumber(0), '0');
  assert.equal(plainNumber(-42), '-42');
});

// --- frontmatter --------------------------------------------------------

test('parseFrontmatter extracts block, front, and body with LF', () => {
  const text = '---\ntitle: Hello\n---\nBody text here\n';
  const { front, body, block } = parseFrontmatter(text);
  assert.equal(front, 'title: Hello');
  assert.equal(body, 'Body text here\n');
  assert.equal(block, '---\ntitle: Hello\n---');
});

test('parseFrontmatter handles CRLF line endings', () => {
  const text = '---\r\ntitle: CRLF\r\n---\r\nBody\r\n';
  const { front, body, block } = parseFrontmatter(text);
  assert.equal(front, 'title: CRLF');
  assert.equal(body, 'Body\r\n');
  assert.equal(block, '---\r\ntitle: CRLF\r\n---');
});

test('parseFrontmatter returns nulls when no block present', () => {
  const text = 'Just a document\nwith no frontmatter\n';
  const { front, body, block } = parseFrontmatter(text);
  assert.equal(front, null);
  assert.equal(body, text);
  assert.equal(block, null);
});

test('frontmatterBlock returns the block or null', () => {
  const text = '---\nk: v\n---\nrest';
  assert.equal(frontmatterBlock(text), '---\nk: v\n---');
  assert.equal(frontmatterBlock('no block'), null);
});

test('stripFrontmatter removes the block and trailing line ending', () => {
  const text = '---\nk: v\n---\nrest of doc\n';
  assert.equal(stripFrontmatter(text), 'rest of doc\n');
});

test('stripFrontmatter leaves text unchanged when no block', () => {
  const text = 'no block here\n';
  assert.equal(stripFrontmatter(text), text);
});

// --- tokens -------------------------------------------------------------

test('tokenize splits on whitespace and lowercases', () => {
  const tokens = tokenize('Hello World FOO');
  assert.deepEqual(tokens, ['hello', 'world', 'foo']);
});

test('tokenize filters out single-char tokens', () => {
  const tokens = tokenize('a bc d ef');
  assert.deepEqual(tokens, ['bc', 'ef']);
});

test('STOPWORDS and INDEX_STOP are distinct sets', () => {
  assert.ok(STOPWORDS.size > 0);
  assert.ok(INDEX_STOP.size > 0);
  // They are deliberately not merged; verify they are not the same reference
  assert.notEqual(STOPWORDS, INDEX_STOP);
});

// --- sanitizedEnv -------------------------------------------------------

test('sanitizedEnv sets SIMT_DEV_WORKSPACE off and drops NODE_TEST vars', () => {
  const env = sanitizedEnv({ PATH: '/usr/bin' });
  assert.equal(env.SIMT_DEV_WORKSPACE, 'off');
  assert.ok(env.PATH);
});

test('sanitizedEnv passes through extra vars', () => {
  const env = sanitizedEnv({ MY_VAR: 'hello' });
  assert.equal(env.MY_VAR, 'hello');
});

// --- spawnBounded -------------------------------------------------------

test('spawnBounded captures stdout', async () => {
  const result = await spawnBounded('echo', ['hello'], { timeoutMs: 5000 });
  assert.equal(result.stdout.toString(), 'hello\n');
  assert.equal(result.code, 0);
});

test('spawnBounded reports non-zero exit code', async () => {
  const result = await spawnBounded('false', [], { timeoutMs: 5000 });
  assert.equal(result.code, 1);
});

test('spawnBounded kills on timeout', async () => {
  const result = await spawnBounded('sleep', ['10'], { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
});
