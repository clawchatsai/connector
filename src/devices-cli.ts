/**
 * devices-cli.ts — `openclaw clawchats devices [revoke <id|label>]` and `show-fingerprint`
 *
 * Plain functions over the config file and an output function, so tests can run them. The
 * running service sees a revoked device in config.json within a second and closes its channels
 * (auth-handler.ts revokeStaleChannels).
 */

import { readConfig, removeDevices } from './config-store.js';
import { publicKeyFingerprint, publicKeyWords } from './channel-binding.js';
import type { PairedDevice } from './plugin-config.js';

type Out = (line: string) => void;

const short = (id: string) => id.slice(0, 8);
const day = (iso: string) => iso.replace('T', ' ').slice(0, 16);

/** Devices that `query` names: a full device id, an id prefix of 6+ characters, or a label (case-insensitive). */
export function matchDevices(devices: PairedDevice[], query: string): PairedDevice[] {
  const q = query.trim();
  if (!q) return [];
  const exactId = devices.filter(d => d.deviceId === q);
  if (exactId.length) return exactId;
  if (q.length >= 6) {
    const byPrefix = devices.filter(d => d.deviceId.startsWith(q.toLowerCase()));
    if (byPrefix.length) return byPrefix;
  }
  return devices.filter(d => d.label.toLowerCase() === q.toLowerCase());
}

export function listDevices(configFile: string, out: Out): boolean {
  const cfg = readConfig(configFile);
  if (!cfg) { out('ClawChats is not configured. Run: openclaw clawchats setup <token>'); return false; }
  const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
  if (!devices.length) {
    out('No browsers are paired. Open ClawChats in a browser and enter a code from your authenticator app to pair it.');
    return true;
  }
  out(`Paired browsers (${devices.length}):`);
  out('');
  for (const d of devices) {
    out(`  ${short(d.deviceId)}  ${d.label}`);
    out(`            paired ${day(d.createdAt)}, last login ${day(d.lastSeen)}`);
  }
  out('');
  out('Remove one with: openclaw clawchats devices revoke <id|label>');
  return true;
}

/** Unpair the device `query` names. False (nothing changed) when it names none, or more than one. */
export function revokeDevice(configFile: string, query: string, out: Out): boolean {
  const cfg = readConfig(configFile);
  if (!cfg) { out('ClawChats is not configured. Run: openclaw clawchats setup <token>'); return false; }
  const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
  const hits = matchDevices(devices, query);
  if (!hits.length) { out(`No paired browser matches "${query}". List them with: openclaw clawchats devices`); return false; }
  if (hits.length > 1) {
    out(`"${query}" matches ${hits.length} browsers. Use the id instead:`);
    for (const d of hits) out(`  ${short(d.deviceId)}  ${d.label}`);
    return false;
  }
  const ids = new Set(hits.map(d => d.deviceId));
  const removed = removeDevices(configFile, d => ids.has(d.deviceId));
  if (!removed.length) { out('That browser was already removed.'); return false; }
  out(`Revoked "${removed[0].label}" (${short(removed[0].deviceId)}). It is signed out now and must pair again with a code.`);
  return true;
}

export function showFingerprint(publicKey: string | null, out: Out): boolean {
  if (!publicKey) {
    out('This connector has no key yet. It is created when the gateway starts the ClawChats service for the first time.');
    return false;
  }
  out('Your gateway\'s key, as four words:');
  out('');
  out(`  ${publicKeyWords(publicKey)}`);
  out('');
  out(`(the same key as digits: ${publicKeyFingerprint(publicKey)})`);
  out('');
  out('ClawChats shows the same words when you pair a browser (and in Settings). If they differ,');
  out('do not pair: something between your browser and this machine is answering instead of it.');
  return true;
}
