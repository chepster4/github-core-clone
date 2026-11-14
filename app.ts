// app.ts — the forge's HTTP server: routing, auth, and JSON discipline.
// The contest's real surface lives in lib/: git smart HTTP (gitproto.ts), REST v3
// (rest.ts), GraphQL v4 (graphql.ts) and MCP (mcp.ts). main.ts owns the lifecycle;
// this file owns the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './lib/graphql.ts';
import { handleGit } from './lib/gitproto.ts';
import { parseJsonBody, pathOf, readBody, sendJson } from './lib/http.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleRest } from './lib/rest.ts';
import { Store } from './lib/store.ts';

/** The token the trial sets for this process; every API call presents it as a bearer. */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * The expected `Authorization` header value, computed once: the token is fixed for
 * the process, so rebuilding `Bearer ${token}` on every request is pure allocation.
 * Empty means no token was set (then nothing is authorized, exactly as before).
 */
let cachedAuth: string | null = null;

/** True when the request carries the trial's bearer token. */
export function isAuthorized(req: IncomingMessage): boolean {
  if (cachedAuth === null) {
    const token = shopToken();
    cachedAuth = token === '' ? '' : `Bearer ${token}`;
  }
  if (cachedAuth === '') return false;
  return req.headers.authorization === cachedAuth;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestSeq += 1;
      const requestId = `req-${requestSeq}`;
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth: it is the probe.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
        return;
      }

      // Every other surface needs the trial's bearer token; without it, 401 JSON, never HTML.
      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
      // The git pattern can only match a two-segment path ending in `.git`, so the
      // API paths (all under /api/v3 or /api/graphql) and /mcp never match it and
      // skip the regex; a git path never starts with those prefixes, so routing
      // never changes. This skips one regex exec on every REST/GraphQL/MCP call.
      // `isRest` is computed once here and reused below, instead of re-testing the
      // same three prefixes in the REST branch.
      const isRest = path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/');
      const gitMatch = isRest || path === '/api/graphql' || path === '/mcp'
        ? null
        : /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch !== null) {
        await handleGit(store, req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] ?? '/', requestId);
        return;
      }

      // REST v3 under /api/v3 (the root answers 200 with the token's scopes).
      if (isRest) {
        await handleRest(store, req, res, path, requestId);
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
          return;
        }
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: parsed.message }, { 'x-github-request-id': requestId });
          return;
        }
        const result = executeGraphQL(store, parsed.value);
        sendJson(res, 200, result, { 'x-github-request-id': requestId });
        return;
      }

      // MCP over streamable HTTP.
      if (path === '/mcp') {
        await handleMcp(store, req, res, requestId);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
    })().catch((err: unknown) => {
      // A handler must never hang or crash the process: answer 500 JSON and keep serving.
      if (!res.headersSent) {
        sendJson(res, 500, { message: (err as Error)?.message ?? 'Internal Server Error' }, { 'x-github-request-id': requestId });
      } else {
        res.end();
      }
    });
  });
}
