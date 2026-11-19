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
import { normalizePath } from './artifacts.mjs';

/** The validations a card lists separately, because they fail independently. */
export const VALIDATION_KINDS = Object.freeze(['structural', 'rubric', 'replay', 'remote-read', 'remote-write']);

/** The five sources a card keeps apart. */
export const CAPABILITY_SOURCES = Object.freeze(['declared', 'local', 'adapter', 'target', 'authorized']);

/** A token that looks like a file: a path, or a name with a program extension. */
const FILE_TOKEN = /\.(mjs|cjs|js|ts|py|sh|rb|pl|java|kt)$/i;

/**
 * The file arguments a validator command names, in the order they appear.
 *
 * The program itself is not one: `node` is not in the repository, and asking whether it is
 * would answer a question about the shell's PATH rather than about this repository. What a
 * validator can prove locally is exactly the file it runs.
 *
 * @param {string} command
 * @returns {string[]}
 */
function validatorInputs(command) {
  return String(command ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !token.startsWith('-') && (token.includes('/') || FILE_TOKEN.test(token)));
}

/**
 * Whether a declared validator can run here, read from the tree and nothing else.
 *
 * Three answers, because two would collapse a distinction the card exists to make:
 *
 *   `true`   every file the command names is in this repository
 *   `false`  a file it names is missing, or it names something outside the repository
 *   `null`   it names no file at all, so nothing in the tree can tell
 *
 * Nothing is executed. A declared command is a claim; this function only reports whether the
 * claim has a subject on disk.
 *
 * @param {string} root
 * @param {{scope?: string|null, command?: string}} reference
 * @returns {{scope: string|null, command: string, files: {path: string, exists: boolean}[], installed: boolean|null, reason: string}}
 */
export function resolveValidator(root, { scope = null, command = '' } = {}) {
  const inputs = validatorInputs(command);
  const outside = inputs.find((token) => normalizePath(token) === null);
  if (outside !== undefined) {
    return { scope, command, files: [], installed: false, reason: `${command} names ${outside}, which is outside this repository; a validator may only run what the repository owns` };
  }
  if (inputs.length === 0) {
    return { scope, command, files: [], installed: null, reason: `${command} names no file in this repository, so whether it can run cannot be read from the tree` };
  }
  const files = inputs.map((token) => ({ path: normalizePath(token) ?? token, exists: existsSync(join(root, normalizePath(token) ?? token)) }));
  const missing = files.filter((file) => !file.exists).map((file) => file.path);
  return {
    scope,
    command,
    files,
    installed: missing.length === 0,
    reason:
      missing.length === 0
        ? `${command} names ${files.map((file) => file.path).join(', ')}, which is in this repository`
        : `${command} names ${missing.join(', ')}, which is not in this repository; the check cannot run`,
  };
}

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
  // A configured scope's validator is the check a document repository actually declares, so
  // the probe resolves each one to the file it names. A declared validator whose file is
  // missing is the case that used to report `available`: the card said the check existed
  // because the manifest mentioned it.
  const scopes = Array.isArray(manifest?.work?.scopes) ? manifest.work.scopes.filter(isObject) : [];
  const validators = scopes.flatMap((scope) =>
    (Array.isArray(scope.validators) ? scope.validators : [])
      .filter(isText)
      .map((command) => resolveValidator(root, { scope: typeof scope.id === 'string' ? scope.id : null, command })),
  );
  return { gates, runnerFiles, validators };
}

/**
 * What the structural card says, in one place, so the three outcomes stay distinguishable.
 *
 * `runnable` counts the checks whose executable is not known to be absent; `missing` counts the
 * ones the probe found absent. A card that reported both as "declared" is the failure this
 * wording exists to prevent.
 */
function structuralReason({ gates, validators, missing, runnable, named, scopes, runnerFiles }) {
  if (runnable > 0) {
    const declared = [...gates.map((gate) => gate.id), ...validators.map((entry) => `${entry.scope ?? 'scope'} validator`)].join(', ');
    return missing.length === 0
      ? `${named} local check(s) are declared: ${declared}`
      : `${named} local check(s) are declared: ${declared}; ${missing.map((entry) => entry.reason).join('; ')}`;
  }
  if (named > 0) return `${named} local check(s) are declared, but none can run: ${missing.map((entry) => entry.reason).join('; ')}`;
  if (scopes.length > 0) {
    const ids = scopes.map((scope) => `\`${scope.id ?? 'scope'}\``).join(', ');
    return `scope ${ids} ${scopes.length === 1 ? 'is' : 'are'} configured with no validator, and no gate is declared; nothing names what a structural check would run`;
  }
  if (runnerFiles.length > 0) return `${runnerFiles.join(', ')} present but no gate or validator is declared; nothing names what a structural check would run`;
  return 'no gate or scope validator is declared; a structural check would have to be invented';
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
  // An unprobed validator is unknown, not missing: a caller that passed no probe has said
  // nothing about whether the file exists, and only the CLI reads the tree.
  const probed = Array.isArray(local.validators) ? local.validators.filter(isObject) : null;
  const resolvedValidators = probed ?? validators.map((entry) => ({ ...entry, files: [], installed: null }));
  const missing = resolvedValidators.filter((entry) => entry.installed === false);
  const runnable = gates.length + resolvedValidators.filter((entry) => entry.installed !== false).length;
  const structuralEvidence = [
    ...gates.map((gate) => ({ kind: 'declared', subject: `gate ${gate.id}: ${gate.command}` })),
    ...resolvedValidators.map((entry) => ({ kind: 'declared', subject: `validator ${entry.scope}: ${entry.command}` })),
    // A probed file is a declaration that a runner exists, not an observation that a check
    // ran, so it sits at the floor with everything else (ADR-142).
    ...runnerFiles.map((file) => ({ kind: 'declared', subject: `runner ${file}` })),
  ];
  const named = gates.length + resolvedValidators.length;
  const structural = card('structural', {
    declared: named > 0,
    available: runnable > 0,
    authorized: null,
    mode: runnable > 0 ? 'runner' : 'unavailable',
    evidence: structuralEvidence,
    reason: structuralReason({ gates, validators: resolvedValidators, missing, runnable, named, scopes, runnerFiles }),
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
