// Push subscriptions of the owner's devices, one JSON file in the connector's data dir (0600: endpoints and keys
// are credentials for sending to that device). Only the owner's signed-in browsers reach the routes that write it;
// gateway-sharing peers never do (their link doesn't carry the HTTP API).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isApplePush } from './web-push.js';

export const PREF_KEYS = ['approvals', 'questions', 'replies', 'mentions', 'automationFailures', 'showPreviews'];
const MAX_DEVICES = 20;

/** Defaults: everything on, except replies on phones (a reply is the most frequent push; desktops have the tab). */
export function defaultPrefs(mobile) {
  return { approvals: true, questions: true, replies: !mobile, mentions: true, automationFailures: true, showPreviews: true };
}

export const deviceId = endpoint => crypto.createHash('sha256').update(String(endpoint)).digest('base64url').slice(0, 16);

export class PushStore {
  constructor(file) {
    this.file = file;
    this.devices = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const d of Array.isArray(raw?.devices) ? raw.devices : []) if (d?.id && d.endpoint && d.keys) this.devices.set(d.id, d);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[push] ${path.basename(file)} unreadable (${e.message}); starting empty`);
    }
    this.onChange = null;
  }

  list() { return [...this.devices.values()]; }
  get(id) { return this.devices.get(id) || null; }

  /** Register (or refresh) a device. An existing one keeps its prefs and label unless new ones are given. */
  upsert({ endpoint, keys, deviceLabel, mobile = false, prefs }) {
    const id = deviceId(endpoint);
    const prev = this.devices.get(id);
    if (!prev && this.devices.size >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices can get notifications`);
    const device = {
      id, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth },
      deviceLabel: String(deviceLabel || prev?.deviceLabel || 'Browser').slice(0, 80),
      createdAt: prev?.createdAt || new Date().toISOString(),
      mobile: !!mobile,
      prefs: cleanPrefs({ ...(prev?.prefs || defaultPrefs(mobile)), ...(prefs || {}) }, mobile),
    };
    this.devices.set(id, device);
    this._save();
    return device;
  }

  setPrefs(id, prefs) {
    const d = this.devices.get(id);
    if (!d) return null;
    d.prefs = cleanPrefs({ ...d.prefs, ...(prefs || {}) }, d.mobile);
    this._save();
    return d;
  }

  remove(id) {
    if (!this.devices.delete(id)) return false;
    this._save();
    return true;
  }

  removeByEndpoint(endpoint) { return this.remove(deviceId(endpoint)); }

  _save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.list() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { this.onChange?.(); } catch (e) { console.warn(`[push] store observer: ${e.message}`); }
  }
}

function cleanPrefs(p, mobile) {
  const d = defaultPrefs(mobile), out = {};
  for (const k of PREF_KEYS) out[k] = typeof p[k] === 'boolean' ? p[k] : d[k];
  return out;
}

/** What the browser sees of a device: never the endpoint or keys. */
export function publicDevice(d) {
  return { id: d.id, deviceLabel: d.deviceLabel, createdAt: d.createdAt, mobile: d.mobile, apple: isApplePush(d.endpoint), prefs: d.prefs };
}
