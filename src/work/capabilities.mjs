// Validation capability cards: what this repository can verify now, and what it only wishes
// it could.
//
// A capability report is where a tool most easily lies, because one word carries four
// different products. "Supports remote writes" can mean an adapter is installed, a target
// answered a request, an actor holds a permission, or all three; reported as one word, the
// weakest reading inherits the strongest. So every card keeps five sources apart:
//
//   declared    the repository names this check, this target or this adapter
//   local       a runner manifest is present on disk - probed, never executed
//   adapter     an installed adapter names the operation
//   target      an observation record says the target reports the capability
//   authorized  a record grants this actor this operation on this target
//
// `available` needs something installed that can actually carry the check out: a declared
// gate, an installed adapter. `authorized` is permission and never capability, so an actor
// granted a write with no adapter to perform it is `authorized: true, available: false` -
// which is the distinction the card exists to make.
//
// Nothing here opens a socket, runs a command or reads a credential file. Observations and
// authorizations arrive as records the caller already holds; probing a live target to fill
// a card would turn a report into an action, and a reachable endpoint is not a reading path
// any more than it is a write permission.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadManifest } from '../manifest/schema.mjs';
import { assuranceLevel } from './assurance.mjs';

/** The validations a card lists separately, because they fail independently. */
export const VALIDATION_KINDS = Object.freeze(['structural', 'rubric', 'replay', 'remote-read', 'remote-write']);

/** The five sources a card keeps apart. */
export const CAPABILITY_SOURCES = Object.freeze(['declared', 'local', 'adapter', 'target', 'authorized']);

/** Runner manifests whose presence is probed. Presence is not a check; see the card below. */
const RUNNER_FILES = Object.freeze(['package.json', 'pyproject.toml', 'build.gradle', 'build.gradle.kts', 'Makefile', 'Cargo.toml']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * Read what this repository holds locally, without running any of it.
 *
 * The gates are the checks the repository declares in its manifest. A runner file is probed
 * because it is evidence a runner exists - not evidence of what it runs, and not evidence
 * that anything passed.
 *
 * @returns {Promise<{gates: {id: string, command: string}[], runnerFiles: string[]}>}
 */
export async function probeLocal(root) {
  const { manifest } = await loadManifest(root);
  const gates = Object.entries(manifest?.gates ?? {})
    .filter(([, command]) => isText(command))
    .map(([id, command]) => ({ id, command }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const runnerFiles = RUNNER_FILES.filter((file) => existsSync(join(root, file)));
  return { gates, runnerFiles };
}

function card(kind, { declared = false, available = false, authorized = null, mode = 'unavailable', evidence = [], reason }) {
  return { kind, declared, available, authorized, mode, assurance: assuranceLevel(evidence), evidence, reason };
}

const ids = (adapters) => adapters.map((adapter) => `\`${adapter.id}\``).join(', ');

/** A target, observation and authorization share one key, or none of them matches. */
const targetKey = (record) => [record.namespace, record.type, record.name].filter(isText).join(':');

const operationsOf = (adapter) => (Array.isArray(adapter.operations) ? adapter.operations : []);

/**
 * The card for every validation kind, given what the repository declares and what a caller
 * has already observed or been granted.
 *
 * @param {{work?: object|null, local?: {gates?: object[], runnerFiles?: string[]}|null, adapters?: object[], observations?: object[], authorizations?: object[]}} input
 * @returns {{kind: string, declared: boolean, available: boolean, authorized: boolean|null, mode: string, assurance: string|null, evidence: {kind: string, subject?: string}[], reason: string}[]}
 */
export function capabilityCards(input = {}) {
  const work = isObject(input.work) ? input.work : null;
  const local = isObject(input.local) ? input.local : {};
  const gates = Array.isArray(local.gates) ? local.gates.filter(isObject) : [];
  const runnerFiles = Array.isArray(local.runnerFiles) ? local.runnerFiles.filter(isText) : [];
  const adapters = Array.isArray(input.adapters) ? input.adapters.filter(isObject).filter((adapter) => isText(adapter.id)) : [];
  const observations = Array.isArray(input.observations) ? input.observations.filter(isObject) : [];
  const authorizations = Array.isArray(input.authorizations) ? input.authorizations.filter(isObject) : [];

  const scopes = Array.isArray(work?.scopes) ? work.scopes.filter(isObject) : [];
  const targets = Array.isArray(work?.targets) ? work.targets.filter(isObject).filter((target) => isText(targetKey(target))) : [];
  const declaredAdapterIds = Array.isArray(work?.adapters) ? work.adapters.filter(isText) : [];

  const validators = scopes.flatMap((scope) =>
    (Array.isArray(scope.validators) ? scope.validators : []).filter(isText).map((command) => ({ scope: scope.id ?? 'scope', command })),
  );

  const installed = adapters.filter((adapter) => adapter.installed === true);
  const offering = (operation) => installed.filter((adapter) => operationsOf(adapter).includes(operation));
  const names = [...new Set([...adapters.map((adapter) => adapter.id), ...declaredAdapterIds])];

  // --- local structural ---------------------------------------------------------------
  const structuralEvidence = [
    ...gates.map((gate) => ({ kind: 'declared', subject: `gate ${gate.id}: ${gate.command}` })),
    ...validators.map((entry) => ({ kind: 'declared', subject: `validator ${entry.scope}: ${entry.command}` })),
    // A probed file is a declaration that a runner exists, not an observation that a check
    // ran, so it sits at the floor with everything else (ADR-142).
    ...runnerFiles.map((file) => ({ kind: 'declared', subject: `runner ${file}` })),
  ];
  const named = gates.length + validators.length;
  const structural = card('structural', {
    declared: named > 0,
    available: named > 0,
    authorized: null,
    mode: named > 0 ? 'runner' : 'unavailable',
    evidence: structuralEvidence,
    reason:
      named > 0
        ? `${named} local check(s) are declared: ${[...gates.map((gate) => gate.id), ...validators.map((entry) => `${entry.scope} validator`)].join(', ')}`
        : runnerFiles.length > 0
          ? `${runnerFiles.join(', ')} present but no gate or validator is declared; nothing names what a structural check would run`
          : 'no gate or scope validator is declared; a structural check would have to be invented',
  });

  // --- semantic rubric ----------------------------------------------------------------
  const rubricDeclaring = adapters.filter((adapter) => operationsOf(adapter).includes('rubric'));
  const rubricInstalled = rubricDeclaring.filter((adapter) => adapter.installed === true);
  const rubric = card('rubric', {
    declared: rubricDeclaring.length > 0,
    available: rubricInstalled.length > 0,
    authorized: null,
    mode: rubricInstalled.length > 0 ? 'adapter' : rubricDeclaring.length > 0 ? 'unavailable' : 'agent-workflow',
    evidence: rubricDeclaring.map((adapter) => ({ kind: 'declared', subject: `adapter ${adapter.id}` })),
    reason:
      rubricInstalled.length > 0
        ? `adapter ${ids(rubricInstalled)} can run a semantic rubric`
        : rubricDeclaring.length > 0
          ? `adapter ${ids(rubricDeclaring)} declares a rubric but is not installed`
          : 'no callable rubric adapter is installed; a rubric stays an agent workflow and its result is not evidence this tool verified',
  });

  // --- offline replay -----------------------------------------------------------------
  const replayDeclaring = adapters.filter((adapter) => operationsOf(adapter).includes('replay'));
  const replayInstalled = replayDeclaring.filter((adapter) => adapter.installed === true);
  const replay = card('replay', {
    declared: replayDeclaring.length > 0,
    available: replayInstalled.length > 0,
    authorized: null,
    mode: replayInstalled.length > 0 ? 'adapter' : 'unavailable',
    evidence: replayDeclaring.map((adapter) => ({ kind: 'declared', subject: `adapter ${adapter.id}` })),
    reason:
      replayInstalled.length > 0
        ? `adapter ${ids(replayInstalled)} can replay a recorded interaction offline`
        : replayDeclaring.length > 0
          ? `adapter ${ids(replayDeclaring)} declares replay but is not installed`
          : 'no replay adapter is installed; a recorded interaction cannot be replayed here, and a mocked run is not a live check',
  });

  // --- remote read --------------------------------------------------------------------
  const keys = [...new Set(targets.map(targetKey))];
  const reads = offering('read');
  const readObservations = keys.flatMap((key) =>
    observations
      .filter((observation) => targetKey(observation) === key && observation.reachable === true && operationsOf(observation).includes('read'))
      .map(() => ({ kind: 'observed', subject: key, passed: true })),
  );
  const unread = keys.filter((key) => !readObservations.some((item) => item.subject === key));
  const remoteRead = card('remote-read', {
    declared: keys.length > 0,
    available: reads.length > 0 && keys.length > 0,
    authorized: null,
    mode: reads.length > 0 && keys.length > 0 ? 'adapter' : 'unavailable',
    evidence: [
      ...keys.map((key) => ({ kind: 'declared', subject: key })),
      ...reads.map((adapter) => ({ kind: 'declared', subject: `adapter ${adapter.id}` })),
      ...readObservations,
    ],
    reason:
      reads.length > 0 && keys.length > 0
        ? `adapter ${ids(reads)} reads ${keys.join(', ')}${readObservations.length > 0 ? '; the target reports read support' : '; no observation has confirmed the target answers'}`
        : keys.length === 0
          ? 'no target is declared in the work manifest; there is nothing to read'
          : `target ${keys.join(', ')} is declared but no installed adapter reads it${unread.length < keys.length ? '; an endpoint answering is not a reading path' : ''}`,
  });

  // --- remote write -------------------------------------------------------------------
  const writes = offering('write');
  const grants = authorizations.filter(
    (record) => isText(record.actor) && keys.includes(targetKey(record)) && operationsOf(record).includes('write'),
  );
  const reachable = keys.filter((key) => observations.some((observation) => targetKey(observation) === key && observation.reachable === true));
  const remoteWrite = card('remote-write', {
    declared: keys.length > 0 || writes.length > 0,
    available: writes.length > 0 && grants.length > 0,
    authorized: grants.length > 0,
    mode: writes.length > 0 && grants.length > 0 ? 'adapter' : 'unavailable',
    evidence: [
      ...keys.map((key) => ({ kind: 'declared', subject: key })),
      ...writes.map((adapter) => ({ kind: 'declared', subject: `adapter ${adapter.id}` })),
      ...grants.map((grant) => ({ kind: 'declared', subject: `authorization ${grant.actor} -> ${targetKey(grant)}` })),
    ],
    reason:
      writes.length > 0 && grants.length > 0
        ? `adapter ${ids(writes)} writes ${grants.map(targetKey).join(', ')} as ${grants.map((grant) => grant.actor).join(', ')}`
        : writes.length > 0
          ? `adapter ${ids(writes)} declares a write but no authorization record grants an actor the operation${reachable.length > 0 ? '; a reachable endpoint does not imply authorization' : ''}`
          : grants.length > 0
            ? `${grants.map((grant) => grant.actor).join(', ')} is authorized to write ${grants.map(targetKey).join(', ')} but no installed adapter can carry it out`
            : `no installed adapter writes a declared target and no authorization record grants one${reachable.length > 0 ? '; a reachable endpoint does not imply authorization or mutation capability' : ''}`,
  });

  return [structural, rubric, replay, remoteRead, remoteWrite];
}
