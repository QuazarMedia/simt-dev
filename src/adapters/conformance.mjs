// Adapter SDK and conformance corpus (W48).
//
// An adapter is how a new ecosystem arrives without the core learning its SDK. The failures this
// module exists to prevent:
//
//   * an adapter that declares an operation it cannot perform, or performs one it never declared;
//   * an executor with no declared side effects, permissions or retry semantics;
//   * a descriptor that carries code and runs it at load, because it arrived as data;
//   * a version or digest that drifts, so a conformance run tests something other than what
//     shipped;
//   * a repository whose default operation breaks because an optional adapter is missing.
//
// A descriptor is data: it declares what the adapter may do and what it needs, and it is validated
// before anything calls it. Being installed is not being enabled (W33), and being declared is not
// being permitted (W32).

export const ADAPTER_SCHEMA = 'simt.adapter/1';

/** The narrow interfaces an adapter may implement. */
export const INTERFACES = Object.freeze(['observer', 'validator', 'executor', 'recipe-mapper']);

/** What the core may allow an adapter to do. */
export const CAPABILITIES = Object.freeze(['observe-only', 'execute']);

const isText = (value) => typeof value === 'string' && value.length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate a descriptor.
 *
 * @param {object} descriptor
 */
export function validateDescriptor(descriptor = {}) {
  const errors = [];
  if (!isText(descriptor?.name)) errors.push('a descriptor needs a name');
  if (!isText(descriptor?.version)) errors.push('a descriptor needs a version');
  if (!isText(descriptor?.digest) || !/^sha256-/.test(descriptor.digest ?? '')) errors.push('a descriptor needs a content digest, so a conformance run names what it tested');

  const interfaces = Array.isArray(descriptor?.interfaces) ? descriptor.interfaces : [];
  if (interfaces.length === 0) errors.push('a descriptor implements no interface');
  for (const name of interfaces) if (!INTERFACES.includes(name)) errors.push(`${name} is not a declared interface`);

  const capabilities = Array.isArray(descriptor?.capabilities) ? descriptor.capabilities : [];
  if (capabilities.length === 0) errors.push('a descriptor declares no capability');
  for (const capability of capabilities) if (!CAPABILITIES.includes(capability)) errors.push(`${capability} is not a declared capability`);

  const bounds = isObject(descriptor?.bounds) ? descriptor.bounds : {};
  if (!(Number.isInteger(bounds.maxInputBytes) && bounds.maxInputBytes > 0)) errors.push('a descriptor needs an input bound');
  if (!(Number.isInteger(bounds.maxOutputBytes) && bounds.maxOutputBytes > 0)) errors.push('a descriptor needs an output bound');
  if (!isText(descriptor?.provenance?.source)) errors.push('a descriptor needs a provenance source');

  if (interfaces.includes('executor')) {
    if (!capabilities.includes('execute')) errors.push('an executor must declare the execute capability');
    if (!Array.isArray(descriptor?.sideEffects) || descriptor.sideEffects.length === 0) errors.push('an executor must declare its side effects');
    if (!Array.isArray(descriptor?.permissions) || descriptor.permissions.length === 0) errors.push('an executor must declare the permissions it needs');
    if (!isObject(descriptor?.retry)) errors.push('an executor must declare retry semantics');
  } else if (capabilities.includes('execute')) {
    errors.push('an adapter that declares no executor cannot declare the execute capability');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Run the conformance corpus over declared adapters.
 *
 * The same suite applies to a document adapter and a remote one: the contract is the interfaces and
 * bounds, not the ecosystem.
 *
 * @param {object[]} adapters
 */
export function conformance(adapters = []) {
  const checks = (Array.isArray(adapters) ? adapters : []).map((adapter) => {
    const validation = validateDescriptor(adapter);
    return {
      name: isText(adapter?.name) ? adapter.name : 'unnamed',
      capability: (adapter?.capabilities ?? [])[0] ?? null,
      ok: validation.valid,
      errors: validation.errors,
    };
  });
  return {
    passes: checks.length > 0 && checks.every((check) => check.ok),
    checks,
    observeOnly: checks.filter((check) => check.capability === 'observe-only').map((check) => check.name),
    executing: checks.filter((check) => check.capability === 'execute').map((check) => check.name),
  };
}

/**
 * Parse a descriptor from an untrusted file.
 *
 * Data only: a descriptor that carries something to execute at load is refused before it is added
 * to the registry, because installing a file must never be running one.
 *
 * @param {string} text
 */
export function parseDescriptor(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { valid: false, errors: ['a descriptor is JSON, and this is not'] };
  }
  if (!isObject(parsed)) return { valid: false, errors: ['a descriptor is a JSON object'] };
  for (const forbidden of ['code', 'script', 'hooks', 'eval', 'imports']) {
    if (Object.prototype.hasOwnProperty.call(parsed, forbidden)) {
      return { valid: false, errors: [`a descriptor may not carry ${forbidden}: it is data, and installing it must not run it`] };
    }
  }
  return validateDescriptor(parsed);
}

/**
 * Whether the adapter is present, and whether the default operation survives without it.
 *
 * @param {{adapters?: string[], requested?: string|null}} input
 */
export function resolveAdapter({ adapters = [], requested = null } = {}) {
  const known = (Array.isArray(adapters) ? adapters : []).filter(isText);
  if (requested === null) return { adapter: null, operation: 'default', intact: true, reason: 'no adapter was requested' };
  if (!known.includes(requested)) {
    return { adapter: null, operation: 'default', intact: true, reason: `${requested} is not installed; the repository keeps its default operation` };
  }
  return { adapter: requested, operation: 'adapter', intact: false, reason: null };
}

/**
 * Whether a descriptor's version and digest match the pin the repository declared.
 *
 * @param {{descriptor?: object, pin?: object}} input
 */
export function pinned({ descriptor = null, pin = null } = {}) {
  if (!isObject(pin) || !isText(pin.version) || !isText(pin.digest)) {
    return { pinned: false, reason: 'an adapter must be pinned by version and digest before it is used' };
  }
  if (descriptor?.version !== pin.version) return { pinned: false, reason: `the descriptor is version ${descriptor?.version ?? 'unset'}, pinned at ${pin.version}` };
  if (descriptor?.digest !== pin.digest) return { pinned: false, reason: `the descriptor digest ${descriptor?.digest ?? 'unset'} does not match the pin` };
  return { pinned: true, reason: null };
}
