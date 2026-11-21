// Which extensions a repository may EXECUTE (ADR-205).
//
// The index loads a parser named by the repository's own manifest (`index.parsers`) with
// `require`, which runs whatever that module does when it is imported. That is code
// execution requested by a checked-in JSON file, so it is the one place in this tool where
// "the repository declared it" is not enough: a repository can be cloned, vendored, or
// opened from a link, and a manifest is data until something decides to trust it.
//
// So execution is a second, explicit declaration:
//
//   "index": { "parsers": "./tools/parser.mjs" },
//   "trust": { "execute": ["./tools/parser.mjs"] }
//
// Missing policy is closed. A manifest that names a parser but no `trust.execute` gets the
// built-in extractors and a state that says why; a malformed policy is a finding, not a
// reason to guess - a config the tool cannot read must not become permission. The value is
// the module SPECIFIER the manifest named, compared literally: it names what will run, not
// a directory or a prefix.
//
// Everything else this tool writes runs from its own code; this file is only about the
// repository's. The same shape is why `federation` and `gates.commands` are declarations a
// person reviews - the difference is that those are commands an operator asked this tool
// to run, while a parser is loaded by an ordinary read of the index.

const TRUST_KEYS = new Set(['execute']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The executable extensions this repository opts into.
 *
 * @param {object|null} manifest
 * @returns {{execute: string[], findings: string[]}}
 */
export function trustPolicy(manifest) {
  const block = manifest?.trust;
  if (block === undefined || block === null) return { execute: [], findings: [] };
  if (!isObject(block)) {
    return { execute: [], findings: ['`trust` must be an object'] };
  }
  const findings = [];
  for (const key of Object.keys(block)) {
    if (!TRUST_KEYS.has(key)) findings.push(`\`trust.${key}\` is not a recognised trust key (expected \`execute\`)`);
  }
  if (block.execute === undefined) return { execute: [], findings };
  if (!Array.isArray(block.execute) || block.execute.some((name) => typeof name !== 'string' || name.trim() === '')) {
    findings.push('`trust.execute` must be a list of module specifiers');
    return { execute: [], findings };
  }
  // Literal on purpose: the entry names the specifier the manifest will load, so a value
  // with stray spaces must not become permission for the trimmed spelling.
  return { execute: block.execute.slice(), findings };
}

/**
 * Whether this repository may execute the adapter its manifest named.
 *
 * A finding anywhere in the block refuses: half a valid policy is not permission.
 *
 * @param {{execute: string[], findings: string[]}} policy
 * @param {string} specifier
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function executionAllowed(policy, specifier) {
  if (policy.findings.length > 0) {
    return { allowed: false, reason: `the trust policy has errors: ${policy.findings[0]}` };
  }
  if (!policy.execute.includes(specifier)) {
    return {
      allowed: false,
      reason: `${specifier} is not in trust.execute, so it was not loaded; add it there to opt into running it`,
    };
  }
  return { allowed: true, reason: null };
}
