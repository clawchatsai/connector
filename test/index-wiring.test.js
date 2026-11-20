// Wiring guard. The login tests call attachBrowserChannel() directly, so they cannot see whether
// index.ts hands the gate the DTLS fingerprints the peer manager read from the SDPs. It did not
// once: every real browser was refused ("could not read the DTLS fingerprints from the SDP").
// This checks the two hand-offs in the source: the peer manager's 'datachannel' event passes the
// fingerprints on, and the gate call receives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publicKeyWords, publicKeyFingerprint } from '../dist/channel-binding.js';

const src = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const peer = fs.readFileSync(new URL('../src/webrtc-peer.ts', import.meta.url), 'utf8');

test("the peer manager emits the browser's DTLS fingerprints with the channel", () => {
  assert.match(peer, /this\.emit\('datachannel', channel, connectionId, this\.browserDtls\.get\(connectionId\)\)/);
});

test("index.ts passes them to setupDataChannelHandler and on to the login gate", () => {
  assert.match(src, /webrtcPeer\.on\('datachannel', \(dc[^)]*dtls\?: DtlsFingerprints\) => \{[\s\S]*?setupDataChannelHandler\(dc, connectionId, ctx, dtls\)/);
  const call = /attachBrowserChannel\(dc, connectionId, \{[\s\S]*?\n  \}(, dtls)?\);/.exec(src);
  assert.ok(call, 'attachBrowserChannel call not found');
  assert.ok(call[1], 'attachBrowserChannel(...) must be called with dtls as its 4th argument');
});

test('the four words of a key: the same vector as the browser\'s tests/unit/device-auth.test.mjs', () => {
  const PUB = 'MCowBQYDK2VwAyEA2L83RxRxq47nHoEvZrvuqQCMFS52DKurdUACJdREIj8=';
  assert.equal(publicKeyWords(PUB), 'rearview-punk-donut-paralegal');
  assert.equal(publicKeyFingerprint(PUB), 'f135-f615-eca6-1060-782b');
});

test('presence reports are read only on a signed-in channel, and a closed channel counts as away', () => {
  const authed = /function processAuthenticatedMessage\([\s\S]*?\n\}/.exec(src)?.[0] || '';
  assert.match(authed, /case 'presence':\s*\n\s*app\?\.push\?\.updatePresence\(connectionId, msg\)/);
  assert.equal(src.match(/case 'presence'/g).length, 1);
  assert.match(src, /webrtcPeer\.on\('datachannel-closed'[\s\S]*?app\?\.push\?\.removePresence\(connectionId\)/);
});
