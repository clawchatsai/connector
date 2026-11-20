// The connector version a peer must run: contact cards changed the grant and the turn protocol (no compatibility with
// older connectors; Houman, 2026-11-20). Both sides send their version in the peer hello and refuse an older peer.

import fs from 'node:fs';

/** The first release with contact cards. */
export const MIN_PEER_VERSION = '0.3.0';
export const UPDATE_COMMAND = 'openclaw plugins install npm:@clawchatsai/connector --force';

let own = null;
/** This connector's version (package.json). */
export function connectorVersion() {
  if (own) return own;
  try { own = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0'; }
  catch { own = '0.0.0'; }
  return own;
}

/** a < b for dotted versions ("0.2.4" < "0.3.0"); prerelease tags are ignored. */
export function olderThan(a, b) {
  const p = v => String(v || '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

/** Whether a peer's announced version is too old (no version at all counts as too old). */
export const peerOutdated = v => typeof v !== 'string' || !v || olderThan(v, MIN_PEER_VERSION);

/** What both sides show. `who`: the person whose connector is old, or null for "yours". */
export function outdatedMessage(who, version) {
  const ran = version ? ` (${version})` : '';
  return who
    ? `${who}'s ClawChats connector is out of date${ran}. Sharing with ${who} needs ${MIN_PEER_VERSION} or newer: ask ${who} to run "${UPDATE_COMMAND}".`
    : `Your ClawChats connector is out of date${ran}. Sharing needs ${MIN_PEER_VERSION} or newer: run "${UPDATE_COMMAND}".`;
}
