// Minimal argv parser. Zero dependencies is a hard requirement (ADR: principle 5):
// a DX tool that needs an install step is a DX tool that fails on a fresh machine.
//
// Supported forms:
//   --flag              boolean
//   --key value         string
//   --key=value         string
//   --no-flag           sets flag false
//   --                  everything after is positional
// Anything unrecognised is an error, not a silent ignore: a typo'd gate name
// that is ignored is worse than a typo'd gate name that fails.

import { EXIT, fail } from './output/index.mjs';

const BOOL_FLAGS = new Set([
  'json',
  'all',
  'dry-run',
  'yes',
  'check',
  'quiet',
  'plan',
  'semantic',
  'mermaid',
  'help',
  'version',
  'accept-conflicts',
  'list',
]);

const VALUE_FLAGS = new Set([
  'budget',
  'max-bytes',
  'paths',
  'skill',
  'task',
  'workspace',
  'root',
  // skills install: which body of a multi-variant skill, and which source when the
  // bytes alone do not identify one.
  'variant',
  'from',
]);

/**
 * @param {string[]} argv raw arguments, excluding node and the script path
 * @returns {{ok: true, value: object} | {ok: false, code: number}}
 */
export function parse(argv) {
  const flags = {};
  const positional = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (passthrough || !arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }

    const eq = arg.indexOf('=');
    const raw = (eq === -1 ? arg : arg.slice(0, eq)).slice(2);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (raw.startsWith('no-')) {
      const positive = raw.slice(3);
      if (!BOOL_FLAGS.has(positive)) {
        return { ok: false, code: usage(`unknown flag --${raw}`) };
      }
      flags[camel(positive)] = false;
      continue;
    }
    if (BOOL_FLAGS.has(raw)) {
      if (inlineValue !== undefined) {
        return { ok: false, code: usage(`--${raw} takes no value`) };
      }
      flags[camel(raw)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(raw)) {
      const value = inlineValue ?? argv[i + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
        return { ok: false, code: usage(`--${raw} requires a value`) };
      }
      if (inlineValue === undefined) i += 1;
      if (raw === 'budget' || raw === 'max-bytes') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, code: usage(`--${raw} must be a non-negative integer, received ${value}`) };
        }
        flags[camel(raw)] = n;
      } else {
        flags[camel(raw)] = value;
      }
      continue;
    }
    return { ok: false, code: usage(`unknown flag --${raw}`) };
  }

  return { ok: true, value: { flags, positional } };
}

/** `--max-bytes` -> `maxBytes`. Callers use camelCase; users type kebab-case. */
function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function usage(message) {
  return fail(message, EXIT.USAGE);
}
