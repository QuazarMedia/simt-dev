import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { adapter } from '../src/agenthooks/render.mjs';
import { deliverPrompt } from '../src/agenthooks/prompt.mjs';
import { assembleBrief } from '../src/brief/assemble.mjs';
import { SQLITE_FILE, reindex } from '../src/index/store.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';
import { ensureGit, simt, tempDir } from './fixture.mjs';

const scenario = JSON.parse(await readFile(new URL('./fixtures/retrieval-v2/scenario.json', import.meta.url), 'utf8'));

async function fixture() {
  const root = await realpath(await tempDir('brief-multitask-'));
  const contents = {
    ...scenario.files,
    'simt.json': '{"brief":{"retrieval":"v2"}}',
    'src/authentication-00.mjs': 'export function authenticate() {} // Authentication middleware, refresh token rotation',
  };
  for (const [path, value] of Object.entries(contents)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  await ensureGit(root);
  await mkdir(join(root, '.simt'), { recursive: true });
  const registry = {
    version: 1,
    capabilities: [{ id: 'review', summary: 'Review changes' }],
    skills: scenario.skills.map((skill) => ({
      ...skill, capabilities: ['review'], keywords: skill.summary.toLowerCase().split(' '), bytes: 512,
      sources: [{ repo: 'retrieval-consumer', path: 'SKILL.md', role: 'canonical', bytes: 512 }],
    })),
  };
  await writeFile(join(root, '.simt', 'skills.graph.json'), JSON.stringify(registry));
  await reindex(root, { fielded: true });
  return root;
}

test('both composite probes cover their tasks and stay inside the byte ceiling', async () => {
  const root = await fixture();
  const mixed = await assembleBrief({ root, task: scenario.mixedPrompt, retrieval: 'v2' });
  assert.equal(mixed.composite.subtasks.length, 4);
  for (const [index, path] of scenario.mixedGold.entries()) {
    assert.ok(mixed.sections.FILES.some((line) => line.includes('T' + (index + 1)) && line.includes(path)), mixed.packed.text);
  }
  assert.ok(mixed.packed.after <= 2048);
  assert.deepEqual(mixed.composite.subtasks.at(-1).files.map(({ path }) => path), ['README.md']);

  const composite = await assembleBrief({ root, task: scenario.compositePrompt, retrieval: 'v2' });
  assert.equal(composite.composite.subtasks.length, 4);
  assert.ok(composite.packed.after <= 2048);
  for (const key of ['FILES', 'TESTS', 'DECISIONS', 'SKILLS', 'CAUTIONS']) assert.ok(composite.sections[key]?.length, composite.packed.text);
  for (let id = 1; id <= 4; id += 1) assert.ok(composite.sections.FILES.some((line) => line.startsWith('[T' + id + ']')));
  assert.equal(composite.packed.text.includes('edge-storage'), false);
});

test('CLI, MCP and opted-in prompt delivery use identical rendered content', async () => {
  const root = await fixture();
  const task = scenario.mixedPrompt;
  const index = join(root, SQLITE_FILE);
  const before = await readFile(index);
  const cli = await simt(['brief', task, '--retrieval', 'v2', '--json'], { cwd: root, env: { SIMT_DEV_WORKSPACE: 'off' } });
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  const answer = JSON.parse(cli.stdout);
  assert.equal(answer.retrieval, 'v2');
  const mcp = await TOOLS.find(({ name }) => name === 'brief').run({ root, task, retrieval: 'v2' });
  assert.deepEqual(mcp.sections, answer.sections);
  const result = await deliverPrompt(adapter('claude'), { prompt: task, cwd: root });
  assert.equal(result.json.hookSpecificOutput.additionalContext, answer.text);
  assert.deepEqual(await readFile(index), before);
});

test('the single-task fast path preserves v1 output and constrained v2 retrieval excludes forbidden files', async () => {
  const root = await fixture();
  const task = 'Fix src/rank.mjs';
  const plain = await assembleBrief({ root, task });
  const experimental = await assembleBrief({ root, task, retrieval: 'v2' });
  assert.deepEqual(experimental, plain);
  const constrained = await assembleBrief({
    root, task: 'Fix ranking without changing src/rank.mjs', retrieval: 'v2',
  });
  assert.ok(constrained.sections.CAUTIONS.includes('Do not edit src/rank.mjs.'));
  assert.equal(constrained.sections.SUBTASKS, undefined);
  assert.ok(!constrained.sections.FILES?.some((line) => line.includes('src/rank.mjs')));
});
