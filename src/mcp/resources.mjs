// Rules and decisions as MCP resources.
//
// The tools answer questions and the answers are arguments to the next call. These two
// answer a different request: "what is the rule you would apply, in full". A client that
// reads them can hold the text rather than reconstructing it from a tool's summary, and
// a reader outside this estate gets the same bytes an adopting repository's agent reads -
// redacted, because a decision record cites its own rulings and not this repository's
// layout (ADR-055, ADR-061).
//
// Both revisions agree on the shape here. They disagree about what a missing resource
// returns, and that difference is handled in the server, not here: this module answers
// with a resource or with nothing at all, and never with an empty `contents` array,
// which the newest revision forbids because it is indistinguishable from an empty rule.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DECISIONS_DIR, loadDecisions, redactEstate, redactInternalPaths } from '../decisions/index.mjs';
import { CLI } from '../name.mjs';
import { loadMdcRules } from '../projection/mdc.mjs';
import { loadRules } from '../projection/rules.mjs';

const RULES_SCHEME = 'simt://rules/';
const DECISIONS_SCHEME = 'simt://decisions/';

/**
 * RFC 6570 templates, so a client can discover the shape without a hard-coded string.
 *
 * `id` and `adr` are the handles a reader already has: a gate names a rule id and a
 * finding names an ADR, so the template's variable names match what those print.
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
  const [collection, ...rest] = uri.split('://');
  if (collection !== 'simt') return null;
  const [name, ...handle] = rest.join('://').split('/');
  const id = handle.join('/');
  if (!id || id === '.' || id === '..' || id.includes('..')) return null;
  if (name === 'rules' && id.includes('/')) return null;
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
 * Every rule and every decision record, one entry each.
 *
 * The list is built from what is on disk rather than from a hand-kept index, so it cannot
 * describe a rule that was renamed or a record that was never written. Order is sorted:
 * the newest revision forbids a set that varies per connection or as a side effect of
 * another request, and a list built from a directory read is the only shape that satisfies
 * that without a cache to invalidate.
 */
export async function listResources() {
  const [rules, mdc, { decisions }] = await Promise.all([loadRules(null), loadMdcRules(), loadDecisions({ all: true })]);
  // `size` is the bytes on disk rather than the bytes served: `read` redacts a decision
  // before sending it, so the served length is not knowable without reading the file, and
  // a size that disagrees with the payload is worse than a size that rounds.
  return [
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
export async function readResource(uri) {
  const parsed = parseResourceUri(uri);
  if (parsed === null) return null;

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
  const { decisions } = await loadDecisions({ all: true });
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

/**
 * The remedy a client gets when it asks for something that is not here.
 *
 * A command, not a path, for the reason every remedy in this package is a command: the
 * reader runs this tool, not this checkout.
 */
const MISSING_REMEDY = `run: ${CLI} rules list, or ${CLI} graph lint to see what this copy can read`;