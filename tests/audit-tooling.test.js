const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { RESTART_EXIT_CODE } = require('../lib/updater');

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
