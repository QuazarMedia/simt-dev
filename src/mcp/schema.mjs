// A JSON Schema checker, for the subset these schemas use.
//
// Written here rather than taken from npm because a tool that validates a payload has
// to keep working on a machine where nothing was installed (ADR-012), and because the
// schemas it checks are in this file: a dependency would be a second place for the same
// rules to live, and the one thing a validator must not be is quietly out of date.
//
// The subset is deliberately small and deliberately loud. A keyword this file does not
// understand is reported as an error rather than skipped, because a keyword silently
// ignored turns a schema into decoration - the check passes, the payload does not match,
// and nobody can say which of the two was wrong. `assertValid` is the only entry point
// the tests use, and it names the failing path.
//
// Supported: type (including union arrays), properties, required, items, enum,
// additionalProperties (boolean or a schema), anyOf.

/**
 * Check a value against a schema.
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path] JSON pointer-ish location, for the message
 * @returns {string|null} the first failure, or null when it validates
 */
export function check(value, schema, path = '$') {
  if (schema === true || schema === undefined) return null;
  if (schema === false) return `${path}: no value is allowed here`;
  if (typeof schema !== 'object' || schema === null) return `${path}: schema must be an object`;

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      // Loud on purpose: see the header. A keyword nobody implements is a promise the
      // schema does not keep, and this is the only place that can notice.
      throw new Error(`schema at ${path} uses "${keyword}", which this checker does not implement`);
    }
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    return `${path}: expected ${describe(schema.type)}, got ${describeValue(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => same(allowed, value))) {
    return `${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`;
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((option) => check(value, option, path) === null);
    if (!matched) return `${path}: matched none of the ${schema.anyOf.length} allowed shapes`;
  }

  if (schema.type === 'object' || schema.properties !== undefined || schema.required !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const key of schema.required ?? []) {
      if (!(key in value)) return `${path}: missing required property "${key}"`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (!(key in value)) continue;
      const failure = check(value[key], sub, `${path}.${key}`);
      if (failure !== null) return failure;
    }
    if (schema.additionalProperties !== undefined) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, sub] of Object.entries(value)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) return `${path}: unexpected property "${key}"`;
        if (schema.additionalProperties !== true) {
          const failure = check(sub, schema.additionalProperties, `${path}.${key}`);
          if (failure !== null) return failure;
        }
      }
    }
  }

  if (schema.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const failure = check(item, schema.items, `${path}[${index}]`);
      if (failure !== null) return failure;
    }
  }
  return null;
}

/** Throws with the first failure, named. The shape a test wants. */
export function assertValid(value, schema, what = 'value') {
  const failure = check(value, schema);
  if (failure !== null) throw new Error(`${what} does not match its schema: ${failure}`);
  return true;
}

const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
  'anyOf',
  'description',
  '$schema',
]);

function typeMatches(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => singleTypeMatches(value, t));
}

function singleTypeMatches(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describe(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

/** What a value IS, for the failure message. Distinct from `describe(type)`. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
