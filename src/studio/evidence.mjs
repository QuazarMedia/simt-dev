// Custody's reader: group the ledger by tree and keep every link visible.
//
// `/api/evidence` remains the CLI's current-tree document. This module answers the
// question the chain view asks: every run, grouped by the tree it proved, with the current
// tree marked and older trees retained rather than filtered away. A v1 line carries no
// kind or outcome; it is rendered as local-only instead of being read as a v2 verdict.

import { GATES } from '../hooks/gates.mjs';
import { claimsVerification, hasTestEvidence, indexTreeId, readLedger, treeId } from '../ledger/index.mjs';

function outcomeOf(entry) {
  if (typeof entry.outcome === 'string') return entry.outcome;
  if (entry.exit === 0) return 'passed';
  return 'failed';
}

function linkOf(entry) {
  const gate = typeof entry.gate === 'string' ? entry.gate : null;
  const legacy = !(entry.v >= 2);
  return {
    v: entry.v ?? 1,
    gate,
    kind: entry.kind ?? null,
    cmd: entry.cmd ?? '',
    exit: entry.exit,
    ms: entry.ms ?? null,
    outcome: outcomeOf(entry),
    summary: entry.summary ?? '',
    revision: entry.revision ?? null,
    adr: gate && GATES[gate] ? GATES[gate].adr : null,
    legacy,
    localOnly: legacy,
  };
}

/** The central gate table, with the why each gate exists. */
export function gateCatalog() {
  return Object.values(GATES).map(({ name, kind, adr, why }) => ({ name, kind, adr, why })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every ledger run grouped by its subject tree.
 *
 * `claim` is an optional message typed into the view. The verdict uses the same
 * `claimsVerification` and `hasTestEvidence` functions as `evidence check`; this reader
 * never treats a typed claim as evidence on its own.
 */
export async function evidenceChains(root, { claim = null } = {}) {
  let head;
  try {
    head = await treeId(root);
  } catch (error) {
    return { ok: false, error: `could not name this tree (${error.message})`, remedy: 'run this inside a git repository' };
  }
  const { entries, errors } = await readLedger(root);
  const byTree = new Map();
  for (const entry of entries) {
    const tree = typeof entry.tree === 'string' ? entry.tree : (typeof entry.subjectTree === 'string' ? entry.subjectTree : 'unknown');
    if (!byTree.has(tree)) byTree.set(tree, { tree, current: tree === head, stale: tree !== head, links: [] });
    byTree.get(tree).links.push(linkOf(entry));
  }
  const chains = [...byTree.values()].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.tree.localeCompare(b.tree);
  });
  let verdict = null;
  if (typeof claim === 'string' && claim.trim() !== '') {
    let indexTree = head;
    try {
      indexTree = (await indexTreeId(root)) ?? head;
    } catch {
      // An unborn or detached checkout still has a worktree tree; the claim check falls
      // back to the HEAD tree rather than turning the whole room into a refusal.
    }
    verdict = {
      message: claim,
      claims: claimsVerification(claim),
      supported: hasTestEvidence(entries, indexTree, { basis: 'index' }),
      tree: indexTree,
    };
  }
  return {
    ok: errors.length === 0,
    command: 'evidence chains',
    root,
    tree: head,
    errors,
    chains,
    catalog: gateCatalog(),
    claim: verdict,
  };
}
