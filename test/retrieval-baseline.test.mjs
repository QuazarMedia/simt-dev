import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { ensureGit, simt, tempDir } from './fixture.mjs';

const fixtures = new URL('./fixtures/retrieval-v2/', import.meta.url);
const readFixture = async (name) => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
const facets = ['FILES', 'TESTS', 'DECISIONS', 'SKILLS', 'LESSONS', 'CAUTIONS'];

async function stageConsumer(root, { files, skills }) {
  const registry = {
    version: 1,
    capabilities: [{ id: 'review', summary: 'Review changes' }],
    skills: skills.map((skill) => ({
      ...skill,
      capabilities: ['review'],
      keywords: skill.summary.toLowerCase().split(' '),
      bytes: 512,
      sources: [{ repo: 'retrieval-consumer', path: 'SKILL.md', role: 'canonical', bytes: 512 }],
    })),
  };
  const source = { ...files };
  // Heavy symbol outlines put the old waterfall packer under pressure at its real cap.
  for (let index = 0; index < 22; index += 1) {
    const id = String(index).padStart(2, '0');
    source[`src/authentication-${id}.mjs`] = Array.from(
      { length: 12 },
      (_, part) => `export const refreshTokenRotationPolicy${id}Stage${part} = ${part};`,
    ).join('\n') + '\n';
  }
  await Promise.all(Object.entries(source).map(async ([file, content]) => {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
  await ensureGit(root);
  await mkdir(join(root, '.simt'), { recursive: true });
  await writeFile(join(root, '.simt', 'skills.graph.json'), JSON.stringify(registry));
}

test('retrieval v1 records four failure classes and six CLI envelopes in an isolated consumer', async () => {
  const scenario = await readFixture('scenario.json');
  const root = await realpath(await tempDir('retrieval-baseline-'));
  await stageConsumer(root, scenario);
  const env = { SIMT_DEV_WORKSPACE: 'off' };
  async function probe(args) {
    const { code, stdout, stderr } = await simt([...args, '--json'], { cwd: root, env, timeout: 15_000 });
    let answer;
    try {
      answer = JSON.parse(stdout);
    } catch (cause) {
      throw new Error(`${args[0]} (exit ${code}): ${stdout}\n${stderr}`, { cause });
    }
    const { root: reportedRoot, ...payload } = answer;
    assert.equal(reportedRoot, root, stdout);
    return { code, payload };
  }

  const mixed = await probe(['brief', scenario.mixedPrompt, '--retrieval', 'v1']);
  const composite = await probe(['brief', scenario.compositePrompt, '--explain', '--retrieval', 'v1']);
  const map = await probe(['map', '--task', scenario.mixedPrompt, '--retrieval', 'v1']);
  const impact = await probe(['impact', 'rankRecords', '--retrieval', 'v1']);
  const why = await probe(['why', 'src/rank.mjs', '--retrieval', 'v1']);
  const gate = await probe(['gate', 'src/inventory.mjs']);
  const check = await probe(['check']);
  const metrics = {
    mixedTaskCoverage: scenario.mixedGold.filter((file) =>
      mixed.payload.sections.FILES.some((line) => line.split(' ', 1)[0] === file)).length / scenario.mixedGold.length,
    survivingFacets: facets.filter((facet) => composite.payload.sections[facet]?.length > 0),
    unrelatedImpactTests: impact.payload.tests.filter((path) => path === 'test/format.test.mjs'),
    foreignSkills: why.payload.items.filter((item) => item.id === 'edge-storage').map((item) => item.id),
  };
  const observed = { metrics, mixed, composite, map, impact, why, gate, check };
  assert.deepEqual(observed, await readFixture('baseline.json'));
});
