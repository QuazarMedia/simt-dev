// One release, resolved once (ADR-203).
//
// The channels used to resolve the version themselves, each from the dispatch input:
// `latest` was expanded in three jobs, so a release landing between them split one run
// across two versions, and `0.7.0` and `latest` named the same artifact under two
// concurrency groups. The fix is not a stricter input check - it is one resolution whose
// answer is DATA, validated once, and fed to every job.
//
// This module is the pure half: given a probe (a set of small async functions that read
// npm, the tag, the release assets and the tap), it produces a descriptor or the reasons
// it cannot. The IO half is scripts/release-descriptor.mjs; tests drive both, and the
// workflow runs the script once and hands the JSON on.
//
// Nothing here trusts the input. A dispatch field is a string somebody typed, it used to
// reach a shell command through `${{ }}` interpolation, and the first thing resolution
// does is refuse every shape but a concrete semver after trimming. `latest` is a request,
// never a value: it is the one input that resolves to something read from the registry.

import { createHash } from 'node:crypto';

import { TARGETS, assetName, releaseUrl } from './release.mjs';

/** The descriptor's own schema. A reader refuses a version it does not know. */
const DESCRIPTOR_SCHEMA = 1;

/** What a dispatch may legitimately ask for. */
const LATEST = 'latest';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * What the caller asked for, without deciding what it means.
 *
 * An empty field and `latest` are the same request: whatever the registry serves as
 * newest. Anything else must already be a concrete version - the form is not a place
 * for ranges, tags or shell text, and refusing them here is what keeps the value out
 * of every command downstream.
 */
export function parseRequest(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || text === LATEST) return { request: LATEST, version: null, error: null };
  if (!SEMVER.test(text)) {
    return {
      request: 'explicit',
      version: null,
      error: `the version input "${text}" is not a concrete x.y.z release; name one, or leave it as latest`,
    };
  }
  return { request: 'explicit', version: text, error: null };
}

/** sha256 of a buffer, hex. One spelling, so two call sites cannot disagree. */
export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The identity of a descriptor.
 *
 * Over the facts a promotion depends on - version, source commit, and each asset's
 * bytes - and not over when it was resolved. Two runs that resolved the same release
 * produce the same id, which is what makes the evidence comparable and the artifact
 * worth uploading.
 */
export function descriptorId(descriptor) {
  const parts = [
    `schema:${descriptor.schema}`,
    `version:${descriptor.version}`,
    `tag:${descriptor.tag}`,
    `commit:${descriptor.commit}`,
    ...descriptor.assets
      .slice()
      .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
      .map((asset) => `asset:${asset.target}:${asset.sha256}:${asset.bytes}`),
  ];
  return digestOf(parts.join('\n'));
}

/**
 * Read the tap's formula into the checksums it would install.
 *
 * The formula is the one place a checksum is authoritative for brew, and it is written
 * by a different job from the one that downloaded the bytes. Comparing the two is the
 * cross-channel check: a formula that names this version with a different hash is a
 * formula that installs bytes nobody verified.
 */
export function formulaChecksums(text, version) {
  const found = new Map();
  if (!text) return found;
  const pair = /^    url "([^"]+)"\n    sha256 "([0-9a-f]{64})"$/gm;
  for (const match of text.matchAll(pair)) {
    const url = match[1];
    if (!url.includes(`/v${version}/`)) continue;
    for (const target of TARGETS) {
      if (url.endsWith(`-${target}`)) found.set(target, match[2]);
    }
  }
  return found;
}

/**
 * Resolve and validate one release.
 *
 * Returns `{descriptor, errors}` and never throws for a probe's absence: a missing tag,
 * a staged npm version and an undownloadable asset are the three ways this run is not
 * ready, and each one has a different remedy that belongs in the message.
 *
 * @param {string} raw the dispatch value
 * @param {{latestVersion: Function, npmHas: Function, tagCommit: Function, asset: Function, tapFormula?: Function}} probe
 */
export async function resolveRelease(raw, probe) {
  const request = parseRequest(raw);
  const errors = [];
  if (request.error) return { descriptor: null, errors: [request.error] };

  let version = request.version;
  if (version === null) {
    try {
      version = String(await probe.latestVersion()).trim();
    } catch (error) {
      return { descriptor: null, errors: [`could not read the newest version from npm: ${error.message}`] };
    }
    if (!SEMVER.test(version)) {
      return { descriptor: null, errors: [`npm answered "${version}", which is not a concrete x.y.z release`] };
    }
  }

  const tag = `v${version}`;
  let commit = null;
  try {
    commit = await probe.tagCommit(version);
  } catch (error) {
    errors.push(`could not read tag ${tag} from the remote: ${error.message}`);
  }
  if (commit === null && errors.length === 0) {
    errors.push(
      `tag ${tag} is not on the remote; publish.yml creates it from the version commit, so the release this input names does not exist`,
    );
  }
  if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) {
    errors.push(`tag ${tag} resolved to "${commit}", which is not a commit id`);
  }

  let npmPresent = false;
  try {
    npmPresent = (await probe.npmHas(version)) === true;
  } catch (error) {
    errors.push(`could not ask npm about simt-dev@${version}: ${error.message}`);
  }
  if (!npmPresent && errors.length === 0) {
    errors.push(
      `simt-dev@${version} is not on the npm registry; the npm channel publishes by STAGING, so approve the stage first (npm stage list, npm stage approve <stage-id>) and run this workflow again`,
    );
  }

  const assets = [];
  for (const target of TARGETS) {
    const name = assetName(version, target);
    const url = releaseUrl(version, target);
    let bytes;
    try {
      bytes = await probe.asset(version, target);
    } catch (error) {
      errors.push(
        `${url} is not downloadable (${error.message}); publish.yml builds the assets when the tag is pushed, so push or re-run it first`,
      );
      continue;
    }
    assets.push({ target, name, url, sha256: digestOf(bytes), bytes: bytes.byteLength });
  }

  // The tap is optional at resolution time: a first release has no formula yet, and the
  // brew job renders it from this descriptor. When a formula DOES name this version its
  // hashes are checked, because that is a channel already claiming this release.
  if (assets.length === TARGETS.length) errors.push(...(await tapErrors(assets, version, probe)));

  if (errors.length > 0) return { descriptor: null, errors };
  const descriptor = { schema: DESCRIPTOR_SCHEMA, version, tag, commit, assets };
  return { descriptor: { ...descriptor, id: descriptorId(descriptor) }, errors: [] };
}

/**
 * The tap's formula against the bytes the release serves.
 *
 * A formula that already names this version with a different hash is a channel that
 * would install bytes nobody verified, and it is the only channel whose checksums are
 * written by hand as well as by the job. Read, compared, and silent when the tap does
 * not name this version at all (the first release, and every release until brew runs).
 */
async function tapErrors(assets, version, probe) {
  if (typeof probe.tapFormula !== 'function') return [];
  let formula = null;
  try {
    formula = await probe.tapFormula();
  } catch {
    return [];
  }
  const declared = formulaChecksums(formula, version);
  const errors = [];
  for (const asset of assets) {
    const tap = declared.get(asset.target);
    if (tap !== undefined && tap !== asset.sha256) {
      errors.push(
        `the tap serves simt-dev-${version}-${asset.target} at sha256 ${tap}, but the release serves ${asset.sha256}; the formula and the asset disagree`,
      );
    }
  }
  return errors;
}

/** Refuse a descriptor whose shape is not the one this reader understands. */
export function checkDescriptor(descriptor) {
  const errors = [];
  if (!descriptor || typeof descriptor !== 'object') return ['the release descriptor is not an object'];
  if (descriptor.schema !== DESCRIPTOR_SCHEMA) {
    errors.push(`the release descriptor has schema ${descriptor.schema}, and this tool reads ${DESCRIPTOR_SCHEMA}`);
  }
  if (!SEMVER.test(String(descriptor.version ?? ''))) errors.push('the release descriptor names no concrete version');
  if (!/^[0-9a-f]{40}$/.test(String(descriptor.commit ?? ''))) errors.push('the release descriptor names no commit');
  if (!Array.isArray(descriptor.assets)) errors.push('the release descriptor carries no assets');
  else {
    for (const target of TARGETS) {
      const asset = descriptor.assets.find((a) => a.target === target);
      if (!asset) errors.push(`the release descriptor has no ${target} asset`);
      else if (!/^[0-9a-f]{64}$/.test(String(asset.sha256 ?? ''))) {
        errors.push(`the release descriptor's ${target} asset has no sha256`);
      }
    }
  }
  if (descriptor.id !== descriptorId(descriptor)) errors.push('the release descriptor id does not match its contents');
  return errors;
}

/**
 * Re-check a descriptor immediately before promoting, because a descriptor is a claim
 * about a moving world.
 *
 * Three things can move under it and each is a release defect rather than a nuisance:
 * npm's newest version (the `latest` alias now points somewhere else), the tag (moved or
 * deleted), and the asset bytes (a re-uploaded or clobbered release). This is the same
 * resolution, aimed at the recorded values instead of the request.
 */
export async function verifyRelease(descriptor, probe) {
  const errors = checkDescriptor(descriptor);
  if (errors.length > 0) return { ok: false, errors };

  try {
    const newest = String(await probe.latestVersion()).trim();
    if (newest !== descriptor.version) {
      errors.push(
        `npm's newest version moved from ${descriptor.version} to ${newest} after this release was resolved; re-run the workflow so one run promotes one release`,
      );
    }
  } catch (error) {
    errors.push(`could not re-read the newest version from npm: ${error.message}`);
  }

  try {
    const commit = await probe.tagCommit(descriptor.version);
    if (commit !== descriptor.commit) {
      errors.push(`tag ${descriptor.tag} now resolves to ${commit ?? '(nothing)'}, not ${descriptor.commit}`);
    }
  } catch (error) {
    errors.push(`could not re-read tag ${descriptor.tag}: ${error.message}`);
  }

  for (const asset of descriptor.assets) {
    let bytes;
    try {
      bytes = await probe.asset(descriptor.version, asset.target);
    } catch (error) {
      errors.push(`${asset.url} is no longer downloadable (${error.message}); the release is partially published`);
      continue;
    }
    const served = digestOf(bytes);
    if (served !== asset.sha256) {
      errors.push(`${asset.name} now hashes to ${served}, not ${asset.sha256}; the served bytes are not the resolved bytes`);
    }
  }

  // Only when every asset was reachable: a missing asset is already named, and a tap
  // comparison against a half-read list would report the wrong channel.
  if (descriptor.assets.every((asset) => errors.every((line) => !line.includes(asset.url)))) {
    errors.push(...(await tapErrors(descriptor.assets, descriptor.version, probe)));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * What each destination still has to do, given what it already serves.
 *
 * A retry after a partial promotion must be safe: the same bytes already published are a
 * skip, not a republish (npm refuses one; PyPI refuses one), and a destination that
 * serves this version at DIFFERENT bytes is a conflict no automation may paper over.
 *
 * @param {{version: string, sha256: string|null}|null} current what the destination serves now
 * @param {object} descriptor
 */
export function promotionStep(current, descriptor) {
  if (!current || current.version !== descriptor.version) {
    return { action: 'publish', reason: 'this destination does not serve the release yet' };
  }
  const wanted = descriptorId(descriptor);
  if (current.sha256 === wanted || current.sha256 == null) {
    return { action: 'skip', reason: 'this destination already serves the release' };
  }
  return {
    action: 'conflict',
    reason: `this destination serves ${descriptor.version} with different bytes; a republish cannot replace an immutable release`,
  };
}

/** The evidence a maintainer reviews, in one stable block per line. */
export function evidenceLines(descriptor) {
  return [
    `release     simt-dev ${descriptor.version}`,
    `commit      ${descriptor.commit}`,
    `tag         ${descriptor.tag}`,
    ...descriptor.assets.map(
      (asset) => `asset       ${asset.name} ${asset.sha256} ${asset.bytes} bytes ${asset.url}`,
    ),
    `descriptor  ${descriptor.id}`,
  ];
}
