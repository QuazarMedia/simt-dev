// One canonical JSON encoder, so two equal values have one digest.
//
// Every module that hashes a claim needs the same answer to "is this the same value": key order
// must not matter, `undefined` must not appear, and arrays must keep their order because a
// sequence is not a set. A second copy of this drifted once already; the evidence ledger and the
// action contracts now share this one.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * JSON with object keys sorted, used with `digestOf` for stable identity.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
