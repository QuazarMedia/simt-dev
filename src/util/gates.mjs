// The two facts every gate line records, and the bound one gate may take. The dispatcher
// kept them inline until its own line ceiling forced the split (plan 0010, PT06); both
// the focused paths and the full-suite path need them.

/** The default bound on one gate, in seconds: an unreadable declaration must not be the
 *  quiet way to remove the ceiling. `gates.timeout` raises or removes it per repository. */
const DEFAULT_GATE_TIMEOUT_SECONDS = 600;

/**
 * What ran the gate, recorded beside the result. Two runs of one command on one tree
 * are only the same evidence when the toolchain that produced them is the same; the
 * node runtime and the package manager are the two facts this tool selects.
 */
export function toolchainIdentity(runner) {
  return { node: process.version, platform: process.platform, arch: process.arch, ...(runner === null ? {} : { runner }) };
}

/**
 * The bound for one gate, in milliseconds. A number applies to every gate; a map applies
 * per name, the shape `gates.cwd` already has. A value that is neither a positive whole
 * number of seconds nor 0 falls back to the default rather than removing the bound: an
 * unreadable declaration must not be the quiet way to disable the ceiling.
 */
export function gateTimeoutMs(declared, name) {
  const value = declared !== null && typeof declared === 'object' ? declared[name] : declared;
  if (value === 0) return 0;
  if (Number.isInteger(value) && value > 0) return value * 1000;
  return DEFAULT_GATE_TIMEOUT_SECONDS * 1000;
}
