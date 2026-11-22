// The Harness wall's data: the CLI's detect and status documents plus the policy table.
//
// The two commands already answer different questions - what is present on disk, and what
// each harness will actually run - so this module keeps both documents intact instead of
// flattening them into a verdict. A config this tool cannot read stays a status problem,
// and a detected harness with no rule channel stays detection-only.

import { run, renderJson } from '../run.mjs';
import { policyCatalog } from '../agenthooks/policy.mjs';

export async function harnessPayload(root) {
  const [detectRun, hooksRun] = await Promise.all([
    run('harness detect', { flags: { json: true }, root }),
    run('agent-hooks status', { flags: { json: true }, root }),
  ]);
  const detect = renderJson(detectRun);
  const hooks = renderJson(hooksRun);
  return {
    ok: detect?.ok !== false && hooks?.ok !== false,
    command: 'harness',
    root,
    detect,
    hooks,
    policies: policyCatalog(),
  };
}
