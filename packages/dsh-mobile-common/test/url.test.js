import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessUrl, pairingUrl, relayBaseUrl } from '../src/url.js';

test('tailscale mode prefers MagicDNS hostname over IP', () => {
  const config = { mode: 'tailscale', gatewayPort: 3081 };
  assert.equal(
    buildAccessUrl({ config, tailscaleHostname: 'woody.tail.ts.net', tailscaleIp: '100.1.2.3' }),
    'http://woody.tail.ts.net:3081/',
  );
});

test('tailscale mode falls back to tailnet IP', () => {
  const config = { mode: 'tailscale', gatewayPort: 3081 };
  assert.equal(buildAccessUrl({ config, tailscaleHostname: null, tailscaleIp: '100.1.2.3' }), 'http://100.1.2.3:3081/');
});

test('relay mode builds the /instance/<id> path URL', () => {
  const config = { mode: 'relay', relay: { url: 'https://relay.example.com/', instanceId: 'Inst-1' } };
  assert.equal(buildAccessUrl({ config }), 'https://relay.example.com/instance/inst-1/');
});

test('relay mode without an instance id points at the picker', () => {
  const config = { mode: 'relay', relay: { url: 'https://relay.example.com/', instanceId: '' } };
  assert.equal(buildAccessUrl({ config }), 'https://relay.example.com/relay/');
});

test('relayBaseUrl strips scheme and slashes', () => {
  assert.equal(relayBaseUrl('https://relay.example.com/'), 'relay.example.com');
  assert.equal(relayBaseUrl('relay.example.com:8443///'), 'relay.example.com:8443');
  assert.equal(relayBaseUrl(''), '');
});

test('pairingUrl appends mobile/pair with encoded code', () => {
  assert.equal(
    pairingUrl({ accessUrl: 'http://woody.tail.ts.net:3081/', pairingCode: '123456' }),
    'http://woody.tail.ts.net:3081/mobile/pair?code=123456',
  );
});
