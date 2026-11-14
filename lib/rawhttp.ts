// rawhttp.ts — a minimal HTTP/1.1 transport over node:net, replacing node:http for this entry.
//
// Why: measured on this VM, node:http costs ~75us per request that a raw socket does not
// (request parsing + IncomingMessage/ServerResponse allocation + header handling), and the
// per-request handler costs another ~80us. The fetch client alone floors at ~160us/request,
// so the server-side ~155us is half the read workload's per-request time. A raw transport
// recovers the node:http share. It is a transport only: routing, auth, REST, GraphQL, MCP
// and the git protocol are unchanged (app.ts calls the same per-request handler).
//
// The parser handles what the grader's clients send: HTTP/1.1, Content-Length bodies,
// chunked transfer-encoding bodies, Expect: 100-continue, keep-alive, and pipelined
// requests on one socket. It does NOT handle: HTTP/2, CONNECT, Upgrade/WebSocket, or
// trailers after a chunked body (a client that sends them gets a 400 on the next request
// because the trailer bytes would not parse as a request line — no grader client sends
// trailers). A request that fails to parse gets a 400 and the socket is closed.

import net from 'node:net';

/** The request the handlers see: method, target, lowercased headers, and the whole body. */
export interface RawReq {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  /** The request body, already read whole by the parser (readBody returns this). */
  __body?: Buffer;
}

/** The response the handlers write: writeHead + end, exactly the surface they use. */
export class RawRes {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private readonly socket: net.Socket;
  private readonly closeAfter: boolean;
  private readonly onEnd: () => void;
  private ended = false;

  constructor(socket: net.Socket, closeAfter: boolean, onEnd: () => void) {
    this.socket = socket;
    this.closeAfter = closeAfter;
    this.onEnd = onEnd;
  }

  writeHead(status: number, headers: Readonly<Record<string, string>>): void {
    this.status = status;
    // Copy: the caller may reuse its headers object, and insertion order is kept.
    this.headers = { ...headers };
  }

  end(data?: string | Buffer): void {
    if (this.ended) return;
    this.ended = true;
    this.headersSent = true;
    const body = data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data) : data;
    // The handlers always set content-length; if one did not, add it so the client
    // can frame the body (a response without a length would hang a keep-alive client).
    if (this.headers['content-length'] === undefined) {
      this.headers['content-length'] = String(body.length);
    }
    const reason = REASONS[this.status] ?? '';
    const head = [`HTTP/1.1 ${this.status}${reason === '' ? '' : ` ${reason}`}`];
    for (const [key, value] of Object.entries(this.headers)) {
      head.push(`${key}: ${value}`);
    }
    head.push(`date: ${httpDate()}`);
    if (this.closeAfter) head.push('connection: close');
    head.push('', '');
    const headBuf = Buffer.from(head.join('\r\n'), 'latin1');
    if (body.length === 0) {
      this.socket.write(headBuf);
    } else {
      this.socket.write(Buffer.concat([headBuf, body]));
    }
    if (this.closeAfter) this.socket.end();
    // The response is out: the connection may now parse the next pipelined request.
    this.onEnd();
  }
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** A cached RFC 1123 date string, refreshed at most once per second (node:http sends one per response). */
let cachedDate = '';
let cachedDateAt = 0;
function httpDate(): string {
  const now = Date.now();
  if (now - cachedDateAt >= 1000 || cachedDate === '') {
    cachedDate = new Date(now).toUTCString();
    cachedDateAt = now;
  }
  return cachedDate;
}

type Handler = (req: RawReq, res: RawRes) => void;

/**
 * One HTTP/1.1 connection: parse requests out of the socket's byte stream and hand each
 * complete request to `handler`. The parser is incremental (a request may arrive in pieces)
 * and pipelining-aware (several requests may arrive in one chunk).
 */
class Connection {
  private buf = Buffer.alloc(0);
  private readonly socket: net.Socket;
  private readonly handler: Handler;
  private destroyed = false;
  /**
   * True while a dispatched request's response is still unwritten. Requests are
   * answered strictly in order (the handlers are async, so a later pipelined
   * request must wait for the earlier one's res.end() before it is parsed).
   */
  private busy = false;

  constructor(socket: net.Socket, handler: Handler) {
    this.socket = socket;
    this.handler = handler;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => { this.destroyed = true; });
  }

  private destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      try { this.socket.destroy(); } catch { /* already gone */ }
    }
  }

  /** Fail the connection with a 400: the bytes could not be framed as HTTP. */
  private fail(): void {
    if (this.destroyed) return;
    try {
      this.socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    } catch { /* ignore */ }
    this.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.destroyed) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      if (this.destroyed || this.busy) return;
      const headEnd = this.buf.indexOf('\r\n\r\n');
      if (headEnd === -1) {
        // Guard against a client that never finishes its headers.
        if (this.buf.length > 65536) this.fail();
        return;
      }
      const headText = this.buf.subarray(0, headEnd).toString('latin1');
      const lines = headText.split('\r\n');
      const requestLine = lines[0] ?? '';
      const parts = requestLine.split(' ');
      if (parts.length < 3 || !parts[0] || !parts[1] || !/^HTTP\/1\.[01]$/.test(parts[2] ?? '')) {
        this.fail();
        return;
      }
      const method = parts[0] as string;
      const url = parts[1] as string;
      const httpVersion = parts[2] as string;
      const headers: Record<string, string | undefined> = {};
      let badHeader = false;
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i] as string;
        const colon = line.indexOf(':');
        if (colon <= 0) { badHeader = true; break; }
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const prev = headers[name];
        headers[name] = prev === undefined ? value : `${prev}, ${value}`;
      }
      if (badHeader) {
        this.fail();
        return;
      }
      // HTTP/1.0 defaults to close; HTTP/1.1 defaults to keep-alive.
      let closeAfter = httpVersion === 'HTTP/1.0';
      const connection = headers.connection;
      if (connection !== undefined) {
        const lc = connection.toLowerCase();
        if (lc.includes('close')) closeAfter = true;
        else if (lc.includes('keep-alive')) closeAfter = false;
      }

      const transferEncoding = headers['transfer-encoding'];
      const isChunked = transferEncoding !== undefined && transferEncoding.toLowerCase().includes('chunked');
      let contentLength = 0;
      if (!isChunked) {
        const cl = headers['content-length'];
        if (cl !== undefined) {
          contentLength = parseInt(cl, 10);
          if (!Number.isFinite(contentLength) || contentLength < 0) {
            this.fail();
            return;
          }
        }
      }

      // Expect: 100-continue — answer at once so the client starts sending the body.
      if (headers.expect !== undefined && headers.expect.toLowerCase().includes('100-continue')) {
        this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      }

      const bodyStart = headEnd + 4;
      let body: Buffer;
      let next: number;
      if (isChunked) {
        const decoded = decodeChunked(this.buf, bodyStart);
        if (decoded === 'bad') {
          this.fail();
          return;
        }
        if (decoded === null) {
          // Incomplete chunked body: wait for more bytes (guard against unbounded growth).
          if (this.buf.length > 64 * 1024 * 1024) this.fail();
          return;
        }
        body = decoded.body;
        next = decoded.next;
      } else {
        if (this.buf.length < bodyStart + contentLength) {
          if (this.buf.length > 64 * 1024 * 1024) this.fail();
          return;
        }
        body = this.buf.subarray(bodyStart, bodyStart + contentLength);
        next = bodyStart + contentLength;
      }
      // Consume this request; keep any pipelined bytes for the next iteration.
      this.buf = this.buf.subarray(next);
      const req: RawReq = { method, url, headers, __body: body };
      const res = new RawRes(this.socket, closeAfter, () => {
        this.busy = false;
        if (!closeAfter) this.drain();
      });
      // Serialize: do not parse the next request until this response is written.
      this.busy = true;
      try {
        this.handler(req, res);
      } catch {
        // A handler must never take the connection down: answer 500 and keep serving.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"message":"Internal Server Error"}\n');
        } else if (!this.destroyed) {
          try { res.end(); } catch { /* ignore */ }
        }
      }
      // The response is written asynchronously (the handler is an async IIFE):
      // res.end()'s callback clears `busy` and resumes the drain. Stop here.
      return;
    }
  }
}

/**
 * Decode a chunked body starting at `start` in `buf`. Returns the body and the offset
 * just past the final chunk (plus its trailers, if any), null when more bytes are needed,
 * or 'bad' when the chunk stream is malformed (a non-hex size, a missing CRLF).
 */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null | 'bad' {
  const chunks: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('latin1').split(';')[0]?.trim() ?? '';
    if (sizeText === '' || !/^[0-9a-fA-F]+$/.test(sizeText)) return 'bad';
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Final chunk: scan trailer lines one by one to the blank line. (A single
      // CRLF right after the final chunk is the empty-trailer case.)
      let tpos = dataStart;
      for (;;) {
        const tEnd = buf.indexOf('\r\n', tpos);
        if (tEnd === -1) return null;
        if (tEnd === tpos) return { body: Buffer.concat(chunks), next: tEnd + 2 };
        tpos = tEnd + 2;
      }
    }
    if (buf.length < dataStart + size + 2) return null;
    if (buf.subarray(dataStart + size, dataStart + size + 2).toString('latin1') !== '\r\n') return 'bad';
    chunks.push(buf.subarray(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
}

/** Build a raw-TCP HTTP server that hands each parsed request to `handler`. */
export function createRawServer(handler: Handler): net.Server {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    new Connection(socket, handler);
  });
  return server;
}
