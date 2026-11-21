import { CLI } from '../name.mjs';
import { collectCorpus } from '../knowledge/collect.mjs';
import { scopedImpact } from '../knowledge/local-impact.mjs';
import { digestOf } from '../knowledge/observations.mjs';
import { readLessonCandidates } from '../memory/lessons.mjs';
import { promotionReady, proposeGraduation } from '../memory/graduation.mjs';
import { localVerificationStatus } from '../verify/local-run.mjs';
import { selectLocalVerification } from '../verify/local-selection.mjs';
import { readWork } from './effective.mjs';

const LIMIT = 32;
const SCAN_LIMIT = 128;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function maintenanceContext(root, id) {
  const work = await readWork(root);
  if (!work.ok) return { error: work.problems[0].message, remedy: work.problems[0].remedy };
  const scope = work.scopes.find((entry) => entry.id === id);
  if (!scope) return { error: `no local work scope ${id}`, remedy: `run ${CLI} work inspect` };
  const result = await collectCorpus({ root, work, scope });
  if (result.error) return result;
  const paths = result.corpus.artifacts.map(({ path }) => path).filter((path) => /\.(?:md|markdown)$/i.test(path));
  const selection = await selectLocalVerification(root, { scopeId: id, extraPaths: paths.slice(0, SCAN_LIMIT) });
  if (selection.error) return selection;
  const accepted = new Set(paths);
  const verification = await localVerificationStatus({
    ...selection, obligations: selection.obligations.filter((entry) => entry.paths.every((path) => accepted.has(path))),
  });
  return { root, work, scope, corpus: result.corpus, verification,
    scanTruncated: result.truncated || paths.length > SCAN_LIMIT };
}

function newerObservations(corpus) {
  const reviewed = corpus.artifacts.flatMap(({ claims }) => claims).filter((claim) =>
    claim.status === 'reviewed' && typeof claim.applicability?.recordedFrom === 'string');
  const byId = new Map(reviewed.map((claim) => [claim.id, claim]));
  const updates = new Map();
  for (const claim of reviewed) {
    for (const ref of claim.evidence ?? []) {
      const prior = byId.get(ref);
      if (!prior || prior.subject !== claim.subject || prior.predicate !== claim.predicate ||
          JSON.stringify(prior.applicability.scope) !== JSON.stringify(claim.applicability.scope) ||
          prior.applicability.recordedFrom >= claim.applicability.recordedFrom) continue;
      const existing = updates.get(ref);
      if (!existing || existing.after.applicability.recordedFrom < claim.applicability.recordedFrom) {
        updates.set(ref, { before: prior, after: claim });
      }
    }
  }
  return [...updates.values()];
}

export async function scopedDebt(context) {
  const { root, scope, corpus, verification } = context;
  const items = new Map();
  const add = (kind, ref, next, details = {}) => {
    const id = `debt:${digestOf(`${kind}\0${ref}`).slice(7, 23)}`;
    const existing = items.get(id);
    items.set(id, { id, kind, ref, next, affectedObligations: (existing?.affectedObligations ?? 0) + 1, ...details });
  };
  for (const { code, path } of corpus.problems) {
    if (code === 'unresolved-source' || code === 'uncertain-anchor') {
      add('broken-citation', path, `${CLI} knowledge sections ${quote(path)}`);
    }
  }
  for (const { before, after } of newerObservations(corpus)) {
    add('new-source-observation', before.id, `${CLI} knowledge sections ${quote(after.path)}`, {
      knownAt: after.applicability.recordedFrom, source: after.path,
    });
  }
  const impact = await scopedImpact(context);
  for (const { ref, reason } of impact.unknown ?? []) {
    if (reason === 'no-generation-receipt') {
      add('missing-derivation', ref, `${CLI} knowledge impact --changed --scope ${quote(scope.id)}`);
    }
  }
  for (const row of impact.regeneration?.stale ?? []) {
    add('stale-derivation', row.output, `${CLI} knowledge impact --changed --scope ${quote(scope.id)}`);
  }
  for (const { id, state } of verification.results) {
    if (state === 'pending-review' || state === 'stale' || state === 'raced') {
      add(state, id, `${CLI} verify status --changed --scope ${quote(scope.id)}`);
    }
  }
  const { candidates } = await readLessonCandidates(root);
  const authorized = new Set(corpus.artifacts.map(({ path }) => path));
  const lessonCandidates = candidates.filter((candidate) => Array.isArray(candidate.paths) &&
    candidate.paths.length > 0 && candidate.paths.every((path) => authorized.has(path))).length;
  return { items: [...items.values()], limit: LIMIT, scanTruncated: context.scanTruncated, lessonCandidates };
}

export function scopedGraduation(context) {
  const byCheck = new Map();
  const references = new Map();
  const scope = quote(context.scope.id);
  for (const obligation of context.verification.results) {
    for (const run of obligation.runs ?? []) {
      if (!byCheck.has(run.check)) byCheck.set(run.check, new Map());
      const seen = byCheck.get(run.check);
      const id = run.receipt ?? 'unavailable';
      const row = seen.get(id) ?? { state: run.state, paths: new Set(), count: run.count };
      for (const path of obligation.paths) row.paths.add(path);
      seen.set(id, row);
    }
  }
  const traces = [];
  for (const [check, receipts] of byCheck) {
    const used = new Set();
    references.set(check, []);
    for (const [receipt, { state, paths, count }] of receipts) {
      const independent = state === 'pass' && [...paths].every((path) => !used.has(path));
      if (independent) {
        for (const path of paths) used.add(path);
        references.get(check).push(receipt);
      }
      traces.push({ goal: check, capability: 'local-verification', validated: state === 'pass' && count > 0, independent,
        steps: [`${CLI} verify select --changed --scope ${scope}`, `${CLI} verify run --changed --scope ${scope} --yes`,
          `${CLI} verify status --changed --scope ${scope}`] });
    }
  }
  const { proposals } = proposeGraduation({ traces });
  return {
    proposals: proposals.slice(0, LIMIT).map((proposal) => ({ ...proposal,
      receipts: references.get(proposal.goal).slice(0, 8), promotion: promotionReady({ proposal }),
    })),
    traces: traces.length, truncated: proposals.length > LIMIT || context.scanTruncated,
    executed: false,
  };
}
