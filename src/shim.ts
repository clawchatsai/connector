/**
 * HTTP Shim — translates DataChannel RPC messages into fake req/res
 * objects compatible with server.js handleRequest().
 *
 * Per spec section 6.3.1:
 * - Fake req: Readable stream with .url, .method, .headers
 * - Fake res: Writable stream (required for pipe() in handleServeFile)
 */

import { Readable, Writable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';

export interface RpcRequest {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface RpcResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody?: Buffer;  // Preserved for binary responses (images, audio, etc.)
}

type HandleRequestFn = (req: FakeReq, res: FakeRes) => void | Promise<void>;

/**
 * Fake IncomingMessage — a Readable stream with HTTP-like properties.
 */
class FakeReq extends Readable {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;

  constructor(rpc: RpcRequest) {
    super();
    this.url = rpc.url;
    this.method = rpc.method;
    // Lowercase header keys to match Node's IncomingHttpHeaders convention.
    // Browsers send 'Authorization' but Node expects 'authorization'.
    const raw = rpc.headers ?? {};
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) lowered[k.toLowerCase()] = v;
    this.headers = lowered as IncomingHttpHeaders;

    // Push body (if any) and signal end — reconstruct binary data from
    // _blob / _multipart envelope sent by the browser's transport.js
    if (rpc.body) {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(rpc.body); } catch { /* not JSON — treat as raw string */ }

      if (parsed && (parsed as Record<string, unknown>)['_blob']) {
        // Binary blob: { _blob: true, contentType: "audio/webm", data: "<base64>" }
        const buf = Buffer.from(parsed['data'] as string, 'base64');
        this.headers['content-type'] = (parsed['contentType'] as string) || 'application/octet-stream';
        this.headers['content-length'] = String(buf.length);
        this.push(buf);
      } else if (parsed && (parsed as Record<string, unknown>)['_text']) {
        // Raw text string (e.g. file content) — push as-is without JSON wrapping
        this.push(parsed['data'] as string);
      } else if (parsed && (parsed as Record<string, unknown>)['_multipart']) {
        // Multipart form data: { _multipart: true, fields: { key: string | { filename, contentType, data } } }
        const boundary = '----ClawChatsBoundary' + Date.now();
        this.headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
        const fields = (parsed['fields'] as Record<string, unknown>) || {};
        const parts: Buffer[] = [];
        for (const [key, value] of Object.entries(fields)) {
          if (value && typeof value === 'object' && (value as Record<string, unknown>)['filename']) {
            const f = value as { filename: string; contentType: string; data: string };
            parts.push(Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`
            ));
            parts.push(Buffer.from(f.data, 'base64'));
            parts.push(Buffer.from('\r\n'));
          } else {
            parts.push(Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`
            ));
          }
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const multipartBuf = Buffer.concat(parts);
        this.headers['content-length'] = String(multipartBuf.length);
        this.push(multipartBuf);
      } else {
        this.push(rpc.body);
      }
    }
    this.push(null);
  }

  _read(): void {
    // No-op — data already pushed in constructor
  }
}

/**
 * Fake ServerResponse — a Writable stream that buffers output.
 *
 * Extends Writable so that fs.createReadStream(...).pipe(res) works
 * (handleServeFile uses pipe()).
 */
class FakeRes extends Writable {
  statusCode: number = 200;
  private _headers: Record<string, string> = {};
  private _chunks: Buffer[] = [];
  private _resolvePromise: ((response: { status: number; headers: Record<string, string>; body: Buffer }) => void) | null = null;
  readonly finished: Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

  constructor() {
    super();
    this.finished = new Promise((resolve) => {
      this._resolvePromise = resolve;
    });

    // When the Writable stream finishes, resolve the promise
    this.on('finish', () => {
      this._resolvePromise?.({
        status: this.statusCode,
        headers: { ...this._headers },
        body: Buffer.concat(this._chunks),
      });
    });
  }

  // Required by Writable
  _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  setHeader(name: string, value: string | number): void {
    this._headers[name.toLowerCase()] = String(value);
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this._headers[k.toLowerCase()] = String(v);
      }
    }
    return this;
  }

  // Override end() to handle the (data, encoding) signature used by send()
  end(chunk?: unknown, encoding?: unknown, _cb?: unknown): this {
    if (chunk != null && typeof chunk !== 'function') {
      this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    // Signal Writable stream finish
    super.end();
    return this;
  }
}

function tryJsonParse(buf: Buffer): string {
  try {
    return buf.toString('utf8');
  } catch {
    return buf.toString('base64');
  }
}

/**
 * Dispatch an RPC request through handleRequest and return the response.
 */
export async function dispatchRpc(
  rpc: RpcRequest,
  handleRequest: HandleRequestFn,
): Promise<RpcResponse> {
  const req = new FakeReq(rpc);
  const res = new FakeRes();

  await handleRequest(req, res);

  const result = await res.finished;

  return {
    id: rpc.id,
    status: result.status,
    headers: result.headers,
    body: tryJsonParse(result.body),
    rawBody: result.body,  // Preserve raw buffer for binary encoding
  };
}
