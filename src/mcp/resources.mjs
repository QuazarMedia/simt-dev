// Rules, decisions, the kernel region and the next plan slice as MCP resources.
//
// The tools answer questions and the answers are arguments to the next call. These
// answer a different request: "what is the rule you would apply, in full", "what does an
// agent actually read here", "what does the plan say to do next". A client that reads
// them can hold the text rather than reconstructing it from a tool's summary, and a
// reader outside this estate gets the same bytes an adopting repository's agent reads -
// redacted, because a decision record cites its own rulings and not this repository's
// layout (ADR-055, ADR-061).
//
// All revisions agree on the shape here. They disagree about what a missing resource
// returns, and that difference is handled in the server, not here: this module answers
// with a resource or with nothing at all, and never with an empty `contents` array,
// which the newest revision forbids because it is indistinguishable from an empty rule.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DECISIONS_DIR, loadDecisionsCached, redactEstate, redactInternalPaths } from '../decisions/index.mjs';
import { planNext } from '../plan/index.mjs';
import { loadMdcRules } from '../projection/mdc.mjs';
import { desiredRegion, loadRules } from '../projection/rules.mjs';

const RULES_SCHEME = 'simt://rules/';
const DECISIONS_SCHEME = 'simt://decisions/';

/**
 * RFC 6570 templates, so a client can discover the shape without a hard-coded string.
 *
 * `id` and `adr` are the handles a reader already has: a gate names a rule id and a
 * finding names an ADR, so the template's variable names match what those print. The two
 * fixed resources (`simt://kernel`, `simt://plan/next`) have no handle to substitute and
 * so are listed directly, not templated.
 */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${RULES_SCHEME}{id}`,
    name: 'rules',
    title: 'Projected rules',
    description: 'One rule as this tool projects it: its frontmatter, its body and its decision citations.',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: `${DECISIONS_SCHEME}{adr}`,
    name: 'decisions',
    title: 'Decision records',
    description: 'One decision record, including the rulings and the reasons they were given.',
    mimeType: 'text/markdown',
  },
];

/**
 * Split a resource URI into its collection and its handle.
 *
 * String handling rather than `new URL`, because a custom scheme is parsed by the WHATWG
 * URL machinery according to rules written for http, and the one thing this has to get
 * right is which character separates `simt://rules` from the id. A handle that carries a
 * slash or a dot segment is refused rather than resolved: a resource URI is not a file
 * path, and the specification requires a server to reject one that tries to be.
 */
function parseResourceUri(uri) {
  if (typeof uri !== 'string') return null;
  // `simt://kernel` is one resource and not a collection: there is no handle to split,
  // so it is matched whole, and anything that only looks like it (`simt://kernel/`)
  // falls through to the refusals below.
  if (uri === 'simt://kernel') return { collection: 'kernel' };
  const [collection, ...rest] = uri.split('://');
  if (collection !== 'simt') return null;
  const [name, ...handle] = rest.join('://').split('/');
  const id = handle.join('/');
  if (!id || id === '.' || id === '..' || id.includes('..')) return null;
  if (name === 'rules' && id.includes('/')) return null;
  // `plan` holds one resource per working plan, and the handle says which: `next` is the
  // plan's own vocabulary for the next ready slice. Any other handle names a resource
  // that does not exist, so it is refused here rather than resolved against a reader's
  // guess.
  if (name === 'plan') return id === 'next' ? { collection: 'plan', id: 'next' } : null;
  if (name !== 'rules' && name !== 'decisions') return null;
  return { collection: name, id };
}

function resource(collection, id, title, bytes) {
  return {
    uri: `simt://${collection}/${id}`,
    name: id,
    title,
    description: `${title}, as this tool projects it`,
    mimeType: 'text/markdown',
    size: bytes,
  };
}

/**
 * The kernel region for a root, rendered on demand.
 *
 * `simt://kernel` promises the kernel's bytes by its name, whatever the repository
 * declared: the declared mode governs what `sync` writes to disk, not what a read path
 * may look at, and a read that re-consulted the manifest would answer a different
 * question than the URI asked (ADR-002). `mode` is threaded through `desiredRegion` for
 * exactly this caller.
 */
function kernelRegion(root) {
  return desiredRegion(root, { mode: 'kernel' });
}

/**
 * Every rule, every decision record, the kernel and - when one is ready - the next
 * plan slice, one entry each.
 *
 * The list is built from what is on disk rather than from a hand-kept index, so it cannot
 * describe a rule that was renamed or a record that was never written. Order is sorted:
 * the newest revision forbids a set that varies per connection or as a side effect of
 * another request, and a list built from a directory read is the only shape that satisfies
 * that without a cache to invalidate.
 *
 * The slice is listed only when one is ready. A listing that promises a read the server
 * then answers with "not found" is a listing that lies, and the plan's "no ready slice"
 * cases are information about the plan, which the `plan_next` tool reports, not about a
 * resource's text.
 */
export async function listResources(root = process.cwd()) {
  const [rules, mdc, { decisions }, region, plan] = await Promise.all([
    loadRules(null),
    loadMdcRules(),
    // Q55: the shipped records through the shared cache (root locates the cache
    // file; the directory stays the package's own, which is what is served).
    loadDecisionsCached({ root, dir: DECISIONS_DIR, all: true }),
    kernelRegion(root),
    planNext(root, null),
  ]);
  // `size` is the bytes on disk rather than the bytes served: `read` redacts a decision
  // before sending it, so the served length is not knowable without reading the file, and
  // a size that disagrees with the payload is worse than a size that rounds. The kernel
  // and the slice have no such gap - both serve exactly what they list - so their sizes
  // are the served ones.
  return [
    {
      uri: 'simt://kernel',
      name: 'kernel',
      title: 'The kernel region',
      description: 'The rules this repository packs in kernel mode, with the deferrals named by their fetch command',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(region.body),
    },
    ...(plan.error || !plan.next
      ? []
      : [
          {
            uri: 'simt://plan/next',
            name: 'plan/next',
            title: 'Next plan slice',
            description: plan.next.title ?? 'the next slice whose dependencies are complete',
            mimeType: 'text/markdown',
            size: plan.next.sectionBytes,
          },
        ]),
    ...[...rules, ...mdc]
      .filter((rule) => rule.id !== null)
      .map((rule) => resource('rules', rule.id, rule.title ?? rule.id, rule.bytes)),
    ...decisions.map((decision) => resource('decisions', decision.id, decision.title ?? decision.id, decision.bytes)),
  ].sort((a, b) => a.uri.localeCompare(b.uri));
}

/**
 * One resource, or null when there is no such id.
 *
 * `null` is not a failure the caller swallows: the specification makes a missing resource
 * a protocol error with a code that CHANGED between revisions, so the server decides the
 * code and this module only declines to invent content.
 */
export async function readResource(uri, root = process.cwd()) {
  const parsed = parseResourceUri(uri);
  if (parsed === null) return null;

  if (parsed.collection === 'kernel') {
    const region = await kernelRegion(root);
    return {
      uri,
      mimeType: 'text/markdown',
      text: region.body,
      // Listed size is read size here on purpose: the body is served exactly as it is
      // rendered, so a client that budgets on the listing gets what it budgeted for.
      bytes: Buffer.byteLength(region.body),
    };
  }

  if (parsed.collection === 'plan') {
    const plan = await planNext(root, null);
    if (plan.error || !plan.next) return null;
    return {
      uri,
      mimeType: 'text/markdown',
      text: plan.next.section,
      bytes: plan.next.sectionBytes,
    };
  }

  if (parsed.collection === 'rules') {
    const [rules, mdc] = await Promise.all([loadRules(null), loadMdcRules()]);
    const rule = [...rules, ...mdc].find((candidate) => candidate.id === parsed.id);
    if (rule === undefined) return null;
    const text = `${frontmatterOf(rule)}\n${rule.body ?? ''}`.trim();
    return {
      uri,
      mimeType: 'text/markdown',
      text,
      // The body a tool returns is redacted for the same reason: a reader outside this
      // estate is told what the rule says and not which directory here it is filed in.
      bytes: Buffer.byteLength(text),
    };
  }

  // `loadDecisions` reads the index, not the records: it reports status, currency and
  // byte count, and keeps no body. Reading the file the index named is one read of a
  // record the reader has already asked for by id.
  const { decisions } = await loadDecisionsCached({ root, dir: DECISIONS_DIR, all: true });
  const decision = decisions.find((candidate) => candidate.id === parsed.id);
  if (decision === undefined) return null;
  const raw = await readFile(join(DECISIONS_DIR, decision.file), 'utf8');
  const text = redactInternalPaths(redactEstate(raw)).trim();
  return { uri, mimeType: 'text/markdown', text, bytes: Buffer.byteLength(text) };
}

function frontmatterOf(rule) {
  const keys = ['id', 'title', 'applies', 'priority'];
  const present = keys.filter((key) => rule[key] !== undefined && rule[key] !== null);
  if (present.length === 0) return '';
  return ['---', ...present.map((key) => `${key}: ${formatValue(rule[key])}`), '---'].join('\n');
}

function formatValue(value) {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}
