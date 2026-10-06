// One-token setup for share links on the user's own Cloudflare R2: from a single R2 API token (Admin Read &
// Write), find the account, create the bucket, turn on its public r2.dev address, and derive S3 credentials
// (Cloudflare documents: Access Key ID = token id, Secret = SHA-256 of the token value). The raw token is not
// kept; the derived credentials are stored by the caller on this machine only.
import crypto from 'node:crypto';

export const BUCKET = 'clawchats-shares';
const API = 'https://api.cloudflare.com/client/v4';

export class SetupError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export async function setupR2(token, { fetchImpl = globalThis.fetch } = {}) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,}$/.test(token)) throw new SetupError('That doesn’t look like a Cloudflare API token. Copy the “Token value”.', 'bad-token');

  const cf = async (path, init = {}) => {
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const accounts = await cf('/accounts');
  if (accounts.status === 401 || accounts.status === 403 || !accounts.data.success) throw new SetupError('Cloudflare rejected this token. Create a new one and paste its “Token value”.', 'rejected');
  const list = accounts.data.result || [];
  if (list.length !== 1) throw new SetupError('This token sees more than one Cloudflare account. Create it as an account token for one account.', 'accounts');
  const accountId = list[0].id;

  // Token id = S3 Access Key ID. Account tokens verify under the account; user tokens under /user.
  let verify = await cf(`/accounts/${accountId}/tokens/verify`);
  if (!verify.data.success) verify = await cf('/user/tokens/verify');
  const tokenId = verify.data.result?.id;
  if (!verify.data.success || verify.data.result?.status !== 'active' || !tokenId) throw new SetupError('This token isn’t active.', 'inactive');

  const created = await cf(`/accounts/${accountId}/r2/buckets`, { method: 'POST', body: JSON.stringify({ name: BUCKET }) });
  const exists = created.status === 409 || (created.data.errors || []).some(e => /exist/i.test(e.message || ''));
  if (!created.data.success && !exists) {
    if (created.status === 403) throw new SetupError('This token can’t manage R2. Give it “Admin Read & Write” (or Workers R2 Storage: Edit).', 'permission');
    throw new SetupError(`Couldn’t create the bucket: ${(created.data.errors || [])[0]?.message || `HTTP ${created.status}`}`, 'bucket');
  }

  const domain = await cf(`/accounts/${accountId}/r2/buckets/${BUCKET}/domains/managed`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const host = domain.data.result?.domain;
  if (!domain.data.success || !host) throw new SetupError(`Couldn’t turn on the bucket’s public address: ${(domain.data.errors || [])[0]?.message || `HTTP ${domain.status}`}`, 'domain');

  return {
    provider: 'r2',
    accountId,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket: BUCKET,
    accessKeyId: tokenId,
    secretAccessKey: crypto.createHash('sha256').update(token).digest('hex'),
    publicBaseUrl: `https://${host}`,
  };
}
