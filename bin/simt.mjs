#!/usr/bin/env node
// simt-dev - developer and agent tooling for the SIMT ecosystem.
//
// POSIX only (ADR-012). package.json declares os: [darwin, linux], so npm refuses
// the install elsewhere rather than letting a hook fail obscurely.

import { parse } from '../src/argv.mjs';
import { EXIT, fail, jsonFailMode, jsonIndentDefault } from '../src/output/index.mjs';

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

  jsonIndentDefault(flags.pretty === true);
  jsonFailMode(flags.json === true);

  // The one command that runs on somebody else's hot path, and therefore the one that
  // does not load the registry. `agent-hook` is called before every tool call an agent
  // makes, so its latency is a product requirement rather than a nicety (plan 0003
  // R15), and the registry's imports - detection, projection, the bench corpus - cost
  // tens of milliseconds before the command itself starts. Measured on the machine
  // this was written on: 127.7 ms through the registry against 91.5 ms with only this
  // module's imports, where the bare runtime is 86.9 ms of it.
  //
  // Only the exact spelling the renderers write takes this path. Anything else -
  // including `agent-hook --help` - loads the registry, so help stays the one list of
  // every command and this shortcut cannot become a second, thinner command surface.
  if (positional[0] === 'agent-hook' && !flags.help && !flags.version) {
    const { agentHookCommand } = await import('../src/commands/agenthook.mjs');
    process.exit((await agentHookCommand(positional.slice(1), flags)) ?? EXIT.OK);
  }

  const { dispatch } = await import('../src/commands/index.mjs');
  const code = (await dispatch(argv)) ?? EXIT.OK;
  // Assigned, not forced: a large document on stdout (a `--json --diff` over a
  // skill-sized body exceeds the 64 KiB pipe buffer) is still draining when the
  // command resolves, and `process.exit()` cuts it — exit 0 with half a JSON
  // document on stdout. Letting the loop empty first makes the exit honest
  // (plan 0003 R50; the S10 contract asserts the document parses).
  process.exitCode = code;
} catch (error) {
  process.exit(fail(error?.message ?? String(error), EXIT.FAIL));
}
