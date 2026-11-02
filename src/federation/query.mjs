// The federation query: one structural question per task, one answer per server (0003).
//
// The slice is narrow on purpose. When a repository names external code-graph servers, the
// brief delegates a single structural question to each and cites where the answer came from,
// and the `federation_query` tool asks one on demand. Neither is a general proxy: a question
// goes to the tool and argument the manifest declared, so a server exposes no tool here that
// the repository did not name. It is not a second index, so there is no coverage bookkeeping
// to keep in sync. And it is not a gate, so a server that is down produces a sentence and
// never a failure.
//
// The servers are asked together and assembled in the order the manifest declares them.
// `Promise.all` answers in the order it was given, so the packet's items cannot reorder
// themselves by whoever replied first - which was the reason this loop used to be serial -
// while a slow server no longer delays every one behind it.

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
  const settled = await Promise.all(
    servers.map(async (server) => ({
      server,
      result: await callTool({
        command: server.command,
        args: server.args,
        cwd: root,
        tool: server.tool,
        argument: server.argument,
        query,
        timeoutMs: server.timeoutMs,
      }),
    })),
  );
  const answers = [];
  const findings = [];
  for (const { server, result } of settled) {
    if (result.error !== undefined) {
      findings.push(`the \`${server.name}\` server did not answer (${result.error})`);
      continue;
    }
    answers.push({ server: server.name, tool: server.tool, query, text: result.text });
  }
  return { answers, findings };
}
