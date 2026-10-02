import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMediaTarget } from './gateway-media.js';

const inbound = (src, extra = '') => `/__gw__/assistant-media?source=${encodeURIComponent(src)}&sessionKey=agent%3Amain%3Adashboard%3Ax&agentId=main${extra}`;

test('outgoing agent media is allowed', () => {
  assert.equal(isAllowedMediaTarget('/api/chat/media/outgoing/s/id/full'), true);
});

test('inbound user media via the assistant-media route is allowed', () => {
  assert.equal(isAllowedMediaTarget(inbound('media://inbound/red---9c45.png')), true);
});

test('anything else is rejected', () => {
  assert.equal(isAllowedMediaTarget('/api/sessions'), false);
  assert.equal(isAllowedMediaTarget(inbound('/etc/passwd')), false);
  assert.equal(isAllowedMediaTarget(inbound('file:///etc/passwd')), false);
  assert.equal(isAllowedMediaTarget(inbound('media://inbound/a/b.png')), false);
  assert.equal(isAllowedMediaTarget(inbound('media://inbound/..png')), false);
  assert.equal(isAllowedMediaTarget(inbound('media://inbound/x.png', '&meta=1&allow=1')), false);
  assert.equal(isAllowedMediaTarget('/__gw__/other?source=media%3A%2F%2Finbound%2Fx.png'), false);
});
