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
import { buildRetrievalCorpus, scaleFiles50k } from '../packages/bench/src/multitask-corpus.mjs';
import { evaluateRetrievalGates, runRetrievalAblation } from '../packages/bench/src/ablate.mjs';
import { measureMapPhases, summarizeLatency } from '../packages/bench/src/retrieval-metrics.mjs';

const fixtureCommit = ['-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', '-c', 'user.name=Retrieval Qualification',
  '-c', 'user.email=qualification@example.invalid', 'commit', '-qm'];
const STRATUM_REPETITIONS = 3;
const LATENCY_SAMPLES = 20;
const lexOptions = {
  '+bm25f-ident': { feedbackEnabled: false, directional: false, coupling: false },
  '+guarded-prf': { directional: false, coupling: false },
  '+directional-graph': { feedbackEnabled: false, coupling: false },
  'full-v2': {},
  'v2-candidate': {},
  '+commit-ir': { commitIr: true },
  '+pmi-thesaurus': { conceptMap: true },
  '+qpp-fusion': { qppFusion: true },
  '+sdm-constructs': { sdm: true },
  '+hits-walk': { hitsWalk: true },
  '+nash-pack': {},
  'full-v3': { commitIr: true, conceptMap: true, qppFusion: true, sdm: true, hitsWalk: true },
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
  const dirs = new Set([root]);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    const dir = dirname(file);
    if (!dirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      dirs.add(dir);
    }
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

async function addCommitHistory(root, commits = []) {
  for (const [file, message] of commits) {
    const abs = join(root, file);
    const body = await readFile(abs, 'utf8');
    await writeFile(abs, body + '\n');
    await git(root, ['add', '--', file]);
    await git(root, [...fixtureCommit, message]);
  }
}

async function corpusEvaluation(baseline, baselinePath, directory, corpus, { selected } = {}) {
  const before = join(directory, 'fixture-baseline');
  const after = join(directory, 'fixture-candidate');
  const lexicalBefore = join(directory, 'history-baseline');
  const lexicalAfter = join(directory, 'history-candidate');
  const { files, cochanges, commits = [] } = corpus.fixture;
  const histories = corpus.tasks.some(({ base }) => base) ? [lexicalBefore, lexicalAfter] : [];
  await Promise.all([
    stage(before, files), stage(after, files),
    ...histories.map((path) => git(directory, ['clone', '-q', '--shared', '--no-checkout', baselinePath, path])),
  ]);
  await addCochangeHistory(after, cochanges);
  if (commits.length) await addCommitHistory(after, commits);
  await Promise.all([baseline.reindex(before), reindex(after, { fielded: true })]);

  let current;
  let graph;
  const reusable = new Map();
  return runRetrievalAblation({ tasks: corpus.tasks, gold: corpus.gold, files, selected, async evaluate({ task, arm, budgets }) {
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

    if (['lexical', 'vocabulary-gap', 'zero-overlap-symptom', 'error-literal', 'scale-50k'].includes(task.stratum)) {
      const legacy = task.base ? lexicalBefore : before;
      const fresh = task.base ? lexicalAfter : after;
      const options = lexOptions[arm];
      if (!options) return replay('legacy-ranking', async () => ({
        ranking: (await document(baseline.run, legacy, 'map', [], { task: task.prompt, budget: '8192' })).files.map(({ path }) => path),
      }));
      graph ??= await loadLiveGraph(fresh, { fielded: true, binding: true, cochange: true, commitIr: true, conceptMap: true, hits: true });
      return { ranking: (await rankMapV2(fresh, graph, task.prompt, options)).ranked.map(({ path }) => path) };
    }

    if (task.stratum === 'composite') {
      const split = arm === '+decompose' || arm === 'full-v2' || arm === 'v2-candidate'
        || arm === '+nash-pack' || arm === 'full-v3' || (arm.startsWith('+') && arm in lexOptions);
      const repack = arm === '+submodular-pack' || arm === '+decompose';
      const nash = arm === '+nash-pack' || arm === 'full-v3';
      const scopeSpans = arm === 'full-v3';
      if (!split && !repack) return replay('legacy-packet', async () => {
        const packets = {};
        for (const budget of budgets) {
          const result = await baseline.assembleBrief({ root: before, task: task.prompt, budget, build: false, federate: false });
          packets[budget] = observation(result.items, result.packed);
        }
        return { packets };
      });
      const compositeKey = `composite:${split}:${repack}:${nash}:${scopeSpans}`;
      return replay(compositeKey, async () => {
        const packets = {};
        if (repack) {
          const args = { root: split ? after : before, task: task.prompt, budget: 0, build: false, federate: false };
          const result = split ? await assembleBrief({ ...args, retrieval: 'v2' }) : await baseline.assembleBrief(args);
          const pack = split ? buildPacket : buildCompactPacket;
          for (const budget of budgets) packets[budget] = observation(result.items, pack(result.items, { budget }));
        } else {
          for (const budget of budgets) {
            const result = await assembleBrief({ root: after, task: task.prompt, budget, build: false, federate: false, retrieval: 'v2', nash, scopeSpans });
            packets[budget] = observation(result.items, result.packed);
          }
        }
        return { packets };
      });
    }

    const [impact, why] = task.requests;
    const symbol = arm === '+symbol-bind' || arm === 'full-v2' || arm === 'v2-candidate' || arm === 'full-v3';
    const coupled = arm === '+cochange' || arm === 'full-v2' || arm === 'v2-candidate' || arm === 'full-v3';
    const governs = arm === '+governance' || arm === 'full-v2' || arm === 'v2-candidate' || arm === 'full-v3';
    return replay(`structural:${symbol}:${coupled}:${governs}`, async () => {
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
    });
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

async function scaleEvaluation(baseline, directory, count, { v3 = false } = {}) {
  const paired = count < 50_000;
  const prior = join(directory, `scale-${count}-baseline`);
  const next = join(directory, `scale-${count}-candidate`);
  const files = count >= 50_000 ? scaleFiles50k(count) : scaleFiles(count);
  await (paired ? Promise.all([stage(prior, files), stage(next, files)]) : stage(next, files));
  let indexFullMs = 0;
  if (paired) {
    await Promise.all([baseline.reindex(prior), reindex(next, { fielded: true })]);
  } else {
    const start = performance.now();
    await reindex(next, { fielded: true });
    indexFullMs = performance.now() - start;
  }
  const edit = files['src/rate.mjs'].replace('return 1', 'return 3');
  await Promise.all((paired ? [prior, next] : [next]).map((path) => writeFile(join(path, 'src/rate.mjs'), edit)));
  let indexIncMs = 0;
  if (!paired) {
    await git(next, ['add', 'src/rate.mjs']);
    await git(next, [...fixtureCommit, 'Update rate for incremental reindex timing']);
    const start = performance.now();
    await reindex(next, { fielded: true });
    indexIncMs = performance.now() - start;
    await writeFile(join(next, 'src/rate.mjs'), edit.replace('return 3', 'return 5'));
  }
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
  if (!paired) {
    rows.push({ count, command: 'index-full', baseline: null, candidate: summarizeLatency([indexFullMs]) });
    rows.push({ count, command: 'index-incremental', baseline: null, candidate: summarizeLatency([indexIncMs]) });
  }
  for (const [command, args, oldFlags, newFlags] of commands) {
    process.stderr.write(`qualify ${count} files ${command}\n`);
    const timings = { baseline: [], candidate: [] };
    for (let index = -1; index < LATENCY_SAMPLES; index += 1) {
      const arms = paired
        ? (index % 2 === 1 ? [['candidate', run, next, newFlags], ['baseline', baseline.run, prior, oldFlags]]
          : [['baseline', baseline.run, prior, oldFlags], ['candidate', run, next, newFlags]])
        : [['candidate', run, next, newFlags]];
      for (const [name, engine, root, flags] of arms) {
        const start = performance.now();
        await document(engine, root, command, args, flags);
        if (index >= 0) timings[name].push(performance.now() - start);
      }
    }
    rows.push({
      count,
      command,
      baseline: paired ? summarizeLatency(timings.baseline) : null,
      candidate: summarizeLatency(timings.candidate),
    });
  }
  if (v3) {
    process.stderr.write(`qualify ${count} files map-v3 / brief-v3\n`);
    const v3Map = [];
    const v3Brief = [];
    for (let index = -1; index < LATENCY_SAMPLES; index += 1) {
      let start = performance.now();
      const loaded = await loadLiveGraph(next, { fielded: true, nativeLexical: true, binding: true, cochange: true });
      await rankMapV2(next, loaded, prompt, {
        commitIr: true, conceptMap: true, qppFusion: true, sdm: true, hitsWalk: true,
      });
      if (index >= 0) v3Map.push(performance.now() - start);
      start = performance.now();
      await assembleBrief({
        root: next, task: prompt, budget: 2048, build: false, federate: false,
        retrieval: 'v2', nash: true, scopeSpans: true,
      });
      if (index >= 0) v3Brief.push(performance.now() - start);
    }
    rows.push({
      count,
      command: 'map-v3',
      baseline: rows.find(({ command }) => command === 'map').baseline,
      candidate: summarizeLatency(v3Map),
    });
    rows.push({
      count,
      command: 'brief-v3',
      baseline: rows.find(({ command }) => command === 'brief').baseline,
      candidate: summarizeLatency(v3Brief),
    });
  }
  const graph = await loadLiveGraph(next, { fielded: true, binding: true, cochange: true });
  const phaseSamples = { ftsMs: [], entityMs: [], graphMs: [], couplingMs: [], packMs: [] };
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const phases = await measureMapPhases({ root: next, graph, task: prompt });
    for (const [name, samples] of Object.entries(phaseSamples)) samples.push(phases[name]);
  }
  rows.find(({ command }) => command === 'map').candidate.phases = Object.fromEntries(
    Object.entries(phaseSamples).map(([name, samples]) => [name, summarizeLatency(samples)]));
  return [...rows, await hookEvaluation(count, paired ? prior : null, next, baseline.deliverPrompt, prompt)];
}

async function hookEvaluation(count, prior, next, baseline, prompt) {
  const roots = prior ? [prior, next] : [next];
  for (const root of roots) {
    await writeFile(join(root, 'simt.json'), JSON.stringify({ brief: root === next ? { retrieval: 'v2' } : {} }));
  }
  const calls = prior ? [baseline, deliverPrompt] : [deliverPrompt];
  const row = adapter('claude');
  const durations = roots.map(() => []);
  for (let run = -1; run < LATENCY_SAMPLES; run += 1) {
    const order = roots.length === 2 ? (run % 2 === 0 ? [0, 1] : [1, 0]) : [0];
    for (const index of order) {
      const root = roots[index];
      const start = performance.now();
      const result = await calls[index](row, { prompt, cwd: root }, { root });
      if (run >= 0) durations[index].push(performance.now() - start);
      if (!result.json) throw new Error(`prompt delivery failed: ${result.skipped}`);
    }
  }
  return {
    count,
    command: 'prompt-submit',
    baseline: prior ? summarizeLatency(durations[0]) : null,
    candidate: summarizeLatency(durations[prior ? 1 : 0]),
  };
}

async function main(argv) {
  let suite = 'v2';
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--suite' && argv[i + 1]) {
      suite = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--suite=')) {
      suite = argv[i].slice('--suite='.length);
    } else {
      positional.push(argv[i]);
    }
  }
  const [baselinePath, directory, mode = 'all'] = positional;
  if (!baselinePath || !directory || !['all', 'quality', 'structure', 'scale', 'hooks'].includes(mode) || !['v2', 'v3'].includes(suite)) {
    throw new Error('usage: node scripts/qualify-retrieval.mjs <baseline-checkout> <empty-output-dir> [quality|structure|scale|hooks] [--suite v2|v3]');
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
  const basis = { baseline: await gitText(baselineRoot, ['rev-parse', 'HEAD']), node: process.version, platform: process.platform, suite };
  if (['all', 'quality', 'structure'].includes(mode)) {
    const corpus = await buildRetrievalCorpus(baselineRoot, { includeV3: suite === 'v3' });
    if (mode === 'structure') corpus.tasks = corpus.tasks.filter(({ stratum }) => stratum === 'impact-governance');
    const selected = suite === 'v3'
      ? ['baseline-v1', 'full-v2', 'v2-candidate', '+commit-ir', '+pmi-thesaurus', '+qpp-fusion', '+sdm-constructs', '+hits-walk', '+nash-pack', 'full-v3']
      : undefined;
    const report = await corpusEvaluation(baseline, baselineRoot, output, corpus, { selected });
    await writeFile(join(output, 'quality.json'),
      JSON.stringify({ ...basis, ...report, gates: evaluateRetrievalGates(report) }, null, 2) + '\n');
  }
  if (mode === 'all' || mode === 'scale') {
    const rows = [];
    const sizes = suite === 'v3' ? [10_000, 50_000] : [500, 10_000];
    for (const size of sizes) rows.push(...await scaleEvaluation(baseline, output, size, { v3: suite === 'v3' }));
    await writeFile(join(output, 'scale.json'), JSON.stringify({ ...basis, rows }, null, 2) + '\n');
  }
  if (mode === 'hooks') {
    const rows = [];
    const prompt = 'Fix rate in src/rate.mjs, and add tests for dispatch in src/dispatch.mjs.';
    const sizes = suite === 'v3' ? [10_000, 50_000] : [500, 10_000];
    for (const size of sizes) {
      rows.push(await hookEvaluation(size, join(output, `scale-${size}-baseline`),
        join(output, `scale-${size}-candidate`), baseline.deliverPrompt, prompt));
    }
    await writeFile(join(output, 'hooks.json'), JSON.stringify({ ...basis, rows }, null, 2) + '\n');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
