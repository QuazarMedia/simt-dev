// Plan 0004 W12: sections, anchors and full-document extraction.
//
// The bar is structural, so the fixture is a document with the four shapes that broke the
// old reader: material past the 24,000-character sample, non-Latin text, a heading inside a
// code fence, and a title used twice. Labels are declared here rather than recomputed from
// the parser, or a test would agree with a bug.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SECTIONS_SCHEMA_VERSION, anchorOf, extractDocument, searchUnits } from '../src/knowledge/sections.mjs';

const FILLER = 'Field notes record what the operator saw, in the order they saw it, and nothing more.';

/** Query → the anchor that must carry it. Five labelled probes, one per deep section. */
const RECALL = [
  { query: 'lighthouse beacon', anchor: 'overview' },
  { query: 'Zenith threshold north pier', anchor: '深层附录' },
  { query: 'Kestrel river districts', anchor: '附录-人口统计' },
  { query: 'tidewater rule harbour', anchor: 'rules' },
  { query: 'second overview repeats title', anchor: 'overview-1' },
];

const ANCHORS = [
  'handbook-运用指南',
  'overview',
  'code-sample',
  'field-notes',
  '深层附录',
  '附录-人口统计',
  'overview-1',
  'rules',
  'links',
];

function handbook({ paragraphs = 240 } = {}) {
  const lines = [
    '# Handbook 运用指南',
    '',
    'Read the [overview](#overview) first, then the [spaced note](<../docs/my notes.md>).',
    '',
    '## Overview',
    '',
    'The lighthouse beacon is maintained by the harbour office and inspected twice a year.',
    '',
    '## Code sample',
    '',
    'The block below holds headings that are data, not structure.',
    '',
    '```md',
    '# Not a heading',
    '[fake](https://example.invalid/x)',
    'const answer = 42;',
    '```',
    '',
  ];
  for (let i = 0; i < paragraphs; i += 1) {
    if (i === 0) lines.push('## Field notes', '');
    lines.push(`${FILLER} Entry ${i}.`, '');
  }
  lines.push(
    '### 深层附录',
    '',
    'The Zenith threshold is 40 metres, measured at the north pier.',
    '',
    '## 附录 人口统计',
    '',
    'The Kestrel river divides the two districts.',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 人口 | 4.2 百万 |',
    '| 面积 | 70,273 km² |',
    '',
    '## Overview',
    '',
    'This second overview repeats the title, which is what makes the anchors collide.',
    '',
    '## Rules',
    '',
    'The tidewater rule applies to every import under the harbour.',
    '',
    '## Links',
    '',
    '[spec]: <./specs/my spec.md>',
    '',
    'See the [appendix](#附录-人口统计) for the numbers.',
    '',
  );
  return lines.join('\n');
}

test('structure: headings, byte ranges and duplicate anchors are recovered exactly', () => {
  const source = handbook({ paragraphs: 4 });
  const doc = extractDocument(source, { path: 'docs/手册.md' });
  assert.equal(doc.version, SECTIONS_SCHEMA_VERSION);
  assert.equal(doc.path, 'docs/手册.md');
  assert.equal(doc.unindexed, null);
  assert.deepEqual(doc.headings.map((heading) => heading.anchor), ANCHORS);
  for (const heading of doc.headings) {
    const sliced = Buffer.from(source).subarray(heading.byteStart, heading.byteEnd).toString('utf8');
    assert.match(sliced, new RegExp(`^#{1,6} ${heading.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }
  // Sections partition the bytes: no gap, no overlap, and nothing past the end.
  for (let i = 1; i < doc.sections.length; i += 1) {
    assert.equal(doc.sections[i].byteStart, doc.sections[i - 1].byteEnd, `${doc.sections[i].id} does not start where the previous section ended`);
  }
  assert.equal(doc.sections.at(-1).byteEnd, doc.bytes);
  assert.equal(new Set(doc.sections.map((section) => section.id)).size, doc.sections.length);
  const deep = doc.sections.find((section) => section.anchor === '深层附录');
  assert.equal(deep.parent, 'field-notes');
  assert.deepEqual(deep.path, ['Handbook 运用指南', 'Field notes', '深层附录']);
});

test('fences: a heading and a link inside a code fence are data', () => {
  const doc = extractDocument(handbook({ paragraphs: 4 }), { path: 'docs/手册.md' });
  assert.equal(doc.headings.some((heading) => heading.title === 'Not a heading'), false);
  assert.equal(doc.links.some((link) => link.target === 'https://example.invalid/x'), false);
  const code = doc.units.find((unit) => unit.text.includes('const answer = 42;'));
  assert.ok(code, 'the fence body reached no unit');
  assert.equal(code.anchor, 'code-sample');
});

test('links: inline and reference definitions keep their target and their section', () => {
  const doc = extractDocument(handbook({ paragraphs: 4 }), { path: 'docs/手册.md' });
  assert.deepEqual(doc.links.map((link) => link.target).sort(), ['#overview', '#附录-人口统计', '../docs/my notes.md', './specs/my spec.md']);
  const appendix = doc.links.find((link) => link.target === '#附录-人口统计');
  assert.equal(appendix.section, 'links');
  const definition = doc.links.find((link) => link.target === './specs/my spec.md');
  assert.equal(definition.kind, 'definition');
});

test('long documents: material past 24,000 bytes is a unit, and Unicode queries reach it', () => {
  const doc = extractDocument(handbook({ paragraphs: 320 }), { path: 'docs/手册.md' });
  assert.ok(doc.bytes > 24000, `fixture is ${doc.bytes} bytes`);
  const deep = doc.sections.find((section) => section.anchor === '深层附录');
  assert.ok(deep.byteStart > 24000, `the deep section starts at ${deep.byteStart}`);
  const hits = RECALL.map(({ query, anchor }) => searchUnits(doc.units, query, { limit: 3 }).some((unit) => unit.anchor === anchor));
  const recall = hits.filter(Boolean).length / hits.length;
  assert.ok(recall >= 0.9, `recall is ${recall} over ${RECALL.length} labelled queries`);
});

test('chunks: bounded, overlapping at paragraph boundaries, and covering the text', () => {
  const source = handbook({ paragraphs: 40 });
  const doc = extractDocument(source, { unitBytes: 160, overlapBytes: 40 });
  for (const unit of doc.units) assert.ok(unit.bytes <= 160, `${unit.id} is ${unit.bytes} bytes`);
  const lines = source.split('\n');
  const missing = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const start = offset;
    const end = start + Buffer.byteLength(lines[i], 'utf8');
    offset = end + 1;
    if (lines[i].trim() === '' || lines[i].startsWith('#')) continue;
    if (!doc.units.some((unit) => unit.byteStart <= start && unit.byteEnd >= end)) missing.push(i);
  }
  assert.deepEqual(missing, [], 'content lines that reached no unit');

  // A bounded overlap is only observable where a paragraph fits the carry budget, so it
  // gets a paragraph of its own rather than 100-byte filler that can never be carried.
  const short = ['# Notes', '', 'alpha one', '', 'beta two', '', 'gamma three', '', 'delta four', '', 'epsilon five', ''].join('\n');
  const chunks = extractDocument(short, { unitBytes: 40, overlapBytes: 16 });
  assert.ok(chunks.units.length > 1);
  let carried = 0;
  for (let i = 1; i < chunks.units.length; i += 1) {
    const previous = chunks.units[i - 1];
    const current = chunks.units[i];
    const shared = previous.byteEnd - current.byteStart;
    assert.ok(shared <= 16, `${current.id} carries ${shared} bytes of the previous unit`);
    if (shared > 0) carried += 1;
  }
  assert.ok(carried > 0, 'no unit carries the previous paragraph across a boundary');
  for (const unit of chunks.units) assert.ok(unit.bytes <= 40, `${unit.id} is ${unit.bytes} bytes`);
});

test('tables: a unit that starts inside a table carries the header it lost', () => {
  const doc = extractDocument(handbook({ paragraphs: 2 }), { unitBytes: 64, overlapBytes: 0 });
  const row = doc.units.find((unit) => unit.text.includes('70,273'));
  assert.ok(row, 'the second row is not in a unit of its own');
  assert.deepEqual(row.tableHeaders, [['指标', '数值']]);
  const reached = searchUnits(doc.units, '数值', { limit: 5 });
  assert.ok(reached.some((unit) => unit.text.includes('70,273')), 'the header did not make the row retrievable');
});

test('digests: the same bytes give the same units, twice', () => {
  const source = handbook({ paragraphs: 4 });
  const first = extractDocument(source, { path: 'docs/手册.md' });
  const second = extractDocument(source, { path: 'docs/手册.md' });
  assert.deepEqual(second, first);
  for (const unit of first.units) assert.match(unit.digest, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(searchUnits(first.units, 'lighthouse'), searchUnits(second.units, 'lighthouse'));
});

test('unsupported content is unindexed with a reason, never an empty verified document', () => {
  const pdf = extractDocument('%PDF-1.7 binary', { path: 'report.pdf' });
  assert.deepEqual(pdf.unindexed, { reason: 'unsupported-binary', path: 'report.pdf' });
  assert.deepEqual(pdf.units, []);
  assert.deepEqual(pdf.sections, []);
  const nul = extractDocument('text\u0000more', { path: 'notes.md' });
  assert.equal(nul.unindexed.reason, 'binary-content');
  const text = extractDocument('plain words', { path: 'notes.md' });
  assert.equal(text.unindexed, null);
  assert.equal(text.sections.length, 1);
  assert.ok(text.units.length > 0);
});

test('anchors: NFKC and any script survive, and an empty title still has one', () => {
  assert.equal(anchorOf('Café Notes'), 'café-notes');
  assert.equal(anchorOf('Ｃａｆｅ Ｎｏｔｅｓ'), 'cafe-notes');
  assert.equal(anchorOf('附录 人口统计'), '附录-人口统计');
  assert.equal(anchorOf('***'), 'section');
});
