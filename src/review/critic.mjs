// The local critic (plan 0003 R39, ADR-090, ADR-008).
//
// `simt review` builds the critic's brief — the staged diff plus everything that
// governs it (R25) — with no model and no socket. `simt review --local` is its first
// consumer: it sends the brief to the endpoint named in the manifest (R37) and asks
// for an ADR-008 verdict skeleton, then verifies the verdict vocabulary and every
// cited id against that brief before the reply becomes a proposal under
// `.simt/reviews/`. A proposal a human never reads is a dead file, which is the
// intended failure mode (ADR-075, ADR-090).
//
// Nothing here writes outside `.simt/reviews/`, and nothing here edits a source
// file — the model is a critic, not an author. The verdict is advisory by
// construction; no gate reads it. The row's own promotion rule names the test:
// precision at least 0.8 on a labelled set of historical diffs. Until
// `simt bench critic` measures that, every report says the gate has not been
// earned, the same honesty ADR-076 asked of R38's metric note.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { EXIT, fail } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { readLocalConfig, chatEndpoint } from '../local/config.mjs';
import { localChat } from '../local/client.mjs';
import { decisionRecords, loadCorpus, tracked } from '../commands/why.mjs';
import { decisionHits, scopeHits, sortHits, sourceRoots } from '../index/govern.mjs';
// `digestOf`, `promptHash` and `proposalFrontmatter` landed with R38's engine and
// the critic is their second real user; sharing them beats a third copy (ADR-002).
import { digestOf, promptHash, proposalFrontmatter } from '../distill/engine.mjs';

const exec = promisify(execFile);

// Locked on-disk beneath `.simt`, like `.simt/distilled` (R38) — a cache of
// proposals keyed by content digest, never projected and never committed.
const REVIEW_DIR = '.simt/reviews';
const ENGINE_REVIEW_LOCAL = 'review-local';

/** The diff brief's byte cap; `--budget` overrides it, `0` means unlimited. */
export const DEFAULT_BUDGET = 8192;

/**
 * The row-level acceptance metric, stated where a caller reads results (ADR-076):
 * the critic is a gate only at precision >= 0.8 on >= 30 labelled diffs, which no
 * bench here has measured yet, so nothing advertises the gate.
 */
const METRIC_NOTE = 'advisory only; gate requires precision >= 0.8 on >= 30 labelled diffs, unmeasured (plan 0003 R39)';

/**
 * The system prompt (ENGINE_REVIEW_LOCAL only). ADR-008's payload is in the user
 * message, next to the diff it governs — the model gets the vocabulary and the
 * diff in one read, not from two memories.
 */
const REVIEW_SYSTEM = 'You critique a staged diff for a software agent. Follow the rules the user message states exactly.';

/**
 * One governing entry in the prompt, `id  detail`. Ids are the citation currency:
 * the reply may cite only these, and the verifier strips anything else.
 */
function briefLine(item) {
  return `${item.id}  ${item.detail}`;
}

/**
 * Build the critic prompt: the diff (capped), then what governs it.
 *
 * The diff comes last among truncations and the truncation is said out loud in
 * ADR-008's terms — an honest reviewer of a partial diff ends at
 * `APPROVE WITH RESIDUAL RISK`, never at `APPROVE`, because blocks they could not
 * see say nothing either way.
 */
export function buildReviewPrompt(diff, items, budget) {
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  const cap = budget > 0 ? budget : diffBytes;
  const head = diffBytes > cap ? diff.slice(0, cap) : diff;
  const truncated = diffBytes > cap;
  return [
    'Review the staged diff below as a critic. Reply with the skeleton only — no preamble.',
    '',
    "Verdict vocabulary (ADR-008), three values exactly:",
    '- BLOCK — a concrete defect, missing mandatory gate, partial test pass, or missing test delta; each finding pairs with a file:line or command reference from the diff.',
    '- APPROVE WITH RESIDUAL RISK — no blocker found; the findings MUST list what was not reviewed.',
    '- APPROVE — fully reviewed, no blocker.',
    '',
    'Reply format, nothing else:',
    'verdict: <one of the three values>',
    '- <finding>',
    '- ...more findings',
    '',
    'Cite governance by writing the id prefixed with @, e.g. @ADR-001, and only ids listed under WHAT GOVERNS THIS CHANGE. An id not in that list cannot govern the change and the verifier names it a fabrication.',
    truncated
      ? `NOTE: the diff is truncated to ${cap} bytes; treat the omitted remainder as not reviewed.`
      : '',
    '',
    'WHAT GOVERNS THIS CHANGE',
    ...items.map((item) => `- ${item.id}  ${item.detail}`),
    '',
    'STAGED DIFF',
    head.endsWith('\n') ? head : `${head}\n`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Everything a staged diff is governed by (R25), one entry per id.
 *
 * ADR-008 is always in the brief because the verdict cites the vocabulary itself
 * even when no Affects line names the diff — that is one record, looked up by id,
 * not a hardcoded title, so its own wording travels with it.
 */
async function governingItems(root, files, commands = []) {
  const [records, corpus] = await Promise.all([decisionRecords(root), loadCorpus(root)]);
  const fileSet = new Set(files);
  const ctx = { files: fileSet, commands: new Set(commands), roots: sourceRoots(files) };
  const items = new Map();
  for (const file of files) {
    const { hits } = decisionHits(records, file, ctx);
    for (const hit of sortHits([...hits, ...scopeHits(file, corpus)])) {
      if (!items.has(hit.id)) items.set(hit.id, hit);
    }
  }
  const vocabulary = records.find((record) => record.id === 'ADR-008');
  if (vocabulary && !items.has('ADR-008')) {
    items.set('ADR-008', { kind: 'decision', id: 'ADR-008', detail: vocabulary.title });
  }
  return [...items.values()];
}

/** ADR-008's three verdicts, as the reply must name them. */
export const VERDICTS = ['BLOCK', 'APPROVE', 'APPROVE WITH RESIDUAL RISK'];

/**
 * Normalize one verdict line's value. Same three values ADR-008 adopted; the
 * reply may vary in case or inner whitespace, in nothing else.
 */
export function parseVerdictValue(raw) {
  const verbatim = String(raw).trim().replace(/\s+/g, ' ').toUpperCase();
  return VERDICTS.includes(verbatim) ? verbatim : null;
}

/**
 * Verify a model reply into a verdict skeleton.
 *
 * What counts as a fault here is what ADR-008 makes mandatory: one of the three
 * values; a BLOCK whose findings carry file:line or a command reference — the
 * reply format pins the pair, so a BLOCK without findings is a vocabulary
 * violation, not an empty approval; the residual-risk verdict listing what was
 * not reviewed verbatim ("never converts a known failure into an approval");
 * and every @-cited id resolved against the brief. The @ marker exists because
 * backticks cannot carry the citation: ADR-008 requires a BLOCK to pair with a
 * file:line reference, and those arrive in backticks too — a citation of
 * governance that does not govern is a fabrication the human would otherwise
 * skim over, but a file:line reference is the evidence ADR-008 demanded, not a
 * governance claim the verifier may police.
 *
 * Returns `{ verdict, findings, cited, faults }`; `verdict` is null when the
 * vocabulary was not met, and the caller writes the proposal anyway with
 * `verified: false` — the faults are the diff between what the model claimed
 * and what the repository proves.
 */
export function parseVerdictReply(text, briefIds) {
  const lines = String(text).trim().split('\n').filter((line) => line.trim() !== '');
  const faults = [];
  const verdictLine = lines.find((line) => /^verdict:/i.test(line.trim()));
  let verdict = null;
  if (!verdictLine) faults.push('no verdict: line');
  else {
    verdict = parseVerdictValue(verdictLine.slice(verdictLine.indexOf(':') + 1));
    if (verdict === null) {
      faults.push(`verdict "${verdictLine.trim()}" is not one of ${VERDICTS.join(' / ')}`);
    }
  }
  const findings = lines.filter((line) => /^\s*-\s+/.test(line)).map((line) => line.trim());
  // Governance citations carry an explicit @ marker. Backticks cannot be the
  // marker: ADR-008 pairs BLOCK with file:line references, which arrive in
  // backticks too, and calling those fabrications would make every honest
  // BLOCK read as unverifiable (the fault this parser once misreported).
  const cited = [...new Set([...text.matchAll(/@([A-Za-z][\w-]*)/g)].map((match) => match[1]))];
  for (const token of cited) {
    if (!briefIds.has(token)) faults.push(`cites @${token} and nothing governs the change by that id`);
  }
  if (verdict === 'BLOCK' && findings.length === 0) {
    faults.push('a BLOCK verdict carries no finding paired with a file:line or command reference');
  }
  if (verdict === 'APPROVE WITH RESIDUAL RISK' && findings.length === 0) {
    faults.push('APPROVE WITH RESIDUAL RISK must list what was not reviewed');
  }
  return { verdict, findings, cited, faults };
}

/** Frontmatter of a cached proposal, same parser the distiller's cache reads. */
export function parseExistingFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const head = text.split('\n---', 1)[0];
  const fields = {};
  for (const line of head.split('\n').slice(1)) {
    const m = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

/**
 * Returns either the report object (ok) or an exit code (fail) — the same shape
 * the command layer returns, so a failure passes through unchanged.
 *
 * With `write` false the critic runs and reports but persists nothing: the bench
 * (its other caller) answers for history as a whole and cannot be a source of
 * proposals for a tree those commits are not in.
 */
export async function reviewTarget(args, flags, { write = true, commands = [] } = {}) {
  if (args.length > 0) {
    return fail(`unknown review argument ${args[0]}`, EXIT.USAGE, `usage: ${CLI} review [--local]`);
  }
  const root = resolve(flags.root ?? process.cwd());
  const listed = await tracked(root);
  if (listed.error) return listed.error;

  let patch;
  let names;
  try {
    const [diff, changed] = await Promise.all([
      exec('git', ['diff', '--staged'], { cwd: root, maxBuffer: 64 << 20 }),
      exec('git', ['diff', '--staged', '--name-only'], { cwd: root, maxBuffer: 8 << 20 }),
    ]);
    patch = diff.stdout;
    names = changed.stdout.split('\n').filter(Boolean);
  } catch (error) {
    return fail(
      `could not read the staged diff here (${error.message})`,
      EXIT.UNSUPPORTED,
      'run review inside a git repository, or stage what needs critiqued first',
    );
  }
  const bytes = Buffer.byteLength(patch, 'utf8');
  const staged = { files: names, bytes };

  if (names.length === 0 || bytes === 0) {
    return {
      ok: true,
      command: 'review',
      root,
      staged,
      governs: [],
      verdict: null,
      verified: true,
      // The brief marker is what the report layer branches on: without it the
      // renderer would read a proposal that an empty stage never produces.
      brief: 'nothing is staged',
    };
  }

  const items = await governingItems(root, names, commands);
  const briefIds = new Set(items.map((item) => item.id));

  if (flags.local !== true) {
    // The deterministic path stops at the brief: the ruling the reply would need
    // is a model output, and model output is what the default path must not need.
    return {
      ok: true,
      command: 'review',
      root,
      staged,
      governs: items,
      verdict: null,
      verified: true,
      brief: 'the brief is what the critic reads; a verdict needs the model',
    };
  }

  const allowRemote = flags.allowRemote === true;
  const budget = Number.isInteger(flags.budget) ? flags.budget : DEFAULT_BUDGET;
  const prompt = buildReviewPrompt(patch, items, budget);
  // The recipe is the prompt itself; a different budget, diff or governance list
  // changes the prompt and with it the cache key, so nothing collides.
  const digest = digestOf(prompt, ENGINE_REVIEW_LOCAL, budget);
  const relProposal = `${REVIEW_DIR}/${digest}.md`;
  const absProposal = join(root, relProposal);

  const cached = flags.refresh === true ? null : await readFile(absProposal, 'utf8').catch(() => null);
  if (cached !== null) {
    const fields = parseExistingFrontmatter(cached);
    const cachedVerdict = parseVerdictValue(fields.verdict ?? '');
    return {
      ok: true,
      command: 'review',
      root,
      staged,
      governs: items,
      digest,
      verdict: cachedVerdict,
      verified: fields.verified !== 'false',
      engine: fields.engine ?? ENGINE_REVIEW_LOCAL,
      budget: Number(fields.budget ?? budget),
      metric: { note: METRIC_NOTE },
      proposal: { path: relProposal, state: 'cached', bytes: Buffer.byteLength(cached, 'utf8') },
    };
  }

  const config = await readLocalConfig(root, { allowRemote });
  const endpoint = chatEndpoint(config);
  if (endpoint.exit !== undefined) return endpoint.exit;

  const chat = await localChat(endpoint.chat, {
    system: REVIEW_SYSTEM,
    prompt,
    temperature: 0,
    maxTokens: budget === 0 ? 2048 : Math.min(2048, Math.max(256, Math.ceil(budget / 4))),
    allowRemote,
  });
  if (!chat.ok) {
    // A command-contract number: the chat guard's sentinel stays inside the
    // engine boundary only; anything leaving reviewTarget is numeric or a report,
    // matching how distillTarget unwraps its engine sentinels (plan 0003 R38).
    return fail(
      `local chat failed: ${chat.error}`,
      EXIT.FAIL,
      'fix the endpoint, or remove --local for the deterministic brief',
    );
  }
  const reply = String(chat.content).trim();
  const check = parseVerdictReply(reply, briefIds);
  const faults = [...check.faults];

  const provenance = `${ENGINE_REVIEW_LOCAL}:${chat.model} (prompt ${promptHash(prompt)})`;
  const proposal =
    proposalFrontmatter({
      source: 'staged diff',
      digest,
      engine: provenance,
      budget,
      verified: faults.length === 0,
      verdict: check.verdict ?? undefined,
      advisory: true,
    }) + `\n${reply}\n`;
  if (write) {
    // One mkdir round-trip per help: the directory exists only for proposals.
    await mkdir(join(root, REVIEW_DIR), { recursive: true });
    await writeFile(absProposal, proposal);
  }

  return {
    ok: true,
    command: 'review',
    root,
    staged,
    governs: items,
    digest,
    verdict: check.verdict,
    findings: check.findings.length,
    cited: check.cited.length,
    verified: faults.length === 0,
    ...(faults.length > 0 ? { faults } : {}),
    engine: provenance,
    budget,
    metric: { note: METRIC_NOTE },
    proposal: write
      ? { path: relProposal, state: 'fresh', bytes: Buffer.byteLength(proposal, 'utf8') }
      : { path: relProposal, state: 'unwritten', bytes: Buffer.byteLength(proposal, 'utf8') },
  };
}

/**
 * The verdict binary the bench evaluates: a gate would block the change exactly
 * when the verdict is `BLOCK`, and ADR-008's other two values are one
 * non-blocking answer to the same question, so precision and recall measure the
 * critic against `BLOCK` and nothing finer.
 *
 * `null` says the pair cannot be judged — a label outside the vocabulary, or a
 * reply that produced none — and the bench counts it as unmeasured rather than
 * folding it into a negative.
 */
export function verdictBinary(labelVerdict, criticVerdict) {
  const truth = parseVerdictValue(labelVerdict);
  const said = parseVerdictValue(criticVerdict);
  if (truth === null || said === null) return null;
  return { truthCritical: truth === 'BLOCK' ? 1 : 0, saidCritical: said === 'BLOCK' ? 1 : 0 };
}

/**
 * `simt bench critic` (plan 0003 R39's acceptance).
 *
 * Reads a labelled set of historical diffs — one `{sha, verdict}` pair per line,
 * the verdict a human assigned under ADR-008 — runs the critic over each diff
 * from its commit, and reports the confusion counts with precision and recall.
 * Precision and recall are reported, or `null` with the missing-inputs named:
 * the metric is measured here or nowhere, never inferred.
 */
export async function criticBench(root, { labelsPath, flags, commands = [] }) {
  const labels = await readLabels(root, labelsPath);
  if (labels.exit !== undefined) return labels.exit;

  const config = await readLocalConfig(root, { allowRemote: flags.allowRemote === true });
  const endpoint = chatEndpoint(config);
  if (endpoint.exit !== undefined) return endpoint.exit;

  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let measured = 0;
  const errors = [];
  for (const label of labels.rows) {
    const pass = await peer(root, label.sha, flags, endpoint, commands);
    if (pass.failed) {
      errors.push(`review ${label.sha} rejected: ${pass.exitMessage}`);
      continue;
    }
    const pair = verdictBinary(label.verdict, pass.verdict);
    if (pair === null) {
      errors.push(`review ${label.sha} did not produce a vocabulary verdict${pass.faults?.length ? `: ${pass.faults[0]}` : ''}`);
      continue;
    }
    measured += 1;
    if (pair.truthCritical === 1 && pair.saidCritical === 1) confusion.tp += 1;
    else if (pair.truthCritical === 0 && pair.saidCritical === 1) confusion.fp += 1;
    else if (pair.truthCritical === 1 && pair.saidCritical === 0) confusion.fn += 1;
    else confusion.tn += 1;
  }

  const precision = confusion.tp + confusion.fp > 0 ? confusion.tp / (confusion.tp + confusion.fp) : null;
  const recall = confusion.tp + confusion.fn > 0 ? confusion.tp / (confusion.tp + confusion.fn) : null;
  return {
    ok: true,
    command: 'bench critic',
    root,
    labels: labels.rows.length,
    labelsPath,
    measured,
    errors,
    ...confusion,
    precision,
    recall,
    gated: precision !== null && precision >= 0.8 && labels.rows.length >= 30 && errors.length === 0,
    labelsNote: labels.rows.length < 30 ? `below the 30-diff acceptance floor (${labels.rows.length})` : null,
    engine: endpoint.chat.model,
  };
}

/** One critic pass over one historical commit — the staged-diff machinery at that sha. */
async function peer(root, sha, flags, endpoint, commands) {
  let diff;
  try {
    diff = (await exec('git', ['show', '--unified=2', sha], { cwd: root, maxBuffer: 64 << 20 })).stdout;
  } catch (error) {
    return { failed: true, exitMessage: error.message };
  }
  // `git show` names each touched file on its own `diff --git a/… b/…` line, so one
  // pass yields both the patch and the file list — no second git call per label.
  const names = [...diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map((match) => match[2]);
  if (names.length === 0) return { failed: true, exitMessage: 'the commit carries no file diff' };

  const items = await governingItems(root, names, commands);
  const briefIds = new Set(items.map((item) => item.id));
  const budget = Number.isInteger(flags.budget) ? flags.budget : DEFAULT_BUDGET;
  const prompt = buildReviewPrompt(diff, items, budget);
  const chat = await localChat(endpoint.chat, {
    system: REVIEW_SYSTEM,
    prompt,
    temperature: 0,
    maxTokens: budget === 0 ? 2048 : Math.min(2048, Math.max(256, Math.ceil(budget / 4))),
    allowRemote: flags.allowRemote === true,
  });
  if (!chat.ok) return { failed: true, exitMessage: chat.error };
  return parseVerdictReply(String(chat.content).trim(), briefIds);
}

async function readLabels(root, labelsPath) {
  let text;
  try {
    text = await readFile(resolve(root, labelsPath), 'utf8');
  } catch {
    return {
      exit: fail(
        `no labelled set at ${labelsPath}`,
        EXIT.FAIL,
        `annotate historical diffs: one {"sha":"<commit>","verdict":"BLOCK|APPROVE|APPROVE WITH RESIDUAL RISK"} per line, labelled by a human under ADR-008 — the bench reports precision and recall over them`,
      ),
    };
  }
  const rows = [];
  const faults = [];
  for (const [index, line] of text.split('\n').filter((l) => l.trim() !== '').entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      faults.push(`line ${index + 1} is not JSON: ${JSON.stringify(line)}`);
      continue;
    }
    if (typeof row.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(row.sha)) {
      faults.push(`line ${index + 1} has no commit sha`);
      continue;
    }
    if (parseVerdictValue(row.verdict ?? '') === null) {
      faults.push(`line ${index + 1} verdict is not one of ${VERDICTS.join(' / ')}`);
      continue;
    }
    rows.push({ sha: row.sha, verdict: parseVerdictValue(row.verdict) });
  }
  if (faults.length > 0) {
    return {
      exit: fail(`${labelsPath}: ${faults.join('; ')}`, EXIT.FAIL, 'every label is one {sha, verdict} pair on its own line'),
    };
  }
  if (rows.length === 0) {
    return { exit: fail(`${labelsPath} names no labelled diffs`, EXIT.FAIL, `label historical diffs in ${labelsPath}`) };
  }
  return { rows };
}
