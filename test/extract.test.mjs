// Built-in extractors (R21, ADR-090).
//
// Recall is against a hand-labelled set of exported names. A live structural parser
// was not run; the bar is 90% of this set, and a private name must not count as exported.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { extract, resolveImports } from '../src/index/extract.mjs';
import { readEdges, readSymbols, reindex } from '../src/index/store.mjs';

const LABELLED = [
  {
    lang: 'typescript',
    path: 'src/a.ts',
    gold: ['greet', 'Box', 'LIMIT', 'Id', 'HasId', 'Color', 'renamed', 'main'],
    hidden: ['hidden'],
    text: [
      'import type { Other } from "./other";',
      'export function greet(name: string): string { return name; }',
      'export class Box {}',
      'export const LIMIT = 1;',
      'export type Id = string;',
      'export interface HasId { id: Id }',
      'export enum Color { Red }',
      'export { inner as renamed } from "./inner";',
      'function hidden() {}',
      'export default function main() {}',
      '',
    ].join('\n'),
  },
  {
    lang: 'kotlin',
    path: 'src/A.kt',
    gold: ['PublicClass', 'top', 'Point', 'Repo', 'Singleton', 'Kind'],
    hidden: ['Hidden', 'secret'],
    text: [
      'package app',
      'import kotlin.collections.List',
      'class PublicClass',
      'private class Hidden',
      'fun top() {}',
      'private fun secret() {}',
      'data class Point(val x: Int)',
      'interface Repo',
      'object Singleton',
      'enum class Kind { A }',
      '',
    ].join('\n'),
  },
  {
    lang: 'python',
    path: 'src/a.py',
    gold: ['greet', 'Box', 'fetch'],
    hidden: ['_hidden'],
    text: [
      'import os',
      'from . import sibling',
      'def greet():',
      '    pass',
      'class Box:',
      '    def method(self):',
      '        pass',
      'def _hidden():',
      '    pass',
      'async def fetch():',
      '    pass',
      '',
    ].join('\n'),
  },
  {
    lang: 'go',
    path: 'src/a.go',
    gold: ['Exported', 'Box', 'Method'],
    hidden: ['unexported', 'hidden', 'method'],
    text: [
      'package p',
      'import (',
      '  "fmt"',
      '  "example.com/mod"',
      ')',
      'func Exported() {}',
      'func unexported() {}',
      'type Box struct{}',
      'type hidden struct{}',
      'func (b Box) Method() {}',
      'func (b Box) method() {}',
      '',
    ].join('\n'),
  },
];

function exportedNames(path, lang, text) {
  return extract(path, text, lang).symbols.filter((row) => row.exported === 1).map((row) => row.name);
}

test('built-in recall is at least 90% of the labelled exports', () => {
  for (const sample of LABELLED) {
    const names = exportedNames(sample.path, sample.lang, sample.text);
    const hit = sample.gold.filter((name) => names.includes(name));
    const ratio = hit.length / sample.gold.length;
    assert.ok(ratio >= 0.9, `${sample.lang} recalled ${hit.length}/${sample.gold.length}: ${sample.gold.filter((name) => !names.includes(name)).join(', ')}`);
    for (const name of sample.hidden) assert.equal(names.includes(name), false, `${sample.lang} exported ${name}`);
  }
});

test('the other languages yield the export and the import', () => {
  const cases = [
    ['java', 'A.java', 'import java.util.List;\npublic class App {}\nclass Hidden {}\n', 'App', 'java.util.List'],
    ['rust', 'a.rs', 'use std::io::Read;\npub fn greet() {}\nfn hidden() {}\npub(crate) fn local() {}\n', 'greet', 'std::io::Read'],
    ['swift', 'a.swift', 'import Foundation\npublic func greet() {}\nfunc hidden() {}\n', 'greet', 'Foundation'],
    ['dart', 'a.dart', "import 'dart:async';\nvoid greet() {}\nclass Box {}\nvoid _hidden() {}\n", 'greet', 'dart:async'],
    ['ruby', 'a.rb', "require 'json'\nclass Box\n  def inner\n  end\nend\ndef top\nend\n", 'Box', 'json'],
    ['csharp', 'A.cs', 'using System;\npublic class Box {}\nclass Hidden {}\n', 'Box', 'System'],
  ];
  for (const [lang, path, text, name, spec] of cases) {
    const found = extract(path, text, lang);
    assert.ok(found.symbols.some((row) => row.name === name && row.exported === 1), lang);
    assert.ok(found.imports.includes(spec), `${lang} import`);
  }
});

test('a relative import points at the tracked file', () => {
  const found = extract('src/a.ts', 'export { inner as renamed } from "./inner";\n', 'typescript');
  const edges = resolveImports('src/a.ts', found.imports, new Set(['src/inner.ts']), 'typescript');
  assert.deepEqual(edges, [{ src: 'src/a.ts', dst: 'src/inner.ts', kind: 'import', weight: 1 }]);
});

test('an import spanning lines is one specifier, and .js names the .ts source (Q41)', () => {
  // The old single-line regexes saw no `from` on the first line, so an import
  // like `store.mjs → persist.mjs` (spanning lines 15-27) produced no edge.
  const text = 'import {\n  a,\n  b,\n} from "./persist.mjs";\nimport "./side.js";\n';
  const found = extract('src/store.mts', text, 'typescript');
  assert.deepEqual(found.imports, ['./persist.mjs', './side.js']);
  const edges = resolveImports(
    'src/store.mts',
    found.imports,
    new Set(['src/persist.mts', 'src/side.ts']),
    'typescript',
  );
  assert.deepEqual(edges, [
    { src: 'src/store.mts', dst: 'src/persist.mts', kind: 'import', weight: 1 },
    { src: 'src/store.mts', dst: 'src/side.ts', kind: 'import', weight: 1 },
  ]);
});

test('the same blobs produce the same symbols, and one edit rewrites that file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  await writeFile(join(root, 'a.ts'), 'import { b } from "./b";\nexport const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  await reindex(root, { backend: 'sqlite' });
  const first = await readSymbols(root, { backend: 'sqlite' });
  const edges = await readEdges(root, { backend: 'sqlite' });
  assert.ok(edges.some((edge) => edge.src === 'a.ts' && edge.dst === 'b.ts' && edge.kind === 'import'));
  const again = await reindex(root, { backend: 'sqlite' });
  assert.equal(again.updated, 0);
  assert.deepEqual(await readSymbols(root, { backend: 'sqlite' }), first);
  await writeFile(join(root, 'b.ts'), 'export const changed = 2;\n');
  await git(['-C', root, 'add', 'b.ts']);
  const edited = await reindex(root, { backend: 'sqlite' });
  assert.equal(edited.updated, 1);
  const names = (await readSymbols(root, { backend: 'sqlite' })).filter((row) => row.path === 'b.ts').map((row) => row.name);
  assert.deepEqual(names, ['changed']);
  assert.ok((await readSymbols(root, { backend: 'sqlite' })).some((row) => row.path === 'a.ts' && row.name === 'a'));
  await rm(root, { recursive: true, force: true });
});

test('a named parser fills the cache and leaves the file alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  const source = 'export const a = 1;\n';
  await writeFile(join(root, 'a.ts'), source);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  const result = await reindex(root, {
    backend: 'jsonl',
    adapter: {
      extract() {
        return {
          symbols: [{ name: 'Exact', kind: 'function', line: 1, sig: 'exact', exported: 1 }],
          edges: [{ dst: 'call:Exact', kind: 'call', weight: 1 }],
        };
      },
    },
  });
  assert.equal(result.parsers, 'loaded');
  const symbols = await readSymbols(root, { backend: 'jsonl' });
  assert.deepEqual(symbols.map((row) => row.name), ['Exact']);
  const edges = await readEdges(root, { backend: 'jsonl' });
  assert.equal(edges[0].kind, 'call');
  assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), source);
  await rm(root, { recursive: true, force: true });
});

test('a parser that is named and not installed leaves the built-in rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'simt.json'), `${JSON.stringify({ index: { parsers: 'not-installed-parsers' } })}\n`);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  const result = await reindex(root, { backend: 'sqlite' });
  assert.equal(result.parsers, 'missing');
  const names = (await readSymbols(root, { backend: 'sqlite' })).map((row) => row.name);
  assert.ok(names.includes('a'));
  await rm(root, { recursive: true, force: true });
});
