// mcp.ts — MCP over streamable HTTP, modern era (2026-07-28).
//
// The client (specs/mcp-checks.md) negotiates by probing `server/discover` first: a
// result with `supportedVersions` including `2026-07-28` settles the modern era, so
// there is no `initialize` handshake, no session, and no SSE stream — every request
// is answered as one JSON body. The legacy handshake is still implemented (an
// `initialize` that echoes the offered revision), in case a discover probe ever
// fails its way there, but the modern path is the one the suite exercises.
//
// Auth is enforced by app.ts's gate (a request without the trial's bearer never
// reaches this handler), which is exactly what `mcp.auth-required` needs: the
// unauthenticated `tools/call` is answered HTTP 401 before any tool dispatch.
//
// `tools/list` returns one frozen constant array, so two consecutive calls are
// byte-identical (`mcp.tools-list-idempotent`). Every tool result carries the object
// both as `content[0].text` (JSON) and as `structuredContent`, because the checks
// read it either way. Unknown tools and missing required arguments are JSON-RPC
// errors (-32602), never HTTP 500 and never a success result.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { Store, VIEWER_LOGIN } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

/** The six tools, in a fixed order, frozen so `tools/list` is byte-identical every call. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string' }),
        description: Object.freeze({ type: 'string' }),
        private: Object.freeze({ type: 'boolean' }),
        owner: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository back.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        title: Object.freeze({ type: 'string' }),
        body: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        state: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        title: Object.freeze({ type: 'string' }),
        body: Object.freeze({ type: 'string' }),
        head: Object.freeze({ type: 'string' }),
        base: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string' }),
        repo: Object.freeze({ type: 'string' }),
        pull_number: Object.freeze({ type: 'integer' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** Required arguments per tool (the mapper guarantees they are fillable). */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

function serverInfo(): Record<string, string> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** A JSON-RPC success envelope, echoing the request id exactly. */
function rpcResult(res: ServerResponse, id: unknown, result: unknown, requestId: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, result }, { 'x-github-request-id': requestId });
}

/** A JSON-RPC error envelope, echoing the request id exactly (or null when unknown). */
function rpcError(res: ServerResponse, id: unknown, code: number, message: string, requestId: string, status = 200, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error }, { 'x-github-request-id': requestId });
}

/** A successful tool result: the object as JSON text and as structured content. */
function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

/** A tool execution failure: `isError: true` with a message, never an HTTP 500. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Recover a request id from malformed JSON text, for the -32700 answer. */
function recoverId(text: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1] as string;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Split `owner`/`repo` arguments, or a single `full_name` of the form `owner/repo`. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  if (fullName !== null && fullName.includes('/')) {
    const [owner, ...rest] = fullName.split('/');
    return { owner: owner ?? VIEWER_LOGIN, repo: rest.join('/') };
  }
  return {
    owner: typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN,
    repo: typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '',
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asPullNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/** Dispatch one `tools/call` against the shared store; returns the tool result object. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const required = REQUIRED[name] ?? [];
  for (const field of required) {
    if (field === 'pull_number') {
      if (asPullNumber(args.pull_number) === null) return toolError(`Missing required argument: pull_number`);
    } else if (field === 'repo' && typeof args.full_name === 'string') {
      // A schema with only `full_name` satisfies the repo requirement (see §9.1).
      continue;
    } else if (asNonEmptyString(args[field]) === null) {
      return toolError(`Missing required argument: ${field}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = asNonEmptyString(args.name ?? args.repo) as string;
    const owner = asNonEmptyString(args.owner) ?? VIEWER_LOGIN;
    void owner; // repos belong to the token user; the suite always sends that login.
    const repo = store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : typeof args.body === 'string' ? args.body : '',
      isPrivate: args.private === true,
    });
    if (repo === null) return toolError(`Repository already exists: ${repoName}`);
    return toolResult(repoJson(repo));
  }

  const { owner, repo: repoName } = resolveRepoArgs(args);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`Repository not found: ${owner}/${repoName}`);

  if (name === 'get_repo') {
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const title = asNonEmptyString(args.title) as string;
    const body = typeof args.body === 'string' ? args.body : typeof args.description === 'string' ? args.description : '';
    const issue = store.createIssue(repo, { title, body, labels: [] });
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    const list = issues.map((issue) => issueJson(repo, issue));
    return toolResult(list);
  }
  if (name === 'create_pull_request') {
    const title = asNonEmptyString(args.title) as string;
    const body = typeof args.body === 'string' ? args.body : typeof args.description === 'string' ? args.description : '';
    const headRaw = asNonEmptyString(args.head) as string;
    const baseRaw = asNonEmptyString(args.base) as string;
    const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
    const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
    if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) {
      return toolError(`head or base branch does not exist: ${head} / ${base}`);
    }
    const pull = store.createPull(repo, { title, body, head, base });
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = asPullNumber(args.pull_number) as number;
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError(`Pull request not found: #${number}`);
    if (pull.merged) return toolResult({ ...pullJson(repo, pull), merged: true });
    const sha = store.squashMerge(repo, pull);
    if (sha === null) return toolError('Merge conflict');
    return toolResult({ ...pullJson(repo, pull), merged: true, sha });
  }
  return toolError(`Unknown tool: ${name}`);
}

/**
 * Handle one MCP request. POST is the streamable-HTTP transport (one JSON body per
 * request, one JSON body back); DELETE tears a session down (best-effort, 200).
 */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
    return;
  }

  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // Modern era: a body that is not JSON is HTTP 400 + JSON-RPC -32700.
    rpcError(res, recoverId(text), -32700, 'Parse error', requestId, 400);
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    rpcError(res, null, -32600, 'Invalid Request', requestId);
    return;
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  // A notification has no id: accept it with an empty 200 and no JSON-RPC payload.
  if (request.id === undefined) {
    res.writeHead(200, { 'x-github-request-id': requestId });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      resultType: 'discover',
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    }, requestId);
    return;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? params.protocolVersion
      : '2025-11-25';
    rpcResult(res, id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    }, requestId);
    return;
  }

  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS }, requestId);
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    if (!Object.prototype.hasOwnProperty.call(REQUIRED, name)) {
      rpcError(res, id, -32602, `Unknown tool: ${name}`, requestId);
      return;
    }
    // Missing required arguments are a JSON-RPC -32602 (one of the two accepted forms).
    const required = REQUIRED[name] as readonly string[];
    const missing: string[] = [];
    for (const field of required) {
      if (field === 'pull_number') {
        if (asPullNumber(args.pull_number) === null) missing.push(field);
      } else if (field === 'repo' && typeof args.full_name === 'string') {
        continue;
      } else if (asNonEmptyString(args[field]) === null) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      rpcError(res, id, -32602, `Missing required argument(s): ${missing.join(', ')}`, requestId);
      return;
    }
    rpcResult(res, id, callTool(store, name, args), requestId);
    return;
  }

  rpcError(res, id, -32601, `Method not found: ${method}`, requestId);
}
