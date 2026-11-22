import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { before, test } from 'node:test';

import {
  buildRetrievalCorpus, naiveRetrieval, RETRIEVAL_STRATA, SUBTASK_COUNTS, validateRetrievalCorpus,
} from '../packages/bench/src/multitask-corpus.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

let root;
let corpus;
before(async () => {
  root = await tempDir('retrieval-history-');
  await writeFile(join(root, 'README.md'), '# Retrieval history\n');
  await mkdir(join(root, 'test'));
  await mkdir(join(root, 'src'));
  for (let index = 0; index < 30; index += 1) {
    await writeFile(join(root, 'src', `route-${index}.mjs`), 'export const route = null;\n');
  }
  await ensureGit(root);
  for (let index = 0; index < 30; index += 1) {
    await writeFile(join(root, 'src', `route-${index}.mjs`), `export const route = ${index};\n`);
    await writeFile(join(root, 'test', `route-${index}.test.mjs`), `import '../src/route-${index}.mjs';\n`);
    await git(['add', '--', 'src', 'test'], { cwd: root });
    await git(['commit', '-qm', `Fix route-${index} response`], { cwd: root });
  }
  await writeFile(join(root, 'src', 'new-route.mjs'), 'export const route = 30;\n');
  await writeFile(join(root, 'test', 'new-route.test.mjs'), "import '../src/new-route.mjs';\n");
  await git(['add', '--', 'src', 'test'], { cwd: root });
  await git(['commit', '-qm', 'Add a new route'], { cwd: root });
  corpus = await buildRetrievalCorpus(root);
});

test('mines history, balances all four strata, and keeps gold outside public descriptors', async () => {
  const { tasks, gold } = corpus;
  assert.equal(tasks.length, 120);
  for (const stratum of RETRIEVAL_STRATA) {
    assert.equal(tasks.filter((task) => task.stratum === stratum).length, 30);
  }

  const lexical = tasks.filter(({ stratum }) => stratum === 'lexical');
  assert.equal(new Set(lexical.map(({ base }) => base)).size, lexical.length);
  for (const task of lexical) {
    const file = gold[task.id].files[0];
    assert.match(file, /^src\/route-\d+\.mjs$/);
    assert.ok(task.prompt.includes(basename(file, extname(file))));
    await git(['cat-file', '-e', `${task.base}:${file}`], { cwd: root });
  }

  const composite = tasks.filter(({ stratum }) => stratum === 'composite');
  for (const count of SUBTASK_COUNTS) {
    assert.equal(composite.filter(({ id }) => gold[id].subtasks.length === count).length, 6);
  }
  const positive = composite.map(({ prompt }) => prompt.split('\n').filter((line) => line.startsWith('- ')).join('\n'));
  assert.equal(positive.filter((prompt) => /\bin src\/[\w-]+\.mjs\.$/m.test(prompt)).length, 10);
  assert.equal(positive.filter((prompt) => /\bin [\w-]+\.mjs\.$/m.test(prompt)).length, 10);
  assert.equal(composite.filter(({ prompt }) => prompt.includes('Do not modify ')).length, 15);
  assert.equal(composite.filter(({ id }) => gold[id].excludes.length > 0).length, 15);

  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(), [
      ...['id', 'prompt', 'stratum'],
      ...(task.stratum === 'lexical' ? ['base'] : task.stratum === 'impact-governance' ? ['requests'] : []),
    ].sort());
  }
  assert.equal(JSON.stringify(await buildRetrievalCorpus(root)), JSON.stringify(corpus));
});

test('rejects missing, duplicate, orphaned and publicly leaked labels', async () => {
  const { tasks, gold } = corpus;
  const [first, ...rest] = tasks;
  const missing = { ...gold };
  delete missing[first.id];
  assert.throws(() => validateRetrievalCorpus({ tasks, gold: missing }), /missing or invalid retrieval gold/);
  assert.throws(() => validateRetrievalCorpus({ tasks: [...tasks, first], gold }), /duplicate retrieval task ID/);
  assert.throws(() => validateRetrievalCorpus({ tasks, gold: { ...gold, orphan: gold[first.id] } }), /orphan task IDs/);
  assert.throws(() => validateRetrievalCorpus({ tasks: [{ ...first, gold: gold[first.id] }, ...rest], gold }), /invalid public/);
  const bad = { ...gold, [first.id]: { ...gold[first.id], subtasks: Array(8).fill(gold[first.id].subtasks[0]) } };
  assert.throws(() => validateRetrievalCorpus({ tasks, gold: bad }), /unbalanced/);
  await assert.rejects(buildRetrievalCorpus(await tempDir('retrieval-no-history-')), /could not mine retrieval history/);
});

test('fixture gold exists and a lexical-only control misses vocabulary and composite targets', () => {
  const { tasks, gold, fixture } = corpus;
  const paths = Object.keys(fixture.files);
  const skills = JSON.parse(fixture.files['.simt/skills.graph.json']).skills;
  let relevant = 0;
  let recoveredByOracle = 0;
  let vocabularyMisses = 0;
  let compositeMisses = 0;
  for (const task of tasks) {
    const label = gold[task.id];
    if (task.stratum === 'lexical') continue;
    if (task.stratum === 'impact-governance') {
      const [impact, why] = task.requests;
      assert.ok(fixture.files[why.target].includes(`function ${impact.target}(`));
      const { dependents, cochange, hubOnly } = label.impact;
      assert.equal(dependents.length, 3);
      assert.ok(fixture.files[dependents[0]].includes(`export { ${impact.target} }`));
      assert.ok(fixture.files[dependents[1]].includes(`${impact.target}('ready')`));
      assert.ok(fixture.files[dependents[2]].includes('runtime/'));
      assert.ok(hubOnly.every((file) => !dependents.includes(file)));
      assert.ok(fixture.cochanges.some(([source, partner]) => source === why.target && cochange.includes(partner)));
      const [adr, rule, skill] = label.governance;
      assert.ok(fixture.files[`docs/decisions/${adr}-maintenance.md`].includes(why.target));
      assert.ok(fixture.files[`rules/${rule}.md`].includes(why.target));
      assert.ok(skills.find(({ name }) => name === skill).paths.includes(why.target));
      continue;
    }
    const targets = label.files ?? label.subtasks.flatMap(({ files }) => files);
    const naive = new Set(naiveRetrieval(task.prompt, paths));
    const present = targets.filter((path) => typeof fixture.files[path] === 'string');
    relevant += targets.length;
    recoveredByOracle += present.length;
    if (task.stratum === 'vocabulary-gap' && !naive.has(targets[0])) vocabularyMisses += 1;
    if (task.stratum === 'composite' && targets.some((path) => !naive.has(path))) compositeMisses += 1;
  }
  assert.equal(recoveredByOracle / relevant, 1);
  assert.equal(vocabularyMisses, 30);
  assert.equal(compositeMisses, 30);
});
