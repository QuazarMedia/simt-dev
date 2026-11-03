// `simt work inspect` — what this repository's work consists of, and what can validate it.
//
// Plan 4's first read-only door (W20). Every fact here is derived from the tree and the
// manifest, and nothing is executed: `detectFacets` reads paths, `probeLocal` reads which
// gates are declared and which runner files exist, and `capabilityCards` turns those into five
// answers that keep "declared", "available" and "authorized" apart. A knowledge-only
// repository must therefore report that no software test is runnable rather than inventing
// one, which is the failure this door exists to prevent.

import { EXIT, fail, present } from '../output/index.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';
import { loadManifest } from '../manifest/schema.mjs';
import { detectFacets } from '../work/facets.mjs';
import { capabilityCards, probeLocal } from '../work/capabilities.mjs';
import { validateWork } from '../work/config.mjs';

const USAGE = `run: ${CLI} work inspect`;

/**
 * The facts the door reports, and the same facts the MCP tool returns.
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
export async function workInspectFacts(root) {
  const { manifest } = await loadManifest(root).catch(() => ({ manifest: null }));
  const declared = manifest?.work ?? null;
  const [facets, local] = await Promise.all([detectFacets(root), probeLocal(root)]);
  return {
    ok: true,
    command: 'work inspect',
    root,
    facets,
    capabilities: capabilityCards({ work: declared, local }),
    work:
      declared === null
        ? { declared: false, ok: true, problems: [] }
        : { declared: true, ...validateWork(declared) },
  };
}

export async function workInspectCommand(args, flags) {
  if (args.length > 0) return fail(`unknown work inspect argument ${args[0]}`, EXIT.USAGE, USAGE);
  const payload = await workInspectFacts(commandRoot(flags));
  present(payload, () => render(payload), flags);
  return EXIT.OK;
}

function render(payload) {
  const lines = [`root       ${payload.root}`];
  for (const facet of payload.facets.artifactKinds) lines.push(`artifact   ${facet.kind.padEnd(14)}${facet.count}`);
  for (const activity of payload.facets.activities) lines.push(`activity   ${activity.activity.padEnd(14)}${activity.evidence[0] ?? ''}`);
  for (const locus of payload.facets.executionLoci) lines.push(`locus      ${locus.locus}`);
  for (const card of payload.capabilities) {
    lines.push(`validation ${card.kind.padEnd(13)}${card.mode.padEnd(15)}${card.reason}`);
  }
  if (payload.work.declared) {
    lines.push(`work       declared, ${payload.work.ok ? 'valid' : `${payload.work.problems.length} problem(s)`}`);
  } else {
    lines.push('work       no work declaration; the facts above come from paths and the manifest alone');
  }
  for (const problem of payload.work.problems) lines.push(`problem    ${problem.path}  ${problem.message}`);
  if (payload.facets.truncated) lines.push('truncated  1');
  return lines.join('\n');
}
