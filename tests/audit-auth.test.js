'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { normalizeAuth, validateAuth } = require('../scripts/auth_import');

test('audit auth-2: scripts/auth.js ignores a comma-separated DEEPSEEK_AUTH_PATH list', () => {
  const r = spawnSync(process.execPath, ['-e', "console.log(require('./scripts/auth.js').AUTH_PATH)"], {
    cwd: ROOT,
    env: { ...process.env, DEEPSEEK_AUTH_PATH: 'a.json,b.json' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.ok(!printed.includes(','), `AUTH_PATH must not be the raw comma list, got: ${printed}`);
  assert.equal(printed, path.join(ROOT, 'deepseek-auth.json'));
});

test('audit auth-3: validateAuth rejects a wasmUrl outside https deepseek.com', () => {
  const bad = [
    'http://127.0.0.1:9/x.wasm',
    'http://192.168.1.1/admin?x.wasm',
    'https://evil.example.com/x.wasm',
    'https://evil-deepseek.com/x.wasm',
    'https://deepseek.com.evil.net/x.wasm',
    'http://fe-static.deepseek.com/x.wasm',
  ];
  for (const wasmUrl of bad) {
    const auth = normalizeAuth({ token: 't', cookie: 'a=b', wasmUrl }, {}, { useEnv: false });
    assert.ok(validateAuth(auth).length > 0, `wasmUrl ${wasmUrl} must be rejected`);
  }
  for (const wasmUrl of [undefined, 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.x.wasm']) {
    const auth = normalizeAuth({ token: 't', cookie: 'a=b', wasmUrl }, {}, { useEnv: false });
    assert.deepEqual(validateAuth(auth), [], `wasmUrl ${wasmUrl} must stay valid`);
  }
});

test('audit auth-5: cookie export import keeps only deepseek.com cookies', () => {
  const auth = normalizeAuth({
    cookies: [
      { name: 'ds_session_id', value: '1', domain: '.deepseek.com' },
      { name: 'sid', value: 'secret', domain: 'evil-deepseek.com' },
      { name: 'x', value: 'y', domain: 'notdeepseek.com' },
      { name: 'z', value: 'w', domain: 'deepseek.example.net' },
    ],
  }, { token: 't' }, { useEnv: false });
  assert.equal(auth.cookie, 'ds_session_id=1');
});
