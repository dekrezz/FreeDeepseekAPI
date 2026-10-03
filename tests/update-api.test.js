const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const S = require('../server.js').__test;

async function startServer(t) {
  const server = S.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function request(port, method, pathName, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathName, agent: false,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fakeUpdater({ restart = 'auto', installError = null } = {}) {
  const seen = [];
  const fail = (status, type, message) => Object.assign(new Error(message), { status, type });
  return {
    seen,
    async status() { return { version: '0.2.0', commit: 'aaaaaaa', channel: 'stable', method: 'git', reason: null, restart }; },
    async check(channel) {
      seen.push(['check', channel]);
      if (channel !== 'stable' && channel !== 'latest') throw fail(400, 'invalid_channel', 'Unknown update channel');
      return { channel, upToDate: false, available: { version: '0.3.0', commit: 'bbbbbbb' }, changes: [{ commit: 'bbbbbbb', subject: 'Safer retries' }], canInstall: true, blockedReason: null, restart };
    },
    async install(channel) {
      seen.push(['install', channel]);
      if (installError) throw installError;
      return { installed: { version: '0.3.0', commit: 'bbbbbbb', channel }, restart };
    },
  };
}

test('the dashboard can read, check and install updates through the admin API', async (t) => {
  const updater = fakeUpdater();
  t.after(S.useUpdater(updater));
  const port = await startServer(t);

  let res = await request(port, 'GET', '/admin/update');
  assert.equal(res.status, 200);
  assert.equal(res.json.version, '0.2.0');
  assert.equal(res.json.channel, 'stable');

  res = await request(port, 'POST', '/admin/update/check', { body: { channel: 'latest' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.available.version, '0.3.0');

  res = await request(port, 'POST', '/admin/update/check', { body: { channel: 'main' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.type, 'invalid_channel');

  res = await request(port, 'POST', '/admin/update/install', { body: { channel: 'latest' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.installed.version, '0.3.0');
  assert.deepEqual(updater.seen.at(-1), ['install', 'latest']);

  res = await request(port, 'GET', '/admin/update/install');
  assert.equal(res.status, 405);
});

test('install errors reach the dashboard with their own status and type', async (t) => {
  const err = Object.assign(new Error('This copy has uncommitted changes'), { status: 409, type: 'local_changes' });
  t.after(S.useUpdater(fakeUpdater({ installError: err })));
  const port = await startServer(t);
  const res = await request(port, 'POST', '/admin/update/install', { body: { channel: 'stable' } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'local_changes');
  assert.match(res.json.error.message, /uncommitted/);
});

test('restart runs only under the launcher', async (t) => {
  let restarted = 0;
  t.after(S.useRestart(() => { restarted += 1; }));
  t.after(S.useUpdater(fakeUpdater({ restart: 'manual' })));
  const port = await startServer(t);
  let res = await request(port, 'POST', '/admin/restart');
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'restart_unavailable');
  assert.equal(restarted, 0);

  S.useUpdater(fakeUpdater({ restart: 'auto' }));
  res = await request(port, 'POST', '/admin/restart');
  assert.equal(res.status, 202);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(restarted, 1);
});

test('another website cannot make the proxy install an update', async (t) => {
  const updater = fakeUpdater();
  t.after(S.useUpdater(updater));
  const port = await startServer(t);
  const res = await request(port, 'POST', '/admin/update/install', { body: { channel: 'latest' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(updater.seen.length, 0);
});
