import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  findTailscale,
  run,
  tailscaleStatus,
  tailscaleIp4,
  tailscaleHostname,
  tailscaleServeStatus,
  tailscalePing,
  tailscaleUp,
} from '../src/tailscale.js';

test('findTailscale honors TAILSCALE_PATH first', () => {
  const r = findTailscale({ TAILSCALE_PATH: '/opt/ts/tailscale' }, 'linux', () => ({ status: 0, stdout: '' }));
  assert.equal(r, path.resolve('/opt/ts/tailscale'));
});

test('findTailscale falls back to PATH via which', () => {
  const r = findTailscale({}, 'linux', () => ({ status: 0, stdout: '/usr/bin/tailscale\n' }));
  assert.equal(r, '/usr/bin/tailscale');
});

test('findTailscale returns null when nothing is found', () => {
  const r = findTailscale({}, 'linux', () => ({ status: 1, stdout: '' }));
  assert.equal(r, null);
});

test('run returns ok result with stdout', () => {
  const spawn = () => ({ status: 0, stdout: '100.101.132.89\n', stderr: '' });
  const r = run(['ip', '-4'], { bin: '/fake/ts', spawn });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, '100.101.132.89\n');
  assert.equal(r.status, 0);
  assert.equal(r.error, null);
});

test('run reports non-zero exit', () => {
  const spawn = () => ({ status: 1, stdout: '', stderr: 'boom' });
  const r = run(['up'], { bin: '/fake/ts', spawn });
  assert.equal(r.ok, false);
  assert.match(r.error, /exited with status 1/);
});

test('run reports missing binary', () => {
  const r = run(['ip', '-4'], { bin: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /tailscale not found/);
});

test('tailscaleIp4 trims and returns null when down', () => {
  assert.equal(tailscaleIp4({ bin: '/f', spawn: () => ({ status: 0, stdout: '  100.1.2.3  \n' }) }), '100.1.2.3');
  assert.equal(tailscaleIp4({ bin: '/f', spawn: () => ({ status: 0, stdout: '' }) }), null);
  assert.equal(tailscaleIp4({ bin: '/f', spawn: () => ({ status: 1, stdout: '', stderr: '' }) }), null);
});

test('tailscaleStatus parses JSON and degrades on bad JSON', () => {
  const good = tailscaleStatus({ bin: '/f', spawn: () => ({ status: 0, stdout: '{"Self":{"DNSName":"x"}}' }) });
  assert.equal(good.ok, true);
  assert.deepEqual(good.json, { Self: { DNSName: 'x' } });

  const bad = tailscaleStatus({ bin: '/f', spawn: () => ({ status: 0, stdout: 'not-json' }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.raw, 'not-json');
});

test('tailscaleHostname reads Self.DNSName and strips trailing dot', () => {
  const spawn = () => ({ status: 0, stdout: '{"Self":{"DNSName":"woody.tail40672a.ts.net."}}' });
  assert.equal(tailscaleHostname({ bin: '/f', spawn }), 'woody.tail40672a.ts.net');
});

test('tailscaleHostname tolerates schema drift', () => {
  assert.equal(tailscaleHostname({ bin: '/f', spawn: () => ({ status: 0, stdout: '{}' }) }), null);
  assert.equal(tailscaleHostname({ bin: '/f', spawn: () => ({ status: 0, stdout: '{"Self":{}}' }) }), null);
});

test('tailscaleServeStatus degrades gracefully on old versions', () => {
  const ok = tailscaleServeStatus({ bin: '/f', spawn: () => ({ status: 0, stdout: '{"TCP":{}}' }) });
  assert.equal(ok.ok, true);

  const old = tailscaleServeStatus({ bin: '/f', spawn: () => ({ status: 1, stdout: '', stderr: 'unknown command' }) });
  assert.equal(old.ok, false);
});

test('tailscalePing and tailscaleUp forward args', () => {
  const seen = [];
  const spawn = (bin, args) => {
    seen.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  tailscalePing('1.2.3.4', { bin: '/f', spawn });
  tailscaleUp({ bin: '/f', spawn });
  assert.deepEqual(seen, [['ping', '1.2.3.4'], ['up']]);
});
