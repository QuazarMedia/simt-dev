import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { readBindingRows } from '../src/index/binding-cache.mjs';
import { extract } from '../src/index/extract.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

const compact = (rows) => rows.map(({ spec, imported, local }) => [spec, imported, local]);
const exportsOf = (rows) => rows.map(({ spec, exported, original, isStar }) => [spec, exported, original, isStar]);

test('records ES aliases, defaults, namespaces and barrel exports alongside the file graph', () => {
  const text = [
    "import {",
    "  add as plus, subtract, type Options",
    "} from './arithmetic.js';",
    "import formatter, * as formatting from './format.js';",
    "export { plus as sum } from './public.js';",
    "export * from './extras.js';",
    "export * as rules from './rules.js';",
    'export function local() {}',
  ].join('\n');
  for (const lang of ['javascript', 'typescript']) {
    const found = extract('src/index.ts', text, lang);
    assert.deepEqual(compact(found.namedImports), [
      ['./arithmetic.js', 'Options', 'Options'], ['./arithmetic.js', 'add', 'plus'], ['./arithmetic.js', 'subtract', 'subtract'],
      ['./format.js', 'default', 'formatter'], ['./format.js', '*', 'formatting'],
    ]);
    assert.equal(found.namedImports[0].line, 1);
    assert.equal(found.namedImports[3].isDefault, true);
    assert.equal(found.namedImports[4].isNamespace, true);
    assert.deepEqual(exportsOf(found.reexports), [
      ['./public.js', 'sum', 'plus', false], ['./extras.js', '*', '*', true], ['./rules.js', 'rules', '*', false],
    ]);
    assert.deepEqual(found.imports, ['./arithmetic.js', './format.js', './public.js', './extras.js', './rules.js']);
    assert.ok(found.symbols.some(({ name, exported }) => name === 'local' && exported));
  }
});

test('keeps Python relative aliases and explicit re-exports and Rust nested use trees', () => {
  const py = extract('pkg/__init__.py', [
    'from .foo import (', '  bar as handler, unused,', ')',
    'import pkg.helpers as helpers',
    'def call():', '    from .hidden import internal', '    return internal()',
    '__all__ = ["handler", "helpers"]',
  ].join('\n'), 'python');
  assert.deepEqual(compact(py.namedImports), [
    ['.foo', 'bar', 'handler'], ['.foo', 'unused', 'unused'],
    ['pkg.helpers', '*', 'helpers'], ['.hidden', 'internal', 'internal'],
  ]);
  assert.deepEqual(exportsOf(py.reexports), [
    ['.foo', 'handler', 'bar', false], ['pkg.helpers', 'helpers', '*', false],
  ]);
  const rust = extract('src/lib.rs', 'pub use crate::work::{\n  item as used, nested::{Token, *}, self as scope\n};', 'rust');
  assert.deepEqual(compact(rust.namedImports), [
    ['crate::work', '*', 'scope'], ['crate::work', 'item', 'used'],
    ['crate::work::nested', '*', ''], ['crate::work::nested', 'Token', 'Token'],
  ]);
  assert.deepEqual(exportsOf(rust.reexports), [
    ['crate::work', 'scope', '*', false], ['crate::work', 'used', 'item', false],
    ['crate::work::nested', '*', '*', true], ['crate::work::nested', 'Token', 'Token', false],
  ]);
});

test('extracts the statically named forms of the other seven language families', () => {
  const cases = [
    ['go', 'import (\n format "sample/format"\n "example/ledger"\n _ "example/config"\n)', [
      ['sample/format', '*', 'format'], ['example/ledger', '*', 'ledger'], ['example/config', '*', ''],
    ]],
    ['java', 'import sample.Widget;\nimport static sample.Math.round;', [
      ['sample.Widget', 'Widget', 'Widget'], ['sample.Math', 'round', 'round'],
    ]],
    ['kotlin', 'import sample.Widget as View\nimport sample.parts.*', [
      ['sample.Widget', 'Widget', 'View'], ['sample.parts', '*', ''],
    ]],
    ['csharp', 'global using View = Sample.Widget;\nusing static Sample.Math;\nusing (stream) {}', [
      ['Sample.Widget', '*', 'View'], ['Sample.Math', '*', ''],
    ]],
    ['swift', '@testable import Sample\nimport struct Foundation.Date', [
      ['Sample', '*', 'Sample'], ['Foundation', 'Date', 'Date'],
    ]],
    ['dart', "import 'library.dart' as tool show Item hide Other;\nexport 'public.dart' show Foo, Bar;", [
      ['library.dart', '*', 'tool'],
    ]],
    ['ruby', "require_relative 'library'\nautoload :Widget, 'sample/widget'\nrequire resolve('unknown')", [
      ['./library', '*', ''], ['sample/widget', 'Widget', 'Widget'],
    ]],
  ];
  for (const [lang, source, expected] of cases) {
    assert.deepEqual(compact(extract('source', source, lang).namedImports), expected, lang);
  }
  const dart = extract('book.dart', "export 'public.dart' show Foo, Bar;\nexport 'secret.dart' hide Private;", 'dart');
  assert.deepEqual(exportsOf(dart.reexports), [
    ['public.dart', 'Bar', 'Bar', false], ['public.dart', 'Foo', 'Foo', false], ['secret.dart', '*', '*', true],
  ]);
  assert.deepEqual(dart.reexports.at(-1).except, ['Private']);
});

test('ignores apparent imports in block comments, regexes and nested template text', () => {
  const source = [
    "/* import phantom from './comment'; */",
    "const regex = /export \\{ gone \\} from 'fake'/;",
    "const text = \`${\`import phantom from './template'\`}\`;",
    "import('./dynamic');",
    "import { live } from './real';",
  ].join('\n').replaceAll('\\`', '`');
  const found = extract('entry.mjs', source, 'javascript');
  assert.deepEqual(compact(found.namedImports), [['./real', 'live', 'live']]);
  assert.deepEqual(found.reexports, []);
  assert.equal(found.namedImports[0].line, 5);
});

test('persists bindings with each blob and updates just the edited source', async () => {
  const root = await tempDir('extract-bindings-');
  await mkdir(join(root, 'src'));
  const entry = join(root, 'src', 'entry.mjs');
  await writeFile(entry, "import { value as read } from './value.mjs';\n");
  await writeFile(join(root, 'src', 'value.mjs'), "export { default as value } from './backend.mjs';\n");
  await ensureGit(root);
  await reindex(root);
  const first = await readBindingRows(root);
  assert.equal(first.error, null);
  assert.ok(first.files.every(({ available }) => available));
  const value = first.files.find(({ path }) => path === 'src/value.mjs');
  assert.deepEqual(exportsOf(value.reexports), [['./backend.mjs', 'value', 'default', false]]);

  await writeFile(entry, "import { value as other } from './value.mjs';\n");
  await git(['add', 'src/entry.mjs'], { cwd: root });
  assert.equal((await reindex(root)).updated, 1);
  const second = await readBindingRows(root);
  assert.deepEqual(second.files.find(({ path }) => path === 'src/value.mjs'), value);
  assert.deepEqual(compact(second.files.find(({ path }) => path === 'src/entry.mjs').namedImports), [
    ['./value.mjs', 'value', 'other'],
  ]);
});
