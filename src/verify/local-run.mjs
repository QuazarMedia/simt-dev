import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { detectTestRunner } from '../testing/runners.mjs';
import { readReports } from '../testing/parsers.mjs';
import { commandAvailable, reportPathProblem } from '../testing/contract.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { readLocalBytes } from '../knowledge/collect.mjs';
import { buildEvidence, readEvidenceRecord, validateEvidence } from '../ledger/evidence.mjs';
import { readLedger, recordRun } from '../ledger/index.mjs';
import { canonicalJson } from '../util/canonical.mjs';
import { gitText } from '../sys/git.mjs';
import { spawnBounded } from '../sys/proc.mjs';

const KIND = 'scoped-verification';
const sha = (value) => `sha256-${createHash('sha256').update(value).digest('hex')}`;
const digest = (value) => sha(canonicalJson(value));
const RUNNER_FILES = ['simt.json', 'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', 'Makefile', 'Cargo.toml'];
const CHECK_LINE = /^simt checked: ([0-9]+)\s*$/gim;

async function fingerprint(root, paths) {
  const results = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readLocalBytes(root, path, 4 << 20);
    results.push({ ref: path, digest: bytes === null ? null : sha(bytes) });
  }
  return results;
}

function checkFiles(root, check) {
  const cwd = check.cwd;
  const candidates = check.argv.filter((token, index) => index > 0 || token.includes('/'));
  const paths = candidates.flatMap((token) => {
    if (token.startsWith('-') || !/[/\.]|\.mjs$/.test(token)) return [];
    const ref = relative(root, resolve(cwd, token));
    return ref !== '' && ref !== '..' && !ref.startsWith('../') ? [ref] : [];
  });
  return [...new Set([...RUNNER_FILES, ...paths])].sort();
}

function observedCount(stdout) {
  const matches = [...stdout.matchAll(CHECK_LINE)].map((match) => Number(match[1]));
  return matches.length === 1 && Number.isSafeInteger(matches[0]) ? matches[0] : null;
}

async function sourceCheck(plan) {
  if (plan.sourceTests.length === 0) return null;
  const { manifest } = await loadManifest(plan.root);
  const declared = manifest?.test?.runner ?? null;
  if (reportPathProblem(declared, plan.root) !== null) return null;
  const spec = await detectTestRunner(plan.root, plan.sourceTests, { spec: declared });
  if (spec === null) return null;
  const built = spec.buildExec(plan.root);
  const cwd = built.cwd ?? plan.root;
  if ((cwd !== plan.root && !cwd.startsWith(`${plan.root}/`)) || await realpath(cwd).catch(() => null) !== cwd) return null;
  if (![built.cmd, ...(spec.requires ?? [])].every((cmd) => commandAvailable(cmd, { cwd }))) return null;
  return {
    id: '@source-tests', argv: [built.cmd, ...built.args], cwd,
    covers: plan.obligations.filter(({ kind }) => kind === 'source').map(({ id }) => id),
    provider: 'repository-test-runner', timeoutMs: 15 * 60_000, kind: 'source',
    parseReport: spec.parse, reportPaths: built.reportPaths ?? [],
  };
}

async function executionPlan(plan) {
  const source = await sourceCheck(plan);
  const checks = plan.selectedChecks.map((check) => ({ ...check, kind: 'document' }));
  return source === null ? checks : [...checks, source];
}

function localEnvironment() {
  const env = { SIMT_DEV_WORKSPACE: 'off', NO_COLOR: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return env;
}

async function verificationSnapshot(plan, check, obligations) {
  const inputs = checkFiles(plan.root, check);
  const checkSources = await fingerprint(plan.root, inputs);
  const sources = await fingerprint(plan.root, obligations.flatMap(({ paths, tests = [] }) => [...paths, ...tests]));
  const revisions = new Map(sources.map(({ ref, digest: revision }) => [ref, revision]));
  const verifier = digest({ id: check.id, argv: check.argv, cwd: relative(plan.root, check.cwd),
    timeoutMs: check.timeoutMs, provider: check.provider, sources: checkSources });
  const revision = await gitText(plan.root, ['rev-parse', 'HEAD']);
  return { verifier, revision, sources, revisions, tree: digest({ revision, verifier, sources }) };
}

async function runCheck(plan, check) {
  const covered = new Set(check.covers);
  const obligations = plan.obligations.filter(({ id }) => covered.has(id));
  const before = await verificationSnapshot(plan, check, obligations);
  const [cmd, ...args] = check.argv;
  const previousReport = check.reportPaths?.length ? await readReports(check.reportPaths).catch(() => '') : '';
  const result = await spawnBounded(cmd, args, {
    cwd: check.cwd, env: localEnvironment(), timeoutMs: check.timeoutMs, maxOutputBytes: 1 << 20,
  });
  const after = await verificationSnapshot(plan, check, obligations);
  const stdout = result.stdout.toString('utf8');
  let count = result.truncated ? null : observedCount(stdout);
  let reportFailed = false;
  if (check.kind === 'source' && count === null && !result.truncated) {
    const report = check.reportPaths.length ? await readReports(check.reportPaths).catch(() => '') : '';
    const parsed = check.parseReport(stdout, report === previousReport ? '' : report);
    count = (parsed?.passed?.length ?? 0) + (parsed?.failed?.length ?? 0);
    reportFailed = (parsed?.failed?.length ?? 0) > 0;
  }
  let outcome = 'pass';
  if (before.tree !== after.tree) outcome = 'raced';
  else if (result.timedOut) outcome = 'timeout';
  else if (result.spawnError !== null) outcome = 'unavailable';
  else if (result.code !== 0 || reportFailed) outcome = 'failed';
  else if (count === null) outcome = 'count-unavailable';
  else if (count < 1) outcome = 'zero-items';
  const evidence = buildEvidence({
    observedAt: new Date().toISOString(),
    subject: { tree: before.tree, before: before.tree, after: after.tree },
    revisions: { before: before.revision, after: after.revision },
    verifier: { id: check.id, digest: before.verifier }, sources: before.sources,
    obligations: obligations.map(({ id, paths, tests = [] }) => ({
      id, state: outcome, basis: 'local',
      scope: [...new Set([...paths, ...tests])].map((ref) => ({ ref, revision: before.revisions.get(ref) })),
    })),
    output: `${stdout}\n${result.stderr.toString('utf8')}`,
    summary: count === null ? `${check.id}: ${outcome}` : `${check.id}: ${outcome} (${count} observed)`,
  });
  const receipt = { version: 1, scope: plan.scope, basis: plan.basis, check: check.id,
    class: check.kind, provider: check.provider, count, outcome, evidence };
  await recordRun(plan.root, {
    cmd: `verify ${plan.scope}/${check.id}`, kind: KIND, revision: before.revision,
    exit: outcome === 'pass' ? 0 : result.code || 1, ms: result.wallMs, output: evidence.summary,
    outcome, verification: receipt,
  });
  return receipt;
}

export async function runLocalVerification(plan, { apply = false } = {}) {
  const checks = await executionPlan(plan);
  const planned = checks.map(({ id, kind, covers, timeoutMs }) => ({ id, kind, covers, timeoutMs }));
  const receipts = [];
  if (apply) {
    for (const check of checks) receipts.push(await runCheck(plan, check));
  }
  return { planned, receipts, executed: receipts.length > 0,
    pending: plan.pending, unverified: plan.selection.unverified };
}

function receiptState(receipt, snapshot, obligation) {
  if (receipt.outcome === 'raced') return 'raced';
  const read = readEvidenceRecord(receipt.evidence);
  if (read.damaged || read.version !== 2 || !Array.isArray(read.record.obligations)) return 'unverified';
  const { canon, ...body } = read.record;
  if (canon !== digest(body)) return 'unverified';
  if (receipt.evidence.verifier?.digest !== snapshot.verifier) return 'stale';
  const result = receipt.evidence.obligations?.find(({ id }) => id === obligation.id);
  if (!result || !Array.isArray(result.scope) || result.scope.some(({ ref, revision }) =>
    !snapshot.revisions.has(ref) || snapshot.revisions.get(ref) !== revision)) return 'stale';
  if (receipt.outcome !== 'pass') return receipt.outcome;
  const revisions = Object.fromEntries(snapshot.revisions);
  return validateEvidence(receipt.evidence, { revisions, needed: [{ id: obligation.id }] }).current ? 'pass' : 'unverified';
}

export async function localVerificationStatus(plan, attestations = []) {
  const { entries, errors } = await readLedger(plan.root);
  const receipts = entries.filter(({ kind, verification }) => kind === KIND &&
    verification?.version === 1 && verification.scope === plan.scope && verification.basis === plan.basis)
    .map(({ verification }) => verification).reverse();
  const checks = await executionPlan(plan);
  const snapshots = new Map();
  for (const check of checks) {
    snapshots.set(check.id, await verificationSnapshot(plan, check,
      plan.obligations.filter(({ id }) => check.covers.includes(id))));
  }

  const results = [];
  for (const obligation of plan.obligations) {
    const inputs = await fingerprint(plan.root, obligation.paths);
    const inputDigest = digest({ scope: plan.scope, id: obligation.id, inputs });
    if (obligation.kind === 'semantic-review') {
      const manual = attestations.find((entry) => entry?.id === obligation.id &&
        typeof entry.reviewer === 'string' && entry.reviewer.trim() && entry.inputDigest === inputDigest);
      results.push({ ...obligation, inputDigest, state: manual ? 'pass' : 'pending-review',
        basis: manual ? 'manual-attestation' : 'human', reviewer: manual?.reviewer ?? null });
      continue;
    }
    const runs = checks.filter(({ covers }) => covers.includes(obligation.id)).map((check) => {
      const receipt = receipts.find(({ check: id, evidence }) =>
        id === check.id && Array.isArray(evidence?.obligations) && evidence.obligations.some((item) => item?.id === obligation.id));
      return { check: check.id, provider: check.provider, count: receipt?.count ?? null,
        state: receipt ? receiptState(receipt, snapshots.get(check.id), obligation) : 'unrun' };
    });
    const passes = runs.filter(({ state }) => state === 'pass');
    const providers = new Set(passes.map(({ provider }) => provider ?? 'unspecified'));
    const pending = plan.selection.unverified.find(({ obligation: id }) => id === obligation.id);
    const state = obligation.needsIndependent && providers.size < 2 ? 'insufficient-independence'
      : passes.length > 0 ? 'pass' : runs[0]?.state ?? pending?.reason ?? 'unrun';
    results.push({ ...obligation, inputDigest, state, basis: 'local', runs });
  }
  const structure = results.filter(({ kind }) => kind !== 'semantic-review');
  return { results, pending: plan.pending, damagedReceipts: errors.length,
    structuralGreen: structure.length > 0 && plan.pending.length === 0 && errors.length === 0 && structure.every(({ state }) => state === 'pass'),
    verified: results.length > 0 && plan.pending.length === 0 && errors.length === 0 && results.every(({ state }) => state === 'pass'),
  };
}
