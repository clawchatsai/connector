// Minimal S3 client (AWS Signature V4) for share links: PUT / DELETE / GET of one object. Works with any
// S3-compatible store; R2 uses region "auto". No SDK: the connector only ever needs these three calls.
import crypto from 'node:crypto';

const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodeKey = key => key.split('/').map(encodeURIComponent).join('/');

/**
 * @param {{endpoint: string, bucket: string, region?: string, accessKeyId: string, secretAccessKey: string}} cfg
 * @param {typeof fetch} [fetchImpl]
 */
export function createS3Client(cfg, fetchImpl = globalThis.fetch) {
  const endpoint = new URL(cfg.endpoint);
  const region = cfg.region || 'auto';

  async function request(method, key, { body = '', contentType, cacheControl, now = new Date() } = {}) {
    const payload = typeof body === 'string' ? Buffer.from(body) : body;
    const payloadHash = sha256Hex(payload);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const path = `/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;

    const headers = { host: endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (contentType) headers['content-type'] = contentType;
    if (cacheControl) headers['cache-control'] = cacheControl;
    const names = Object.keys(headers).sort();
    const canonical = [method, path, '', ...names.map(n => `${n}:${headers[n]}`), '', names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host;

    const res = await fetchImpl(`${endpoint.origin}${path}`, {
      method,
      headers,
      body: method === 'PUT' ? payload : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, text: await res.text().catch(() => '') };
  }

  return {
    put: (key, body, opts) => request('PUT', key, { body, ...opts }),
    delete: key => request('DELETE', key),
    get: key => request('GET', key),
  };
}
