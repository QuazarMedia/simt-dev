// Find the simt-dev binary, in POSIX sh, as one block of text.
//
// Two generated files run simt-dev on someone else's machine and must agree about
// how it is found: the hook shim (src/hooks/shim.mjs) and the CI workflow
// (src/ci/workflow.mjs). They were written separately and the second copy would
// have been a real divergence risk - a change to the resolution order that reaches
// the hook but not the workflow means the gate passes locally and is unfindable in
// CI, which is the failure this whole tool is about.
//
// The caller's shell is expected to have `set -eu` and a `ROOT` already defined:
// the shim derives ROOT from git, the workflow takes it from the runner. That is why
// this is a block and not a script.

import { BIN_ENV, BIN_REL, CLI, PACKAGE_NAME } from './name.mjs';

/**
 * @param {string} command arguments to hand the tool, with `$ROOT` spelled as a shell
 *   expansion - `hooks run pre-commit --root "$ROOT"`, `check --root "$ROOT"`
 * @param {object} [opts]
 * @param {string} [opts.subject] what it could not find, as the caller names it:
 *   the shim says "the dispatcher", the workflow says the command
 * @param {string} [opts.remedy] the last line, which is the only part that differs
 *   between a hook (which can be opted out of) and a CI job (which cannot)
 * @returns {string} POSIX sh source
 */
export function renderLocator(command, { subject = CLI, remedy = `REMEDY run: npm i -D ${PACKAGE_NAME}` } = {}) {
  const D = '$';
  return `# ${D}${BIN_ENV} must name ONE program: an executable on PATH, or a .mjs entry
# point to hand to node. It cannot be a command line, because there is no safe way
# to split one in sh without eval, and a value with a space is refused rather than
# half-executed - running from a source checkout is normal for anyone working on
# this project itself, so this path has to work with no install step.
run_simt_dev() {
  case "${D}1" in
    *' '*)
      echo "${CLI}: ${D}${BIN_ENV} names a command line, not a program." >&2
      echo "  set it to a single executable or a .mjs path, e.g." >&2
      echo "    ${BIN_ENV}=/path/to/checkout/${BIN_REL}" >&2
      exit 1
      ;;
    *.mjs)
      # shift first: "${D}@" still holds ${D}1, which would pass the program path to
      # itself as the first argument.
      program="${D}1"
      shift
      exec node "${D}program" "${D}@"
      ;;
    *)
      exec "${D}1" "${D}@"
      ;;
  esac
}

if [ -n "${D}{${BIN_ENV}:-}" ]; then
  run_simt_dev "${D}${BIN_ENV}" ${command}
fi

if [ -f "${D}ROOT/node_modules/${PACKAGE_NAME}/${BIN_REL}" ]; then
  exec node "${D}ROOT/node_modules/${PACKAGE_NAME}/${BIN_REL}" ${command}
fi

if command -v ${CLI} >/dev/null 2>&1; then
  exec ${CLI} ${command}
fi

echo "${CLI}: cannot locate ${subject}." >&2
# Every expansion in these diagnostics must carry a default. Under \`set -eu\` an
# unbound variable aborts the shell, so an unguarded ${D}${BIN_ENV} here would
# kill the message that exists to explain the failure - and this block only runs
# when nothing resolved, which is the one moment the reader needs it.
echo "  looked for: ${D}{${BIN_ENV}:-<unset>}, ${D}ROOT/node_modules/${PACKAGE_NAME}, ${CLI} on PATH" >&2
echo "${remedy}" >&2
exit 1
`;
}