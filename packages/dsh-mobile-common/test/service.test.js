import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isPidAlive,
  verifyPidfile,
  refusalMessage,
  readPidFile,
  readSidecar,
  readLogTail,
  resolveDshBinary,
  checkGateway,
  checkGatewaySync,
  createService,
  startService,
  stopService,
  serviceStatus,
  serviceLogs,
} from '../src/service.js';

// ---- pure helpers ----

test('isPidAlive probes with signal 0', () => {
  assert.equal(isPidAlive(42, 'linux', () => {}), true);
  assert.equal(
    isPidAlive(42, 'linux', () => {
      const e = new Error('gone');
      e.code = 'ESRCH';
      throw e;
    }),
    false,
  );
  assert.equal(
    isPidAlive(42, 'linux', () => {
      const e = new Error('perm');
      e.code = 'EPERM';
      throw e;
    }),
    true,
  );
  assert.equal(isPidAlive(null, 'linux', () => {}), false);
});

test('verifyPidfile gates on sidecar presence + pid/token match', () => {
  assert.deepEqual(verifyPidfile({ pidfile: null, sidecar: { pid: 1, token: 't' } }), { valid: false, reason: 'no-pidfile' });
  assert.deepEqual(verifyPidfile({ pidfile: { pid: 1, token: 't' }, sidecar: null }), { valid: false, reason: 'missing-sidecar' });
  assert.deepEqual(
    verifyPidfile({ pidfile: { pid: 1, token: 't' }, sidecar: { pid: 2, token: 't' } }),
    { valid: false, reason: 'pid-mismatch' },
  );
  assert.deepEqual(
    verifyPidfile({ pidfile: { pid: 1, token: 't' }, sidecar: { pid: 1, token: 'other' } }),
    { valid: false, reason: 'token-mismatch' },
  );
  assert.deepEqual(verifyPidfile({ pidfile: { pid: 1, token: 't' }, sidecar: { pid: 1, token: 't' } }), { valid: true, reason: 'ok' });
});

test('refusalMessage names the pid and the non-mobile risk', () => {
  const msg = refusalMessage(777, 'token-mismatch');
  assert.match(msg, /777/);
  assert.match(msg, /NON-mobile/);
});

test('readPidFile / readSidecar / readLogTail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-svc-'));
  try {
    const pidFile = path.join(tmp, 'pid.json');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 12, token: 'tok' }));
    assert.deepEqual(readPidFile(pidFile), { pid: 12, token: 'tok' });

    const sidecar = readSidecar(tmp, 12);
    assert.equal(sidecar, null); // no sidecar yet
    fs.writeFileSync(path.join(tmp, '12.json'), JSON.stringify({ pid: 12, token: 'tok' }));
    assert.deepEqual(readSidecar(tmp, 12), { pid: 12, token: 'tok' });

    const log = path.join(tmp, 'service.log');
    fs.writeFileSync(log, 'line1\nline2\nline3\n');
    assert.deepEqual(readLogTail(log, 2), ['line2', 'line3']);
    assert.deepEqual(readLogTail(path.join(tmp, 'missing.log'), 10), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveDshBinary honors DSH_BIN then PATH', () => {
  assert.equal(resolveDshBinary({ DSH_BIN: '/opt/dsh/bin' }, 'linux', () => ({})), path.resolve('/opt/dsh/bin'));
  const onPath = resolveDshBinary({}, 'linux', () => ({ status: 0, stdout: '/usr/bin/dsh\n' }));
  assert.equal(onPath, '/usr/bin/dsh');
  assert.equal(resolveDshBinary({}, 'linux', () => ({ status: 1, stdout: '' })), null);
});

test('checkGateway returns true on any HTTP response and false on error', async () => {
  assert.equal(await checkGateway(3081, { fetchImpl: async () => ({ status: 200 }) }), true);
  assert.equal(await checkGateway(3081, { fetchImpl: async () => ({ status: 500 }) }), true);
  assert.equal(await checkGateway(3081, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
  assert.equal(await checkGateway(null, {}), false);
});

// ---- createService stop(): safety behavior (no real spawning) ----

function svcDeps(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-svc-run-'));
  const paths = () => ({
    pidFilePath: path.join(tmp, 'pid.json'),
    instancesDir: path.join(tmp, 'instances'),
    logsDir: path.join(tmp, 'logs'),
  });
  return { tmp, paths, ...overrides };
}

test('stop() refuses to kill a pid whose sidecar token mismatches', async () => {
  const calls = [];
  const killImpl = (pid, sig) => {
    calls.push([pid, sig]);
  };
  const { tmp, paths } = svcDeps();
  try {
    fs.mkdirSync(paths().instancesDir, { recursive: true });
    fs.writeFileSync(paths().pidFilePath, JSON.stringify({ pid: 123, token: 'pid-tok', startedAt: 1 }));
    fs.writeFileSync(path.join(paths().instancesDir, '123.json'), JSON.stringify({ pid: 123, token: 'OTHER' }));

    const svc = createService({ platform: 'linux', paths, killImpl, sleepImpl: () => {} });
    const res = svc.stop();
    assert.equal(res.status, 'refused');
    assert.equal(res.ok, false);
    assert.match(res.error, /NON-mobile/);
    // never delivered a terminating signal
    assert.ok(!calls.some(([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stop() clears a stale pidfile when the pid is dead', async () => {
  const { tmp, paths } = svcDeps();
  try {
    fs.writeFileSync(paths().pidFilePath, JSON.stringify({ pid: 999, token: 'x', startedAt: 1 }));
    const killImpl = (pid, sig) => {
      if (sig === 0) {
        const e = new Error('gone');
        e.code = 'ESRCH';
        throw e;
      }
    };
    const svc = createService({ platform: 'linux', paths, killImpl });
    const res = svc.stop();
    assert.equal(res.status, 'stale-cleared');
    assert.equal(fs.existsSync(paths().pidFilePath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stop() SIGTERMs a verified mobile instance on POSIX (no SIGKILL when it exits)', async () => {
  const calls = [];
  let terminated = false;
  const killImpl = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 0) {
      if (terminated) {
        const e = new Error('gone');
        e.code = 'ESRCH';
        throw e;
      }
      return;
    }
    if (sig === 'SIGTERM') terminated = true;
  };
  const { tmp, paths } = svcDeps();
  try {
    fs.mkdirSync(paths().instancesDir, { recursive: true });
    fs.writeFileSync(paths().pidFilePath, JSON.stringify({ pid: 123, token: 'tok', startedAt: 1 }));
    fs.writeFileSync(path.join(paths().instancesDir, '123.json'), JSON.stringify({ pid: 123, token: 'tok' }));

    const svc = createService({ platform: 'linux', paths, killImpl, sleepImpl: () => {} });
    const res = svc.stop();
    assert.equal(res.status, 'stopped');
    assert.ok(calls.some(([, sig]) => sig === 'SIGTERM'));
    assert.ok(!calls.some(([, sig]) => sig === 'SIGKILL'));
    assert.equal(fs.existsSync(paths().pidFilePath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stop() uses taskkill on Windows', async () => {
  const spawned = [];
  const spawnImpl = (bin, args) => {
    spawned.push([bin, args]);
    return { on() {}, unref() {} };
  };
  const { tmp, paths } = svcDeps();
  try {
    fs.mkdirSync(paths().instancesDir, { recursive: true });
    fs.writeFileSync(paths().pidFilePath, JSON.stringify({ pid: 123, token: 'tok', startedAt: 1 }));
    fs.writeFileSync(path.join(paths().instancesDir, '123.json'), JSON.stringify({ pid: 123, token: 'tok' }));

    const svc = createService({ platform: 'win32', paths, killImpl: () => {}, spawnImpl, sleepImpl: () => {} });
    const res = svc.stop();
    assert.equal(res.status, 'stopped');
    assert.deepEqual(spawned[0][0], 'taskkill');
    assert.deepEqual(spawned[0][1], ['/PID', '123', '/T', '/F']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- createService start() ----

test('start() spawns detached dsh with trusted-host + env and writes pidfile', () => {
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    spawned.push({ bin, args, options });
    return { pid: 4242, on() {}, unref() {} };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-svc-start-'));
  const fakeBin = path.join(tmp, 'dsh');
  fs.writeFileSync(fakeBin, 'fake');
  const paths = () => ({
    pidFilePath: path.join(tmp, 'pid.json'),
    instancesDir: path.join(tmp, 'instances'),
    logsDir: path.join(tmp, 'logs'),
  });
  try {
    const svc = createService({
      platform: 'linux',
      env: { DSH_BIN: fakeBin },
      paths,
      randomToken: () => 'a'.repeat(32),
      spawnImpl,
      killImpl: () => {
        const e = new Error('gone');
        e.code = 'ESRCH';
        throw e;
      },
    });
    const config = { gatewayPort: 3081 };
    const res = svc.start({ config, authorities: ['woody.tail.ts.net', '100.1.2.3'], logPath: path.join(tmp, 'logs', 'service.log') });
    assert.equal(res.ok, true);
    assert.equal(res.pid, 4242);
    assert.equal(res.token, 'a'.repeat(32));

    const { bin, args, options } = spawned[0];
    assert.equal(bin, fakeBin);
    assert.deepEqual(args, ['--profile', 'web', '--trusted-host', 'woody.tail.ts.net', '--trusted-host', '100.1.2.3']);
    assert.equal(options.detached, true);
    assert.equal(options.env.DSH_MOBILE_INSTANCE, '1');
    assert.equal(options.env.DSH_MOBILE_TOKEN, 'a'.repeat(32));
    assert.equal(options.env.DSH_MOBILE_GATEWAY_PORT, '3081');

    const pidfile = JSON.parse(fs.readFileSync(paths().pidFilePath, 'utf8'));
    assert.equal(pidfile.pid, 4242);
    assert.equal(pidfile.token, 'a'.repeat(32));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('start() refuses when already running', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-svc-already-'));
  const fakeBin = path.join(tmp, 'dsh');
  fs.writeFileSync(fakeBin, 'fake');
  const paths = () => ({
    pidFilePath: path.join(tmp, 'pid.json'),
    instancesDir: path.join(tmp, 'instances'),
    logsDir: path.join(tmp, 'logs'),
  });
  try {
    fs.writeFileSync(paths().pidFilePath, JSON.stringify({ pid: 5, token: 't', startedAt: 1 }));
    const svc = createService({
      platform: 'linux',
      env: { DSH_BIN: fakeBin },
      paths,
      killImpl: () => {}, // alive
      spawnImpl: () => ({ pid: 9, on() {}, unref() {} }),
    });
    const res = svc.start({ config: { gatewayPort: 3081 } });
    assert.equal(res.ok, false);
    assert.match(res.error, /already running/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- command-line-facing synchronous wrappers ----

test('checkGatewaySync uses a node fetch probe', () => {
  assert.equal(checkGatewaySync(3081, { spawnImpl: () => ({ status: 0 }) }), true);
  assert.equal(checkGatewaySync(3081, { spawnImpl: () => ({ status: 1 }) }), false);
  assert.equal(checkGatewaySync(null, {}), false);
});

test('startService/stopService/serviceStatus/serviceLogs adapt the service core', () => {
  const svc = {
    start: () => ({ ok: true, pid: 7, startedAt: 111, token: 't', cmdline: 'dsh' }),
    stop: () => ({ ok: true, status: 'stopped', pid: 7 }),
    status: () => ({ running: true, pid: 7, startedAt: 111, gatewayReachable: true }),
    logs: (tail, logPath) => [logPath, String(tail)],
  };
  assert.deepEqual(startService({ config: {} }, svc), {
    started: true,
    alreadyRunning: false,
    pid: 7,
    startedAt: 111,
    token: 't',
    error: null,
  });
  assert.deepEqual(stopService({}, svc), { stopped: true, pid: 7, error: null });
  assert.deepEqual(serviceStatus({ config: { gatewayPort: 3081 } }, svc), {
    running: true,
    pid: 7,
    startedAt: 111,
    gatewayReachable: true,
  });
  assert.deepEqual(serviceLogs({ logPath: '/x', tail: 5 }, svc), ['/x', '5']);
});

test('startService reports alreadyRunning from the core result', () => {
  const svc = { start: () => ({ ok: false, alreadyRunning: true, pid: 9, error: 'service already running (pid 9)' }) };
  const res = startService({ config: {} }, svc);
  assert.deepEqual(res, { started: false, alreadyRunning: true, pid: 9, error: 'service already running (pid 9)' });
});

test('readWindowsEnv reads machine then user registry scopes', async () => {
  const { readWindowsEnv } = await import('../src/service.js');

  const machineHit = (cmd, args) => {
    assert.equal(cmd, 'reg');
    assert.equal(args[2], 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
    return { status: 0, stdout: '    DEEPSEEK_API_KEY    REG_SZ    sk-mach\n' };
  };
  assert.equal(readWindowsEnv('DEEPSEEK_API_KEY', machineHit), 'sk-mach');

  const machineMiss = (cmd, args) => {
    if (args[2].startsWith('HKLM')) return { status: 1, stdout: '' };
    assert.equal(args[2], 'HKCU\\Environment');
    return { status: 0, stdout: '    DEEPSEEK_API_KEY    REG_EXPAND_SZ    sk-user\n' };
  };
  assert.equal(readWindowsEnv('DEEPSEEK_API_KEY', machineMiss), 'sk-user');

  const none = () => ({ status: 1, stdout: '' });
  assert.equal(readWindowsEnv('DEEPSEEK_API_KEY', none), null);

  const throws = () => {
    throw new Error('reg missing');
  };
  assert.equal(readWindowsEnv('DEEPSEEK_API_KEY', throws), null);
});
