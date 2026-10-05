// The MCP transport: newline-delimited JSON-RPC 2.0 on stdio.
//
// This file is the PROTOCOL and nothing else. It knows about `initialize`,
// `tools/list`, `tools/call` and `ping`; it knows nothing about skills, rules or repos.
// The tools themselves live in `src/mcp/tools.mjs`.
//
// Three decisions, each of which is a place where the obvious implementation is wrong:
//
//   1. STDOUT IS THE PROTOCOL. Every diagnostic goes to stderr. A single byte of human
//      prose on stdout corrupts the stream, and the failure mode is a client that shows
//      nothing and says nothing about why - so `emit()` is never used here, and the tools
//      return VALUES rather than writing to the process streams.
//   2. TOOL FAILURES ARE RESULTS, NOT PROTOCOL ERRORS. A malformed request is a
//      JSON-RPC error; a repo with no region is a successful call whose answer says the
//      region is unmanaged. An MCP client that renders an exception will not render an
//      answer, and the answer is the useful part.
//   3. NO MUTATING TOOL IS EXPOSED. `init`, `sync`, `hooks install`, `skills install`
//      and `upgrade` are absent on purpose: an editor that can call a tool can call it
//      without a human reading a diff first, and ADR-001 makes pushing approval-sensitive
//      for a reason that does not weaken because the caller is a model.

import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC codes. -32700/-32600/-32601 are the spec's parse/request/method set. */
export const RPC = {
  PARSE: -32700,
  REQUEST: -32600,
  METHOD: -32601,
  INTERNAL: -32603,
};

const SERVER_INFO = { name: 'simt-dev', title: 'SIMT developer and agent tooling' };

/**
 * Handle one parsed request. Pure with respect to the process: returns the response
 * object or null (for a notification), and never writes anywhere. Testable without a
 * pipe, which is the only way to test a line protocol honestly.
 */
export async function handle(request, tools, { version } = {}) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return error(null, RPC.REQUEST, 'request must be a JSON object');
  }
  const { id, method, params } = request;
  // A notification is a request with no id, and the spec's rule is unconditional: it
  // never gets a response, whatever its method. Answering one anyway desynchronises a
  // client that is waiting for the next real answer in the stream.
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    return isNotification ? null : error(id, RPC.REQUEST, 'request needs a string method');
  }
  if (isNotification) return null;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO, version: version ?? '0.0.0' },
        instructions:
          'Read-only. Every answer is JSON. `simt skills brief` is the one to call first: it returns the pre-assembled set for a task, plus what it deliberately left out and why.',
      });

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: tools.map(describe) });

    case 'tools/call': {
      const name = params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        // A named tool that does not exist is the client's mistake, so it is a protocol
        // error - unlike a tool that runs and reports a bad repo.
        return error(id, RPC.METHOD, `no tool named "${name}"; call tools/list first`);
      }
      const args = params?.arguments ?? {};
      try {
        const payload = await tool.run(args);
        return result(id, { content: [contentOf(payload)], isError: false });
      } catch (failure) {
        return result(id, {
          content: [contentOf({ error: failure.message, remedy: failure.remedy ?? null })],
          isError: true,
        });
      }
    }

    default:
      return isNotification ? null : error(id, RPC.METHOD, `unknown method "${method}"`);
  }
}

/**
 * Echo the client's protocol version when it is one this server implements.
 *
 * Echoing a version we do not implement would be a lie the client cannot detect until a
 * feature silently misbehaves; answering with our own is the spec's own guidance and
 * fails loudly at the one place the client checks.
 */
function negotiate(requested) {
  const SUPPORTED = new Set([PROTOCOL_VERSION]);
  return typeof requested === 'string' && SUPPORTED.has(requested) ? requested : PROTOCOL_VERSION;
}

function describe(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Content is one text block. Bounded, and truncation is announced in the text itself -
 *  the same rule the CLI follows, because a model that cannot tell a truncated answer
 *  from a complete one will guess. */
function contentOf(payload) {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const limit = typeof payload === 'object' && payload !== null ? payload.maxBytes : 0;
  if (Number.isInteger(limit) && limit > 0 && Buffer.byteLength(text) > limit) {
    const slice = Buffer.from(text).subarray(0, limit).toString('utf8');
    text = `${slice}\nTRUNCATED ${Buffer.byteLength(text) - limit} bytes omitted; raise maxBytes`;
  }
  return { type: 'text', text };
}

function result(id, value) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Serve until stdin ends.
 *
 * Lines are processed strictly in order. A server that interleaves responses would let a
 * client match the wrong answer to the wrong question, and the tools here are already
 * sequential and cheap - parallelising them would buy nothing and cost correctness.
 */
export async function serve(tools, { input = process.stdin, output = process.stdout, version, onError } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;

    let response;
    try {
      response = await handle(JSON.parse(line), tools, { version });
    } catch (parseFailure) {
      response = error(null, RPC.PARSE, `invalid JSON: ${parseFailure.message}`);
    }
    if (response === null) continue;
    output.write(`${JSON.stringify(response)}\n`);
  }
  return EXIT_OK;
}

const EXIT_OK = 0;