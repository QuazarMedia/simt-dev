#!/usr/bin/env node
// The entry point, and the one place the runtime floor is enforced.
//
// `package.json` declares `engines.node >= 22.20.0`, and npm only warns: an older
// runtime used to reach the CLI and fail somewhere inside the module graph — a syntax
// error or a missing API — instead of the one sentence that says what to install
// (review 0003 Q54). Nothing but this tiny module is imported before the check, so the
// message is what a reader gets; the CLI is imported only once the floor holds.
//
// 5 is EXIT.UNSUPPORTED. `output/index.mjs` is the CLI graph this file exists to avoid
// loading before the check, so the literal is repeated here and asserted by
// `test/node-version.test.mjs`.

import { MIN_NODE, satisfiesMinimum } from '../src/node-version.mjs';

if (!satisfiesMinimum(process.versions.node)) {
  process.stderr.write(
    `ERROR 5 simt-dev needs Node >= ${MIN_NODE}; this is ${process.versions.node}\n` +
      `REMEDY install Node ${MIN_NODE} or newer, then rerun: simt --version\n`,
  );
  process.exit(5);
}

await import('../src/cli.mjs');
