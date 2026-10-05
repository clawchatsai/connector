// PeerLink: an authenticated request/response channel between two connectors over a WebRTC
// DataChannel (gateway sharing). No TOTP: each side proves it holds the key pinned for this share
// by signing both handshake nonces and both DTLS fingerprints as it sees them. A relay that swapped
// the SDP fingerprints (to sit in the middle of DTLS) makes the two views disagree, so the
// signatures don't verify and the link never opens.
//
// Wire format (JSON strings):
//   { t: 'hello', v: 1, role, shareId, nonce }
//   { t: 'auth', sig }
//   { t: 'req', id, method, params } → { t: 'res', id, ok, result | error }
//   { t: 'ev', id, event, data }      (progress for a request, e.g. streamed text)

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { canonicalJson, verifySignature } from './keys.js';

const HANDSHAKE_MS = 15_000;
const MAX_FRAME = 256 * 1024;

/** sha-256 DTLS fingerprint from an SDP ("" when absent). */
export function sdpFingerprint(sdp) {
  const m = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/m.exec(String(sdp || ''));
  return m ? m[1].toUpperCase() : '';
}

export class PeerLink extends EventEmitter {
  /**
   * @param {object} o
   * @param {{ send(s: string): void, close(): void, onMessage(h): void, onClosed(h): void }} o.dc
   * @param {'requester'|'owner'} o.role   this side
   * @param {string} o.shareId
   * @param {{ signJson(obj): string }} o.key  this connector's key
   * @param {string} o.peerKey   the other side's pinned public key (base64 SPKI)
   * @param {{ local: string, remote: string }} o.dtls  DTLS fingerprints as this side sees them
   */
  constructor({ dc, role, shareId, key, peerKey, dtls = { local: '', remote: '' }, handshakeMs = HANDSHAKE_MS, log = console }) {
    super();
    Object.assign(this, { dc, role, shareId, key, peerKey, dtls, log });
    this.peerRole = role === 'owner' ? 'requester' : 'owner';
    this.nonce = crypto.randomBytes(24).toString('base64');
    this.peerNonce = null;
    this.sentAuth = false;
    this.verified = false;
    this.ready = false;
    this.closed = false;
    this._seq = 0;
    this._pending = new Map(); // id -> { resolve, reject, onEvent }
    this._handlers = new Map(); // method -> async (params, emit) => result
    this._timer = setTimeout(() => this._fail('handshake timed out'), handshakeMs);
    this._timer.unref?.();
    dc.onMessage(data => this._onFrame(data));
    dc.onClosed(() => this._onClosed());
    this._send({ t: 'hello', v: 1, role, shareId, nonce: this.nonce });
  }

  /** What `signer` signs: both nonces and both fingerprints, from the signer's point of view. */
  _statement(signer, signerNonce, otherNonce, signerFp, otherFp) {
    return canonicalJson({ purpose: 'clawchats-peer-v1', shareId: this.shareId, signer, signerNonce, otherNonce, signerFp, otherFp });
  }

  _onFrame(data) {
    if (this.closed) return;
    if (typeof data !== 'string' || data.length > MAX_FRAME) return this._fail('oversized frame');
    let m;
    try { m = JSON.parse(data); } catch { return this._fail('bad frame'); }
    if (!this.ready) return this._onHandshake(m);
    if (m.t === 'req') return this._onRequest(m);
    if (m.t === 'res') {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      return m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error?.message || 'peer error'), { code: m.error?.code }));
    }
    if (m.t === 'ev') this._pending.get(m.id)?.onEvent?.(m.event, m.data);
  }

  _onHandshake(m) {
    if (m.t === 'hello') {
      if (m.v !== 1 || m.role !== this.peerRole || m.shareId !== this.shareId || typeof m.nonce !== 'string' || this.peerNonce) return this._fail('bad hello');
      this.peerNonce = m.nonce;
      this.sentAuth = true;
      this._send({ t: 'auth', sig: this.key.signJson(JSON.parse(this._statement(this.role, this.nonce, this.peerNonce, this.dtls.local, this.dtls.remote))) });
    } else if (m.t === 'auth') {
      if (!this.peerNonce) return this._fail('auth before hello');
      const statement = this._statement(this.peerRole, this.peerNonce, this.nonce, this.dtls.remote, this.dtls.local);
      if (!verifySignature(this.peerKey, statement, m.sig)) return this._fail('peer signature did not verify');
      this.verified = true;
    } else {
      return this._fail('unexpected frame before auth');
    }
    if (this.verified && this.sentAuth && !this.ready) {
      this.ready = true;
      clearTimeout(this._timer);
      this.emit('ready');
    }
  }

  async _onRequest(m) {
    const h = this._handlers.get(m.method);
    const reply = r => this._send({ t: 'res', id: m.id, ...r });
    if (!h) return reply({ ok: false, error: { code: 'unknown_method', message: `unknown method ${m.method}` } });
    try {
      const result = await h(m.params || {}, (event, data) => this._send({ t: 'ev', id: m.id, event, data }));
      reply({ ok: true, result: result ?? null });
    } catch (e) {
      reply({ ok: false, error: { code: e.code || 'error', message: e.message || 'failed' } });
    }
  }

  /** Serve a method for the other side (owner: the narrow peer API). */
  handle(method, fn) { this._handlers.set(method, fn); return this; }

  /** Call a method on the other side; `onEvent(event, data)` gets its progress events. */
  request(method, params = {}, { onEvent, timeoutMs = 30 * 60_000 } = {}) {
    if (!this.ready || this.closed) return Promise.reject(new Error('peer link not ready'));
    const id = `r${++this._seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      timer.unref?.();
      this._pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
        onEvent,
      });
      this._send({ t: 'req', id, method, params });
    });
  }

  _send(obj) { if (!this.closed) this.dc.send(JSON.stringify(obj)); }

  _fail(reason) {
    if (this.closed) return;
    this.log.warn?.(`[peer] ${this.shareId}: ${reason}`);
    this.emit('failed', reason);
    this.close();
  }

  close() {
    if (this.closed) return;
    try { this.dc.close(); } catch { /* gone */ }
    this._onClosed();
  }

  _onClosed() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._timer);
    for (const [, p] of this._pending) p.reject(new Error('peer link closed'));
    this._pending.clear();
    this.emit('closed');
  }
}
