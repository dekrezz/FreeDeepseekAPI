// Limits for callers outside this machine: request budget, wrong-key lockout, connection caps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const S = require('../server.js').__test;

const clock = (start = 1000000) => { const c = () => c.t; c.t = start; return c; };
const socket = (remoteAddress) => Object.assign(new EventEmitter(), { remoteAddress, destroyed: false, destroy() { this.destroyed = true; } });

test('an address over its minute budget gets 429 until the minute ends', () => {
  const now = clock();
  const guard = S.createRemoteGuard({ perMinute: 2, now });
  assert.equal(guard.check('203.0.113.5').allowed, true);
  assert.equal(guard.check('203.0.113.5').allowed, true);
  assert.deepEqual(guard.check('203.0.113.5'), { allowed: false, retryAfter: 60 });
  assert.equal(guard.check('203.0.113.6').allowed, true, 'another address has its own budget');
  now.t += 60000;
  assert.equal(guard.check('203.0.113.5').allowed, true);
});

test('wrong keys lock the address out, even with the request budget off', () => {
  const now = clock();
  const guard = S.createRemoteGuard({ perMinute: 0, authFailLimit: 3, authLockMs: 1000, now });
  guard.failedAuth('203.0.113.5');
  guard.failedAuth('203.0.113.5');
  assert.equal(guard.check('203.0.113.5').allowed, true);
  guard.failedAuth('203.0.113.5');
  assert.deepEqual(guard.check('203.0.113.5'), { allowed: false, retryAfter: 1 });
  assert.equal(guard.connect('203.0.113.5'), false, 'a locked address is refused at the socket');
  now.t += 1000;
  assert.equal(guard.check('203.0.113.5').allowed, true);
});

test('wrong keys spread past the lock window never add up to a lockout', () => {
  const now = clock();
  const guard = S.createRemoteGuard({ authFailLimit: 2, authLockMs: 1000, now });
  guard.failedAuth('203.0.113.5');
  now.t += 1000;
  guard.failedAuth('203.0.113.5');
  assert.equal(guard.check('203.0.113.5').allowed, true);
});

test('the table of addresses stays bounded under a flood', () => {
  const guard = S.createRemoteGuard({ maxTracked: 100, now: clock() });
  for (let i = 0; i < 5000; i++) guard.check(`198.51.${i >> 8}.${i & 255}`);
  assert.ok(guard.size() <= 100);
});

test('connections: loopback passes, keyless outsiders are closed, the cap frees on close', () => {
  const guard = S.createRemoteGuard({ perIpConnections: 1 });
  const local = socket('::ffff:127.0.0.1');
  S.guardConnection(local, { guard, proxyKey: '', trustProxy: false });
  assert.equal(local.destroyed, false);

  const keyless = socket('203.0.113.5');
  S.guardConnection(keyless, { guard, proxyKey: '', trustProxy: false });
  assert.equal(keyless.destroyed, true);

  const first = socket('203.0.113.5');
  const second = socket('203.0.113.5');
  S.guardConnection(first, { guard, proxyKey: 'k', trustProxy: false });
  S.guardConnection(second, { guard, proxyKey: 'k', trustProxy: false });
  assert.equal(first.destroyed, false);
  assert.equal(second.destroyed, true);
  first.emit('close');
  const third = socket('203.0.113.5');
  S.guardConnection(third, { guard, proxyKey: 'k', trustProxy: false });
  assert.equal(third.destroyed, false);
});

test('a client cannot pose as loopback through X-Forwarded-For', () => {
  const req = (forwarded) => ({ socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(S.guardIp(req('127.0.0.1')), '203.0.113.5', 'ignored unless TRUST_PROXY is set');
  const saved = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  try {
    assert.equal(S.guardIp(req('127.0.0.1, 198.51.100.9')), '198.51.100.9', 'the hop the proxy appended counts');
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
  }
});
