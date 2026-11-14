// A reference browser for the connector tests: the device side of the login (auth-handler.ts),
// written with node:crypto and against the spec only, not against src/. The real browser code is
// frontend/connection/device-auth.js in the clawchats repo; the e2e test there runs it against this connector.
import crypto from 'node:crypto';

export const AUTH_DOMAIN = 'clawchats-auth-v2';
export const FP_A = 'A1'.repeat(32); // a browser DTLS fingerprint (64 hex digits)
export const FP_B = 'B2'.repeat(32); // a connector DTLS fingerprint

export function transcript(role, b, devicePub = '', label = '') {
  return JSON.stringify([AUTH_DOMAIN, role, b.nonce, b.connectionId, b.browserFp, b.connectorFp, b.connectorPub, devicePub, label]);
}

const spki = (key) => key.export({ format: 'der', type: 'spki' }).toString('base64');

export function makeBrowser(label = 'Test browser') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = spki(publicKey);
  const deviceId = crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex').slice(0, 32);
  return { pub, deviceId, label, privateKey, sign: (data) => crypto.sign(null, Buffer.from(data), privateKey).toString('base64') };
}

/** The binding a browser computes from the auth-required it received and its own view of the DTLS fingerprints. */
export function bindingOf(authRequired, connectionId, dtls = { browser: FP_A, connector: FP_B }) {
  return { nonce: authRequired.nonce, connectionId, browserFp: dtls.browser, connectorFp: dtls.connector, connectorPub: authRequired.connectorKey };
}

/** Does the connector's auth-required prove it holds its key for this binding? */
export function connectorProofOk(authRequired, binding) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(authRequired.connectorKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(transcript('connector', binding)), key, Buffer.from(authRequired.connectorSig, 'base64'));
  } catch { return false; }
}

export const deviceLogin = (browser, binding, over = {}) => ({
  type: 'auth-device', deviceId: browser.deviceId, sig: browser.sign(transcript('device', binding, browser.pub)), ...over,
});

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
export const backupKey = (code) => crypto.createHash('sha256').update(code.toUpperCase().replace(/\s/g, '')).digest('hex');

/** kind 'totp': code is the 6 digits; 'backup': the XXXX-XXXX code. */
export function pairMsg(browser, binding, code, kind = 'totp', label = browser.label) {
  const signed = transcript('pair', binding, browser.pub, label);
  return { type: 'auth-pair', devicePub: browser.pub, label, kind, proof: hmac(kind === 'totp' ? code : backupKey(code), signed), sig: browser.sign(signed) };
}
