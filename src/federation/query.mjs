// The federation query: one structural question per task, one answer per server (0003 R26).
//
// The slice is narrow on purpose. When a repository names external code-graph servers, the
// brief delegates a single structural question to each and cites where the answer came from.
// It is not a proxy — there is no MCP tool that forwards to a foreign server, so nothing
// here can be called for anything but a brief. It is not a second index, so there is no
// coverage bookkeeping to keep in sync. And it is not a gate, so a server that is down
// produces a sentence and never a failure.
//
// The servers are asked in the order the manifest declares them, one at a time. Parallel
// would be faster and would make the packet's item order a race, and a packet whose order
// depends on which server answered first is the one property this whole module exists
// beside.

import { callTool } from './client.mjs';

/**
 * Ask each declared server the same question.
 *
 * @param {object} request
 * @param {string} request.root the repository the servers are started in
 * @param {string} request.query the structural question, already non-empty
 * @param {object[]} request.servers the servers `readFederation` returned
 * @returns `{ answers, findings }` — one `{ server, tool, query, text }` per server that
 *   answered, one sentence per server that did not
 */
export async function consult({ root, query, servers }) {
  const answers = [];
  const findings = [];
  for (const server of servers) {
    const result = await callTool({
      command: server.command,
      args: server.args,
      cwd: root,
      tool: server.tool,
      argument: server.argument,
      query,
      timeoutMs: server.timeoutMs,
    });
    if (result.error !== undefined) {
      findings.push(`the \`${server.name}\` server did not answer (${result.error})`);
      continue;
    }
    answers.push({ server: server.name, tool: server.tool, query, text: result.text });
  }
  return { answers, findings };
}
