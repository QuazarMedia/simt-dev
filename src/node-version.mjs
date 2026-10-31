// The runtime floor, in one place both entry points read (review 0003 Q54).
//
// `package.json` declares `engines.node` and `pyproject.toml` declares a python
// version; both are advisory to the installer, so an older runtime reached the CLI
// and failed somewhere inside it — a syntax error, a missing API — instead of the one
// sentence that says what to install. This module is deliberately tiny and has no
// imports: the bootstrap that calls it must not load the tool that cannot run.

/** The oldest Node this package runs on. Mirrors `package.json` `engines.node`. */
export const MIN_NODE = '22.20.0';

/**
 * Whether `current` is at least `minimum`, compared component by component.
 *
 * A string compare is wrong ("9.0.0" > "22.20.0"), and `process.versions.node` may
 * carry a pre-release suffix that `Number()` would turn into NaN, so the numeric
 * prefix of each component is what counts.
 *
 * @param {string} current a version such as `22.20.0` or `23.1.0-rc.1`
 * @param {string} [minimum]
 * @returns {boolean}
 */
export function satisfiesMinimum(current, minimum = MIN_NODE) {
  const parse = (value) =>
    String(value)
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const have = parse(current);
  const want = parse(minimum);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
