// Issue #6 (multi-account rate-limit failover) and the admin/dashboard API.
// Every upstream call is served by an in-process fetch mock; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const pow = require('../lib/pow');
const S = require('../server.js').__test;

const COMPLETION = '/api/v0/chat/completion';
const SESSION_CREATE = '/api/v0/chat_session/create';
const POW = '/api/v0/chat/create_pow_challenge';
const UPLOAD = '/api/v0/file/upload_file';

const RATE_TEXT = 'Слишком частые сообщения. Повторите попытку позже';
const HINT_EVENT = `event: hint\ndata: ${JSON.stringify({ type: 'error', content: RATE_TEXT, clear_response: true, finish_reason: 'rate_limit_reached' })}\n\n`;
const HINT_SSE = `event: ready\ndata: {"request_message_id":1,"response_message_id":2}\n\n${HINT_EVENT}`;
const HINT_SSE_NO_READY = HINT_EVENT;

function okSse(text, { messageId = 2, finishReason } = {}) {
  const response = { message_id: messageId, fragments: [{ type: 'RESPONSE', content: text }] };
  if (finishReason) response.finish_reason = finishReason;
  return `data: ${JSON.stringify({ v: { response } })}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n`;
}
function sse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function acct(id, extra = {}) {
  return {
    id,
    file: `/tmp/fdsapi-secret-dir/${id}.json`,
    config: { token: `tok-${id}-SECRET`, cookie: `ck_${id}=CK-${id}-SECRET; other=2` },
    headers: { Authorization: `Bearer ${id}` },
    cooldownUntil: 0,
    failures: 0,
    lastUsedAt: 0,
    ...extra,
  };
}

function useAccounts(t, list) {
  const original = S.accounts.splice(0, S.accounts.length, ...list);
  t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
}

function seedStickySession(t, agent, accountId, sessionId) {
  const session = S.createSession();
  Object.assign(session, { id: sessionId, accountId, parentMessageId: 5, createdAt: Date.now(), messageCount: 10 });
  S.sessions.set(agent, session);
  t.after(() => { S.sessions.delete(agent); });
  return session;
}

// handlers.completion: { <accountId>: [() => Response, ...] } consumed in order,
// the last entry repeats. Other routes answer with healthy defaults unless overridden.
function installUpstream(t, handlers = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const completionIndex = new Map();
  let sessionSeq = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const account = String(options.headers?.Authorization || '').replace(/^Bearer /, '');
    let body = null;
    if (typeof options.body === 'string') {
      try { body = JSON.parse(options.body); } catch (e) { body = options.body; }
    }
    calls.push({ path: u.pathname, account, body });
    if (u.pathname === POW) {
      if (handlers.pow) { const r = handlers.pow(account); if (r) return r; }
      return jsonResp({ code: 0, data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', signature: 'sig', difficulty: 1, expire_at: 1, target_path: body?.target_path } } } });
    }
    if (u.pathname === SESSION_CREATE) {
      if (handlers.sessionCreate) { const r = handlers.sessionCreate(account); if (r) return r; }
      sessionSeq++;
      return jsonResp({ code: 0, data: { biz_code: 0, biz_data: { id: `sess-${account}-${sessionSeq}` } } });
    }
    if (u.pathname === UPLOAD) {
      return jsonResp({ code: 0, data: { biz_code: 0, biz_data: { id: `file-${account}`, status: 'SUCCESS' } } });
    }
    if (u.pathname === COMPLETION) {
      const queue = handlers.completion?.[account];
      if (!queue || queue.length === 0) throw new Error(`test upstream: no completion handler for account ${account}`);
      const i = completionIndex.get(account) || 0;
      completionIndex.set(account, i + 1);
      return queue[Math.min(i, queue.length - 1)]();
    }
    throw new Error(`test upstream: unexpected fetch ${u.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.method(pow, 'solvePOW', async () => 1);
  return calls;
}

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
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      agent: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function chat(port, agent, messages, extra = {}) {
  return request(port, 'POST', '/v1/chat/completions', {
    body: { model: 'deepseek-v4-flash', messages, ...extra },
    headers: { 'x-agent-session': agent },
  });
}

const HISTORY_MESSAGES = [
  { role: 'system', content: 'SYSTEM_RULES' },
  { role: 'user', content: 'TASK_ONE original task' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'SECOND_Q follow up' },
];

const byPath = (calls, p, account) => calls.filter(c => c.path === p && (account === undefined || c.account === account));

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

test('isRateLimitSignal recognizes DeepSeek rate-limit text and finish reasons only', () => {
  const positives = [
    RATE_TEXT,
    'Слишком частые запросы',
    'Too many requests',
    'Messages too frequent, try again later',
    'rate limit exceeded',
    'Rate-Limit reached',
    '请求过于频繁，请稍后再试',
    '请求过多',
    '请求次数过多',
    { content: RATE_TEXT },
    { biz_msg: 'Too Many Requests' },
    { finish_reason: 'rate_limit_reached', content: '' },
  ];
  for (const value of positives) {
    assert.equal(S.isRateLimitSignal(value), true, `expected rate limit: ${JSON.stringify(value)}`);
  }
  const negatives = [
    'Содержание слишком длинное. Сократите его и попробуйте снова.',
    'Maximum context length exceeded',
    'too many tokens',
    'Temporary backend overload',
    'invalid parent message id',
    '',
    null,
    undefined,
    { finish_reason: 'stop', content: '' },
    { content: 'Содержание слишком длинное.' },
  ];
  for (const value of negatives) {
    assert.equal(S.isRateLimitSignal(value), false, `expected not rate limit: ${JSON.stringify(value)}`);
  }
});

test('isRateLimitSignal does not match "rate limit" inside another word', () => {
  for (const text of ['exceeds the generate limit', 'moderate limit reached', 'separate limit per file', 'accurate limits']) {
    assert.equal(S.isRateLimitSignal(text), false, `expected not rate limit: ${text}`);
  }
  for (const text of ['exceeded_rate_limit', 'error: rate-limit', '(rate limit)']) {
    assert.equal(S.isRateLimitSignal(text), true, `expected rate limit: ${text}`);
  }
});

test('/health account status keeps failures as the lifetime count', () => {
  const account = acct('health', { failures: 0, totalFailures: 4 });
  const status = S.accountStatus(account);
  assert.equal(status.failures, 4);
});

test('a rate-limit signal is never classified as context-too-long', () => {
  assert.equal(S.isContextTooLongError('Prompt rate limit exceeded'), false);
  assert.equal(S.isContextTooLongError({ content: RATE_TEXT, finish_reason: 'rate_limit_reached' }), false);
  assert.equal(S.isContextTooLongError({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), true);
});

test('an HTTP 400 carrying a rate-limit message becomes a 429 rate_limit_error', () => {
  const error = S.createUpstreamHttpError(400, `{"code":0,"msg":"${RATE_TEXT}"}`, '9');
  assert.equal(error.status, 429);
  assert.equal(error.type, 'rate_limit_error');
  assert.equal(error.retryAfter, '9');
  assert.match(error.message, /Слишком частые/);

  const plain = S.createUpstreamHttpError(400, '{"msg":"invalid parent message id"}');
  assert.equal(plain.status, 400);
  assert.equal(plain.type, 'upstream_http_error');
});

test('markAccountFailure cools down on rate-limit text with Retry-After, but not on a plain 400', () => {
  const now = Date.now();
  const limited = acct('limited');
  S.markAccountFailure(limited, 400, 'completion', '17', 'too frequent');
  assert.ok(Math.abs(limited.cooldownUntil - (now + 17_000)) <= 2000, `cooldown ${limited.cooldownUntil - now}ms`);
  assert.equal(limited.cooldownReason, 'rate_limit');
  assert.equal(limited.lastError.kind, 'rate_limit');
  assert.equal(limited.lastError.status, 400);
  assert.equal(limited.failures, 1);
  assert.equal(limited.totalFailures, 1);

  const plain = acct('plain');
  S.markAccountFailure(plain, 400, 'completion', null, 'invalid parent message id');
  assert.equal(plain.cooldownUntil, 0);
  assert.equal(plain.lastError.kind, 'upstream');
  assert.equal(plain.failures, 1);

  const auth = acct('auth');
  S.markAccountFailure(auth, 401, 'completion', null, 'expired');
  assert.ok(auth.cooldownUntil > now);
  assert.equal(auth.cooldownReason, 'auth');
  assert.equal(auth.lastError.kind, 'auth');
});

test('a successful request resets consecutive failures but keeps the lifetime count', () => {
  const account = acct('ok', { failures: 3, totalFailures: 5 });
  S.recordAccountSuccess(account);
  assert.equal(account.failures, 0);
  assert.equal(account.totalFailures, 5);
  assert.ok(account.lastSuccessAt > 0);
});

test('admin-disabled accounts are skipped by selection and cannot serve', (t) => {
  const a = acct('A', { adminDisabled: true });
  const b = acct('B');
  useAccounts(t, [a, b]);
  assert.equal(S.accountCanServe(a), false);
  assert.equal(S.accountCanServe(b), true);
  const session = S.createSession();
  session.accountId = 'A';
  assert.equal(S.selectAccountForSession(session).id, 'B');
});

// ---------------------------------------------------------------------------
// Issue #6: in-request failover
// ---------------------------------------------------------------------------

test('issue #6: a rate-limit hint in a 200 stream cools the account and fails over with the full transcript', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, { completion: { A: [() => sse(HINT_SSE)], B: [() => sse(okSse('hello from B'))] } });
  seedStickySession(t, 'issue6-hint', 'A', 'old-A');
  const port = await startServer(t);
  const before = Date.now();

  const res = await chat(port, 'issue6-hint', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'hello from B');
  assert.equal(res.headers['x-account-id'], 'B');
  assert.ok(A.cooldownUntil > before, 'A must be cooling down');
  assert.equal(B.cooldownUntil, 0);
  const aCompletions = byPath(calls, COMPLETION, 'A');
  assert.equal(aCompletions.length, 1);
  assert.equal(aCompletions[0].body.chat_session_id, 'old-A');
  const bFirst = byPath(calls, COMPLETION, 'B')[0];
  assert.ok(bFirst, 'B must be tried');
  assert.notEqual(bFirst.body.chat_session_id, 'old-A');
  assert.equal(bFirst.body.parent_message_id, null);
  assert.match(bFirst.body.prompt, /SYSTEM_RULES/);
  assert.match(bFirst.body.prompt, /TASK_ONE/);
  assert.match(bFirst.body.prompt, /SECOND_Q/);
});

test('issue #6: a rate-limit hint without a ready event fails over instead of becoming context_length_exceeded', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, { completion: { A: [() => sse(HINT_SSE_NO_READY)], B: [() => sse(okSse('hello from B'))] } });
  seedStickySession(t, 'issue6-noready', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'issue6-noready', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'hello from B');
  assert.equal(res.headers['x-account-id'], 'B');
  assert.equal(res.headers['x-freedeepseek-context-compacted'], undefined);
  assert.equal(byPath(calls, COMPLETION, 'A').length, 1);
  assert.ok(A.cooldownUntil > Date.now());
});

test('issue #6: an HTTP 400 rate-limit body fails over without recreating a session on the limited account', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, {
    completion: {
      A: [() => jsonResp({ code: 0, msg: RATE_TEXT, data: null }, 400, { 'retry-after': '30' })],
      B: [() => sse(okSse('hello from B'))],
    },
  });
  seedStickySession(t, 'issue6-400', 'A', 'old-A');
  const port = await startServer(t);
  const before = Date.now();

  const res = await chat(port, 'issue6-400', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-account-id'], 'B');
  assert.equal(byPath(calls, SESSION_CREATE, 'A').length, 0);
  assert.equal(byPath(calls, COMPLETION, 'A').length, 1);
  assert.ok(Math.abs(A.cooldownUntil - (before + 30_000)) <= 3000, `cooldown ${A.cooldownUntil - before}ms`);
});

test('issue #6: an HTTP 429 fails over and honors Retry-After', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  installUpstream(t, {
    completion: {
      A: [() => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '42' } })],
      B: [() => sse(okSse('hello from B'))],
    },
  });
  seedStickySession(t, 'issue6-429', 'A', 'old-A');
  const port = await startServer(t);
  const before = Date.now();

  const res = await chat(port, 'issue6-429', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-account-id'], 'B');
  assert.ok(Math.abs(A.cooldownUntil - (before + 42_000)) <= 3000, `cooldown ${A.cooldownUntil - before}ms`);
});

test('issue #6: a JSON rate-limit body on HTTP 200 fails over instead of reading an empty stream', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, {
    completion: {
      A: [() => jsonResp({ code: 0, data: { biz_code: 1, biz_msg: 'Слишком частые сообщения' } })],
      B: [() => sse(okSse('hello from B'))],
    },
  });
  seedStickySession(t, 'issue6-json200', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'issue6-json200', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-account-id'], 'B');
  assert.equal(byPath(calls, COMPLETION, 'A').length, 1);
  assert.ok(A.cooldownUntil > Date.now());
});

test('issue #6: when every login is rate-limited the client gets 429 rate_limit with Retry-After', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, { completion: { A: [() => sse(HINT_SSE)], B: [() => sse(HINT_SSE)] } });
  seedStickySession(t, 'issue6-all', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'issue6-all', HISTORY_MESSAGES);

  assert.equal(res.status, 429, res.text);
  assert.equal(res.json.error.type, 'rate_limit');
  assert.match(res.headers['retry-after'] || '', /^\d+$/);
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.equal(byPath(calls, COMPLETION, 'A').length, 1);
  assert.equal(byPath(calls, COMPLETION, 'B').length, 1);
});

test('issue #6: image attachments are re-uploaded to the failover account', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, { completion: { A: [() => sse(HINT_SSE)], B: [() => sse(okSse('I see a pixel'))] } });
  t.after(() => { S.sessions.delete('issue6-image'); });
  const port = await startServer(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

  const res = await chat(port, 'issue6-image', [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ],
  }]);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-account-id'], 'B');
  assert.deepEqual(byPath(calls, COMPLETION, 'A')[0].body.ref_file_ids, ['file-A']);
  assert.deepEqual(byPath(calls, COMPLETION, 'B')[0].body.ref_file_ids, ['file-B']);
});

test('a served request resets the serving account consecutive failures', async (t) => {
  const B = acct('B', { failures: 3, totalFailures: 5 });
  useAccounts(t, [B]);
  installUpstream(t, { completion: { B: [() => sse(okSse('fine'))] } });
  t.after(() => { S.sessions.delete('success-reset'); });
  const port = await startServer(t);

  const res = await chat(port, 'success-reset', [{ role: 'user', content: 'hi' }]);

  assert.equal(res.status, 200, res.text);
  assert.equal(B.failures, 0);
  assert.equal(B.totalFailures, 5);
});

// ---------------------------------------------------------------------------
// Guards: behavior that must not change
// ---------------------------------------------------------------------------

test('guard: a plain HTTP 400 does not cool the account and recreates the session on the same login', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, {
    completion: {
      A: [
        () => jsonResp({ code: 0, data: { biz_code: 7, biz_msg: 'invalid parent message id' } }, 400),
        () => sse(okSse('recovered on A')),
      ],
      B: [() => sse(okSse('wrong account'))],
    },
  });
  seedStickySession(t, 'guard-400', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'guard-400', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'recovered on A');
  assert.equal(res.headers['x-account-id'], 'A');
  assert.equal(A.cooldownUntil, 0);
  assert.equal(byPath(calls, SESSION_CREATE, 'A').length, 1);
  assert.equal(byPath(calls, COMPLETION, 'B').length, 0);
});

test('guard: a non-rate-limit JSON body on HTTP 200 recreates the session on the same login', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, {
    completion: {
      A: [
        () => jsonResp({ code: 0, data: { biz_code: 7, biz_msg: 'invalid parent message id' } }),
        () => sse(okSse('recovered on A')),
      ],
      B: [() => sse(okSse('wrong account'))],
    },
  });
  const session = seedStickySession(t, 'guard-json200', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'guard-json200', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'recovered on A');
  assert.equal(res.headers['x-account-id'], 'A');
  assert.equal(A.cooldownUntil, 0);
  assert.equal(byPath(calls, SESSION_CREATE, 'A').length, 1);
  assert.equal(byPath(calls, COMPLETION, 'B').length, 0);
  const second = byPath(calls, COMPLETION, 'A')[1].body;
  assert.notEqual(second.chat_session_id, 'old-A');
  assert.equal(second.parent_message_id, null);
  assert.match(second.prompt, /TASK_ONE/, 'the fresh chat gets the full transcript');
  assert.notEqual(session.id, 'old-A');
});

test('guard: a JSON body on the fresh chat too fails loudly and does not keep the broken chat', async (t) => {
  const A = acct('A');
  useAccounts(t, [A]);
  installUpstream(t, {
    completion: {
      A: [() => jsonResp({ code: 0, data: { biz_code: 7, biz_msg: 'invalid parent message id' } })],
    },
  });
  const session = seedStickySession(t, 'guard-json200-twice', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'guard-json200-twice', HISTORY_MESSAGES);

  assert.equal(res.status, 502, res.text);
  assert.match(res.json.error.message, /invalid parent message id/);
  assert.equal(A.cooldownUntil, 0);
  assert.notEqual(session.id, 'old-A');
});

test('guard: a signal-less instant-empty reply stays on the same login and follows the overflow path', async (t) => {
  const A = acct('A');
  const B = acct('B');
  useAccounts(t, [A, B]);
  const calls = installUpstream(t, {
    completion: {
      A: [() => sse('data: {"p":"response/status","v":"FINISHED"}\n\n'), () => sse(okSse('second try on A'))],
      B: [() => sse(okSse('wrong account'))],
    },
  });
  seedStickySession(t, 'guard-instant-empty', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'guard-instant-empty', HISTORY_MESSAGES);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'second try on A');
  assert.equal(res.headers['x-account-id'], 'A');
  assert.equal(A.cooldownUntil, 0);
  assert.equal(byPath(calls, COMPLETION, 'B').length, 0);
  // Overflow path: the retry opened a fresh chat on A instead of continuing old-A.
  assert.equal(byPath(calls, SESSION_CREATE, 'A').length, 1);
  assert.notEqual(byPath(calls, COMPLETION, 'A')[1].body.chat_session_id, 'old-A');
});

test('a continuation that hits a rate-limit hint keeps the first part and cools the account', async (t) => {
  const A = acct('A');
  useAccounts(t, [A]);
  installUpstream(t, {
    completion: {
      A: [() => sse(okSse('part one', { finishReason: 'length' })), () => sse(HINT_SSE)],
    },
  });
  seedStickySession(t, 'continuation-limit', 'A', 'old-A');
  const port = await startServer(t);

  const res = await chat(port, 'continuation-limit', [{ role: 'user', content: 'write a long essay' }]);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'part one');
  assert.ok(A.cooldownUntil > Date.now());
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

test('adminAccessDecision limits a keyless admin API to direct loopback clients', () => {
  const deny = S.adminAccessDecision({ remoteAddress: '203.0.113.5', headers: {} }, { proxyKey: '', allowRemote: false });
  assert.equal(deny.allowed, false);
  assert.equal(deny.status, 403);
  assert.equal(deny.error.type, 'admin_forbidden');

  const proxied = S.adminAccessDecision({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.5' } }, { proxyKey: '', allowRemote: false });
  assert.equal(proxied.allowed, false);
  const forwarded = S.adminAccessDecision({ remoteAddress: '::1', headers: { forwarded: 'for=203.0.113.5' } }, { proxyKey: '', allowRemote: false });
  assert.equal(forwarded.allowed, false);

  assert.equal(S.adminAccessDecision({ remoteAddress: '127.0.0.1', headers: {} }, { proxyKey: '', allowRemote: false }).allowed, true);
  assert.equal(S.adminAccessDecision({ remoteAddress: '::ffff:127.0.0.1', headers: {} }, { proxyKey: '', allowRemote: false }).allowed, true);
  assert.equal(S.adminAccessDecision({ remoteAddress: '203.0.113.5', headers: {} }, { proxyKey: '', allowRemote: true }).allowed, true);
  assert.equal(S.adminAccessDecision({ remoteAddress: '203.0.113.5', headers: {} }, { proxyKey: 'secret', allowRemote: false }).allowed, true);
});

test('adminAccessDecision: a keyless admin API rejects other browser origins, rebinding hosts, and X-Real-IP', () => {
  const opts = { proxyKey: '', allowRemote: false };
  const local = (headers) => S.adminAccessDecision({ remoteAddress: '127.0.0.1', headers }, opts);

  // The dashboard served by the proxy itself: same-origin POST.
  assert.equal(local({ host: '127.0.0.1:9655', origin: 'http://127.0.0.1:9655' }).allowed, true);
  assert.equal(local({ host: 'localhost:9655', origin: 'http://localhost:9655' }).allowed, true);
  assert.equal(local({ host: '[::1]:9655' }).allowed, true);
  // curl / scripts send no Origin.
  assert.equal(local({ host: '127.0.0.1:9655' }).allowed, true);

  // Another local web app (CSRF from a loopback dev server).
  const csrf = local({ host: '127.0.0.1:9655', origin: 'http://localhost:3000' });
  assert.equal(csrf.allowed, false);
  assert.equal(csrf.status, 403);
  assert.equal(csrf.error.type, 'admin_forbidden');
  assert.equal(local({ host: '127.0.0.1:9655', origin: 'null' }).allowed, false);

  // DNS rebinding: loopback socket, foreign Host, no Origin on a same-origin GET.
  const rebound = local({ host: 'evil.example:9655' });
  assert.equal(rebound.allowed, false);
  assert.equal(rebound.error.type, 'admin_forbidden');

  // A local reverse proxy that only sets X-Real-IP is not a local client.
  assert.equal(local({ host: '127.0.0.1:9655', 'x-real-ip': '203.0.113.5' }).allowed, false);

  // With a key the bearer gate is the protection instead.
  assert.equal(S.adminAccessDecision({ remoteAddress: '127.0.0.1', headers: { host: 'proxy.example', origin: 'https://dash.example' } }, { proxyKey: 'secret', allowRemote: false }).allowed, true);
});

test('adminAccessDecision: PROXY_ADMIN_ALLOW_REMOTE without a key only lifts the client address rule', () => {
  const opts = { proxyKey: '', allowRemote: true, corsOrigins: new Set(['https://proxy.lan:9655']) };
  const remote = (headers) => S.adminAccessDecision({ remoteAddress: '192.168.1.30', headers }, opts);

  // A LAN client using the proxy's IP, from the dashboard or curl.
  assert.equal(remote({ host: '192.168.1.20:9655', origin: 'http://192.168.1.20:9655' }).allowed, true);
  assert.equal(remote({ host: '192.168.1.20:9655' }).allowed, true);
  assert.equal(remote({ host: '[fd00::20]:9655' }).allowed, true);
  assert.equal(remote({ host: 'localhost:9655' }).allowed, true);
  // A hostname the operator listed in PROXY_CORS_ORIGINS.
  assert.equal(remote({ host: 'proxy.lan:9655', origin: 'https://proxy.lan:9655' }).allowed, true);
  // Relayed by a reverse proxy: the address rule is lifted, so this is allowed.
  assert.equal(remote({ host: '192.168.1.20:9655', 'x-forwarded-for': '203.0.113.5' }).allowed, true);

  // DNS rebinding: an unlisted hostname pointing at the proxy.
  const rebound = remote({ host: 'evil.example:9655' });
  assert.equal(rebound.allowed, false);
  assert.equal(rebound.status, 403);
  assert.equal(rebound.error.type, 'admin_forbidden');
  assert.equal(remote({ host: 'evil.example:9655', origin: 'http://evil.example:9655' }).allowed, false);

  // CSRF: a browser page from another origin.
  const csrf = remote({ host: '192.168.1.20:9655', origin: 'http://localhost:3000' });
  assert.equal(csrf.allowed, false);
  assert.equal(csrf.error.type, 'admin_forbidden');
  assert.equal(remote({ host: '192.168.1.20:9655', origin: 'null' }).allowed, false);
});

test('a keyless admin POST from another loopback origin is refused over HTTP', async (t) => {
  const A = acct('A');
  useAccounts(t, [A]);
  const port = await startServer(t);
  const res = await request(port, 'POST', '/admin/accounts/A/disable', {
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error.type, 'admin_forbidden');
  assert.notEqual(A.adminDisabled, true);

  const own = await request(port, 'POST', '/admin/accounts/A/disable', {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(own.status, 200, own.text);
  assert.equal(A.adminDisabled, true);
});

function adminFixture(t) {
  const holder = { id: 'busy-holder', agentId: 'agent-busy' };
  const list = [
    acct('ready'),
    acct('cooling', {
      cooldownUntil: Date.now() + 120_000,
      cooldownReason: 'rate_limit',
      failures: 2,
      totalFailures: 7,
      lastError: { kind: 'rate_limit', status: 200, message: RATE_TEXT, at: Date.now() - 1000 },
    }),
    acct('filedis', { config: { token: 'tok-filedis-SECRET', cookie: 'ck=CK-filedis-SECRET', enabled: false } }),
    acct('admindis', { adminDisabled: true }),
    acct('busy'),
    acct('nocreds', { config: { token: '', cookie: '' } }),
  ];
  useAccounts(t, list);
  t.after(() => S.releaseAccountChatLock(holder));
  return { list, holder };
}

const ACCOUNT_VIEW_KEYS = [
  'busy', 'busy_agent', 'busy_since', 'cooldown_reason', 'cooldown_remaining_sec', 'cooldown_until',
  'credentials', 'disabled_by', 'email', 'enabled', 'failures', 'id', 'last_error', 'last_success_at',
  'last_used_at', 'name', 'status', 'total_failures', 'usage',
].sort();

test('GET /admin/accounts reports every account state without leaking credentials or file paths', async (t) => {
  const { list, holder } = adminFixture(t);
  await S.acquireAccountChatLock(list.find(a => a.id === 'busy'), holder);
  const port = await startServer(t);

  const res = await request(port, 'GET', '/admin/accounts');

  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(typeof res.json.now, 'number');
  const byId = Object.fromEntries(res.json.accounts.map(a => [a.id, a]));
  for (const view of res.json.accounts) assert.deepEqual(Object.keys(view).sort(), ACCOUNT_VIEW_KEYS);

  assert.equal(byId.ready.status, 'ready');
  assert.equal(byId.ready.enabled, true);
  assert.equal(byId.ready.disabled_by, null);
  assert.deepEqual(byId.ready.credentials, { token: true, cookie_count: 2 });
  assert.equal(byId.ready.cooldown_until, null);
  assert.equal(byId.ready.cooldown_reason, null);
  assert.equal(byId.ready.last_error, null);
  assert.deepEqual(byId.ready.usage, { requests: 0, prompt_tokens: 0, completion_tokens: 0, usd: 0 });

  assert.equal(byId.cooling.status, 'cooldown');
  assert.equal(byId.cooling.cooldown_reason, 'rate_limit');
  assert.equal(byId.cooling.cooldown_until, list[1].cooldownUntil);
  assert.ok(byId.cooling.cooldown_remaining_sec > 100);
  assert.equal(byId.cooling.failures, 2);
  assert.equal(byId.cooling.total_failures, 7);
  assert.equal(byId.cooling.last_error.kind, 'rate_limit');
  assert.equal(byId.cooling.last_error.message, RATE_TEXT);

  assert.equal(byId.filedis.status, 'disabled');
  assert.equal(byId.filedis.disabled_by, 'file');
  assert.equal(byId.filedis.enabled, false);
  assert.equal(byId.admindis.status, 'disabled');
  assert.equal(byId.admindis.disabled_by, 'admin');
  assert.equal(byId.busy.status, 'busy');
  assert.equal(byId.busy.busy, true);
  assert.equal(byId.busy.busy_agent, 'agent-busy');
  assert.equal(typeof byId.busy.busy_since, 'number');
  assert.equal(byId.nocreds.status, 'no_credentials');
  assert.deepEqual(byId.nocreds.credentials, { token: false, cookie_count: 0 });

  assert.deepEqual(res.json.pool, {
    total: 6, ready: 1, busy: 1, cooldown: 1, disabled: 2, no_credentials: 1, can_serve: 2,
    next_ready_at: list[1].cooldownUntil,
    next_ready_in_sec: res.json.pool.next_ready_in_sec,
  });
  assert.ok(res.json.pool.next_ready_in_sec > 100);

  assert.doesNotMatch(res.text, /SECRET/);
  assert.doesNotMatch(res.text, /\.json/);
  assert.doesNotMatch(res.text, /fdsapi-secret-dir/);
  assert.doesNotMatch(res.text, /\/tmp\//);
});

test('admin disable, enable, and clear-cooldown change runtime state with precise errors', async (t) => {
  const { list } = adminFixture(t);
  const ready = list.find(a => a.id === 'ready');
  const cooling = list.find(a => a.id === 'cooling');
  const port = await startServer(t);

  let res = await request(port, 'POST', '/admin/accounts/ready/disable');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.account.status, 'disabled');
  assert.equal(res.json.account.disabled_by, 'admin');
  assert.equal(res.json.pool.disabled, 3, 'file-disabled, admin-disabled, and the newly disabled login');
  assert.equal(S.accountCanServe(ready), false);
  res = await request(port, 'POST', '/admin/accounts/ready/disable');
  assert.equal(res.status, 200, 'disable is idempotent');

  res = await request(port, 'POST', '/admin/accounts/ready/enable');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.status, 'ready');
  assert.equal(S.accountCanServe(ready), true);

  res = await request(port, 'POST', '/admin/accounts/filedis/enable');
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'disabled_in_file');

  res = await request(port, 'POST', '/admin/accounts/missing/disable');
  assert.equal(res.status, 404, res.text);
  assert.equal(res.json.error.type, 'account_not_found');

  res = await request(port, 'POST', '/admin/accounts/cooling/clear-cooldown');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.status, 'ready');
  assert.equal(res.json.account.cooldown_until, null);
  assert.equal(res.json.account.failures, 2, 'failure counters are kept');
  assert.equal(res.json.account.last_error.kind, 'rate_limit', 'last error is kept');
  assert.equal(S.accountCanServe(cooling), true);

  res = await request(port, 'GET', '/admin/accounts/ready/disable');
  assert.equal(res.status, 405, res.text);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(res.json.error.type, 'method_not_allowed');

  res = await request(port, 'POST', '/admin/accounts');
  assert.equal(res.status, 405, res.text);
  assert.equal(res.headers.allow, 'GET');

  res = await request(port, 'GET', '/admin/unknown');
  assert.equal(res.status, 404, res.text);
  assert.equal(res.json.error.type, 'not_found');
});

test('POST /admin/accounts/reload re-reads auth files and keeps runtime state of kept logins', async (t) => {
  useAccounts(t, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-reload-'));
  const previousDir = process.env.DEEPSEEK_AUTH_DIR;
  process.env.DEEPSEEK_AUTH_DIR = dir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.DEEPSEEK_AUTH_DIR;
    else process.env.DEEPSEEK_AUTH_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('a.json', { token: 'tok-a', cookie: 'ck=a' });
  write('b.json', { token: 'tok-b', cookie: 'ck=b' });
  const port = await startServer(t);

  let res = await request(port, 'POST', '/admin/accounts/reload');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.added, ['a', 'b']);
  assert.deepEqual(res.json.removed, []);
  assert.equal(res.json.pool.total, 2);
  assert.deepEqual(S.accounts.map(a => a.id), ['a', 'b']);

  const a = S.accounts.find(x => x.id === 'a');
  const aCooldown = Date.now() + 300_000;
  a.cooldownUntil = aCooldown;
  a.cooldownReason = 'rate_limit';
  write('c.json', { token: 'tok-c', cookie: 'ck=c' });
  write('bad.json', '{"token":"tok-LEAK-in-broken-json", ');

  res = await request(port, 'POST', '/admin/accounts/reload');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.added, ['c']);
  assert.deepEqual(res.json.removed, []);
  assert.deepEqual(res.json.kept.sort(), ['a', 'b']);
  assert.equal(res.json.errors.length, 1);
  assert.equal(res.json.errors[0].file, 'bad.json');
  assert.equal(typeof res.json.errors[0].message, 'string');
  assert.doesNotMatch(res.text, /tok-LEAK/);
  assert.equal(res.text.includes(dir), false, 'response must not expose the auth directory');
  assert.equal(S.accounts.find(x => x.id === 'a').cooldownUntil, aCooldown, 'kept login keeps its cooldown');

  fs.unlinkSync(path.join(dir, 'b.json'));
  fs.unlinkSync(path.join(dir, 'bad.json'));
  res = await request(port, 'POST', '/admin/accounts/reload');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.removed, ['b']);
  assert.deepEqual(S.accounts.map(x => x.id).sort(), ['a', 'c']);
  assert.equal(S.accounts.find(x => x.id === 'a').cooldownUntil, aCooldown);

  const pinned = seedStickySession(t, 'reload-pinned-a', 'a', 'chat-of-old-login');
  write('a.json', { token: 'tok-a-fresh-login', cookie: 'ck=a2' });
  res = await request(port, 'POST', '/admin/accounts/reload');
  assert.equal(res.status, 200, res.text);
  const reloadedA = S.accounts.find(x => x.id === 'a');
  assert.equal(reloadedA.cooldownUntil, 0, 'a new login clears the cooldown');
  assert.equal(reloadedA.config.token, 'tok-a-fresh-login');
  assert.equal(reloadedA.headers.Authorization, 'Bearer tok-a-fresh-login');
  assert.equal(pinned.id, null, 'a chat created by the old login is not reused by the new one');
  assert.equal(pinned.accountId, 'a');

  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  res = await request(port, 'POST', '/admin/accounts/reload');
  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.error.type, 'no_accounts_found');
  assert.deepEqual(S.accounts.map(x => x.id).sort(), ['a', 'c'], 'failed reload leaves the pool unchanged');
});

// ---------------------------------------------------------------------------
// Dashboard static route
// ---------------------------------------------------------------------------

test('GET /dashboard serves a whitelisted page with a strict CSP and nothing else', async (t) => {
  const port = await startServer(t);

  const page = await request(port, 'GET', '/dashboard');
  assert.equal(page.status, 200, page.text);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');

  const script = await request(port, 'GET', '/dashboard/app.js');
  assert.equal(script.status, 200, script.text);
  assert.match(script.headers['content-type'], /javascript/);

  const style = await request(port, 'GET', '/dashboard/app.css');
  assert.equal(style.status, 200, style.text);
  assert.match(style.headers['content-type'], /^text\/css/);

  assert.equal((await request(port, 'GET', '/dashboard/../server.js')).status, 404);
  assert.equal((await request(port, 'GET', '/dashboard/%2e%2e/server.js')).status, 404);
  assert.equal((await request(port, 'GET', '/dashboard/x')).status, 404);
});

// ---------------------------------------------------------------------------
// Dashboard data: request log, usage aggregates, account file management
// ---------------------------------------------------------------------------

function freshRequestStats(t) {
  S.clearRequestStats();
  t.after(() => S.clearRequestStats());
}
function forgetAgents(t, ...agents) {
  t.after(() => { for (const agent of agents) S.sessions.delete(agent); });
}

const REQUEST_VIEW_KEYS = [
  'account', 'agent', 'api', 'completion_tokens', 'error_message', 'error_type', 'id', 'ip', 'local',
  'model', 'ms', 'ok', 'path', 'prompt_tokens', 'reasoning_tokens', 'status', 'stream', 'ts', 'usd',
].sort();

test('GET /admin/requests lists request metadata newest first, never prompt or answer text', async (t) => {
  freshRequestStats(t);
  useAccounts(t, [acct('ready')]);
  installUpstream(t, { completion: { ready: [() => sse(okSse('ANSWER_PRIVATE_TEXT'))] } });
  forgetAgents(t, 'dashboard:log-1', 'dashboard:log-2', 'dashboard:log-3');
  const port = await startServer(t);

  let res = await chat(port, 'dashboard:log-1', [{ role: 'user', content: 'PROMPT_PRIVATE_TEXT' }]);
  assert.equal(res.status, 200, res.text);
  res = await chat(port, 'dashboard:log-2', [{ role: 'user', content: 'hi' }], { model: 'no-such-model' });
  assert.equal(res.status, 400, res.text);
  res = await request(port, 'POST', '/v1/messages', {
    body: { model: 'deepseek-v4-flash', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'PROMPT_PRIVATE_TEXT 2' }] },
    headers: { 'x-agent-session': 'dashboard:log-3' },
  });
  assert.equal(res.status, 200, res.text);

  res = await request(port, 'GET', '/admin/requests');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(typeof res.json.now, 'number');
  assert.equal(res.json.capacity, 400);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.matched, 3);
  const rows = res.json.requests;
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), REQUEST_VIEW_KEYS);
  assert.ok(rows[0].id > rows[1].id && rows[1].id > rows[2].id, 'newest first, ids increase');

  const [anthropic, invalid, openai] = rows;
  assert.equal(openai.path, '/v1/chat/completions');
  assert.equal(openai.api, 'openai');
  assert.equal(openai.stream, false);
  assert.equal(openai.status, 200);
  assert.equal(openai.ok, true);
  assert.equal(openai.local, false);
  assert.equal(openai.account, 'ready');
  assert.equal(openai.agent, 'dashboard:log-1');
  assert.equal(openai.model, 'deepseek-v4-flash');
  assert.ok(openai.prompt_tokens > 0 && openai.completion_tokens > 0);
  assert.equal(openai.reasoning_tokens, 0);
  assert.ok(openai.usd > 0);
  assert.equal(openai.error_type, null);
  assert.equal(openai.error_message, null);

  assert.equal(invalid.status, 400);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error_type, 'invalid_model');
  assert.match(invalid.error_message, /no-such-model/);
  assert.equal(invalid.account, null);

  assert.equal(anthropic.api, 'anthropic');
  assert.equal(anthropic.path, '/v1/messages');
  assert.equal(anthropic.stream, true);
  assert.equal(anthropic.ok, true);

  assert.doesNotMatch(res.text, /PRIVATE_TEXT/, 'the log never carries message content');
  assert.doesNotMatch(res.text, /SECRET/);
});

test('GET /admin/requests filters, pages, and rejects bad queries precisely', async (t) => {
  freshRequestStats(t);
  const now = Date.now();
  const base = { ip: '127.0.0.1', path: '/v1/chat/completions', prompt_tokens: 10, completion_tokens: 5, usd: 0.001, ms: 900 };
  S.recordRequest({ ...base, ts: now - 4000, status: 200, ok: true, agent: 'a1', account: 'acc1', model: 'deepseek-v4-flash' });
  S.recordRequest({ ...base, ts: now - 3000, status: 429, ok: false, agent: 'a2', account: 'acc2', model: 'deepseek-v4-flash-thinking', error_type: 'rate_limit', error_message: 'All accounts are cooling down' });
  S.recordRequest({ ...base, ts: now - 2000, status: 200, ok: true, agent: 'a1', account: 'acc2', model: 'deepseek-v4-flash', path: '/v1/messages', api: 'anthropic' });
  S.recordRequest({ ...base, ts: now - 1000, status: 500, ok: false, agent: 'a3', account: 'acc1', model: 'deepseek-v4-flash', error_type: 'server_error', error_message: 'boom' });
  const port = await startServer(t);

  const ids = async (query) => {
    const res = await request(port, 'GET', `/admin/requests${query}`);
    assert.equal(res.status, 200, res.text);
    return res.json.requests.map(r => r.agent + ':' + r.status);
  };
  assert.deepEqual(await ids('?status=error'), ['a3:500', 'a2:429']);
  assert.deepEqual(await ids('?status=ok'), ['a1:200', 'a1:200']);
  assert.deepEqual(await ids('?status=429'), ['a2:429']);
  assert.deepEqual(await ids('?account=acc2'), ['a1:200', 'a2:429']);
  assert.deepEqual(await ids('?model=deepseek-v4-flash-thinking'), ['a2:429']);
  assert.deepEqual(await ids('?api=anthropic'), ['a1:200']);
  assert.deepEqual(await ids('?agent=a1'), ['a1:200', 'a1:200']);
  assert.deepEqual(await ids('?limit=2'), ['a3:500', 'a1:200']);

  const all = (await request(port, 'GET', '/admin/requests')).json.requests;
  assert.equal(all[0].api, 'openai', 'rows without api derive it from the path');
  const page = await request(port, 'GET', `/admin/requests?before_id=${all[1].id}&limit=10`);
  assert.deepEqual(page.json.requests.map(r => r.id), [all[2].id, all[3].id]);
  assert.equal(page.json.matched, 2);

  for (const bad of ['?limit=0', '?limit=401', '?limit=abc', '?status=maybe', '?before_id=x', '?api=grpc']) {
    const res = await request(port, 'GET', `/admin/requests${bad}`);
    assert.equal(res.status, 400, `${bad}: ${res.text}`);
    assert.equal(res.json.error.type, 'invalid_query');
  }
  assert.equal((await request(port, 'POST', '/admin/requests')).status, 405);
});

test('the request log is capped at 400 rows and error text is scrubbed of credentials', async (t) => {
  freshRequestStats(t);
  useAccounts(t, [acct('ready')]);
  for (let i = 0; i < 405; i++) {
    S.recordRequest({ ts: Date.now(), ip: '127.0.0.1', path: '/v1/chat/completions', status: 200, ok: true, prompt_tokens: 1, completion_tokens: 1, usd: 0, ms: 1, agent: `bulk-${i}`, account: null, model: 'deepseek-v4-flash' });
  }
  S.recordRequest({
    ts: Date.now(), ip: '127.0.0.1', path: '/v1/chat/completions', status: 502, ok: false, prompt_tokens: 0, completion_tokens: 0, usd: 0, ms: 1,
    agent: 'leaky', account: 'ready', model: 'deepseek-v4-flash', error_type: 'server_error',
    error_message: `upstream said Authorization: Bearer tok-ready-SECRET and cookie CK-ready-SECRET ${'x'.repeat(1000)}`,
  });
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/requests?limit=400');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.total, 400);
  assert.equal(res.json.requests.length, 400);
  assert.equal(res.json.requests[0].agent, 'leaky');
  assert.equal(res.json.requests.at(-1).agent, 'bulk-6', 'the oldest rows are dropped first');
  assert.doesNotMatch(res.text, /SECRET/);
  assert.match(res.json.requests[0].error_message, /\[redacted\]/);
  assert.ok(res.json.requests[0].error_message.length <= 300, 'error text is clipped');
});

test('GET /admin/usage aggregates estimated tokens by account, model, endpoint, agent, and time', async (t) => {
  freshRequestStats(t);
  const now = Date.now();
  const row = (ago, extra) => ({ ts: now - ago, ip: '127.0.0.1', path: '/v1/chat/completions', status: 200, ok: true, prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, usd: 0.0001, ms: 1000, agent: 'cli', account: 'acc1', model: 'deepseek-v4-flash', ...extra });
  S.recordRequest(row(10 * 60_000));
  S.recordRequest(row(20 * 60_000, { account: 'acc2', model: 'deepseek-v4-flash-thinking', reasoning_tokens: 20, agent: 'dashboard:c1' }));
  S.recordRequest(row(30 * 60_000, { ok: false, status: 429, prompt_tokens: 0, completion_tokens: 0, usd: 0, account: null, error_type: 'rate_limit' }));
  S.recordRequest(row(2 * 3600_000, { path: '/v1/messages', api: 'anthropic' }));
  S.recordRequest(row(30 * 3600_000, { account: 'acc2' }));
  const port = await startServer(t);

  let res = await request(port, 'GET', '/admin/usage?window=1h');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  const hour = res.json;
  assert.equal(hour.estimated, true);
  assert.deepEqual(hour.pricing, { input_per_m: 0.22, output_per_m: 0.66, currency: 'USD' });
  assert.equal(hour.window.key, '1h');
  assert.equal(hour.bucket.key, '1m');
  assert.equal(hour.series.length, 60);
  assert.deepEqual(
    { requests: hour.totals.requests, errors: hour.totals.errors, prompt_tokens: hour.totals.prompt_tokens, completion_tokens: hour.totals.completion_tokens, reasoning_tokens: hour.totals.reasoning_tokens },
    { requests: 3, errors: 1, prompt_tokens: 200, completion_tokens: 100, reasoning_tokens: 20 },
  );
  assert.equal(hour.totals.avg_ms, 1000);
  const seriesSum = hour.series.reduce((sum, b) => sum + b.requests, 0);
  assert.equal(seriesSum, 3);
  assert.ok(hour.series.every((b, i, a) => i === 0 || b.t - a[i - 1].t === 60_000), 'dense, evenly spaced buckets');
  const byKey = (list) => Object.fromEntries(list.map(e => [e.key === null ? '(none)' : e.key, e]));
  const accounts = byKey(hour.by_account);
  assert.equal(accounts.acc1.requests, 1);
  assert.equal(accounts.acc2.requests, 1);
  assert.equal(accounts['(none)'].errors, 1);
  assert.equal(byKey(hour.by_model)['deepseek-v4-flash'].requests, 2);
  assert.equal(byKey(hour.by_model)['deepseek-v4-flash-thinking'].reasoning_tokens, 20);
  assert.equal(byKey(hour.by_endpoint)['/v1/chat/completions'].requests, 3);
  assert.equal(byKey(hour.by_agent)['dashboard:c1'].prompt_tokens, 100);
  assert.deepEqual(hour.by_model.map(e => e.requests), [2, 1], 'breakdowns sort by requests, descending');

  res = await request(port, 'GET', '/admin/usage?window=24h');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.bucket.key, '15m');
  assert.equal(res.json.series.length, 96);
  assert.equal(res.json.totals.requests, 4, 'the 30h-old row is outside the 24h window');
  assert.equal(byKey(res.json.by_endpoint)['/v1/messages'].requests, 1);

  assert.equal(res.json.lifetime.requests, 5);
  assert.equal(typeof res.json.lifetime.since, 'number');
  assert.equal(byKey(res.json.lifetime.by_account).acc2.requests, 2, 'lifetime per-account totals include old rows');

  res = await request(port, 'GET', '/admin/usage?window=6h&bucket=1h');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.series.length, 6);

  for (const bad of ['?window=7d', '?bucket=2m', '?window=15m&bucket=1h']) {
    const r = await request(port, 'GET', `/admin/usage${bad}`);
    assert.equal(r.status, 400, `${bad}: ${r.text}`);
    assert.equal(r.json.error.type, 'invalid_query');
  }
});

function useAuthDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-manage-'));
  const previousDir = process.env.DEEPSEEK_AUTH_DIR;
  process.env.DEEPSEEK_AUTH_DIR = dir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.DEEPSEEK_AUTH_DIR;
    else process.env.DEEPSEEK_AUTH_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function rawRequest(port, method, pathName, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (e) { /* */ } resolve({ status: res.statusCode, text: data, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST /admin/accounts/import writes a 0600 auth file into the accounts dir and loads it', async (t) => {
  useAccounts(t, []);
  const dir = useAuthDir(t);
  fs.writeFileSync(path.join(dir, 'first.json'), JSON.stringify({ token: 'tok-first-SECRET', cookie: 'a=1' }));
  const port = await startServer(t);
  assert.equal((await request(port, 'POST', '/admin/accounts/reload')).status, 200);

  const exported = { token: 'tok-new-SECRET', hif_dliq: 'HD-SECRET', hif_leim: 'HL-SECRET', cookie: 'ds_session_id=CK-new-SECRET; smidV2=x', wasmUrl: 'https://fe-static.deepseek.com/chat/static/x.wasm' };
  let res = await request(port, 'POST', '/admin/accounts/import', { body: { name: 'Work Main', auth: exported } });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.account.id, 'work-main');
  assert.equal(res.json.account.name, 'Work Main');
  assert.equal(res.json.account.status, 'ready');
  assert.deepEqual(res.json.added, ['work-main']);
  assert.equal(res.json.pool.total, 2);
  assert.doesNotMatch(res.text, /SECRET/);
  assert.equal(res.text.includes(dir), false);
  const file = path.join(dir, 'work-main.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.token, 'tok-new-SECRET');
  assert.equal(written.cookie, exported.cookie);
  assert.equal(written.hif_dliq, 'HD-SECRET');
  assert.equal(written.name, 'Work Main');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(S.accounts.map(a => a.id).sort(), ['first', 'work-main']);

  res = await request(port, 'POST', '/admin/accounts/import', { body: { name: 'Work Main', auth: { token: 'tok-other', cookie: 'b=2' } } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'account_exists');

  res = await request(port, 'POST', '/admin/accounts/import', { body: { name: 'Again', auth: exported } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'duplicate_account');
  assert.equal(res.json.error.account, 'work-main');

  res = await request(port, 'POST', '/admin/accounts/import', { body: { name: 'No Cookie', auth: { token: 'tok-x' } } });
  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.error.type, 'invalid_auth');
  assert.deepEqual(res.json.error.errors, ['cookie missing']);

  for (const body of [{ auth: exported }, { name: '   ', auth: exported }, { name: 'x'.repeat(65), auth: exported }, { name: 'ok', auth: 'string' }]) {
    res = await request(port, 'POST', '/admin/accounts/import', { body });
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.type, 'invalid_request');
  }

  res = await rawRequest(port, 'POST', '/admin/accounts/import', '{"name":');
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.type, 'invalid_json');

  res = await rawRequest(port, 'POST', '/admin/accounts/import', JSON.stringify({ name: 'big', auth: { token: 't', cookie: 'c'.repeat(70 * 1024) } }));
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error.type, 'payload_too_large');

  assert.equal((await request(port, 'GET', '/admin/accounts/import')).status, 405);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['first.json', 'work-main.json'], 'failed imports write nothing');
});

test('POST /admin/accounts/import refuses when auth files come from an explicit path list', async (t) => {
  useAccounts(t, [acct('ready')]);
  const previousDir = process.env.DEEPSEEK_AUTH_DIR;
  const previousPath = process.env.DEEPSEEK_AUTH_PATH;
  delete process.env.DEEPSEEK_AUTH_DIR;
  process.env.DEEPSEEK_AUTH_PATH = '/nonexistent/a.json,/nonexistent/b.json';
  t.after(() => {
    if (previousDir === undefined) delete process.env.DEEPSEEK_AUTH_DIR; else process.env.DEEPSEEK_AUTH_DIR = previousDir;
    if (previousPath === undefined) delete process.env.DEEPSEEK_AUTH_PATH; else process.env.DEEPSEEK_AUTH_PATH = previousPath;
  });
  const port = await startServer(t);
  const res = await request(port, 'POST', '/admin/accounts/import', { body: { name: 'x', auth: { token: 't', cookie: 'c=1' } } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'import_unsupported');
  assert.doesNotMatch(res.text, /nonexistent/);
});

test('PATCH /admin/accounts/:id renames and persists enabled in the auth file', async (t) => {
  useAccounts(t, []);
  const dir = useAuthDir(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ token: 'tok-a-SECRET', cookie: 'a=1' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ token: 'tok-b-SECRET', cookie: 'b=1' }), { mode: 0o600 });
  const port = await startServer(t);
  assert.equal((await request(port, 'POST', '/admin/accounts/reload')).status, 200);

  let res = await request(port, 'PATCH', '/admin/accounts/a', { body: { name: 'Personal', enabled: false } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.id, 'a');
  assert.equal(res.json.account.name, 'Personal');
  assert.equal(res.json.account.status, 'disabled');
  assert.equal(res.json.account.disabled_by, 'file');
  assert.doesNotMatch(res.text, /SECRET/);
  let onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  assert.deepEqual(onDisk, { token: 'tok-a-SECRET', cookie: 'a=1', name: 'Personal', enabled: false });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'a.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json'], 'no temp files left behind');

  S.accounts.find(a => a.id === 'a').adminDisabled = true;
  res = await request(port, 'PATCH', '/admin/accounts/a', { body: { enabled: true } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.account.status, 'ready', 'persistent enable also lifts the runtime pause');
  onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
  assert.equal('enabled' in onDisk, false);
  assert.equal(onDisk.name, 'Personal');

  for (const body of [{}, { enabled: 'no' }, { name: '' }, { token: 'x' }]) {
    res = await request(port, 'PATCH', '/admin/accounts/a', { body });
    assert.equal(res.status, 422, `${JSON.stringify(body)}: ${res.text}`);
    assert.equal(res.json.error.type, 'invalid_request');
  }
  res = await request(port, 'PATCH', '/admin/accounts/missing', { body: { name: 'x' } });
  assert.equal(res.status, 404, res.text);
  assert.equal(res.json.error.type, 'account_not_found');
});

test('DELETE /admin/accounts/:id archives the auth file out of the pool', async (t) => {
  useAccounts(t, []);
  const dir = useAuthDir(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ token: 'tok-a-SECRET', cookie: 'a=1' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ token: 'tok-b-SECRET', cookie: 'b=1' }));
  const port = await startServer(t);
  assert.equal((await request(port, 'POST', '/admin/accounts/reload')).status, 200);

  let res = await request(port, 'DELETE', '/admin/accounts/a');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.removed, ['a']);
  assert.match(res.json.archived_as, /^a\.json\.removed-\d+$/);
  assert.deepEqual(res.json.accounts.map(a => a.id), ['b']);
  assert.equal(res.json.pool.total, 1);
  assert.doesNotMatch(res.text, /SECRET/);
  assert.equal(res.text.includes(dir), false);
  assert.deepEqual(S.accounts.map(a => a.id), ['b']);
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2);
  assert.ok(files.includes('b.json'));
  assert.ok(files.includes(res.json.archived_as), 'credentials are archived, not destroyed');

  res = await request(port, 'DELETE', '/admin/accounts/b');
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'last_account');
  assert.ok(fs.existsSync(path.join(dir, 'b.json')));

  res = await request(port, 'DELETE', '/admin/accounts/missing');
  assert.equal(res.status, 404, res.text);
});

test('POST /admin/accounts/restore brings an archived auth file back into the pool', async (t) => {
  useAccounts(t, []);
  const dir = useAuthDir(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ token: 'tok-a-SECRET', cookie: 'a=1' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ token: 'tok-b-SECRET', cookie: 'b=1' }));
  const port = await startServer(t);
  assert.equal((await request(port, 'POST', '/admin/accounts/reload')).status, 200);
  const removed = await request(port, 'DELETE', '/admin/accounts/a');
  assert.equal(removed.status, 200, removed.text);

  let res = await request(port, 'POST', '/admin/accounts/restore', { body: { archived_as: removed.json.archived_as } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.restored, ['a']);
  assert.deepEqual(res.json.accounts.map(a => a.id).sort(), ['a', 'b']);
  assert.deepEqual(S.accounts.map(a => a.id).sort(), ['a', 'b']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json']);
  assert.doesNotMatch(res.text, /SECRET/);
  assert.equal(res.text.includes(dir), false);

  res = await request(port, 'POST', '/admin/accounts/restore', { body: { archived_as: removed.json.archived_as } });
  assert.equal(res.status, 404, res.text);
  assert.equal(res.json.error.type, 'archive_not_found');

  for (const archived_as of ['../a.json.removed-1', 'a.json', 'sub/a.json.removed-1', '', 7]) {
    res = await request(port, 'POST', '/admin/accounts/restore', { body: { archived_as } });
    assert.equal(res.status, 422, `${JSON.stringify(archived_as)}: ${res.text}`);
    assert.equal(res.json.error.type, 'invalid_request');
  }

  const second = await request(port, 'DELETE', '/admin/accounts/a');
  assert.equal(second.status, 200, second.text);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ token: 'tok-new-SECRET', cookie: 'n=1' }));
  res = await request(port, 'POST', '/admin/accounts/restore', { body: { archived_as: second.json.archived_as } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'restore_target_exists');
  assert.ok(fs.existsSync(path.join(dir, second.json.archived_as)), 'archive is left in place on conflict');
  assert.equal((await request(port, 'GET', '/admin/accounts/restore')).status, 405);
});

test('DELETE /admin/accounts/:id refuses accounts loaded from outside the managed accounts dir', async (t) => {
  useAccounts(t, [acct('outside'), acct('other')]);
  useAuthDir(t);
  const port = await startServer(t);
  const res = await request(port, 'DELETE', '/admin/accounts/outside');
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error.type, 'account_file_protected');
  assert.doesNotMatch(res.text, /fdsapi-secret-dir/);
  assert.equal(S.accounts.length, 2);
});

test('new admin routes keep the keyless CSRF / rebinding gate', async (t) => {
  freshRequestStats(t);
  const port = await startServer(t);
  for (const [method, p] of [['GET', '/admin/requests'], ['GET', '/admin/usage'], ['POST', '/admin/accounts/import'], ['DELETE', '/admin/accounts/x'], ['PATCH', '/admin/accounts/x'], ['POST', '/admin/accounts/restore']]) {
    const res = await request(port, method, p, { headers: { origin: 'http://localhost:1' }, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${p}: ${res.text}`);
    assert.equal(res.json.error.type, 'admin_forbidden');
  }
});

test('dashboard serves flat lowercase .js/.css/.svg assets from its folder and nothing else', async (t) => {
  const port = await startServer(t);
  for (const p of ['/dashboard/API.md', '/dashboard/DESIGN.md', '/dashboard/missing.js', '/dashboard/App.js', '/dashboard/a.b.js', '/dashboard/sub/app.js', '/dashboard/.hidden.js']) {
    const res = await request(port, 'GET', p);
    assert.equal(res.status, 404, `${p}: ${res.text}`);
  }
  const res = await request(port, 'GET', '/dashboard/app.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
});
