// http.ts — the small HTTP helpers every surface shares (kept apart from app.ts so
// the lib modules never import the router, and the router never cycles back).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with an already-serialized JSON body (a cached reply): no re-serialization. */
export function sendPrebuilt(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
export function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  // Fast path for a plain printable-ASCII request target: cut at the query or
  // fragment and return the path — exactly what `new URL(url, base).pathname`
  // gives for such a target (the URL parser keeps %XX as-is and never decodes it).
  // Anything the parser would normalize differently — protocol-relative `//`, dot
  // segments, backslashes, spaces or control characters, non-ASCII — falls back
  // to the parser, so routing never changes for any request.
  if (
    url.startsWith('/') &&
    !url.startsWith('//') &&
    !url.includes('/.') &&
    !url.includes('\\') &&
    !url.includes(' ') &&
    !url.includes('\t') &&
    !url.includes('\n') &&
    !/[^\x20-\x7E]/.test(url)
  ) {
    let end = url.length;
    const query = url.indexOf('?');
    if (query !== -1 && query < end) end = query;
    const fragment = url.indexOf('#');
    if (fragment !== -1 && fragment < end) end = fragment;
    return end === url.length ? url : url.slice(0, end);
  }
  try {
    return new URL(url, 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read a request body whole, as bytes (a Buffer is never a string until the caller decodes it). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    // Stream chunks already arrive as Buffers; copying each one again only doubles the work.
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a body as JSON. Returns `{ ok: true, value }` or `{ ok: false, message }`; an empty
 * body is `{ ok: true, value: null }` (a bodyless POST), a malformed one a 400.
 */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, message: 'Problems parsing JSON' };
  }
}
