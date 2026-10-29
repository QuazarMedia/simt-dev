// The MCP transport: newline-delimited JSON-RPC 2.0 on stdio.
//
// This file is the PROTOCOL and nothing else. It knows about `initialize`,
// `tools/list`, `tools/call`, `resources/*`, `prompts/*` and what remains of `ping`; it
// knows nothing about skills, rules or repos. The tools live in `src/mcp/tools.mjs`, the
// resources in `src/mcp/resources.mjs`, the prompts in `src/mcp/prompts.mjs`.
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
import { CLI } from '../name.mjs';
import { getPrompt, PROMPTS } from './prompts.mjs';
import { RESOURCE_TEMPLATES, listResources, readResource } from './resources.mjs';

/**
 * Every protocol revision this server speaks, newest first.
 *
 * The list is a claim about revisions that were read, not about ones that exist: each
 * entry names a published revision and the behaviour this file implements for it, and
 * ADR-068 records what changed. A revision not in this list is answered with
 * `UnsupportedProtocolVersionError` rather than an optimistic guess, because the failure
 * mode of guessing is a client that believes a feature is on and watches it misbehave.
 */
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

/**
 * The revision this server answers with when the client has not asked for one.
 *
 * Named the way every caller has always named it, and it is the newest supported
 * revision rather than the only one: a client that asks for an older one gets it.
 */
export const PROTOCOL_VERSION = SUPPORTED_VERSIONS[0];

/** JSON-RPC codes. -32700/-32600/-32601 are the spec's parse/request/method set. */
export const RPC = {
  PARSE: -32700,
  REQUEST: -32600,
  METHOD: -32601,
  INTERNAL: -32603,
  /**
   * `UnsupportedProtocolVersionError`, renumbered to -32022 in 2026-07-28. The spec
   * reserves -32000..-32019 for implementations and -32020..-32099 for itself, so the
   * older -32004 would now be an implementation-defined code in the wrong range.
   */
  UNSUPPORTED_VERSION: -32022,
  /** Resource not found: -32002 in every revision up to 2025-11-25, -32602 after. */
  RESOURCE_NOT_FOUND_LEGACY: -32002,
  RESOURCE_NOT_FOUND: -32602,
};

/** The `_meta` keys 2026-07-28 puts on a request and in a result. */
export const META = {
  PROTOCOL_VERSION: 'io.modelcontextprotocol/protocolVersion',
  CLIENT_INFO: 'io.modelcontextprotocol/clientInfo',
  CLIENT_CAPABILITIES: 'io.modelcontextprotocol/clientCapabilities',
  SERVER_INFO: 'io.modelcontextprotocol/serverInfo',
};

/** Revisions that removed `ping`, per the 2026-07-28 changelog (SEP-2575). */
const PING_REMOVED_IN = '2026-07-28';

const SERVER_INFO = { name: 'simt-dev', title: 'SIMT developer and agent tooling' };

/**
 * One hour, and the reason it is a number rather than an omission.
 *
 * `ttlMs` and `cacheScope` are required on list results from 2026-07-28, and the value
 * is a fact about this server rather than a courtesy: the tool list changes when the
 * release changes and not otherwise, so an hour is long enough to spare a client the
 * round trip and short enough that a client started from a stale one re-reads it within
 * a working day. `private`, because the list names the reader's own repository and no
 * intermediary may hold it.
 */
const LIST_CACHE = { ttlMs: 3600000, cacheScope: 'private' };

/**
 * Handle one parsed request. Pure with respect to the process: returns the response
 * object or null (for a notification), and never writes anywhere. Testable without a
 * pipe, which is the only way to test a line protocol honestly.
 *
 * `state` is the negotiated revision, and it is the only thing this function mutates.
 * 2026-07-28 removed the handshake and made every request carry its own version, so a
 * session is not part of the protocol any more - but a client on an older revision
 * negotiates once and then sends bare requests, and answering those at the newest
 * revision would hand it fields it did not ask for. So the version is read from the
 * request when there is one and remembered only for the clients that need it.
 *
 * `root` is the repository the read surface answers for. The resources carry no argument
 * channel in the specification - `resources/read` takes a URI and nothing else - so the
 * caller names the root and the default is the process's cwd, which is what an editor's
 * stdio server sits in.
 *
 * @param {object|null} request a parsed JSON-RPC message
 * @param {object[]} tools
 * @param {{packageVersion?: string, state?: {version: string|null}, root?: string}} options
 * @returns {Promise<object|null>}
 */
export async function handle(request, tools, { packageVersion, state, root } = {}) {
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

  const asked = params?._meta?.[META.PROTOCOL_VERSION];
  if (typeof asked === 'string' && !SUPPORTED_VERSIONS.includes(asked)) {
    // The one place a client checks whether it got what it asked for, so this is where
    // an unsupported version has to fail. The message names the revisions that do work,
    // because "unsupported" alone leaves the client to guess between the two answers a
    // server can give.
    return error(
      id,
      RPC.UNSUPPORTED_VERSION,
      `protocol version ${asked} is not supported; this server speaks ${SUPPORTED_VERSIONS.join(', ')}`,
    );
  }
  const negotiated =
    typeof asked === 'string' ? asked : method === 'initialize' ? negotiate(params?.protocolVersion) : state?.version;
  // A caller that passes no `state` gets one request with no memory: `serve` threads one
  // through the stream, and a test that calls this directly usually wants exactly that.
  const session = state ?? { version: null };
  if (method === 'initialize') session.version = negotiated;
  const v = negotiated ?? PROTOCOL_VERSION;

  const reply = (value) => result(id, decorate(value, v, { packageVersion, tools }));

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: v,
        capabilities: capabilities(),
        // `serverInfo` stays in the body here even on 2026-07-28: a client that has just
        // called a method the newest revision removed is by definition an older client,
        // and the field is where it looks.
        serverInfo: serverInfo(packageVersion),
        instructions: INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'initialized':
      return null;

    // MUST, from 2026-07-28 on. Cheap, stateless, and the stdio way for a client that
    // supports both shapes to find out which one it is talking to before it commits.
    case 'server/discover':
      return reply({
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: capabilities(),
        instructions: INSTRUCTIONS,
        ...(cacheable(v) ? LIST_CACHE : {}),
      });

    case 'ping':
      // Removed in 2026-07-28, and kept before it: a client that speaks an older
      // revision and probes liveness gets an answer, and one that speaks the newest
      // gets told the method is gone rather than a success it would read as support.
      if (atLeast(v, PING_REMOVED_IN)) {
        return error(id, RPC.METHOD, `ping was removed in ${PING_REMOVED_IN}; this session negotiated ${v}`);
      }
      return reply({});

    case 'tools/list':
      return reply({
        tools: tools.map((t) => describe(t, v)),
        ...(cacheable(v) ? LIST_CACHE : {}),
      });

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
        // Both blocks, always. `structuredContent` is what a client validates against
        // `outputSchema` and what it can index; the text block is what a client that
        // predates structured output reads. Emitting one without the other leaves half
        // the clients guessing, which is the state this release was filed for.
        return reply({
          content: [contentOf(payload)],
          structuredContent: payload,
          isError: false,
        });
      } catch (failure) {
        // An error is a result too, and it carries the same two shapes: the remedy is
        // the part a model needs to act on, and it has to survive in whichever block the
        // client reads.
        const payload = { error: failure.message, remedy: failure.remedy ?? null };
        return reply({ content: [contentOf(payload)], structuredContent: payload, isError: true });
      }
    }

    case 'resources/list':
      return reply(
        cacheable(v) ? { resources: await listResources(root), ...LIST_CACHE } : { resources: await listResources(root) },
      );
    case 'resources/templates/list':
      return reply(
        cacheable(v)
          ? { resourceTemplates: RESOURCE_TEMPLATES, ...LIST_CACHE }
          : { resourceTemplates: RESOURCE_TEMPLATES },
      );
    case 'resources/read': {
      // The code for a resource that is not there CHANGED, and a server that answers
      // with one code to both revisions is a server that is wrong to whichever half of
      // the client's world it is not. The newest revision forbids an empty `contents`
      // array as the answer, so "absent" can only be an error.
      const code = atLeast(v, '2026-07-28') ? RPC.RESOURCE_NOT_FOUND : RPC.RESOURCE_NOT_FOUND_LEGACY;
      const uri = request.params?.uri;
      const found = await readResource(uri, root);
      if (found === null) return error(id, code, `no such resource: ${String(uri)}`);
      return reply(
        cacheable(v) ? { contents: [found], ...LIST_CACHE } : { contents: [found] },
      );
    }
    case 'prompts/list':
      return reply(
        cacheable(v) ? { prompts: PROMPTS, ...LIST_CACHE } : { prompts: PROMPTS },
      );
    case 'prompts/get': {
      const name = params?.name;
      // `getPrompt` returns null only for a prompt this server does not have: its
      // argument failures degrade into the template text itself, because an unfilled
      // variable is still readable and the agent it reaches can ask the user. A named
      // prompt that does not exist is the client's mistake, so it is a protocol error -
      // the same rule as tools/call, and for the same reason: there is no result shape
      // that means absence.
      const found = await getPrompt(name, params?.arguments ?? {});
      if (found === null) return error(id, RPC.METHOD, `no prompt named "${String(name)}"; call prompts/list first`);
      return reply(found);
    }
    default:
      return isNotification ? null : error(id, RPC.METHOD, `unknown method "${method}"`);
  }
}

const INSTRUCTIONS =
  `Read-only. Every answer is JSON. \`${CLI} skills brief\` is the one to call first: it returns the pre-assembled set for a task, plus what it deliberately left out and why.`;

function serverInfo(packageVersion) {
  return { ...SERVER_INFO, version: packageVersion ?? '0.0.0' };
}

function capabilities() {
  return {
    tools: { listChanged: false },
    // Unconditional, and that is the point: every rule and every decision record ships
    // with the package, so there is always something to read. The empty object is the
    // documented way to say "resources, but no subscriptions and no change
    // notifications" — both of which this server has no way to honour, and a client
    // told otherwise would subscribe to a stream that never arrives.
    //
    // It used to be conditional on a property hung on the tools array, which nothing
    // ever set: a capability gated on a flag nobody flips is the same promise a client
    // waits on forever, only quieter.
    resources: {},
    // Two fixed templates, listed statically: there is nothing to subscribe to and
    // nothing that changes without a release, so the same empty object makes the same
    // promise here as above the resources.
    prompts: {},
  };
}

/**
 * Echo the client's protocol version when it is one this server implements.
 *
 * Echoing a version we do not implement would be a lie the client cannot detect until a
 * feature silently misbehaves; answering with our own is the spec's own guidance and
 * fails loudly at the one place the client checks.
 */
function negotiate(requested) {
  return typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

/** Revision ordering. These are dates, so lexicographic is chronological - stated here
 *  because "sort a version string" is the kind of helper that gets rewritten by someone
 *  who thinks it is a number, and this one is right. */
function atLeast(version, floor) {
  return version >= floor;
}

/** 2026-07-28 requires `ttlMs` and `cacheScope` on list results; earlier ones ignore them. */
function cacheable(version) {
  return atLeast(version, '2026-07-28');
}

/**
 * What the newest revision adds to every result.
 *
 * `resultType` is required from 2026-07-28 and is absent before it — clients on older
 * revisions treat it as an unknown field, and clients MUST read a missing one as
 * `complete`, so emitting it unconditionally is the compatible half and omitting it on
 * the new revision is not. `_meta.serverInfo` is a SHOULD, and it is how a stateless
 * client learns who it is talking to now that `initialize` is gone.
 */
function decorate(value, version, { packageVersion }) {
  if (!atLeast(version, '2026-07-28')) return value;
  return {
    resultType: 'complete',
    ...value,
    _meta: { [META.SERVER_INFO]: serverInfo(packageVersion) },
  };
}

function describe(tool, version) {
  const entry = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Every tool here is a reader: none writes, and none writes twice. Saying so lets a
    // client cache the answer and, where it offers, let the model call without a
    // confirmation step. The declaration is per tool rather than global because the next
    // tool this file gains may not be one.
    annotations: { readOnlyHint: true, idempotentHint: true, ...(tool.annotations ?? {}) },
  };
  // `outputSchema` exists in all three revisions, and a tool that declares its input
  // shape but not its output shape leaves the client guessing what a successful answer
  // looks like - which is the same defect as a returned value nothing can be checked
  // against.
  if (tool.outputSchema) entry.outputSchema = tool.outputSchema;
  return entry;
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
 *
 * One `state` for the whole stream, holding the revision a client negotiated through
 * `initialize`. That is the residue of a handshake the 2026-07-28 revision removed, kept
 * only because a client on an older revision sends bare requests afterwards and expects
 * the answers it agreed to.
 */
export async function serve(tools, { input = process.stdin, output = process.stdout, packageVersion, onError } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const state = { version: null };
  for await (const line of rl) {
    if (line.trim() === '') continue;

    // Parse and handling fail differently and must answer differently. A line that is
    // not JSON has no id to answer to, so it is a parse error with `id: null`; a
    // throw inside `handle` belongs to the request it was answering, so it keeps
    // that request's id — answering it as a parse error hangs the client that is
    // still waiting for its answer (Q12).
    let response;
    let message;
    try {
      message = JSON.parse(line);
    } catch (parseFailure) {
      response = error(null, RPC.PARSE, `invalid JSON: ${parseFailure.message}`);
    }
    if (response === undefined) {
      try {
        response = await handle(message, tools, { packageVersion, state });
      } catch (handlerFailure) {
        const id = message !== null && typeof message === 'object' && 'id' in message ? message.id : null;
        response = error(id, RPC.INTERNAL, `internal error: ${handlerFailure?.message ?? handlerFailure}`);
      }
    }
    if (response === null) continue;
    output.write(`${JSON.stringify(response)}\n`);
  }
  return EXIT_OK;
}

const EXIT_OK = 0;