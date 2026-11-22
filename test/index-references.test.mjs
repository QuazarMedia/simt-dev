import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { readBindingRows } from '../src/index/binding-cache.mjs';
import { extractReferences } from '../src/index/references.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

function referenceTuples(chunk) {
  return chunk.references.map(({ callerSym, kind, localName, memberName }) => [callerSym, kind, localName, memberName]);
}

test('records scoped calls and qualified references across supported language families', () => {
  const cases = [
    ['entry.ts', 'typescript', "import * as api from './api';\nfunction run() { api.fetch(); }", 'api'],
    ['entry.js', 'javascript', "import * as api from './api';\nconst run = () => { api.fetch(); }", 'api'],
    ['entry.py', 'python', 'import api\ndef run():\n    api.fetch()\napi.fetch()', 'api'],
    ['entry.go', 'go', 'package main\nimport api "example/api"\nfunc (h Handler) run() { api.fetch() }', 'api'],
    ['entry.rs', 'rust', 'use crate::api::{self as api};\nfn run() { api::fetch(); }', 'api'],
    ['Entry.java', 'java', 'import sample.Api;\nclass Entry { void run() { Api.fetch(); } }', 'Api'],
    ['Entry.kt', 'kotlin', 'import sample.Api as api\nclass Entry { fun run() = api.fetch() }', 'api'],
  ];
  for (const [path, lang, source, local] of cases) {
    const chunk = extractReferences(path, source, lang);
    const expected = [['run', 'call', local, 'fetch']];
    if (lang === 'python') expected.push([null, 'call', local, 'fetch']);
    assert.deepEqual(referenceTuples(chunk), expected, lang);
    const scope = chunk.scopes.find(({ symbol }) => symbol === 'run');
    assert.equal(chunk.references[0].callerScope, scope.id, lang);
    if (lang === 'java' || lang === 'kotlin') assert.equal(scope.qualifiedName, 'Entry.run');
  }
});

test('distinguishes inheritance, type annotations, imported values and shadowed calls', () => {
  const source = [
    "import { Base, Shape, helper } from './api';",
    "import * as api from './namespace';",
    'class Figure extends api.Base implements Shape {',
    '  draw(helper: Shape) { helper(); return new Base(); }',
    '}',
    'function choose() { return helper; }',
    'function compute() { return api[key](); }',
    "import('./dynamic');",
  ].join('\n');
  const chunk = extractReferences('entry.ts', source, 'typescript');
  assert.deepEqual(referenceTuples(chunk), [
    ['Figure', 'inherits', 'api', 'Base'],
    ['Figure', 'inherits', 'Shape', null],
    ['draw', 'type', 'Shape', null],
    ['draw', 'call', 'helper', null],
    ['draw', 'call', 'Base', null],
    ['choose', 'ref', 'helper', null],
  ]);
  assert.equal(chunk.references[3].shadowed, true);
  assert.equal(chunk.references[5].shadowed, undefined);
  assert.deepEqual(chunk.unresolved.map(({ kind, spec }) => [kind, spec]), [
    ['computed-member', undefined], ['dynamic-import', './dynamic'],
  ]);
  assert.deepEqual(referenceTuples(extractReferences('entry.py', 'class Figure(api.Base, Shape):\n    pass', 'python')), [
    ['Figure', 'inherits', 'api', 'Base'], ['Figure', 'inherits', 'Shape', null],
  ]);
});

test('ignores literals and comments and retains calls after multiline imports', () => {
  const source = [
    'import {', '  live as run, phantom', "} from './api'; run();",
    '/** fake() */',
    "const text = 'phantom()';",
    'const regex = /phantom()/;',
    '`phantom() ${`alsoFake()`}`;',
    "const punctuation = '(';",
    'function use() { /* fake() */ run(); }',
  ].join('\n');
  assert.deepEqual(referenceTuples(extractReferences('entry.mjs', source, 'javascript')), [
    [null, 'call', 'run', null], ['use', 'call', 'run', null],
  ]);
  const python = 'def run():\n    """ghost()"""\n    # ghost()\n    return live()';
  assert.deepEqual(referenceTuples(extractReferences('entry.py', python, 'python')), [['run', 'call', 'live', null]]);
});

test('reindex refreshes the reference chunk for just the edited file', async () => {
  const root = await tempDir('index-references-');
  await writeFile(join(root, 'entry.mjs'), "import * as api from './api.mjs';\nfunction run() { api.first(); }");
  await writeFile(join(root, 'api.mjs'), 'export function first() { return helper(); }');
  await ensureGit(root);
  await reindex(root);
  const first = await readBindingRows(root);
  assert.equal(first.error, null);
  assert.deepEqual(referenceTuples(first.files.find(({ path }) => path === 'entry.mjs').chunk), [['run', 'call', 'api', 'first']]);

  await writeFile(join(root, 'entry.mjs'), "import * as api from './api.mjs';\nfunction run() { api.second(); }");
  await git(['add', 'entry.mjs'], { cwd: root });
  assert.equal((await reindex(root)).updated, 1);
  const second = await readBindingRows(root);
  assert.equal(second.error, null);
  assert.deepEqual(second.files.find(({ path }) => path === 'api.mjs'), first.files.find(({ path }) => path === 'api.mjs'));
  assert.deepEqual(referenceTuples(second.files.find(({ path }) => path === 'entry.mjs').chunk), [['run', 'call', 'api', 'second']]);
});
