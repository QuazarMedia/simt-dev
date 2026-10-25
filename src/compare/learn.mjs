// Estate learning through `compare` (plan 0003 R36).
//
// Aggregates `.simt/ledger.jsonl`, `.simt/lessons.jsonl`, and ablation/bench
// records across workspace repositories to surface:
//   1. the most-violated rules (from hook denials and `review-block` findings);
//   2. the most-failing and slowest gates (from evidence ledgers);
//   3. rules/sections with no measured value (`dR <= DEL_R_TOLERANCE` and `dC > 0`
//      from stored ablation runs);
//   4. deterministic ADR drafts (`status: draft`) proposing rulings grounded in
//      that workspace evidence.
//
// Determinism (Accept): given the same ledgers and records on disk, the report and
// every ADR draft are byte-identical (no wall-clock timestamps, fixed sorting and
// rounding).

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { policiesFor } from '../agenthooks/policy.mjs';
import { compareArms, evaluateRunRecord, loadPrices, loadRunRecords } from '../bench/report.mjs';
import { GATES } from '../hooks/gates.mjs';
import { readLedger } from '../ledger/index.mjs';
import { readLessonCandidates } from '../memory/lessons.mjs';
import { readManifest } from '../projection/manifest.mjs';

const DEL_R_TOLERANCE = 0.01;

const POLICY_BY_ID = new Map(policiesFor('pre-tool-use').map((p) => [p.id, p]));
const POLICY_BY_ADR = new Map(policiesFor('pre-tool-use').map((p) => [p.adr, p]));

const GATE_ENTRIES = Object.values(GATES);

function round4(n) {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function round1(n) {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

/**
 * Map a ledger command string back to a canonical gate name when possible, or keep
 * the trimmed command string so custom commands still aggregate cleanly.
 */
export function classifyGateCommand(cmd, manifest = null) {
  const raw = String(cmd ?? '').trim();
  if (!raw) return { gate: 'unknown', adr: null };

  const declaredCommands = manifest?.gates?.commands ?? {};
  for (const [gateName, gateCmd] of Object.entries(declaredCommands)) {
    if (typeof gateCmd === 'string' && gateCmd.trim() === raw) {
      return { gate: gateName, adr: GATES[gateName]?.adr ?? null };
    }
  }

  if (GATES[raw]) {
    return { gate: raw, adr: GATES[raw].adr };
  }

  for (const gate of GATE_ENTRIES) {
    if (gate.kind === 'script' && gate.script) {
      const scriptRe = new RegExp(`(?:^|\\s)npm\\s+run(?:\\s+--silent)?\\s+${gate.script}(?:\\s|$)`);
      if (scriptRe.test(raw) || (gate.script === 'test' && /\b(?:npm\s+test|node\s+--test|pytest|go\s+test)\b/.test(raw))) {
        return { gate: gate.name, adr: gate.adr };
      }
    }
    if (gate.kind === 'staged' && Array.isArray(gate.tools)) {
      for (const tool of gate.tools) {
        if (raw.includes(`node_modules/.bin/${tool}`) || new RegExp(`\\b${tool}\\b`).test(raw)) {
          return { gate: gate.name, adr: gate.adr };
        }
      }
    }
  }

  return { gate: raw, adr: null };
}

/**
 * Extract violated rule/policy identifiers from a lesson candidate (`hook-denial` or `review-block`).
 */
export function classifyRuleViolations(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  const kind = candidate.kind;
  if (kind !== 'hook-denial' && kind !== 'review-block') return [];

  const text = `${candidate.errorLine ?? ''} ${candidate.summary ?? ''}`;
  const keywords = Array.isArray(candidate.keywords) ? candidate.keywords.map(String) : [];
  const found = new Map();

  for (const kw of keywords) {
    const policy = POLICY_BY_ID.get(kw.toLowerCase());
    if (policy) {
      found.set(policy.id, {
        rule: policy.id,
        adr: policy.adr,
        kind: 'policy',
      });
    }
  }

  for (const m of text.matchAll(/\b(ADR-\d{3,})\b/gi)) {
    const adr = m[1].toUpperCase();
    const policy = POLICY_BY_ADR.get(adr);
    if (policy) {
      found.set(policy.id, {
        rule: policy.id,
        adr: policy.adr,
        kind: 'policy',
      });
    } else if (![...found.values()].some((v) => v.adr === adr)) {
      found.set(adr, {
        rule: adr,
        adr,
        kind: 'adr',
      });
    }
  }

  if (found.size === 0) {
    for (const policy of POLICY_BY_ID.values()) {
      if (policy.id === 'push' && /\bpush\b/i.test(text)) {
        found.set(policy.id, { rule: policy.id, adr: policy.adr, kind: 'policy' });
      } else if (
        policy.id === 'rewrite' &&
        /\b(?:--no-verify|--amend|rebase|reset\s+--hard|force-push|--force)\b/i.test(text)
      ) {
        found.set(policy.id, { rule: policy.id, adr: policy.adr, kind: 'policy' });
      } else if (policy.id === 'generated' && /\bgenerat(?:ed|es)\b/i.test(text)) {
        found.set(policy.id, { rule: policy.id, adr: policy.adr, kind: 'policy' });
      }
    }
  }

  if (found.size === 0) {
    const fallbackId = kind === 'hook-denial' ? 'hook-policy' : 'review-block';
    found.set(fallbackId, {
      rule: fallbackId,
      adr: null,
      kind,
    });
  }

  return [...found.values()];
}

function parseAblatedSectionArm(arm) {
  const raw = String(arm ?? '');
  if (raw.startsWith('no-core-')) {
    const slug = raw.slice('no-core-'.length);
    return { sectionId: `core:${slug}`, arm: raw, kind: 'core', targetId: slug, affects: ['rules/core.md'] };
  }
  if (raw.startsWith('no-profile-')) {
    const id = raw.slice('no-profile-'.length);
    return { sectionId: `profile:${id}`, arm: raw, kind: 'profile', targetId: id, affects: [`rules/stacks/${id}.md`] };
  }
  if (raw.startsWith('no-process-')) {
    const id = raw.slice('no-process-'.length);
    return { sectionId: `process:${id}`, arm: raw, kind: 'process', targetId: id, affects: [`rules/mdc/${id}.mdc`] };
  }
  return null;
}

async function collectRepoAblationRecords(repoPath) {
  const [records, prices] = await Promise.all([
    loadRunRecords(repoPath).catch(() => []),
    loadPrices(repoPath).catch(() => null),
  ]);
  if (records.length === 0) return [];
  return records.map((rec) => evaluateRunRecord(rec, prices));
}

async function readExplicitNoValueSections(repoPath) {
  const file = join(repoPath, '.simt', 'ablation.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const list = Array.isArray(raw?.sections) ? raw.sections : Array.isArray(raw) ? raw : [];
    return list;
  } catch {
    return [];
  }
}

function formatAffectsList(affects) {
  const sorted = [...new Set(affects.map(String).filter(Boolean))].sort();
  return sorted.length > 0 ? `[${sorted.map((a) => JSON.stringify(a)).join(', ')}]` : '[]';
}

function formatSupersedesList(supersedes) {
  if (!Array.isArray(supersedes) || supersedes.length === 0) return '[]';
  return `[${supersedes
    .map((s) => `{ adr: ${JSON.stringify(s.adr)}, ruling: ${s.ruling === null ? 'null' : s.ruling} }`)
    .join(', ')}]`;
}

/**
 * Render a deterministic ADR draft markdown string (`Status: draft`).
 * Contains no wall-clock date so two runs over the same ledgers produce byte-identical output.
 */
export function renderAdrDraft({
  draftId,
  category,
  title,
  affects = [],
  supersedes = [],
  context,
  rulings = [],
  consequences = [],
}) {
  const statusParts = ['draft'];
  for (const s of supersedes) {
    statusParts.push(s.ruling === null ? `supersedes ${s.adr}` : `supersedes ${s.adr} ruling ${s.ruling}`);
  }
  const lines = [
    '---',
    `simt-affects: ${formatAffectsList(affects)}`,
    `simt-supersedes: ${formatSupersedesList(supersedes)}`,
    '---',
    `# ${draftId} — ${title}`,
    '',
    `Status: ${statusParts.join(' · ')}`,
    `Category: ${category}`,
    '',
    '## Context',
    '',
    context,
    '',
    '## Rulings',
    '',
    ...rulings.flatMap((r, idx) => [`${idx + 1}. ${r}`, '']),
    '## Consequences',
    '',
    ...consequences.map((c) => `- ${c}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Aggregate ledgers, hook denials, and ablation records across `repos` (sorted paths).
 *
 * @param {string[]} repos
 * @returns {Promise<{
 *   reposWithLedgers: number,
 *   reposWithDenials: number,
 *   totalLedgerRuns: number,
 *   totalHookDenials: number,
 *   mostViolatedRules: Array<{rule: string, adr: string|null, kind: string, count: number, repos: string[], sample: string}>,
 *   mostFailingGates: Array<{gate: string, adr: string|null, runs: number, failures: number, failRate: number, meanMs: number, medianMs: number, p95Ms: number, maxMs: number, repos: string[], topError: string|null}>,
 *   slowestGates: Array<{gate: string, adr: string|null, runs: number, failures: number, failRate: number, meanMs: number, medianMs: number, p95Ms: number, maxMs: number, repos: string[], topError: string|null}>,
 *   noValueRules: Array<{sectionId: string, kind: string, targetId: string, dR: number, dC: number, tasks: number, repos: string[]}>,
 *   adrDrafts: Array<{id: string, category: string, target: string, title: string, affects: string[], supersedes: Array<{adr: string, ruling: number|null}>, markdown: string}>
 * }>}
 */
export async function learnAcrossEstate(repos) {
  const sortedRepos = [...(repos ?? [])].sort();

  const ruleViolations = new Map();
  const gateStats = new Map();
  const ablationByArm = new Map();
  const currentRunsAll = [];
  const explicitSections = [];

  let reposWithLedgers = 0;
  let reposWithDenials = 0;
  let totalLedgerRuns = 0;
  let totalHookDenials = 0;

  for (const repoPath of sortedRepos) {
    const repoName = basename(repoPath);
    const [manifestRes, ledgerRes, lessonsRes, benchEvaluated, explicitAblation] = await Promise.all([
      readManifest(repoPath).catch(() => ({ manifest: null })),
      readLedger(repoPath).catch(() => ({ entries: [] })),
      readLessonCandidates(repoPath).catch(() => ({ candidates: [] })),
      collectRepoAblationRecords(repoPath),
      readExplicitNoValueSections(repoPath),
    ]);

    const manifest = manifestRes?.manifest ?? null;
    const ledgerEntries = ledgerRes?.entries ?? [];
    const candidates = lessonsRes?.candidates ?? [];

    if (ledgerEntries.length > 0) reposWithLedgers += 1;
    totalLedgerRuns += ledgerEntries.length;

    let repoDenials = 0;
    for (const cand of candidates) {
      if (cand.kind === 'hook-denial' || cand.kind === 'review-block') {
        if (cand.kind === 'hook-denial') repoDenials += 1;
        const hits = classifyRuleViolations(cand);
        for (const hit of hits) {
          const entry = ruleViolations.get(hit.rule) ?? {
            rule: hit.rule,
            adr: hit.adr ?? null,
            kind: hit.kind,
            count: 0,
            repos: new Set(),
            samples: [],
          };
          entry.count += 1;
          entry.repos.add(repoName);
          const sample = String(cand.errorLine ?? cand.summary ?? '').trim();
          if (sample && !entry.samples.includes(sample)) entry.samples.push(sample);
          ruleViolations.set(hit.rule, entry);
        }
      }
    }
    if (repoDenials > 0) reposWithDenials += 1;
    totalHookDenials += repoDenials;

    for (const line of ledgerEntries) {
      const { gate, adr } = classifyGateCommand(line.cmd, manifest);
      const entry = gateStats.get(gate) ?? {
        gate,
        adr: adr ?? null,
        runs: 0,
        failures: 0,
        durations: [],
        repos: new Set(),
        errorCounts: new Map(),
      };
      if (!entry.adr && adr) entry.adr = adr;
      entry.runs += 1;
      if (line.exit !== 0) {
        entry.failures += 1;
        const errText = String(line.errorLine ?? line.summary ?? '').trim();
        if (errText) {
          entry.errorCounts.set(errText, (entry.errorCounts.get(errText) ?? 0) + 1);
        }
      }
      if (typeof line.ms === 'number' && Number.isFinite(line.ms) && line.ms >= 0) {
        entry.durations.push(line.ms);
      }
      entry.repos.add(repoName);
      gateStats.set(gate, entry);
    }

    for (const row of benchEvaluated) {
      const tagged = { ...row, task: `${repoName}:${row.task}` };
      if (row.arm === 'current') {
        currentRunsAll.push(tagged);
      } else if (parseAblatedSectionArm(row.arm)) {
        const list = ablationByArm.get(row.arm) ?? [];
        list.push({ row: tagged, repoName });
        ablationByArm.set(row.arm, list);
      }
    }

    for (const sec of explicitAblation) {
      explicitSections.push({ sec, repoName });
    }
  }

  const mostViolatedRules = [...ruleViolations.values()]
    .map((v) => ({
      rule: v.rule,
      adr: v.adr,
      kind: v.kind,
      count: v.count,
      repos: [...v.repos].sort(),
      sample: [...v.samples].sort()[0] ?? '',
    }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

  const allGates = [...gateStats.values()].map((g) => {
    const totalMs = g.durations.reduce((acc, n) => acc + n, 0);
    const meanMs = g.durations.length > 0 ? round1(totalMs / g.durations.length) : 0;
    const medianMs = round1(median(g.durations));
    const p95Ms = round1(percentile95(g.durations));
    const maxMs = g.durations.length > 0 ? round1(Math.max(...g.durations)) : 0;
    const failRate = g.runs > 0 ? round4(g.failures / g.runs) : 0;
    const topError =
      [...g.errorCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    return {
      gate: g.gate,
      adr: g.adr,
      runs: g.runs,
      failures: g.failures,
      failRate,
      meanMs,
      medianMs,
      p95Ms,
      maxMs,
      repos: [...g.repos].sort(),
      topError,
    };
  });

  const mostFailingGates = allGates
    .filter((g) => g.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.failRate - a.failRate || a.gate.localeCompare(b.gate));

  const slowestGates = [...allGates].sort(
    (a, b) => b.p95Ms - a.p95Ms || b.meanMs - a.meanMs || a.gate.localeCompare(b.gate),
  );

  const noValueMap = new Map();

  for (const [arm, entries] of [...ablationByArm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parsed = parseAblatedSectionArm(arm);
    if (!parsed || currentRunsAll.length === 0) continue;
    const ablatedRuns = entries.map((e) => e.row);
    const cmp = compareArms(arm, ablatedRuns, 'current', currentRunsAll);
    if (cmp.pairedTasks === 0) continue;
    const dR = round4(cmp.deltas.R);
    const dC = round4(cmp.deltas.C);
    if (dR <= DEL_R_TOLERANCE && dC > 0) {
      noValueMap.set(parsed.sectionId, {
        sectionId: parsed.sectionId,
        kind: parsed.kind,
        targetId: parsed.targetId,
        affects: parsed.affects,
        dR,
        dC,
        tasks: cmp.pairedTasks,
        repos: [...new Set(entries.map((e) => e.repoName))].sort(),
      });
    }
  }

  for (const { sec, repoName } of explicitSections) {
    const sectionId = String(sec.id ?? sec.sectionId ?? '');
    if (!sectionId) continue;
    const dR = round4(Number(sec.dR ?? 0));
    const dC = round4(Number(sec.dC ?? 0));
    const isCandidate = sec.deletionCandidate === true || (sec.measured !== false && dR <= DEL_R_TOLERANCE && dC > 0);
    if (!isCandidate) continue;
    const [kind = 'core', targetId = sectionId] = sectionId.split(':');
    const affects =
      kind === 'profile'
        ? [`rules/stacks/${targetId}.md`]
        : kind === 'process'
          ? [`rules/mdc/${targetId}.mdc`]
          : ['rules/core.md'];
    const existing = noValueMap.get(sectionId);
    if (existing) {
      existing.repos = [...new Set([...existing.repos, repoName])].sort();
    } else {
      noValueMap.set(sectionId, {
        sectionId,
        kind,
        targetId,
        affects,
        dR,
        dC,
        tasks: Number(sec.tasks ?? 1),
        repos: [repoName],
      });
    }
  }

  const noValueRules = [...noValueMap.values()]
    .map(({ affects, ...rest }) => rest)
    .sort((a, b) => a.dR - b.dR || b.dC - a.dC || a.sectionId.localeCompare(b.sectionId));

  const adrDrafts = [];
  let draftCounter = 1;
  const nextDraftId = () => `ADR-DRAFT-${String(draftCounter++).padStart(3, '0')}`;

  for (const v of mostViolatedRules) {
    const draftId = nextDraftId();
    const title = `Reinforce or narrow ${v.rule}${v.adr ? ` (${v.adr})` : ''} after ${v.count} violation(s)`;
    const affects = ['rules/core.md', 'src/agenthooks/policy.mjs'];
    const supersedes = v.adr ? [{ adr: v.adr, ruling: null }] : [];
    const context =
      `Workspace aggregation across ${v.repos.length} repository(ies) (${v.repos.join(', ')}) recorded ` +
      `${v.count} violation(s) of \`${v.rule}\`${v.adr ? ` (${v.adr})` : ''}` +
      `${v.sample ? ` — sample: "${v.sample}"` : ''}.`;
    const rulings = [
      `**Keep or narrow \`${v.rule}\`.** Either promote a targeted lesson/check for \`${v.rule}\` or narrow its scope in \`src/agenthooks/policy.mjs\` if the denials are false positives.`,
    ];
    const consequences = [
      `Updates enforcement or guidance for \`${v.rule}\` across ${v.repos.join(', ')}.`,
    ];
    adrDrafts.push({
      id: draftId,
      category: 'violated-rule',
      target: v.rule,
      title,
      affects,
      supersedes,
      markdown: renderAdrDraft({
        draftId,
        category: 'violated-rule',
        title,
        affects,
        supersedes,
        context,
        rulings,
        consequences,
      }),
    });
  }

  for (const g of mostFailingGates) {
    const draftId = nextDraftId();
    const pct = round1(g.failRate * 100);
    const title = `Stabilise gate "${g.gate}" (${g.failures}/${g.runs} failed, p95 ${g.p95Ms} ms)`;
    const affects = ['src/hooks/gates.mjs', 'src/hooks/dispatcher.mjs'];
    const supersedes = g.adr ? [{ adr: g.adr, ruling: null }] : [];
    const context =
      `Across ${g.repos.length} repository(ies) (${g.repos.join(', ')}), gate \`${g.gate}\` failed ` +
      `${g.failures} of ${g.runs} run(s) (${pct}%), with median ${g.medianMs} ms and p95 ${g.p95Ms} ms` +
      `${g.topError ? ` (most common error: "${g.topError}")` : ''}.`;
    const rulings = [
      `**Remediate or split \`${g.gate}\`.** Capture the recurring failure signature as a lesson or move slow verification to diff-aware pre-push gating so pre-commit stays fast and deterministic.`,
    ];
    const consequences = [
      `Reduces failure rate (${pct}%) and p95 latency (${g.p95Ms} ms) for \`${g.gate}\`.`,
    ];
    adrDrafts.push({
      id: draftId,
      category: 'failing-gate',
      target: g.gate,
      title,
      affects,
      supersedes,
      markdown: renderAdrDraft({
        draftId,
        category: 'failing-gate',
        title,
        affects,
        supersedes,
        context,
        rulings,
        consequences,
      }),
    });
  }

  for (const g of slowestGates) {
    if (mostFailingGates.some((f) => f.gate === g.gate)) continue;
    if (g.p95Ms < 1000) continue;
    const draftId = nextDraftId();
    const title = `Bound latency of slow gate "${g.gate}" (p95 ${g.p95Ms} ms)`;
    const affects = ['src/hooks/gates.mjs', 'src/hooks/dispatcher.mjs'];
    const supersedes = g.adr ? [{ adr: g.adr, ruling: null }] : [];
    const context =
      `Across ${g.repos.length} repository(ies) (${g.repos.join(', ')}), gate \`${g.gate}\` ran ${g.runs} time(s) ` +
      `with median ${g.medianMs} ms and p95 ${g.p95Ms} ms.`;
    const rulings = [
      `**Scope \`${g.gate}\` to affected targets.** Route \`${g.gate}\` through diff-aware test selection or move it from pre-commit to pre-push.`,
    ];
    const consequences = [
      `Lowers hook latency for \`${g.gate}\` across ${g.repos.join(', ')}.`,
    ];
    adrDrafts.push({
      id: draftId,
      category: 'slow-gate',
      target: g.gate,
      title,
      affects,
      supersedes,
      markdown: renderAdrDraft({
        draftId,
        category: 'slow-gate',
        title,
        affects,
        supersedes,
        context,
        rulings,
        consequences,
      }),
    });
  }

  for (const s of noValueRules) {
    const rawEntry = noValueMap.get(s.sectionId);
    const affects = rawEntry?.affects ?? ['rules/core.md'];
    const draftId = nextDraftId();
    const title = `Prune or demote zero-value section "${s.sectionId}" (dR=${s.dR}, dC=+$${s.dC})`;
    const context =
      `Leave-one-out ablation across ${s.tasks} paired task(s) in ${s.repos.join(', ')} measured ` +
      `\`${s.sectionId}\` at dR=${s.dR} (<= ${DEL_R_TOLERANCE}) and dC=+$${s.dC} (> 0).`;
    const rulings = [
      `**Demote or remove \`${s.sectionId}\`.** Move \`${s.sectionId}\` out of the always-on kernel or delete the redundant prose so every repository saves its token cost.`,
    ];
    const consequences = [
      `Removes unmeasured always-on cost (+$${s.dC} per task) without reducing resolution rate (dR=${s.dR}).`,
    ];
    adrDrafts.push({
      id: draftId,
      category: 'no-value-rule',
      target: s.sectionId,
      title,
      affects,
      supersedes: [],
      markdown: renderAdrDraft({
        draftId,
        category: 'no-value-rule',
        title,
        affects,
        supersedes: [],
        context,
        rulings,
        consequences,
      }),
    });
  }

  return {
    reposWithLedgers,
    reposWithDenials,
    totalLedgerRuns,
    totalHookDenials,
    mostViolatedRules,
    mostFailingGates,
    slowestGates,
    noValueRules,
    adrDrafts,
  };
}

/**
 * Format the estate learning block for text output in `simt compare`.
 * Returns `[]` when no ledger runs, hook denials, or no-value sections exist,
 * unless `force` (`--learn`) is true.
 */
export function renderLearningLines(learning, { force = false } = {}) {
  if (!learning) return [];
  const hasData =
    learning.totalLedgerRuns > 0 ||
    learning.mostViolatedRules.length > 0 ||
    learning.noValueRules.length > 0 ||
    learning.adrDrafts.length > 0;
  if (!hasData && !force) return [];

  const lines = [
    `learning  ${learning.totalLedgerRuns} ledger run(s) across ${learning.reposWithLedgers} repo(s), ${learning.totalHookDenials} hook denial(s) across ${learning.reposWithDenials} repo(s), ${learning.adrDrafts.length} ADR draft(s)`,
  ];

  for (const v of learning.mostViolatedRules) {
    lines.push(
      `violated  ${v.rule}${v.adr ? ` (${v.adr})` : ''}  count=${v.count}  repos=${v.repos.join(',')}`,
    );
  }
  for (const g of learning.mostFailingGates) {
    lines.push(
      `failing   ${g.gate}${g.adr ? ` (${g.adr})` : ''}  failures=${g.failures}/${g.runs} (${round1(g.failRate * 100)}%)  p95=${g.p95Ms}ms  repos=${g.repos.join(',')}`,
    );
  }
  for (const g of learning.slowestGates) {
    lines.push(
      `slowest   ${g.gate}${g.adr ? ` (${g.adr})` : ''}  p95=${g.p95Ms}ms  median=${g.medianMs}ms  runs=${g.runs}  repos=${g.repos.join(',')}`,
    );
  }
  for (const s of learning.noValueRules) {
    lines.push(
      `novalue   ${s.sectionId}  dR=${s.dR}  dC=${s.dC}  tasks=${s.tasks}  repos=${s.repos.join(',')}`,
    );
  }
  for (const d of learning.adrDrafts) {
    lines.push(`draft     ${d.id}  [${d.category}] ${d.title}`);
    if (force) {
      for (const mdLine of d.markdown.trimEnd().split('\n')) {
        lines.push(`          ${mdLine}`);
      }
    }
  }

  return lines;
}
