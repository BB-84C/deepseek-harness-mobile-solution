import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccessUrl, canonicalAuthority, pairingUrl, relayBaseUrl } from '../src/url.js';

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

test('canonicalAuthority keeps only host[:port] for --trusted-host', () => {
  // dsh >= 0.2 fails plugin load on anything else (assertTrustedAuthority).
  assert.equal(canonicalAuthority('https://dsh.bb84.ai'), 'dsh.bb84.ai');
  assert.equal(canonicalAuthority('https://dsh.bb84.ai/'), 'dsh.bb84.ai');
  assert.equal(canonicalAuthority('https://dsh.bb84.ai/dsh/abc'), 'dsh.bb84.ai');
  assert.equal(canonicalAuthority('relay.example.com:8443/path'), 'relay.example.com:8443');
  assert.equal(canonicalAuthority('100.101.132.89'), '100.101.132.89');
  assert.equal(canonicalAuthority('100.101.132.89:3081'), '100.101.132.89:3081');
  assert.equal(canonicalAuthority('WoODY.tail40672a.ts.net'), 'woody.tail40672a.ts.net');
  assert.equal(canonicalAuthority('http://user:pw@host.example:81/x'), 'host.example:81');
  assert.equal(canonicalAuthority('[fd7a:115c:a1e0::ea01:84bf]:3081'), '[fd7a:115c:a1e0::ea01:84bf]:3081');
  assert.equal(canonicalAuthority('fd7a:115c:a1e0::ea01:84bf'.replace('::', '::')), '[fd7a:115c:a1e0::ea01:84bf]');
});

test('canonicalAuthority rejects empty and unusable input', () => {
  assert.equal(canonicalAuthority(''), null);
  assert.equal(canonicalAuthority('   '), null);
  assert.equal(canonicalAuthority(null), null);
  assert.equal(canonicalAuthority(undefined), null);
  assert.equal(canonicalAuthority(42), null);
  assert.equal(canonicalAuthority('http://'), null);
});
