// The CLI proper, imported by `bin/simt.mjs` after the runtime floor is checked.
//
// It lives here rather than in `bin/` because a static import in the entry point is
// evaluated before the entry point's own code: the version check could not run first,
// and an old Node failed inside the module graph instead of saying which version it
// needed.

import { parse, rawJsonFlag } from './argv.mjs';
import { EXIT, fail, jsonFailMode, jsonIndentDefault } from './output/index.mjs';

try {
  const argv = process.argv.slice(2);
  const parsed = parse(argv);
  if (!parsed.ok) {
    // The flags do not exist yet, so the JSON mode is read off the raw words:
    // a parse failure under `--json` is a JSON document on stdout, not text on
    // stderr with an empty stdout (ADR-070 ruling 4).
    jsonFailMode(rawJsonFlag(argv));
    process.exit(fail(parsed.error.message, parsed.error.code));
  }
  const { flags, positional } = parsed.value;

  // Set before anything can fail: `no command given` under `--json` is a JSON
  // document too, and a failure that prints as text with an empty stdout breaks
  // the same ruling the parse failure above honours (ADR-070 ruling 4).
  jsonIndentDefault(flags.pretty === true);
  jsonFailMode(flags.json === true);

  // No arguments at all is a usage error, not a silent help dump: an agent that
  // ran the wrong thing should be told so rather than handed 40 lines of prose.
  if (positional.length === 0 && !flags.help && !flags.version) {
    process.exit(fail('no command given', EXIT.USAGE));
  }

  const { dispatch } = await import('./commands/index.mjs');
  const code = (await dispatch(argv)) ?? EXIT.OK;
  // Assigned, not forced: a large document on stdout (a `--json --diff` over a
  // skill-sized body exceeds the 64 KiB pipe buffer) is still draining when the
  // command resolves, and `process.exit()` cuts it — exit 0 with half a JSON
  // document on stdout. Letting the loop empty first makes the exit honest
  process.exitCode = code;
} catch (error) {
  process.exit(fail(error?.message ?? String(error), EXIT.FAIL));
}
