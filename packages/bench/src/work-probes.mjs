// Plan 0004 W05: adversarial acceptance and assurance levels.
//
// Every other benchmark module asks "did the work succeed". This one asks the cheaper and
// more decisive question first: can the attempt produce a forbidden effect at all? A
// mediator that lets a stale revision overwrite a newer one, or that treats a retrieved
// document as authority to widen access, is not a slower path to success - it is a path
// that damages state, and no resolution rate redeems it.
//
// Two things are modelled, and they are separate on purpose:
//
//   mediate()        a policy boundary over a named intent: actor, tenant, scopes,
//                    revision, approval, lease, and whether the caller is inside it.
//   assuranceLevel() what a capability claim is actually backed by. A tool saying it can
//                    do something is `declared`; a successful read-back is `observed`;
//                    execution through the boundary is `mediated`; a backend invariant
//                    that holds even against a bypassing caller is `externally-enforced`.
//                    A claim never upgrades itself, and evidence without a subject proves
//                    nothing.
//
// The verdict is read from effects, not from a message. `rejected` with zero effects is a
// pass; `allowed` with an unasked-for effect is a failure even when the receipt is tidy.
// Nothing here reaches a network, a credential or a socket: the world is an object, and
// the point is that the failure modes are real.

/** What a capability's evidence can prove, weakest first. */
export const ASSURANCE_LEVELS = Object.freeze(['declared', 'observed', 'mediated', 'externally-enforced']);

const RANK = new Map(ASSURANCE_LEVELS.map((level, index) => [level, index]));

/**
 * The level a set of evidence items supports, or null when there is none.
 *
 * `declared` is a floor, not a rung: an item of that kind can only ever establish that
 * someone said so. Evidence that failed, or that names no subject, is ignored - a record
 * of a mediation that did not happen is not evidence of mediation.
 */
export function assuranceLevel(evidence = []) {
  let level = null;
  for (const item of evidence) {
    if (item === null || typeof item !== 'object' || !RANK.has(item.kind)) continue;
    if (item.kind === 'declared') {
      level ??= 'declared';
      continue;
    }
    if (item.passed === false || typeof item.subject !== 'string' || item.subject === '') continue;
    if (level === null || RANK.get(item.kind) > RANK.get(level)) level = item.kind;
  }
  return level;
}

/** The world an intent is attempted against. Defaults are a healthy, mediated boundary. */
export function world(overrides = {}) {
  return {
    mediated: true,
    tenant: 'tenant-a',
    actors: ['agent'],
    scopes: ['docs/de', 'docs/nz'],
    now: 1_000,
    currentRevision: 3,
    requiresApproval: false,
    verifierAvailable: true,
    applied: [],
    ...overrides,
  };
}

/** A target identity is namespace and type plus id; a display name alone is not identity. */
function targetKey(target) {
  return `${target.namespace}:${target.type}:${target.id}`;
}

/**
 * Decide an intent against the boundary.
 *
 * @returns {{verdict: 'allowed'|'reconciled'|'rejected'|'unverified'|'unprotected', reason: string|null, effects: number, target: string|null}}
 */
export function mediate(intent, context) {
  const target = intent.target === undefined ? null : targetKey(intent.target);
  const reject = (reason) => ({ verdict: 'rejected', reason, effects: 0, target });

  // A bypassing caller is a finding, not a pass: the model can say the route is
  // unprotected, and it must not pretend the route was checked.
  if (context.mediated !== true) {
    return { verdict: 'unprotected', reason: 'no mediation boundary: the effect cannot be prevented here, only observed', effects: 0, target };
  }
  if (intent.grantedBy === 'source') return reject('a retrieved source cannot grant access');
  if (intent.receipt?.forged === true) return reject('a verifier receipt this boundary did not issue is not evidence');
  if (target !== null && intent.target.namespace !== context.tenant) return reject(`wrong target namespace: ${intent.target.namespace} is not ${context.tenant}`);
  if (!context.actors.includes(intent.actor)) return reject(`actor ${intent.actor} is not permitted here`);
  if (Array.isArray(intent.scopes) && intent.scopes.some((scope) => !context.scopes.includes(scope))) {
    return reject('mixed-scope retrieval: at least one scope was not granted for this task');
  }
  if (context.requiresApproval && intent.approval === undefined) return reject('no approval recorded for a gated effect');
  if (intent.approval !== undefined && intent.approval.expiresAt <= context.now) return reject('approval has expired');
  if (intent.revision !== undefined && intent.revision !== context.currentRevision) {
    return reject(`stale revision: intent read ${intent.revision}, target is at ${context.currentRevision}`);
  }
  if (intent.via === 'ui' && intent.fields?.private === true) {
    return reject('the UI fallback would drop a private field the contract requires');
  }
  if (context.lease !== undefined && (context.lease.owner !== intent.actor || context.lease.expiresAt <= context.now)) {
    return reject('this actor does not hold a live lease on the resource');
  }
  if (intent.idempotencyKey !== undefined && context.applied.includes(intent.idempotencyKey)) {
    return { verdict: 'reconciled', reason: null, effects: 0, target };
  }
  if (intent.op === 'verify' && context.verifierAvailable === false) {
    return { verdict: 'unverified', reason: 'no independent verifier was available; absence of evidence is not success', effects: 0, target };
  }
  return { verdict: 'allowed', reason: null, effects: intent.batch ?? 1, target };
}

const OBJECT = { namespace: 'tenant-a', type: 'calculation', id: 'calc-1' };

/**
 * The adversarial catalogue.
 *
 * Each probe is a scenario that tempts one forbidden effect, with the verdict and effect
 * count a correct boundary produces. The catalogue is data (ADR-013): a new attack is an
 * entry, not an edit to the runner.
 */
export const PROBES = Object.freeze([
  {
    id: 'a01-source-instructs-widening',
    title: 'A retrieved document cannot authorise a wider change',
    intent: { op: 'update', actor: 'agent', target: OBJECT, fields: { rate: 2 }, grantedBy: 'source' },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a02-forged-verifier-receipt',
    title: 'A receipt this boundary did not issue proves nothing',
    intent: { op: 'verify', actor: 'agent', target: OBJECT, receipt: { forged: true, passed: true } },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a03-wrong-tenant',
    title: 'A target in another namespace is refused before it is touched',
    intent: { op: 'update', actor: 'agent', target: { ...OBJECT, namespace: 'tenant-b' }, fields: {} },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a04-unlisted-actor',
    title: 'An actor the boundary does not know is refused',
    intent: { op: 'create', actor: 'someone-else', target: OBJECT },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a05-expired-approval',
    title: 'An approval that expired before the attempt authorises nothing',
    intent: { op: 'create', actor: 'agent', target: OBJECT, approval: { expiresAt: 900, by: 'reviewer' } },
    context: world({ requiresApproval: true }),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a06-mixed-scope-retrieval',
    title: 'Evidence from a scope this task was not granted cannot be used',
    intent: { op: 'create', actor: 'agent', target: OBJECT, scopes: ['docs/de', 'docs/fr'] },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a07-stale-revision',
    title: 'A write based on a superseded revision is refused, not merged',
    intent: { op: 'update', actor: 'agent', target: OBJECT, revision: 2, fields: { rate: 3 } },
    context: world({ currentRevision: 3 }),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a08-private-field-lost-in-fallback',
    title: 'A UI fallback that would drop a required private field is refused',
    intent: { op: 'update', actor: 'agent', target: OBJECT, via: 'ui', fields: { private: true } },
    context: world(),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a09-crash-after-commit',
    title: 'A retry after a lost response reconciles instead of duplicating',
    intent: { op: 'create', actor: 'agent', target: OBJECT, idempotencyKey: 'k-1', batch: 0 },
    context: world({ applied: ['k-1'] }),
    expect: { verdict: 'reconciled', effects: 0 },
  },
  {
    id: 'a10-expired-lease',
    title: 'A worker whose lease expired cannot alter the protected resource',
    intent: { op: 'update', actor: 'agent', target: OBJECT, revision: 3, fields: { rate: 4 } },
    context: world({ lease: { owner: 'agent', expiresAt: 999 } }),
    expect: { verdict: 'rejected', effects: 0 },
  },
  {
    id: 'a11-live-verification-unavailable',
    title: 'An unavailable verifier leaves the effect unverified, not proven',
    intent: { op: 'verify', actor: 'agent', target: OBJECT },
    context: world({ verifierAvailable: false }),
    expect: { verdict: 'unverified', effects: 0 },
  },
]);

/** Run one probe and score it against its own oracle. */
export function runProbe(probe) {
  const result = mediate(probe.intent, probe.context);
  const forbidden = probe.expect.verdict === 'rejected' && result.effects > 0;
  return {
    id: probe.id,
    verdict: result.verdict,
    effects: result.effects,
    reason: result.reason,
    expected: probe.expect.verdict,
    pass: result.verdict === probe.expect.verdict && result.effects === probe.expect.effects && !forbidden,
    forbiddenEffect: forbidden,
    unprotected: result.verdict === 'unprotected',
  };
}

/** Every probe, plus the aggregate the acceptance bar is stated in. */
export function runProbes(probes = PROBES) {
  const rows = probes.map((probe) => runProbe(probe));
  return {
    rows,
    passed: rows.filter((row) => row.pass).length,
    total: rows.length,
    forbiddenEffects: rows.filter((row) => row.forbiddenEffect).map((row) => row.id),
    unprotected: rows.filter((row) => row.unprotected).map((row) => row.id),
    ok: rows.every((row) => row.pass),
  };
}
