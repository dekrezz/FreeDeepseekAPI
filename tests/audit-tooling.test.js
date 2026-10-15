const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { RESTART_EXIT_CODE } = require('../lib/updater');

test('audit tooling-3: client.js names a corrupt deepseek-auth.json instead of saying auth is not set', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'client.js'), path.join(dir, 'client.js'));
  fs.copyFileSync(path.join(ROOT, 'lib', 'pow.js'), path.join(dir, 'lib', 'pow.js'));
  fs.writeFileSync(path.join(dir, 'deepseek-auth.json'), '{"token": "abc', 'utf8');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('DEEPSEEK_')) delete env[k];
  const res = spawnSync(process.execPath, [path.join(dir, 'client.js'), 'hi'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /deepseek-auth\.json/, 'stderr must name the broken file');
  assert.match(res.stderr, /invalid JSON|not valid JSON|JSON/i);
});

test('audit tooling-6: the launcher gives up when the server keeps exiting with the restart code', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsa-launch-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const counter = path.join(dir, 'runs');
  const entry = path.join(dir, 'fake-server.js');
  fs.writeFileSync(entry, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    process.exit(${RESTART_EXIT_CODE});
  `);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'start.js')], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, FDSA_SERVER_ENTRY: entry }, timeout: 8000, killSignal: 'SIGKILL',
  });
  const runs = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0;
  assert.notEqual(res.error && res.error.code, 'ETIMEDOUT', `launcher still looping after ${runs} spawns`);
  assert.ok(runs <= 20, `launcher spawned the server ${runs} times`);
  assert.notEqual(res.status, 0, 'launcher must exit non-zero after repeated instant restarts');
});
