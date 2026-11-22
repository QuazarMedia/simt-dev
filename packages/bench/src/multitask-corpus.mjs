import { basename, extname } from 'node:path';

import { gitPaths } from '../../../src/sys/git.mjs';
import { isTestPath } from '../../../src/testing/paths.mjs';
import { STOPWORDS, tokenize } from '../../../src/text/tokens.mjs';
import { cmp } from '../../../src/util/sort.mjs';
import { listCandidates } from './mine.mjs';

export const SUBTASK_COUNTS = Object.freeze([2, 3, 4, 6, 8]);
export const RETRIEVAL_STRATA = Object.freeze(['lexical', 'vocabulary-gap', 'composite', 'impact-governance']);

const VOCABULARY = [
  ['renewal', 'rotateCredentials', 'People get logged out too early while browsing'],
  ['quota', 'allocateAllowance', 'Customers can submit too many requests at once'],
  ['dedupe', 'assignIdempotencyKey', 'Double-clicking a button creates two orders'],
  ['backoff', 'scheduleRetry', 'The application hammers the server during an outage'],
  ['cursor', 'encodeContinuation', 'The next page repeats the last few results'],
  ['retention', 'pruneHistory', 'Old activity stays visible after the cleanup deadline'],
  ['normalization', 'foldDisplayName', 'The same person appears twice with different accents'],
  ['invalidation', 'evictEntry', 'A changed profile picture keeps showing the old version'],
  ['reconciliation', 'mergeStatements', 'Payments listed by the bank never appear in the ledger'],
  ['coalescing', 'joinPendingRead', 'Opening several tabs causes identical requests'],
  ['heartbeat', 'sendKeepalive', 'Idle connections close while an operator is away'],
  ['backpressure', 'pauseProducer', 'Memory grows without bound when downloads are slow'],
  ['rounding', 'quantizeAmount', 'The total differs from the receipt by a penny'],
  ['handoff', 'transferOwnership', 'A disconnected worker leaves new jobs stuck forever'],
  ['bucketing', 'assignWindow', 'Midnight activity gets counted under the previous date'],
  ['encoding', 'escapeDelimiter', 'A comma in a customer name shifts spreadsheet columns'],
  ['fingerprinting', 'computeDigest', 'Edited downloads are marked identical to the originals'],
  ['partitioning', 'pickShard', 'One machine receives nearly all customers'],
  ['deferred', 'enqueueOutbox', 'Receipts are missing after the purchase finishes'],
  ['compaction', 'mergeSegments', 'The archive gets bigger although records are removed'],
  ['hydration', 'restoreSnapshot', 'An unsaved draft disappears after a reload'],
  ['redaction', 'maskValue', 'Private phone numbers appear in exported reports'],
  ['fairness', 'advanceTurn', 'Small jobs wait indefinitely behind heavy ones'],
  ['unpacking', 'expandBundle', 'Uploaded archives show empty directories'],
  ['fallback', 'selectReplica', 'The screen goes blank when the primary region fails'],
  ['negotiation', 'chooseLocale', 'Visitors see text in a language they cannot read'],
  ['debouncing', 'deferSearch', 'Typing each character sends a new search request'],
  ['collation', 'compareLabels', 'Titles beginning with accented letters sort at the end'],
  ['conversion', 'resolveOffset', 'Meeting reminders are an hour early after the clocks change'],
  ['recovery', 'replayJournal', 'Recent edits vanish after a crash and restart'],
];

const COMPOSITE = [
  ['bugfix', 'Fix the symptom where'],
  ['feature', 'Add diagnostics for the case where'],
  ['refactor', 'Refactor the handling of the case where'],
  ['tests', 'Add regression tests for the case where'],
  ['config', 'Migrate the configuration for the case where'],
  ['docs', 'Document what to do when'],
  ['feature', 'Add a warning for the case where'],
  ['tests', 'Test the recovery path where'],
];

const MIN_CASES = Math.max(...SUBTASK_COUNTS);
const publicFields = new Set(['id', 'stratum', 'prompt', 'requests', 'base']);
const retrievalFacets = new Set(['FILES', 'TESTS', 'DECISIONS', 'SKILLS', 'LESSONS', 'CAUTIONS']);

async function lexicalCases(root, candidates, count) {
  const mined = new Map();
  for (const candidate of candidates) {
    if (!candidate.prompt || mined.has(candidate.sha)) continue;
    // A retrieval arm searches the parent tree. Files first introduced by the
    // fix could never be found in that tree, even by an ideal ranker.
    const changed = await gitPaths(root, ['diff', '--no-renames', '--diff-filter=MDT', '--name-only', candidate.base, candidate.sha]);
    const files = changed.filter((path) => !isTestPath(path)).sort(cmp);
    if (files.length > 0) {
      mined.set(candidate.sha, {
        task: {
          id: `lexical-${candidate.sha}`, stratum: 'lexical',
          prompt: candidate.prompt, base: candidate.base,
        },
        label: { files },
      });
    }
    if (mined.size === count) break;
  }
  if (mined.size < count) {
    throw new Error(`lexical corpus needs ${count} history candidates; found ${mined.size}`);
  }
  return [...mined.values()];
}

function fixtureCases(files, count) {
  return VOCABULARY.slice(0, count).map(([name, symbol, symptom], index) => {
    const id = String(index + 1).padStart(3, '0');
    const source = `src/${name}.mjs`;
    const barrel = `src/public/${name}.mjs`;
    const caller = `src/runtime/${name}.mjs`;
    const partner = `src/config/${name}.json`;
    const dispatcher = `src/dispatch/${name}.mjs`;
    const unrelatedTest = `test/${name}-health.test.mjs`;
    const rule = `maintain-${name}`;
    const skill = `operate-${name}`;
    const adr = `ADR-${id}`;
    const test = `test/${name}.test.mjs`;
    const docs = `docs/guides/${name}.md`;
    const lesson = `${id}-${name}`;
    const health = `${symbol}Health`;
    files[source] = `// ${symptom}\nexport function ${symbol}(value) { return value; }\nexport const ${health} = true;\n`;
    files[barrel] = `export { ${symbol} } from '../${name}.mjs';\n`;
    files[caller] = `import { ${symbol} } from '../public/${name}.mjs';\nexport const observed = ${symbol}('ready');\n`;
    files[partner] = '{"enabled":true}\n';
    files[dispatcher] = `import { ${health} } from '../${name}.mjs';\nexport const healthy = ${health};\n`;
    files[test] = `import assert from 'node:assert/strict';\nimport { observed } from '../src/runtime/${name}.mjs';\nassert.equal(observed, 'ready');\n`;
    files[unrelatedTest] = `import assert from 'node:assert/strict';\nimport { healthy } from '../src/dispatch/${name}.mjs';\nassert.equal(healthy, true);\n`;
    files[docs] = `# Operator guide\n\n${symptom}.\n`;
    files[`docs/decisions/${adr}-maintenance.md`] = `---\nsimt-affects: ["${source}"]\n---\n# ${adr} — Maintenance\n\nStatus: accepted\n`;
    files[`rules/${rule}.md`] = `---\nsimt-id: ${rule}\nsimt-scope: ["${source}"]\n---\n# Maintenance\n`;
    files[`docs/lessons/${lesson}.md`] = `---\nsimt-trigger: { paths: ["${source}"] }\n---\n\n# Reproduce the symptom before making changes\n`;
    return { id, source, symbol, symptom, barrel, caller, partner, test, docs, adr, rule, skill, lesson, dispatcher, unrelatedTest };
  });
}

function compositeCase(fixtures, start) {
  const id = fixtures[start].id;
  const size = SUBTASK_COUNTS[start % SUBTASK_COUNTS.length];
  const subtasks = [];
  const clauses = [];
  for (let offset = 0; offset < size; offset += 1) {
    const entry = fixtures[(start + offset) % fixtures.length];
    const [kind, action] = COMPOSITE[offset];
    const file = kind === 'docs' ? entry.docs : kind === 'config' ? entry.partner : kind === 'tests' ? entry.test : entry.source;
    const anchor = offset === 0 && start % 3 === 1 ? ` in ${file}`
      : offset === 0 && start % 3 === 2 ? ` in ${basename(file)}` : '';
    clauses.push(`${action} ${entry.symptom[0].toLowerCase()}${entry.symptom.slice(1)}${anchor}`);
    const facets = { FILES: [file] };
    if (file === entry.source || file === entry.test) facets.TESTS = [entry.test];
    if (file === entry.source) {
      facets.DECISIONS = [entry.adr];
      facets.SKILLS = [entry.skill];
      facets.LESSONS = [entry.lesson];
    }
    subtasks.push({ kind, files: [file], facets });
  }
  const exclude = fixtures[(start + size) % fixtures.length].source;
  const excludes = start % 2 === 0 ? [] : [exclude];
  const prompt = [...clauses.map((clause) => `- ${clause}.`), ...excludes.map((file) => `Do not modify ${file}.`)].join('\n');
  return {
    task: { id: `composite-${id}`, stratum: 'composite', prompt },
    label: { subtasks, excludes },
  };
}

function syntheticCases(count) {
  const files = { 'package.json': '{"name":"retrieval-fixture","type":"module","scripts":{"test":"node --test"}}\n' };
  const fixtures = fixtureCases(files, count);
  files['.simt/skills.graph.json'] = JSON.stringify({
    version: 1,
    capabilities: [{ id: 'maintenance', summary: 'Maintain operational behavior' }],
    skills: fixtures.map(({ source, skill }) => ({
      name: skill, summary: 'Maintain operational behavior', capabilities: ['maintenance'],
      paths: [source], stack: ['node'], bytes: 512,
      sources: [{ repo: 'retrieval-fixture', path: source, role: 'canonical', bytes: 512 }],
    })),
  });
  const cases = fixtures.flatMap((entry, index) => {
    const { id, source, symptom, symbol, barrel, caller, partner, test, adr, rule, skill, dispatcher, unrelatedTest } = entry;
    return [
      { task: { id: `vocabulary-${id}`, stratum: 'vocabulary-gap', prompt: symptom }, label: { files: [source] } },
      compositeCase(fixtures, index),
      {
        task: {
          id: `structural-${id}`, stratum: 'impact-governance',
          prompt: `Trace callers of ${symbol} and explain governance of ${source}.`,
          requests: [{ command: 'impact', target: symbol }, { command: 'why', target: source }],
        },
        label: {
          impact: { dependents: [barrel, caller, test], cochange: [partner], hubOnly: [dispatcher, unrelatedTest] },
          governance: [adr, rule, skill],
        },
      },
    ];
  });
  return { cases, files, cochanges: fixtures.map(({ source, partner }) => [source, partner]) };
}

export async function buildRetrievalCorpus(root, { perStratum = VOCABULARY.length } = {}) {
  if (!Number.isInteger(perStratum) || perStratum < MIN_CASES || perStratum > VOCABULARY.length) {
    throw new Error(`perStratum must be an integer from ${MIN_CASES} to ${VOCABULARY.length}`);
  }
  const mined = await listCandidates(root);
  if (!mined.ok) throw new Error(`could not mine retrieval history: ${mined.error}`);
  const { cases, files, cochanges } = syntheticCases(perStratum);
  const lexical = await lexicalCases(root, mined.candidates, perStratum);
  const entries = [...lexical, ...cases].sort((a, b) => cmp(a.task.id, b.task.id));
  const tasks = entries.map(({ task }) => task);
  const gold = Object.fromEntries(entries.map(({ task, label }) => [task.id, label]));
  const corpus = { tasks, gold, fixture: { files, cochanges } };
  validateRetrievalCorpus(corpus, { perStratum });
  return corpus;
}

function nonemptyStrings(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === 'string' && value.trim() !== '')
    && new Set(values).size === values.length;
}

function validSubtask(subtask) {
  const { kind, files, facets } = subtask ?? {};
  return COMPOSITE.some(([known]) => known === kind) && nonemptyStrings(files)
    && facets && typeof facets === 'object' && Object.entries(facets).length > 0
    && Object.entries(facets).every(([facet, values]) => retrievalFacets.has(facet) && nonemptyStrings(values));
}

function validLabel(stratum, label) {
  switch (stratum) {
    case 'lexical':
    case 'vocabulary-gap':
      return nonemptyStrings(label.files);
    case 'composite':
      return Array.isArray(label.subtasks) && SUBTASK_COUNTS.includes(label.subtasks.length)
        && label.subtasks.every(validSubtask)
        && (label.excludes?.length === 0 || nonemptyStrings(label.excludes));
    case 'impact-governance':
      return nonemptyStrings(label.impact?.dependents) && nonemptyStrings(label.impact?.cochange)
        && (label.impact?.hubOnly?.length === 0 || nonemptyStrings(label.impact?.hubOnly))
        && nonemptyStrings(label.governance);
  }
}

export function validateRetrievalCorpus({ tasks, gold }, { perStratum = 30 } = {}) {
  if (!Array.isArray(tasks) || !gold || typeof gold !== 'object' || Array.isArray(gold)) {
    throw new Error('retrieval corpus requires public tasks and a gold record');
  }
  const seen = new Set();
  const counts = new Map(RETRIEVAL_STRATA.map((stratum) => [stratum, 0]));
  const balance = new Map(SUBTASK_COUNTS.map((count) => [count, 0]));
  for (const task of tasks) {
    const { id, stratum, prompt, requests, base } = task ?? {};
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) {
      throw new Error(`invalid or duplicate retrieval task ID: ${id}`);
    }
    if (!counts.has(stratum) || typeof prompt !== 'string' || !prompt.trim()
      || Object.keys(task).some((key) => !publicFields.has(key))) {
      throw new Error(`invalid public retrieval task: ${id}`);
    }
    if (stratum === 'lexical' ? !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base ?? '') : base !== undefined) {
      throw new Error(`invalid retrieval base: ${id}`);
    }
    if (stratum === 'impact-governance') {
      if (requests?.length !== 2 || !['impact', 'why'].every((command, index) =>
        requests[index]?.command === command && typeof requests[index]?.target === 'string'
        && requests[index].target.trim() && Object.keys(requests[index]).length === 2)) {
        throw new Error(`invalid structural retrieval requests: ${id}`);
      }
    } else if (requests !== undefined) {
      throw new Error(`unexpected retrieval requests: ${id}`);
    }
    if (!Object.hasOwn(gold, id) || !gold[id] || !validLabel(stratum, gold[id])) {
      throw new Error(`missing or invalid retrieval gold: ${id}`);
    }
    seen.add(id);
    counts.set(stratum, counts.get(stratum) + 1);
    if (stratum === 'composite') {
      const size = gold[id].subtasks.length;
      balance.set(size, balance.get(size) + 1);
    }
  }
  if (Object.keys(gold).length !== seen.size) throw new Error('retrieval gold contains orphan task IDs');
  if ([...counts.values()].some((count) => count < perStratum)) throw new Error('retrieval strata are undersized');
  const sizes = [...balance.values()];
  if (Math.min(...sizes) < 1 || Math.max(...sizes) - Math.min(...sizes) > 1) {
    throw new Error('composite subtask counts are unbalanced');
  }
}

export function naiveRetrieval(prompt, paths, { limit = 10 } = {}) {
  const words = new Set(tokenize(prompt).filter((word) => !STOPWORDS.has(word)));
  return paths.map((path) => {
    const name = basename(path, extname(path));
    const score = new Set(tokenize(name).filter((word) => words.has(word))).size;
    return { path, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || cmp(a.path, b.path))
    .slice(0, limit).map(({ path }) => path);
}
