import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { ALWAYS_DENIED, CORPUS_DEFAULTS, buildCorpus } from './corpus.mjs';
import { IDENTITY_FILE, identityMap, readIdentityMap } from './lineage.mjs';
import { inventorySources } from './sources.mjs';
import { resolveScope } from '../work/artifacts.mjs';

/** Read a bounded regular file with no symbolic links in its repo-relative path. */
export async function readLocalBytes(root, path, maxBytes = CORPUS_DEFAULTS.maxBytes) {
  if (path.split('/').some((segment) => /^(?:\.env(?:\.|$)|\.ssh$|\.gnupg$)/.test(segment))) return null;
  const named = join(root, path);
  try {
    if (!named.startsWith(`${root}/`) || await realpath(named) !== named) return null;
    const handle = await open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return null;
      const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead === info.size ? bytes.subarray(0, bytesRead) : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function collectCorpus({ root, work, scope, previous = null }) {
  let inventory;
  try {
    inventory = await inventorySources(root, { paths: scope.paths, maxFiles: CORPUS_DEFAULTS.maxFiles });
  } catch (error) {
    return {
      error: `cannot list the tracked files of this repository: ${String(error?.message ?? error).split('\n')[0]}`,
      remedy: 'run this in a Git repository with one commit',
    };
  }
  const physicalRoot = await realpath(root);
  const read = (path) => readLocalBytes(physicalRoot, path);
  const text = async (path) => (await read(path))?.toString('utf8') ?? null;
  const declaredIdentities = await text(IDENTITY_FILE);
  let identities = {};
  if (declaredIdentities !== null) {
    let doc;
    try {
      doc = JSON.parse(declaredIdentities);
    } catch (error) {
      return { error: `${IDENTITY_FILE} is not JSON: ${error.message}`, remedy: 'fix or remove the identity map' };
    }
    const map = readIdentityMap(doc);
    const fatal = map.problems.find((entry) => entry.code !== 'duplicate-id');
    if (fatal !== undefined) return { error: `${IDENTITY_FILE}: ${fatal.message}`, remedy: fatal.remedy };
    identities = identityMap(map.paths);
  }
  const deny = [...ALWAYS_DENIED, ...work.scopes.flatMap(({ tracker }) => tracker?.visibility === 'private' ? [tracker.path] : [])];
  const controlled = new Set(inventory.candidates.filter((row) => row.tracked && !row.symlink).map((row) => row.path));
  const corpus = await buildCorpus({
    scope,
    scopes: work.scopes,
    candidates: inventory.candidates,
    policy: { deny, identities, maxBytes: CORPUS_DEFAULTS.maxBytes, unitBytes: CORPUS_DEFAULTS.unitBytes },
    previous,
    read,
    sidecar(path) {
      const sidecar = `${path}.meta.json`;
      const owner = resolveScope(work.scopes, sidecar);
      return controlled.has(sidecar) && owner.scope === scope.id && !owner.ignored ? text(sidecar) : null;
    },
  });
  return { corpus, candidates: inventory.candidates, truncated: inventory.truncated };
}
