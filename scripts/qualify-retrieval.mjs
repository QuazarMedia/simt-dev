// Run with an isolated checkout of the baseline and an empty writable output directory.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deliverPrompt } from '../src/agenthooks/prompt.mjs';
import { adapter } from '../src/agenthooks/render.mjs';
import { assembleBrief } from '../src/brief/assemble.mjs';
import { buildPacket, keptSections } from '../src/brief/packet.mjs';
import { buildCompactPacket } from '../src/brief/render.mjs';
import { loadLiveGraph } from '../src/index/live.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { reindex } from '../src/index/store.mjs';
import { run } from '../src/run.mjs';
import { git, gitText } from '../src/sys/git.mjs';
import { buildRetrievalCorpus } from '../packages/bench/src/multitask-corpus.mjs';
import { runRetrievalAblation } from '../packages/bench/src/ablate.mjs';
import { summarizeLatency } from '../packages/bench/src/retrieval-metrics.mjs';

const fixtureCommit = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Retrieval Qualification',
  '-c', 'user.email=qualification@example.invalid', 'commit', '-qm'];
const STRATUM_REPETITIONS = 3;
const LATENCY_SAMPLES = 20;
const lexOptions = {
  '+bm25f-ident': { feedbackEnabled: false, directional: false, coupling: false },
  '+guarded-prf': { directional: false, coupling: false },
  '+directional-graph': { feedbackEnabled: false, coupling: false },
  'full-v2': {},
};

async function document(engine, root, command, args = [], flags = {}) {
  const result = await engine(command, { root, args, flags: { json: true, ...flags } });
  if (!result.documents[0] || (!result.ok && command !== 'check')) {
    throw new Error(`${command} failed: ${JSON.stringify(result.error ?? result.documents[0])}`);
  }
  return result.documents[0];
}

async function stage(root, files) {
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await git(root, ['init', '-q']);
  await git(root, ['add', '--', '.']);
  await git(root, [...fixtureCommit, 'Create fixture']);
}

async function addCochangeHistory(root, pairs) {
  for (const [source, partner] of pairs) {
    const code = await readFile(join(root, source), 'utf8');
    for (let index = 0; index < 2; index += 1) {
      await writeFile(join(root, source), code + `// revision ${index}\n`);
      await writeFile(join(root, partner), JSON.stringify({ enabled: index !== 0 }) + '\n');
      await git(root, ['add', '--', source, partner]);
      await git(root, [...fixtureCommit, 'Update coupled files']);
    }
  }
}

function observation(items, packed) {
  const sections = keptSections(items, packed.cut);
  const tokens = (lines = []) => [...new Set(lines.join(' ').match(/[\w@./-]+/gu) ?? [])];
  const facets = Object.fromEntries(Object.entries(sections).map(([facet, lines]) => [facet, tokens(lines)]));
  return { text: packed.text, files: facets.FILES ?? [], facets };
}

async function corpusEvaluation(baseline, baselinePath, directory, corpus) {
  const before = join(directory, 'fixture-baseline');
  const after = join(directory, 'fixture-candidate');
  const lexicalBefore = join(directory, 'history-baseline');
  const lexicalAfter = join(directory, 'history-candidate');
  const { files, cochanges } = corpus.fixture;
  const histories = corpus.tasks.some(({ base }) => base) ? [lexicalBefore, lexicalAfter] : [];
  await Promise.all([
    stage(before, files), stage(after, files),
    ...histories.map((path) => git(directory, ['clone', '-q', '--shared', '--no-checkout', baselinePath, path])),
  ]);
  await addCochangeHistory(after, cochanges);
  await Promise.all([baseline.reindex(before), reindex(after, { fielded: true })]);

  let current;
  let graph;
  const reusable = new Map();
  return runRetrievalAblation({ tasks: corpus.tasks, gold: corpus.gold, files, async evaluate({ task, arm, budgets }) {
    if (current !== task.id) {
      current = task.id;
      reusable.clear();
      if (task.base) {
        await Promise.all([lexicalBefore, lexicalAfter].map((path) =>
          git(path, ['checkout', '-q', '--detach', task.base])));
        await Promise.all([baseline.reindex(lexicalBefore), reindex(lexicalAfter, { fielded: true })]);
      }
      graph = null;
      process.stderr.write(`qualify ${task.stratum} ${task.id}\n`);
    }

    function replay(key, load) {
      if (!reusable.has(key)) reusable.set(key, { rows: [], count: 0 });
      const entry = reusable.get(key);
      const index = entry.count % STRATUM_REPETITIONS;
      entry.count += 1;
      entry.rows[index] ??= load();
      return entry.rows[index];
    }

    if (task.stratum === 'lexical' || task.stratum === 'vocabulary-gap') {
      const legacy = task.base ? lexicalBefore : before;
      const fresh = task.base ? lexicalAfter : after;
      const options = lexOptions[arm];
      if (!options) return replay('legacy-ranking', async () => ({
        ranking: (await document(baseline.run, legacy, 'map', [], { task: task.prompt, budget: '8192' })).files.map(({ path }) => path),
      }));
      graph ??= await loadLiveGraph(fresh, { fielded: true, binding: true, cochange: true });
      return { ranking: (await rankMapV2(fresh, graph, task.prompt, options)).ranked.map(({ path }) => path) };
    }

    if (task.stratum === 'composite') {
      const split = arm === '+decompose' || arm === 'full-v2';
      const repack = arm === '+submodular-pack' || arm === '+decompose';
      if (!split && !repack) return replay('legacy-packet', async () => {
        const packets = {};
        for (const budget of budgets) {
          const result = await baseline.assembleBrief({ root: before, task: task.prompt, budget, build: false, federate: false });
          packets[budget] = observation(result.items, result.packed);
        }
        return { packets };
      });
      const packets = {};
      if (repack) {
        const args = { root: split ? after : before, task: task.prompt, budget: 0, build: false, federate: false };
        const result = split ? await assembleBrief({ ...args, retrieval: 'v2' }) : await baseline.assembleBrief(args);
        const pack = split ? buildPacket : buildCompactPacket;
        for (const budget of budgets) packets[budget] = observation(result.items, pack(result.items, { budget }));
      } else {
        for (const budget of budgets) {
          const result = await assembleBrief({ root: after, task: task.prompt, budget, build: false, federate: false, retrieval: 'v2' });
          packets[budget] = observation(result.items, result.packed);
        }
      }
      return { packets };
    }

    const [impact, why] = task.requests;
    const symbol = arm === '+symbol-bind' || arm === 'full-v2';
    const coupled = arm === '+cochange' || arm === 'full-v2';
    const governs = arm === '+governance' || arm === 'full-v2';
    const legacy = await replay('legacy-structural', async () => ({
      impact: await document(baseline.run, before, 'impact', [why.target]),
      why: await document(baseline.run, before, 'why', [why.target]),
    }));
    const precise = symbol || coupled
      ? await document(run, after, 'impact', [`${why.target}#${impact.target}`], { retrieval: 'v2' }) : null;
    const reach = symbol ? precise : legacy.impact;
    const policy = governs ? await document(run, after, 'why', [why.target], { retrieval: 'v2' }) : legacy.why;
    return {
      impact: [...reach.importers, ...reach.tests, ...(coupled ? precise.cochange.map(({ dst }) => dst) : [])],
      governance: policy.items.filter(({ kind }) => ['decision', 'rule', 'skill'].includes(kind)).map(({ id }) => id),
    };
  } });
}

function scaleFiles(count) {
  const files = {
    'package.json': '{"name":"scale-fixture","type":"module","scripts":{"test":"node --test"}}\n',
    '.gitignore': '.simt/\n',
    'test/dispatch.test.mjs': 'import { dispatch } from "../src/dispatch.mjs";\nif (dispatch() < 1) throw new Error("dispatch");\n',
    'src/dispatch.mjs': 'import { rate } from "./rate.mjs";\nexport function dispatch() { return rate(); }\n',
    'src/rate.mjs': 'export function rate() { return 1; }\nexport function quota() { return 2; }\n',
    'src/profile.mjs': 'import { quota } from "./rate.mjs";\nexport function profile() { return quota(); }\n',
    'docs/decisions/ADR-001-rate.md': '# ADR-001 — Rate\n\nStatus: accepted\n\nAffects: `src/rate.mjs`\n',
  };
  for (let i = Object.keys(files).length; i < count; i += 1) {
    files[`src/modules/m${String(i).padStart(5, '0')}.mjs`] = `export const moduleValue${i} = ${i};\n`;
  }
  return files;
}

async function scaleEvaluation(baseline, directory, count) {
  const prior = join(directory, `scale-${count}-baseline`);
  const next = join(directory, `scale-${count}-candidate`);
  const files = scaleFiles(count);
  await Promise.all([stage(prior, files), stage(next, files)]);
  await Promise.all([baseline.reindex(prior), reindex(next, { fielded: true })]);
  const edit = files['src/rate.mjs'].replace('return 1', 'return 3');
  await Promise.all([prior, next].map((path) => writeFile(join(path, 'src/rate.mjs'), edit)));
  const prompt = 'Fix rate in src/rate.mjs, and add tests for dispatch in src/dispatch.mjs.';
  const common = { changed: true };
  const commands = [
    ['brief', [prompt], {}, { retrieval: 'v2' }],
    ['map', [], { task: prompt }, { task: prompt, retrieval: 'v2' }],
    ['impact', ['rate'], {}, { retrieval: 'v2' }],
    ['why', ['src/rate.mjs'], {}, { retrieval: 'v2' }],
    ['check', [], {}, common],
    ['gate', [], common, { ...common, precise: true }],
  ];
  const rows = [];
  for (const [command, args, oldFlags, newFlags] of commands) {
    process.stderr.write(`qualify ${count} files ${command}\n`);
    const timings = { baseline: [], candidate: [] };
    for (let index = -1; index < LATENCY_SAMPLES; index += 1) {
      const arms = [['baseline', baseline.run, prior, oldFlags], ['candidate', run, next, newFlags]];
      if (index % 2 === 1) arms.reverse();
      for (const [name, engine, root, flags] of arms) {
        const start = performance.now();
        await document(engine, root, command, args, flags);
        if (index >= 0) timings[name].push(performance.now() - start);
      }
    }
    rows.push({ count, command, ...Object.fromEntries(Object.entries(timings)
      .map(([name, measurements]) => [name, summarizeLatency(measurements)])) });
  }
  return [...rows, await hookEvaluation(count, prior, next, baseline.deliverPrompt, prompt)];
}

async function hookEvaluation(count, prior, next, baseline, prompt) {
  const roots = [prior, next];
  for (const [index, root] of roots.entries()) {
    await writeFile(join(root, 'simt.json'), JSON.stringify({ brief: index ? { retrieval: 'v2' } : {} }));
  }
  const calls = [baseline, deliverPrompt];
  const row = adapter('claude');
  const durations = [[], []];
  for (let run = -1; run < LATENCY_SAMPLES; run += 1) {
    for (const index of run % 2 === 0 ? [0, 1] : [1, 0]) {
      const root = roots[index];
      const start = performance.now();
      const result = await calls[index](row, { prompt, cwd: root }, { root });
      if (run >= 0) durations[index].push(performance.now() - start);
      if (!result.json) throw new Error(`prompt delivery failed: ${result.skipped}`);
    }
  }
  return { count, command: 'prompt-submit', baseline: summarizeLatency(durations[0]), candidate: summarizeLatency(durations[1]) };
}

async function main([baselinePath, directory, mode = 'all']) {
  if (!baselinePath || !directory || !['all', 'quality', 'structure', 'scale', 'hooks'].includes(mode)) {
    throw new Error('usage: node scripts/qualify-retrieval.mjs <baseline-checkout> <empty-output-dir> [quality|structure|scale|hooks]');
  }
  const baselineRoot = resolve(baselinePath);
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  process.env.SIMT_DEV_WORKSPACE = 'off';
  const atBaseline = (path) => import(pathToFileURL(join(baselineRoot, path)).href);
  const baseline = Object.assign({}, ...await Promise.all([
    atBaseline('src/run.mjs'), atBaseline('src/brief/assemble.mjs'), atBaseline('src/index/store.mjs'),
    atBaseline('src/agenthooks/prompt.mjs'),
  ]));
  const basis = { baseline: await gitText(baselineRoot, ['rev-parse', 'HEAD']), node: process.version, platform: process.platform };
  if (['all', 'quality', 'structure'].includes(mode)) {
    const corpus = await buildRetrievalCorpus(baselineRoot);
    if (mode === 'structure') corpus.tasks = corpus.tasks.filter(({ stratum }) => stratum === 'impact-governance');
    const report = await corpusEvaluation(baseline, baselineRoot, output, corpus);
    await writeFile(join(output, 'quality.json'), JSON.stringify({ ...basis, ...report }, null, 2) + '\n');
  }
  if (mode === 'all' || mode === 'scale') {
    const rows = [];
    for (const size of [500, 10000]) rows.push(...await scaleEvaluation(baseline, output, size));
    await writeFile(join(output, 'scale.json'), JSON.stringify({ ...basis, rows }, null, 2) + '\n');
  }
  if (mode === 'hooks') {
    const rows = [];
    const prompt = 'Fix rate in src/rate.mjs, and add tests for dispatch in src/dispatch.mjs.';
    for (const size of [500, 10000]) {
      rows.push(await hookEvaluation(size, join(output, `scale-${size}-baseline`),
        join(output, `scale-${size}-candidate`), baseline.deliverPrompt, prompt));
    }
    await writeFile(join(output, 'hooks.json'), JSON.stringify({ ...basis, rows }, null, 2) + '\n');
  }
}

await main(process.argv.slice(2));
