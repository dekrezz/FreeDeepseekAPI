'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pow = require('../lib/pow');
const auth = require('../scripts/auth_import');
const chrome = require('../scripts/lib/chrome-setup');
const { readAccountFiles } = require('../server.js').__test;

const BUILTIN_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
// Tiny modules with the DeepSeek PoW exports. `ok` writes status 1 and answer 42.
// `loop` never returns from wasm_solve.
const OK_WASM = Buffer.from('AGFzbQEAAAABFQNgAn9/AX9gAX8Bf2AGf39/f39/AAMEAwABAgUDAQABB08EBm1lbW9yeQIAE19fd2JpbmRnZW5fZXhwb3J0XzAAAB9fX3diaW5kZ2VuX2FkZF90b19zdGFja19wb2ludGVyAAEKd2FzbV9zb2x2ZQACCicDBQBBgAgLBABBIAsaACAAQQE2AgAgAEEIakQAAAAAAABFQDkDAAs=', 'base64');
const LOOP_WASM = Buffer.from('AGFzbQEAAAABFQNgAn9/AX9gAX8Bf2AGf39/f39/AAMEAwABAgUDAQABB08EBm1lbW9yeQIAE19fd2JpbmRnZW5fZXhwb3J0XzAAAB9fX3diaW5kZ2VuX2FkZF90b19zdGFja19wb2ludGVyAAEKd2FzbV9zb2x2ZQACChQDBQBBgAgLBABBIAsHAANADAALCw==', 'base64');
const challenge = { salt: 'salt', expire_at: 1710000000, challenge: 'abc', difficulty: 4 };

const BAD_WASM_URLS = [
  'http://127.0.0.1:9/x.wasm',
  'http://192.168.1.1/admin?x.wasm',
  'https://evil.example.com/x.wasm',
  'https://evil-deepseek.com/x.wasm',
  'https://deepseek.com.evil.net/x.wasm',
  'http://fe-static.deepseek.com/x.wasm',
  '',
];

function restoreFetch(original) {
  global.fetch = original;
  pow._moduleCache.clear();
}

test('isDeepseekWasmUrl is the auth_import host check', () => {
  assert.equal(auth.isDeepseekWasmUrl, pow.isDeepseekWasmUrl);
  assert.equal(auth.wasmUrlOrDefault, pow.wasmUrlOrDefault);
  assert.equal(auth.DEFAULT_WASM, BUILTIN_WASM);
  assert.equal(pow.DEFAULT_WASM, BUILTIN_WASM);
  assert.equal(auth.wasmUrlOrDefault('https://evil.example.com/sha3.wasm'), BUILTIN_WASM);
  assert.equal(auth.wasmUrlOrDefault('https://chat.deepseek.com/sha3.wasm'), 'https://chat.deepseek.com/sha3.wasm');
});

test('account files with any other wasmUrl keep the built-in module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-host-acct-'));
  try {
    const files = BAD_WASM_URLS.map((wasmUrl, i) => {
      const file = path.join(dir, `bad-${i}.json`);
      const body = { token: `tok-${i}`, cookie: 'a=b', name: 'bad', wasmUrl };
      fs.writeFileSync(file, JSON.stringify(body));
      return file;
    });
    const goodUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.custom.wasm';
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ token: 'tok-good', cookie: 'a=b', wasmUrl: goodUrl }));
    files.push(good);
    const missing = path.join(dir, 'missing.json');
    fs.writeFileSync(missing, JSON.stringify({ token: 'tok-missing', cookie: 'a=b' }));
    files.push(missing);

    const { loaded, errors } = readAccountFiles(files);
    assert.equal(errors.length, 0);
    assert.equal(loaded.length, files.length);
    for (let i = 0; i < BAD_WASM_URLS.length; i++) {
      assert.equal(loaded[i].config.wasmUrl, BUILTIN_WASM, BAD_WASM_URLS[i] || '(empty)');
      assert.equal(loaded[i].config.token, `tok-${i}`);
      const onDisk = JSON.parse(fs.readFileSync(files[i], 'utf8'));
      assert.equal(onDisk.wasmUrl, BAD_WASM_URLS[i]);
    }
    assert.equal(loaded[BAD_WASM_URLS.length].config.wasmUrl, goodUrl);
    assert.equal(JSON.parse(fs.readFileSync(good, 'utf8')).wasmUrl, goodUrl);
    assert.equal(loaded[BAD_WASM_URLS.length + 1].config.wasmUrl, BUILTIN_WASM);
    assert.equal(JSON.parse(fs.readFileSync(missing, 'utf8')).wasmUrl, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chrome capture keeps the built-in module unless the sha3 wasm resource is on https://*.deepseek.com', () => {
  const good = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  assert.equal(chrome.capturedWasmUrl([good]), good);
  assert.equal(chrome.capturedWasmUrl(['https://cdn.example.com/app.js', good]), good);
  assert.equal(chrome.capturedWasmUrl(['https://evil.example.com/sha3.wasm', good]), BUILTIN_WASM);
  assert.equal(chrome.capturedWasmUrl(['http://fe-static.deepseek.com/sha3.wasm']), BUILTIN_WASM);
  assert.equal(chrome.capturedWasmUrl(['https://evil-deepseek.com/sha3_wasm_bg.wasm']), BUILTIN_WASM);
  assert.equal(chrome.capturedWasmUrl([]), BUILTIN_WASM);
  assert.equal(chrome.capturedWasmUrl(undefined), BUILTIN_WASM);

  const src = fs.readFileSync(path.join(ROOT, 'scripts/deepseek_chrome_auth.js'), 'utf8');
  assert.match(src, /capturedWasmUrl\(\s*pageState\.resources\s*\)/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-host-chrome-'));
  try {
    const file = path.join(dir, 'deepseek-auth.json');
    for (const wasmUrl of BAD_WASM_URLS) {
      const wrote = chrome.writeCapturedAuth(file, {
        token: 'tok',
        cookie: 'ds_session_id=abc',
        hif_dliq: 'd',
        hif_leim: 'l',
        wasmUrl,
        baseUrl: 'https://chat.deepseek.com',
      });
      assert.equal(wrote, true);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(stored.wasmUrl, BUILTIN_WASM, wasmUrl || '(missing)');
      assert.equal(stored.token, 'tok');
      assert.equal(stored.cookie, 'ds_session_id=abc');
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      fs.rmSync(file);
    }
    const keep = 'https://chat.deepseek.com/static/sha3_custom.wasm';
    assert.equal(chrome.writeCapturedAuth(file, { token: 'tok', cookie: 'a=b', wasmUrl: keep }), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wasmUrl, keep);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pow does not fetch a wasmUrl outside https://*.deepseek.com', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(302, { Location: '/evil.wasm' });
    res.end(OK_WASM);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url, opts) => {
    fetched.push({ url: String(url), redirect: opts && opts.redirect });
    throw new Error('fetch must not run for a non-deepseek wasmUrl');
  };
  try {
    const port = server.address().port;
    await assert.rejects(
      () => pow.solvePOW(challenge, `http://127.0.0.1:${port}/sha3.wasm`),
      /https:\/\/\*\.deepseek\.com/,
    );
    for (const wasmUrl of BAD_WASM_URLS) {
      await assert.rejects(() => pow.solvePOW(challenge, wasmUrl), /https:\/\/\*\.deepseek\.com/);
    }
    assert.equal(hits, 0);
    assert.deepEqual(fetched, []);
  } finally {
    restoreFetch(originalFetch);
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('pow fetch refuses a redirect and does not compile its body', async () => {
  const originalFetch = global.fetch;
  const originalCompile = WebAssembly.compile;
  let compiledPayload = 0;
  let bodyReads = 0;
  const calls = [];
  // Node's fetch implementation also compiles an internal wasm parser. Count only
  // the PoW bytes from the redirect body.
  WebAssembly.compile = async function (bytes) {
    if (Buffer.from(bytes).equals(OK_WASM)) compiledPayload += 1;
    return originalCompile.call(WebAssembly, bytes);
  };
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), redirect: opts && opts.redirect });
    if (String(url).includes('evil.example.com')) {
      return new Response(OK_WASM, { status: 200 });
    }
    const resp = new Response(OK_WASM, {
      status: 302,
      headers: { Location: 'https://evil.example.com/sha3.wasm' },
    });
    const read = resp.arrayBuffer.bind(resp);
    resp.arrayBuffer = async () => {
      bodyReads += 1;
      return read();
    };
    return resp;
  };
  const wasmUrl = 'https://fe-static.deepseek.com/chat/static/redir.wasm';
  try {
    await assert.rejects(() => pow.solvePOW(challenge, wasmUrl), /refusing redirect/);
    assert.deepEqual(calls, [{ url: wasmUrl, redirect: 'manual' }]);
    assert.equal(bodyReads, 0);
    assert.equal(compiledPayload, 0);
    assert.equal(pow._moduleCache.has(wasmUrl), false);

    // A client that followed the redirect would see HTTP 200 with redirected set.
    calls.length = 0;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), redirect: opts && opts.redirect });
      const resp = new Response(OK_WASM, { status: 200 });
      Object.defineProperty(resp, 'redirected', { value: true });
      const read = resp.arrayBuffer.bind(resp);
      resp.arrayBuffer = async () => {
        bodyReads += 1;
        return read();
      };
      return resp;
    };
    await assert.rejects(() => pow.solvePOW(challenge, wasmUrl), /refusing redirect/);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(bodyReads, 0);
    assert.equal(compiledPayload, 0);
  } finally {
    WebAssembly.compile = originalCompile;
    restoreFetch(originalFetch);
  }
});

test('pow does not compile wasm bytes served from another host', async () => {
  const originalFetch = global.fetch;
  const originalCompile = WebAssembly.compile;
  let compiledPayload = 0;
  let bodyReads = 0;
  WebAssembly.compile = async function (bytes) {
    if (Buffer.from(bytes).equals(OK_WASM)) compiledPayload += 1;
    return originalCompile.call(WebAssembly, bytes);
  };
  global.fetch = async (url, opts) => {
    assert.equal(opts.redirect, 'manual');
    const resp = new Response(OK_WASM, { status: 200 });
    Object.defineProperty(resp, 'url', { value: 'https://evil.example.com/sha3.wasm' });
    const read = resp.arrayBuffer.bind(resp);
    resp.arrayBuffer = async () => {
      bodyReads += 1;
      return read();
    };
    return resp;
  };
  const wasmUrl = 'https://fe-static.deepseek.com/chat/static/followed.wasm';
  try {
    await assert.rejects(() => pow.solvePOW(challenge, wasmUrl), /another host/);
    assert.equal(bodyReads, 0);
    assert.equal(compiledPayload, 0);
  } finally {
    WebAssembly.compile = originalCompile;
    restoreFetch(originalFetch);
  }
});

test('solvePOW(challenge, wasmUrl) still returns the numeric answer', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const wasmUrl = 'https://fe-static.deepseek.com/chat/static/ok.wasm';
  global.fetch = async (url, opts) => {
    calls += 1;
    assert.equal(String(url), wasmUrl);
    assert.equal(opts.redirect, 'manual');
    return new Response(OK_WASM, { status: 200 });
  };
  try {
    assert.equal(await pow.solvePOW(challenge, wasmUrl), 42);
    assert.equal(await pow.solvePOW(challenge, wasmUrl, {}), 42);
    assert.equal(calls, 1);
  } finally {
    restoreFetch(originalFetch);
  }
});

test('wasm_solve runs off the main thread and a hung module is terminated', { timeout: 4000 }, async () => {
  const originalFetch = global.fetch;
  const wasmUrl = 'https://fe-static.deepseek.com/chat/static/loop.wasm';
  global.fetch = async () => new Response(LOOP_WASM, { status: 200 });
  let ticks = 0;
  const pulse = setInterval(() => { ticks += 1; }, 20);
  const started = Date.now();
  try {
    await assert.rejects(
      () => pow.solvePOW(challenge, wasmUrl, { solveTimeoutMs: 250 }),
      /wasm_solve timed out/,
    );
    assert.ok(Date.now() - started < 2000, 'terminate must not wait out a stuck module');
    assert.ok(ticks >= 2, 'the main thread must keep running while wasm_solve is stuck');
  } finally {
    clearInterval(pulse);
    restoreFetch(originalFetch);
  }
});
