#!/usr/bin/env node
// simt-dev - developer and agent tooling for the SIMT ecosystem.
//
// Windows note (ADR-011): npm generates the .cmd shim for this file, so the
// shebang is a convenience for POSIX shells, not the only entry path.

import { dispatch } from '../src/commands/index.mjs';
import { EXIT, fail } from '../src/output/index.mjs';
import { parse } from '../src/argv.mjs';

try {
  const argv = process.argv.slice(2);
  const parsed = parse(argv);
  if (!parsed.ok) {
    process.exit(parsed.code);
  }
  const { flags, positional } = parsed.value;

  // No arguments at all is a usage error, not a silent help dump: an agent that
  // ran the wrong thing should be told so rather than handed 40 lines of prose.
  if (positional.length === 0 && !flags.help && !flags.version) {
    process.exit(fail('no command given', EXIT.USAGE));
  }

  process.exit((await dispatch(argv)) ?? EXIT.OK);
} catch (error) {
  process.exit(fail(error?.message ?? String(error), EXIT.FAIL, 'run: simt-dev doctor'));
}
