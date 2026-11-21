import { realpath } from 'node:fs/promises';

import { loadManifest } from '../manifest/schema.mjs';
import { gitText } from '../sys/git.mjs';
import { normalizePath, resolveScope } from '../work/artifacts.mjs';
import { BUNDLE_SCHEMA, exportBundle, importBundle } from './bundle.mjs';
import { EDGE_KINDS } from './claims.mjs';
import { collectCorpus, readLocalBytes } from './collect.mjs';
import { digestOf } from './observations.mjs';
import { isIsoDay } from './validity.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LIMIT = 1024;
const text = (value) => typeof value === 'string';
const idOK = (value) => text(value) && value.length <= 128 && ID.test(value);
const sharedPrefix = (prefix, path) => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`);
const today = () => new Date().toISOString().slice(0, 10);

async function repositoryBasis(root) {
  const { manifest } = await loadManifest(root);
  const revision = await gitText(root, ['rev-parse', 'HEAD']);
  // An unadopted repository still has a reproducible identity across its own clones.
  const roots = (await gitText(root, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').sort();
  return { repository: manifest?.id ?? digestOf(roots.join('\n')), revision };
}

function applicableArtifact({ work, scope }, path) {
  if (!text(path) || normalizePath(path) !== path || path.split('/').some((segment) =>
    /^(?:\.env(?:\.|$)|\.ssh$|\.gnupg$|\.simt$|\.git$|node_modules$)/.test(segment))) return false;
  if (work.scopes.some(({ tracker }) => tracker?.visibility === 'private' && sharedPrefix(tracker.path, path))) return false;
  const owner = resolveScope(work.scopes, path);
  return owner.scope === scope.id && !owner.ignored;
}

function checkedCatalogue(document, context, corpus, basis, at) {
  if (document?.version !== 1 || !Array.isArray(document.entries) || document.entries.length > LIMIT) {
    return { error: `a version 1 catalogue needs an entries list of at most ${LIMIT} candidates` };
  }
  if (document.repository !== basis.repository) return { error: 'the catalogue describes another repository' };
  if (document.revision !== basis.revision) return { error: 'the catalogue revision is stale' };
  const entries = [];
  const problems = [];
  const duplicates = [];
  const known = new Map();
  const units = new Map(corpus.units.map((unit) => [JSON.stringify([unit.path, unit.anchor]), unit]));
  for (const item of document.entries) {
    if (!idOK(item?.id) || !text(item?.anchor) || !['public', 'internal'].includes(item.permission) ||
        !applicableArtifact(context, item.path)) {
      problems.push({ code: 'inadmissible-catalogue-entry' });
      continue;
    }
    const unit = units.get(JSON.stringify([item.path, item.anchor]));
    if (!unit || unit.provenance !== 'committed' || unit.revision !== item.revision) {
      problems.push({ id: item.id, code: 'unverified-location' });
      continue;
    }
    const entry = { id: item.id, path: unit.path, anchor: unit.anchor,
      artifact: unit.artifact, revision: unit.revision, permission: item.permission };
    const prior = known.get(item.id);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(entry)) {
        known.set(item.id, null);
        problems.push({ id: item.id, code: 'conflicting-candidate' });
      } else duplicates.push(item.id);
      continue;
    }
    known.set(item.id, entry);
  }
  entries.push(...[...known.values()].filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)));
  const edges = [];
  for (const link of (Array.isArray(document.links) ? document.links : []).slice(0, LIMIT)) {
    if (!known.get(link?.from) || !known.get(link?.to)) {
      problems.push({ code: 'unknown-catalogue-endpoint' });
      continue;
    }
    if (!EDGE_KINDS.includes(link.kind)) problems.push({ code: 'unsupported-catalogue-edge', from: link.from, to: link.to });
    else edges.push({ from: link.from, to: link.to, kind: link.kind, status: 'proposed' });
  }
  const observations = [];
  const observed = new Set();
  for (const item of (Array.isArray(document.observations) ? document.observations : []).slice(0, LIMIT)) {
    if (!idOK(item?.id) || !known.get(item?.ref) || !isIsoDay(item.observedAt) ||
        !isIsoDay(item.expiresAt) || item.observedAt > at || item.expiresAt < at ||
        !/^sha256-[0-9a-f]{64}$/.test(item.digest ?? '')) {
      problems.push({ code: 'unavailable-offline-observation' });
      continue;
    }
    if (observed.has(item.id)) {
      duplicates.push(item.id);
      continue;
    }
    observed.add(item.id);
    observations.push({ id: item.id, candidate: item.ref, observedAt: item.observedAt, expiresAt: item.expiresAt,
      digest: item.digest, basis: 'external-observation' });
  }
  return { entries, edges, observations, duplicates: [...new Set(duplicates)].sort(), problems, executed: false };
}

export async function configuredCatalogue(context, corpus) {
  if (context.scope.catalogue === undefined) return null;
  try {
    const root = await realpath(context.root);
    const bytes = await readLocalBytes(root, context.scope.catalogue, 512 * 1024);
    if (bytes === null) return { error: 'the configured catalogue is unavailable' };
    return checkedCatalogue(JSON.parse(bytes.toString('utf8')), context, corpus, await repositoryBasis(root), today());
  } catch {
    return { error: 'the configured catalogue could not be read and validated' };
  }
}

export async function scopedExchange(sub, context, { doc = null, limit = 20, page = 0 } = {}) {
  const basis = await repositoryBasis(context.root);
  if (sub === 'export' && !(context.scope.share?.length > 0)) return { error: 'the scope declares no shareable paths' };
  const collected = await collectCorpus(context);
  if (collected.error) return collected;
  const { corpus } = collected;
  if (sub === 'export') {
    const permitted = (path) => applicableArtifact(context, path) &&
      resolveScope([{ id: 'shared', paths: context.scope.share }], path).scope === 'shared';
    const units = corpus.units.filter(({ path, provenance }) => provenance === 'committed' && permitted(path));
    const seen = new Set();
    const facts = units.flatMap((unit) => {
      const id = `${unit.artifact}:${unit.id}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ id, kind: 'source-citation', text: unit.title || unit.path, permission: 'public',
        revision: { ref: unit.path, digest: unit.sourceDigest } }];
    });
    return exportBundle({ facts, repository: basis.repository,
      revisions: [{ ref: 'HEAD', digest: basis.revision }], limit, page, hideCounts: true });
  }

  const bundle = doc?.bundle ?? doc;
  if (bundle?.schema === BUNDLE_SCHEMA) {
    const report = importBundle(bundle, { at: today() });
    if (!report.ok) return report;
    if (bundle.producer?.digest !== digestOf(JSON.stringify({ revisions: bundle.revisions, facts: bundle.facts }))) {
      return { error: 'the bundle does not match its producer digest' };
    }
    const byPath = new Map(corpus.artifacts.map((artifact) => [artifact.path, artifact]));
    const seen = new Set();
    const duplicates = [];
    const facts = report.facts.flatMap((fact) => {
      const source = byPath.get(fact.revision.ref);
      if (!source || !applicableArtifact(context, source.path) || source.provenance !== 'committed' ||
          source.digest !== fact.revision.digest) return [];
      if (seen.has(fact.id)) {
        duplicates.push(fact.id);
        return [];
      }
      seen.add(fact.id);
      return [{ id: fact.id, kind: fact.kind, revision: fact.revision, basis: 'external-observation' }];
    });
    return { ...report, facts, duplicates: [...new Set(duplicates)].sort() };
  }
  return checkedCatalogue(doc, context, corpus, basis, today());
}
