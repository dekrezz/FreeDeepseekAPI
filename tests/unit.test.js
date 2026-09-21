const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('auth menu has no third-party Telegram watermark and accepts --lang', () => {
  const help = runNode(['scripts/auth.js', '--help', '--lang', 'en']);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.doesNotMatch(help.stdout + help.stderr, /forgetmeai|t\.me\//i);
  assert.match(help.stdout, /FreeDeepseekAPI/);
  assert.match(help.stdout, /--lang/);

  const tui = require('../scripts/lib/tui-menu');
  assert.equal(tui.detectLocale({ LANG: 'ru_RU.UTF-8' }), 'ru');
  assert.equal(tui.detectLocale({ LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(tui.detectLocale({ FREDEEPSEEK_LANG: 'en', LANG: 'ru_RU.UTF-8' }), 'en');
  assert.equal(tui.languageFromLocale('ru-RU'), 'ru');
  assert.equal(tui.languageFromLocale('zh-Hans-CN'), 'zh');
  assert.equal(tui.languageFromLocale('en-US'), 'en');
  assert.equal(tui.t('ru', 'login'), 'Войти через Chrome');
  assert.equal(tui.cycleLang('en', 1), 'ru');
  const mouse = tui.parseSgrMouse('\x1b[<0;12;5M\x1b[<0;12;5m');
  assert.equal(mouse[0].left, true);
  assert.equal(mouse[0].x, 12);
  assert.equal(mouse[0].y, 5);
  assert.equal(tui.hitTest([{ id: 'item:0', x: 3, y: 5, w: 40, h: 1 }], 12, 5).id, 'item:0');
  assert.equal(tui.parseKey('\x1b[A'), 'up');
  assert.equal(tui.parseKey(' '), 'space');
  assert.equal(tui.parseKey('q'), 'quit');
  const mark = tui.wordmarkLines('FREEDEEP');
  assert.equal(mark.length, 5);
  assert.match(mark[0], /█/);
  assert.doesNotMatch(mark.join('\n'), /┌|│|└/);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('chrome extension manifest only declares icon files that exist', () => {
  const manifestPath = path.join(ROOT, 'chrome-extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const iconPaths = [];

  function collectIconPaths(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'icons' || key === 'default_icon') iconPaths.push(value);
      return;
    }

    if (!value || typeof value !== 'object') return;

    if ((key === 'icons' || key === 'default_icon') && !Array.isArray(value)) {
      for (const iconPath of Object.values(value)) {
        if (typeof iconPath === 'string') iconPaths.push(iconPath);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      collectIconPaths(childValue, childKey);
    }
  }

  collectIconPaths(manifest);

  for (const iconPath of iconPaths) {
    assert.equal(
      fs.existsSync(path.join(path.dirname(manifestPath), iconPath)),
      true,
      `Missing extension icon declared in manifest: ${iconPath}`,
    );
  }
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('consumed upstream HTTP errors retain status, type, and retry hints', () => {
  const limited = serverInternals.createUpstreamHttpError(429, '  Rate limited\ntry later  ', '12');
  assert.equal(limited.status, 429);
  assert.equal(limited.type, 'rate_limit_error');
  assert.equal(limited.retryAfter, '12');
  assert.match(limited.message, /Rate limited try later/);

  const unauthorized = serverInternals.createUpstreamHttpError(401, 'expired');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.type, 'authentication_error');
});

test('sweepIdleSessions evicts only idle entries', () => {
  serverInternals.sessions.set('stale-x', { lastActivityAt: 1 });
  serverInternals.sessions.set('fresh-x', { lastActivityAt: Date.now() });
  serverInternals.sweepIdleSessions(60 * 1000);
  assert.equal(serverInternals.sessions.has('stale-x'), false);
  assert.equal(serverInternals.sessions.has('fresh-x'), true);
  serverInternals.sessions.delete('fresh-x');
});

test('proxy API key authentication is optional and uses exact bearer tokens', () => {
  assert.equal(serverInternals.isProxyAuthorized(undefined, ''), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret', 'secret'), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Basic secret', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret ', 'secret'), false);
});

test('proxy API key can be loaded from a mounted secret and required explicitly', () => {
  const dir = tmpdir();
  const secretPath = path.join(dir, 'proxy-api-key');
  fs.writeFileSync(secretPath, 'mounted-secret\n');

  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: secretPath }), 'mounted-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY: 'env-secret', PROXY_API_KEY_FILE: secretPath }), 'env-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: path.join(dir, 'missing') }), '');
  assert.doesNotThrow(() => serverInternals.requireProxyApiKey('mounted-secret', true));
  assert.throws(
    () => serverInternals.requireProxyApiKey('', true),
    /PROXY_API_KEY is required/,
  );
});

test('Containerfile keeps the rootless Podman runtime minimal and fail-closed', () => {
  const containerfile = fs.readFileSync(path.join(ROOT, 'Containerfile'), 'utf8');
  const containerignore = fs.readFileSync(path.join(ROOT, '.containerignore'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const copyLines = containerfile
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('COPY '));

  assert.deepEqual(copyLines, [
    'COPY --chown=1000:1000 package.json server.js ./',
    'COPY --chown=1000:1000 lib/pow.js ./lib/pow.js',
  ]);
  assert.doesNotMatch(containerfile, /^\s*(?:COPY|ADD)\s+\.\s/m);
  assert.match(containerfile, /^USER 1000:1000$/m);
  assert.match(containerfile, /HOST=0\.0\.0\.0/);
  assert.match(containerfile, /NON_INTERACTIVE=1/);
  assert.match(containerfile, /REQUIRE_PROXY_API_KEY=1/);
  assert.match(containerfile, /PROXY_API_KEY_FILE=\/run\/secrets\/proxy-api-key/);
  assert.match(containerfile, /^HEALTHCHECK /m);
  assert.match(containerfile, /path:'\/health'/);
  assert.match(containerfile, /^CMD \["node", "server\.js"\]$/m);

  assert.match(containerignore, /^\*$/m);
  assert.doesNotMatch(containerignore, /^!.*(?:auth|secret|\.env)/mi);
  assert.match(readme, /--publish 127\.0\.0\.1:9655:9655/);
  assert.match(readme, /--secret free-deepseek-auth[^\n]*mode=0400/);
  assert.match(readme, /--secret free-deepseek-proxy-key[^\n]*mode=0400/);
  assert.match(readme, /--read-only/);
  assert.match(readme, /--cap-drop=ALL/);
  assert.match(readme, /--security-opt=no-new-privileges/);
});

test('loopback host detection covers supported local bind addresses', () => {
  assert.equal(serverInternals.isLoopbackHost('127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('::1'), true);
  assert.equal(serverInternals.isLoopbackHost('[::1]'), true);
  assert.equal(serverInternals.isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('localhost'), true);
  assert.equal(serverInternals.isLoopbackHost('0.0.0.0'), false);
});

test('browser origin guard allows local UIs and exact configured origins only', () => {
  const allowed = new Set(['https://ui.example.com', 'chrome-extension://trusted-id']);
  assert.equal(serverInternals.isBrowserOriginAllowed(undefined, allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://localhost:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://127.0.0.1:8080', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://[::1]:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://ui.example.com/path', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://trusted-id', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://evil.example', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://other-id', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('null', allowed), false);
});

test('parseToolCall converts canonical DeepSeek DSML into an OpenAI tool call', () => {
  const dsml = [
    'I will inspect it.',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '<｜DSML｜parameter name="code" string="true">print("ok")</｜DSML｜parameter>',
    '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>',
    '<｜DSML｜parameter name="capture" string="false">true</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'execute_code');
  assert.deepEqual(JSON.parse(call.arguments), {
    code: 'print("ok")',
    timeout: 30,
    capture: true,
  });
});

test('parseToolCall accepts the doubled-bar DSML Web variant from issue #19', () => {
  const dsml = [
    '<｜｜DSML｜｜ Tool Calls>',
    '<｜｜DSML｜｜ name="web_search">{"query":"DeepSeek DSML"}',
    '</｜｜DSML｜｜ Tool Calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'web_search');
  assert.deepEqual(JSON.parse(call.arguments), { query: 'DeepSeek DSML' });
});

test('issue #19 stacked native DSML is listed and never treated as a gateway tool', () => {
  const dsml = [
    '<｜｜DSML｜｜ Tool Calls> <｜｜DSML｜｜ name="execute_code">{"code":"print(1)"}',
    '<｜｜DSML｜｜ name="web_search">{"query":"Unity player controller"}',
  ].join('\n');

  assert.equal(serverInternals.looksLikeToolCallMarkup(dsml), true);
  assert.equal(serverInternals.isDeepSeekNativeTool('execute_code'), true);
  assert.equal(serverInternals.isDeepSeekNativeTool('web_search'), true);
  assert.equal(serverInternals.isDeepSeekNativeTool('write_file'), false);

  const listed = serverInternals.listDsmlToolCalls(dsml);
  assert.deepEqual(listed.map(call => call.name), ['execute_code', 'web_search']);
  assert.equal(serverInternals.selectAgentToolCall(dsml, ['write_file', 'read_file']), null);
  assert.equal(serverInternals.selectAgentToolCall(dsml, ['execute_code'])?.name, 'execute_code');
  assert.match(serverInternals.EMPTY_RESPONSE_NUDGE, /empty/);
  assert.match(serverInternals.formatToolReminder([
    { type: 'function', function: { name: 'write_file' } },
  ]), /execute_code/);
});

test('parseToolCall accepts zero-argument, CDATA, legacy, collapsed, and prefixed wrappers', () => {
  const zeroArg = serverInternals.parseToolCall(
    '<|DSML|tool_calls><|DSML|invoke name="ping"></|DSML|invoke></|DSML|tool_calls>'
  );
  assert.deepEqual(zeroArg, { name: 'ping', arguments: '{}' });

  const cdata = serverInternals.parseToolCall(
    '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>]]></parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(cdata.arguments), { content: 'line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>' });

  const collapsed = serverInternals.parseToolCall(
    '<DSMLtool_calls><DSMLinvoke name="read_file"><DSMLparameter name="path">/tmp/a</DSMLparameter></DSMLinvoke></DSMLtool_calls>'
  );
  assert.deepEqual(JSON.parse(collapsed.arguments), { path: '/tmp/a' });

  const prefixed = serverInternals.parseToolCall(
    '<abc:tool_calls><abc:invoke name="read_file"><abc:parameter name="path">/tmp/b</abc:parameter></abc:invoke></abc:tool_calls>'
  );
  assert.deepEqual(JSON.parse(prefixed.arguments), { path: '/tmp/b' });
});

test('parseToolCall normalizes fullwidth delimiters and narrowly repairs a missing opening wrapper', () => {
  const fullwidth = serverInternals.parseToolCall(
    '＜｜DSML｜Tool Calls＞＜｜DSML｜Invoke name=“read_file”＞＜｜DSML｜Parameter name=“path”＞/tmp/c＜/｜DSML｜Parameter＞＜/｜DSML｜Invoke＞＜/｜DSML｜Tool Calls＞'
  );
  assert.deepEqual(JSON.parse(fullwidth.arguments), { path: '/tmp/c' });

  const repaired = serverInternals.parseToolCall(
    '<invoke name="read_file"><parameter name="path">/tmp/d</parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(repaired.arguments), { path: '/tmp/d' });
});

test('parseToolCall rejects bare invokes and bare JSON examples', () => {
  const bareInvoke = '<|DSML|invoke name="execute_code"><|DSML|parameter name="code">danger()</|DSML|parameter></|DSML|invoke>';
  assert.equal(serverInternals.parseToolCall(bareInvoke), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(bareInvoke), true);

  const prose = 'For example return {"name":"execute_code","arguments":{"code":"danger()"}} when appropriate.';
  assert.equal(serverInternals.parseToolCall(prose), null);
  assert.equal(serverInternals.parseToolCall('```json\n{"name":"execute_code","arguments":{"code":"danger()"}}\n```'), null);
});

test('parseToolCall ignores language-tagged source fences and still accepts fenced JSON envelopes', () => {
  const csharpDump = [
    'Here is the script',
    '```csharp',
    'using UnityEngine;',
    'public class PlayerController : MonoBehaviour {',
    '    [SerializeField] float speed = 6f;',
    '    void Update() {',
    '        var input = new Vector2(Input.GetAxis("Horizontal"), Input.GetAxis("Vertical"));',
    '        transform.position += (Vector3)(input.normalized * speed * Time.deltaTime);',
    '    }',
    '}',
    '```',
  ].join('\n');
  assert.equal(serverInternals.parseToolCall(csharpDump), null);
  assert.equal(serverInternals.looksLikeCodeDumpInsteadOfTool(csharpDump), true);

  const fencedEnvelope = [
    '```json',
    '{"tool_call":{"name":"write_file","arguments":{"path":"Assets/Scripts/PlayerController.cs","content":"class X {}"}}}',
    '```',
  ].join('\n');
  const call = serverInternals.parseToolCall(fencedEnvelope);
  assert.equal(call.name, 'write_file');
  assert.deepEqual(JSON.parse(call.arguments), {
    path: 'Assets/Scripts/PlayerController.cs',
    content: 'class X {}',
  });
});

test('code-dump detector catches Hermes-style C# pastes but not ordinary answers', () => {
  const unfenced = [
    'using UnityEngine;',
    'namespace Game.Player {',
    'public class PlayerController : MonoBehaviour {',
    `    ${'void Tick() {}\n'.repeat(80)}`,
    '}',
    '}',
  ].join('\n');
  assert.equal(serverInternals.looksLikeCodeDumpInsteadOfTool(unfenced), true);
  assert.equal(serverInternals.looksLikeCodeDumpInsteadOfTool('The file is already updated. I will run tests next.'), false);
  assert.equal(serverInternals.looksLikeCodeDumpInsteadOfTool('```json\n{"ok":true}\n```'), false);
  assert.equal(serverInternals.looksLikeToolCallMarkup(unfenced), false);
});

test('parseToolCall accepts only explicit JSON envelopes with valid object arguments', () => {
  const explicit = serverInternals.parseToolCall(
    'Use this: {"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}'
  );
  assert.deepEqual(JSON.parse(explicit.arguments), { path: '/tmp/a' });

  const openai = serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [{
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/b' }) },
    }],
  }));
  assert.deepEqual(JSON.parse(openai.arguments), { path: '/tmp/b' });

  assert.equal(serverInternals.parseToolCall('{"tool_call":{"name":"read_file","arguments":"not-json"}}'), null);
  assert.equal(serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [
      { function: { name: 'read_file', arguments: '{}' } },
      { function: { name: 'write_file', arguments: '{}' } },
    ],
  })), null);
});

test('parseToolCall bounds tool markup and scans unmatched braces in linear time', () => {
  const oversized = `<|DSML|tool_calls>${'x'.repeat(256 * 1024)}</|DSML|tool_calls>`;
  assert.equal(serverInternals.parseToolCall(oversized), null);

  const started = Date.now();
  assert.equal(serverInternals.parseToolCall('{'.repeat(64 * 1024)), null);
  assert.ok(Date.now() - started < 1000, 'unmatched JSON braces should not block the event loop');

  const malformedTagStarted = Date.now();
  const malformedTags = `<tool_calls><invoke name="${'<invoke name="'.repeat(16000)}</tool_calls>`;
  assert.equal(serverInternals.parseToolCall(malformedTags), null);
  assert.ok(Date.now() - malformedTagStarted < 1000, 'malformed quoted DSML tags should be rejected in bounded time');
});

test('parseToolCall refuses incomplete DSML instead of executing JSON found inside it', () => {
  const malformed = [
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '{"name":"dangerous_fallback","code":"rm -rf /"}',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  assert.equal(serverInternals.parseToolCall(malformed), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true);
});

test('parseToolCall rejects partially consumed DSML parameters and wrapper scope', () => {
  const truncatedSecondParameter = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter><parameter name="content">truncated</invoke></tool_calls>';
  const trailingInvokeJunk = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter>GARBAGE</invoke></tool_calls>';
  const truncatedSecondInvoke = '<tool_calls><invoke name="ping"></invoke><invoke name="write_file"><parameter name="path">/tmp/a</tool_calls>';
  const twoCompleteInvokes = '<tool_calls><invoke name="ping"></invoke><invoke name="ping"></invoke></tool_calls>';
  const secondInvokeOutsideWrapper = '<tool_calls><invoke name="ping"></invoke></tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter></invoke>';
  const trailingWrapperJunk = '<tool_calls><invoke name="ping"></invoke>GARBAGE</tool_calls>';
  const unclosedCdata = '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[truncated</parameter></invoke></tool_calls>';
  const tooManyParameters = `<tool_calls><invoke name="write_file">${Array.from({ length: 129 }, (_, i) => `<parameter name="p${i}">${i}</parameter>`).join('')}</invoke></tool_calls>`;

  for (const malformed of [
    truncatedSecondParameter,
    trailingInvokeJunk,
    truncatedSecondInvoke,
    twoCompleteInvokes,
    secondInvokeOutsideWrapper,
    trailingWrapperJunk,
    unclosedCdata,
    tooManyParameters,
  ]) {
    assert.equal(serverInternals.parseToolCall(malformed), null, malformed);
    assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true, malformed);
  }
});

test('tool schema compaction drops prose annotations but preserves validation shape', () => {
  const compact = serverInternals.compactToolSchema({
    type: 'object',
    description: 'large top-level description',
    properties: {
      command: { type: 'string', description: 'large property description' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string', description: 'annotation, not the property name' },
      title: { type: 'boolean', title: 'annotation, not the property name' },
      nested: {
        anyOf: [
          { type: 'string', description: 'remove from array item one' },
          { type: 'integer', title: 'remove from array item two' },
        ],
      },
    },
    required: ['command', 'description', 'title'],
  });

  assert.deepEqual(compact, {
    type: 'object',
    properties: {
      command: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string' },
      title: { type: 'boolean' },
      nested: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    required: ['command', 'description', 'title'],
  });
});

test('tool schema compaction preserves literal const, enum, and default values', () => {
  const literals = {
    type: 'object',
    description: 'drop this annotation',
    const: { description: 'literal field', title: 'literal title', nested: { examples: ['literal'] } },
    enum: [
      { description: 'first', value: 1 },
      { title: 'second', value: 2 },
    ],
    default: { description: 'default literal', title: 'default title' },
    properties: {
      choice: {
        description: 'drop nested annotation',
        const: { description: 'required argument value', title: 'keep me' },
      },
    },
  };

  assert.deepEqual(serverInternals.compactToolSchema(literals), {
    type: 'object',
    const: literals.const,
    enum: literals.enum,
    default: literals.default,
    properties: {
      choice: { const: literals.properties.choice.const },
    },
  });
});

test('buildBoundedPrompt preserves task edges and drops duplicate recovery history', () => {
  const system = `SYSTEM_START\n${'s'.repeat(50000)}\nTOOL_ADAPTER_END`;
  const history = `[Previous conversation]\n${'h'.repeat(10000)}\n`;
  const conversation = `TASK_START\n${'c'.repeat(70000)}\nLATEST_TOOL_RESULT`;
  const bounded = serverInternals.buildBoundedPrompt(system, history, conversation, 20000);

  assert.equal(bounded.compacted, true);
  assert.equal(bounded.historyDropped, true);
  assert.ok(bounded.prompt.length <= 20000);
  assert.match(bounded.prompt, /SYSTEM_START/);
  assert.match(bounded.prompt, /TOOL_ADAPTER_END/);
  assert.match(bounded.prompt, /TASK_START/);
  assert.match(bounded.prompt, /LATEST_TOOL_RESULT/);
  assert.doesNotMatch(bounded.prompt, /Previous conversation/);
});

test('conversation compaction shrinks huge tool results and keeps the latest user turn', () => {
  const conversation = [
    'User: implement the player controller\n\n',
    `[Tool Result]\n${'OLD_FILE'.repeat(8000)}\n\n`,
    `[Tool Result]\n${'NEW_FILE'.repeat(8000)}\nRESULT_END\n\n`,
    'User: now write the edited script with a tool\n',
  ].join('');
  const compacted = serverInternals.compactConversation(conversation, 12000);
  assert.ok(compacted.length <= 12000);
  assert.match(compacted, /implement the player controller/);
  assert.match(compacted, /now write the edited script with a tool/);
  assert.match(compacted, /RESULT_END/);
  const oldRepeats = compacted.split('OLD_FILE').length - 1;
  assert.ok(oldRepeats < 800, `oldest tool result should be shrunk, got ${oldRepeats} repeats`);
});

test('tool reminder is pinned after compaction so sticky sessions keep the tool format', () => {
  const tools = [
    { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
  ];
  const reminder = serverInternals.formatToolReminder(tools);
  assert.match(reminder, /write_file, read_file/);
  assert.match(reminder, /Do not paste source files/);

  const pinned = serverInternals.pinToolReminder(`TASK\n${'x'.repeat(5000)}`, tools, 800);
  assert.ok(pinned.length <= 800);
  assert.match(pinned, /--- END TOOL REMINDER ---$/);
  assert.match(pinned, /Available tools: write_file, read_file/);
  assert.equal(serverInternals.formatToolReminder([]), '');
});

test('client-provided multi-turn history suppresses server recovery-history injection', () => {
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
  ]), false);
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', content: 'result' },
  ]), true);
});

test('OpenCode session-title requests are answered locally without DeepSeek', () => {
  const messages = [
    { role: 'user', content: 'Generate a title for this conversation:\n' },
    { role: 'user', content: 'What is the tech stack of this project?' },
  ];
  assert.equal(serverInternals.isSessionTitleRequest(messages), true);
  assert.equal(serverInternals.localSessionTitle(messages), 'What is the tech stack of this project?');
  assert.equal(serverInternals.isSessionTitleRequest([
    { role: 'user', content: 'What is the tech stack of this project?' },
  ]), false);
});

test('sticky continuation omits repeated system prompt and prior turns', () => {
  const session = serverInternals.createSession();
  const firstMessages = [
    { role: 'system', content: 'You are OpenCode. Huge standing instructions.' },
    { role: 'user', content: 'what is the stack' },
  ];
  const first = serverInternals.resolveUpstreamPrompt(session, firstMessages, [], '');
  assert.match(first.systemPrompt, /You are OpenCode/);
  assert.match(first.conversation, /what is the stack/);
  assert.equal(first.omittedSystem, false);

  session.id = 'remote-1';
  session.sentSystemFingerprint = first.fingerprint;
  const next = serverInternals.resolveUpstreamPrompt(session, [
    { role: 'system', content: 'You are OpenCode. Huge standing instructions.' },
    { role: 'user', content: 'what is the stack' },
    { role: 'assistant', content: 'Node proxy' },
    { role: 'user', content: 'and the tests?' },
  ], [], '');
  assert.equal(next.systemPrompt, '');
  assert.equal(next.omittedSystem, true);
  assert.equal(next.omittedPriorTurns, true);
  assert.match(next.conversation, /and the tests/);
  assert.doesNotMatch(next.conversation, /what is the stack/);
  assert.doesNotMatch(next.conversation, /You are OpenCode/);
  assert.match(next.fullSystemPrompt, /You are OpenCode/);
});

test('sticky continuation omits system even when the client restates new instructions', () => {
  const session = serverInternals.createSession();
  session.id = 'remote-1';
  session.sentSystemFingerprint = serverInternals.fingerprintPrompt('old instructions');
  const next = serverInternals.resolveUpstreamPrompt(session, [
    { role: 'system', content: 'new instructions' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'follow up' },
  ], [], '');
  assert.equal(next.omittedSystem, true);
  assert.equal(next.systemPrompt, '');
  assert.match(next.conversation, /follow up/);
  assert.doesNotMatch(next.conversation, /\bhello\b/);
});

test('agent requests drop harness websearch and force native DeepSeek Search + DeepThink', () => {
  const stripped = serverInternals.stripHarnessWebSearchTools([
    { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'websearch', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'webfetch', parameters: { type: 'object' } } },
  ]);
  assert.deepEqual(stripped.names.sort(), ['webfetch', 'websearch']);
  assert.equal(stripped.tools.length, 1);
  assert.equal(stripped.tools[0].function.name, 'bash');
  assert.deepEqual(serverInternals.agentNativeWebFlags(stripped.tools, stripped.names), {
    thinking_enabled: true,
    search_enabled: true,
  });
  const formatted = serverInternals.formatMessages(
    [{ role: 'system', content: 'You are opencode' }, { role: 'user', content: 'search the docs' }],
    stripped.tools,
    { nativeSearchNotice: true },
  );
  assert.match(formatted.systemPrompt, /DeepSeek native Web Search and DeepThink/);
  assert.doesNotMatch(formatted.systemPrompt, /## websearch/);
  assert.match(formatted.systemPrompt, /## bash/);
});

test('OpenCode system prompt keeps the agent role and replaces token-economy with autonomy', () => {
  const original = [
    'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
    '# Tone and style',
    'You should be concise, direct, and to the point.',
    'IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. If you can answer in 1-3 sentences or a short paragraph, please do.',
    'IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.',
    'IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. One word answers are best.',
    'Here are some examples to demonstrate appropriate verbosity:',
    'user: what is 2+2?',
    'assistant: 4',
    '# Proactiveness',
    'You are allowed to be proactive, but only when the user asks you to do something.',
    '2. Not surprising the user with actions you take without asking',
    '# Doing tasks',
    'If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.',
    'You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.',
  ].join('\n');

  const adapted = serverInternals.adaptOpenCodeSystemPrompt(original);
  assert.match(adapted, /^You are opencode,/);
  assert.match(adapted, /# Doing tasks/);
  assert.match(adapted, /Finish the user's task autonomously/);
  assert.match(adapted, /Do not ask clarifying questions/);
  assert.match(adapted, /complete the whole task/);
  assert.match(adapted, /search the repo/);
  assert.doesNotMatch(adapted, /minimize output tokens/i);
  assert.doesNotMatch(adapted, /fewer than 4 lines/i);
  assert.doesNotMatch(adapted, /One word answers are best/i);
  assert.doesNotMatch(adapted, /unable to find the correct command, ask the user/i);
  assert.doesNotMatch(adapted, /without asking/);
  assert.doesNotMatch(adapted, /command\.md/);
  assert.equal(serverInternals.adaptOpenCodeSystemPrompt('You are a helpful assistant. Be brief.'), 'You are a helpful assistant. Be brief.');

  const formatted = serverInternals.formatMessages(
    [{ role: 'system', content: original }, { role: 'user', content: 'fix the tests' }],
    [],
  );
  assert.match(formatted.systemPrompt, /Finish the user's task autonomously/);
  assert.doesNotMatch(formatted.systemPrompt, /minimize output tokens/i);
  assert.match(formatted.prompt, /fix the tests/);
});

test('context-too-long detector recognizes DeepSeek localized errors', () => {
  assert.equal(serverInternals.isContextTooLongError({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Maximum context length exceeded' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Temporary backend overload' }), false);
});

test('too-long HTTP bodies become 400 instead of a session-reset storm', () => {
  const error = serverInternals.createUpstreamHttpError(502, 'Содержание слишком длинное. Сократите его и попробуйте снова.');
  assert.equal(error.status, 400);
  assert.equal(error.type, 'context_length_exceeded');
  assert.match(error.message, /слишком длинное/);

  assert.equal(serverInternals.isInstantEmptyResponse({
    content: '',
    reasoningContent: '',
    messageId: null,
    elapsedMs: 300,
  }), true);
  assert.equal(serverInternals.isInstantEmptyResponse({
    content: '',
    reasoningContent: '',
    messageId: 'msg-1',
    elapsedMs: 300,
  }), false);
  assert.equal(serverInternals.isInstantEmptyResponse({
    content: '',
    reasoningContent: 'thinking',
    messageId: null,
    elapsedMs: 300,
  }), false);

  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, false, true),
    { status: 400, type: 'context_length_exceeded' },
  );
});

test('an empty reply keeps a live DeepSeek chat instead of opening a new one', () => {
  const session = serverInternals.createSession();
  session.id = 'live-chat';
  assert.equal(serverInternals.remoteSessionShouldStay(session, {
    overflow: false,
    modelError: { type: 'error', content: '' },
  }), true);
  assert.equal(serverInternals.remoteSessionShouldStay(session, { overflow: true }), false);
  assert.equal(serverInternals.remoteSessionShouldStay(session, {
    modelError: { content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' },
  }), false);
  assert.equal(serverInternals.remoteSessionShouldStay(serverInternals.createSession(), {}), false);
});

test('abandoned tool-loop detector retries short stops after a tool result', () => {
  const afterTool = [
    { role: 'user', content: 'implement it' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: 'file contents' },
  ];
  assert.equal(serverInternals.lastTurnIsToolResult(afterTool), true);
  assert.equal(serverInternals.looksLikeAbandonedToolLoop('ok', afterTool), true);
  assert.equal(serverInternals.looksLikeAbandonedToolLoop('Done. The player controller is finished.', afterTool), false);
  assert.equal(serverInternals.looksLikeAbandonedToolLoop('ok', [{ role: 'user', content: 'hello' }]), false);
});

test('empty-response retry keeps recovery history unless a smaller global cap requires compaction', () => {
  const system = 'SYSTEM';
  const history = '[Previous conversation]\nUser: old\nAssistant: answer\n\n[Continue from here]\n\n';
  const conversation = 'User: follow up';
  const initial = serverInternals.buildBoundedPrompt(system, history, conversation, 5000);
  const unchangedRetry = serverInternals.buildRetryPrompt(system, history, conversation, initial.prompt, 4000);

  assert.equal(unchangedRetry.compacted, false);
  assert.match(unchangedRetry.prompt, /Previous conversation/);
  assert.match(unchangedRetry.prompt, /Assistant: answer/);

  const largeConversation = `TASK_START\n${'x'.repeat(9000)}\nLATEST_RESULT`;
  const largeInitial = serverInternals.buildBoundedPrompt(system, history, largeConversation, 8000);
  const smallerRetry = serverInternals.buildRetryPrompt(system, history, largeConversation, largeInitial.prompt, 4000);
  assert.equal(smallerRetry.compacted, true);
  assert.ok(smallerRetry.prompt.length <= 4000);
  assert.match(smallerRetry.prompt, /TASK_START/);
  assert.match(smallerRetry.prompt, /LATEST_RESULT/);
});

test('fresh-session retry restores local history that a healthy remote session initially omitted', () => {
  const system = 'SYSTEM';
  const history = serverInternals.buildRecoveryHistoryPrefix([
    { user: 'original task', assistant: 'original answer' },
  ]);
  const conversation = 'User: follow up';
  const establishedSessionPrompt = serverInternals.buildBoundedPrompt(system, '', conversation, 5000).prompt;
  const freshSessionRetry = serverInternals.buildRetryPrompt(
    system,
    history,
    conversation,
    establishedSessionPrompt,
    5000,
  );

  assert.ok(freshSessionRetry.prompt.length > establishedSessionPrompt.length);
  assert.match(freshSessionRetry.prompt, /Previous conversation/);
  assert.match(freshSessionRetry.prompt, /original task/);
  assert.match(freshSessionRetry.prompt, /original answer/);
  assert.match(freshSessionRetry.prompt, /follow up/);
});

test('remote reset preserves local history and sticky account while returning failure diagnostics', () => {
  const session = serverInternals.createSession();
  session.id = 'failed-session';
  session.parentMessageId = 'parent';
  session.createdAt = 123;
  session.messageCount = 17;
  session.accountId = 'account_2';
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const failure = serverInternals.resetRemoteSession(session);
  assert.deepEqual(failure, {
    failedSessionId: 'failed-session',
    failedMessageCount: 17,
    accountId: 'account_2',
  });
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.createdAt, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.accountId, 'account_2');
  assert.equal(session.history.length, 1);
});

test('account rotation clears a foreign remote session and preserves local recovery history', (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  serverInternals.accounts.push(
    {
      id: 'cooling',
      config: { token: 'one', cookie: 'one' },
      cooldownUntil: Date.now() + 60_000,
      headers: {},
    },
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
    },
  );
  const session = serverInternals.createSession();
  session.id = 'foreign-session';
  session.parentMessageId = 'foreign-parent';
  session.accountId = 'cooling';
  session.messageCount = 7;
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const selected = serverInternals.selectAccountForSession(session);
  assert.equal(selected.id, 'ready');
  assert.equal(session.accountId, 'ready');
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.history.length, 1);
});

test('simultaneous holders are routed onto different idle accounts', (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  const holders = [];
  t.after(() => {
    for (const holder of holders) serverInternals.releaseAccountChatLock(holder);
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });
  serverInternals.accounts.push(
    { id: 'acct_a', config: { token: 'a', cookie: 'a' }, cooldownUntil: 0, lastUsedAt: 0, headers: {} },
    { id: 'acct_b', config: { token: 'b', cookie: 'b' }, cooldownUntil: 0, lastUsedAt: 0, headers: {} },
  );
  const h1 = { id: 'req-1', agentId: 'agent-1' };
  const h2 = { id: 'req-2', agentId: 'agent-2' };
  holders.push(h1, h2);
  const first = serverInternals.selectAccountForSession(serverInternals.createSession(), h1);
  serverInternals.acquireAccountChatLock(first, h1);
  const second = serverInternals.selectAccountForSession(serverInternals.createSession(), h2);
  serverInternals.acquireAccountChatLock(second, h2);
  assert.notEqual(first.id, second.id);
  assert.equal(serverInternals.listAccountChatLocks().length, 2);
});

test('a second holder queues on a busy sticky account instead of failing immediately', async (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  const h1 = { id: 'req-1', agentId: 'agent-1' };
  const h2 = { id: 'req-2', agentId: 'agent-2' };
  t.after(() => {
    serverInternals.releaseAccountChatLock(h1);
    serverInternals.releaseAccountChatLock(h2);
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });
  serverInternals.accounts.push(
    { id: 'acct_a', config: { token: 'a', cookie: 'a' }, cooldownUntil: 0, lastUsedAt: 0, headers: {} },
  );
  const first = serverInternals.selectAccountForSession(serverInternals.createSession(), h1);
  await serverInternals.acquireAccountChatLock(first, h1);
  const sticky = serverInternals.createSession();
  sticky.accountId = 'acct_a';
  const selected = serverInternals.selectAccountForSession(sticky, h2);
  assert.equal(selected.id, 'acct_a');

  let acquired = false;
  const waiting = serverInternals.acquireAccountChatLock(selected, h2, 1000).then((waited) => {
    acquired = true;
    return waited;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(acquired, false);
  serverInternals.releaseAccountChatLock(h1);
  assert.equal(await waiting, true);
});

test('account lock wait times out with concurrent_chat_blocked', async (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  const h1 = { id: 'req-1', agentId: 'agent-1' };
  t.after(() => {
    serverInternals.releaseAccountChatLock(h1);
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });
  serverInternals.accounts.push(
    { id: 'acct_a', config: { token: 'a', cookie: 'a' }, cooldownUntil: 0, lastUsedAt: 0, headers: {} },
  );
  const first = serverInternals.selectAccountForSession(serverInternals.createSession(), h1);
  await serverInternals.acquireAccountChatLock(first, h1);
  await assert.rejects(
    () => serverInternals.acquireAccountChatLock(first, { id: 'req-2', agentId: 'agent-2' }, 30),
    (err) => err.status === 429 && err.type === 'concurrent_chat_blocked',
  );
});

test('Flash cost estimate uses official off-peak per-million rates', () => {
  assert.equal(serverInternals.modelCostUsd('deepseek-v4-flash', 1_000_000, 1_000_000), 0.88);
});

test('cross-account continuation is accepted only with a fresh recovery prompt', () => {
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'one' },
    freshSessionReset: false,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: true,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: false,
  }), false);
});

test('TTL and depth rollover happens before prompt construction and preserves recovery state', () => {
  const depthSession = serverInternals.createSession();
  depthSession.id = 'deep-session';
  depthSession.messageCount = 100;
  depthSession.accountId = 'account_1';
  depthSession.history.push({ user: 'u', assistant: 'a' });
  const depthReset = serverInternals.prepareSessionForPrompt(depthSession, Date.now());
  assert.equal(depthReset.reason, 'max_message_depth');
  assert.equal(depthSession.id, null);
  assert.equal(depthSession.history.length, 1);
  assert.equal(depthSession.accountId, 'account_1');

  const now = Date.now();
  const ttlSession = serverInternals.createSession();
  ttlSession.id = 'old-session';
  ttlSession.createdAt = now - (2 * 60 * 60 * 1000) - 1;
  const ttlReset = serverInternals.prepareSessionForPrompt(ttlSession, now);
  assert.equal(ttlReset.reason, 'session_ttl');
  assert.equal(ttlReset.failedSessionId, 'old-session');
});

test('tool results use the global prompt cap instead of an unconditional 8k truncation', () => {
  const toolResult = `RESULT_START\n${'z'.repeat(12000)}\nRESULT_END`;
  const formatted = serverInternals.formatMessages([
    { role: 'user', content: 'inspect this' },
    { role: 'tool', content: toolResult },
  ], []);

  assert.match(formatted.prompt, /RESULT_START/);
  assert.match(formatted.prompt, /RESULT_END/);
  assert.ok(formatted.prompt.length > 12000);

  const bounded = serverInternals.buildBoundedPrompt(formatted.systemPrompt, '', formatted.prompt, 5000);
  assert.equal(bounded.compacted, true);
  assert.ok(bounded.prompt.length <= 5000);
  assert.match(bounded.prompt, /RESULT_END/);
});

test('image inputs stay structured across OpenAI, Responses, and Anthropic payloads', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const openaiMessages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe it' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ],
  }];
  const responses = serverInternals.normalizeApiParams({
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe it' },
        { type: 'input_image', image_url: 'https://example.com/picture.webp' },
      ],
    }],
  }, 'responses');
  const anthropic = serverInternals.normalizeApiParams({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: 'Describe it' },
      ],
    }],
  }, 'anthropic');

  assert.equal(serverInternals.extractImageInputs(openaiMessages)[0].url, `data:image/png;base64,${png}`);
  assert.equal(responses.messages[0].content[1].type, 'image_url');
  assert.equal(serverInternals.extractImageInputs(responses.messages)[0].url, 'https://example.com/picture.webp');
  assert.equal(anthropic.messages[0].content[0].type, 'image_url');
  assert.equal(serverInternals.extractImageInputs(anthropic.messages)[0].url, `data:image/png;base64,${png}`);

  const formatted = serverInternals.formatMessages(anthropic.messages, []);
  assert.match(formatted.prompt, /Describe it/);
  assert.match(formatted.prompt, /\[Image attachment\]/);
  assert.doesNotMatch(formatted.prompt, /iVBOR/);
});

test('image materialization rejects private URLs and unsupported provider file IDs', async () => {
  await assert.rejects(
    serverInternals.materializeImageInput({ url: 'http://127.0.0.1/private.png' }, 0),
    /public HTTPS URL/,
  );
  await assert.rejects(
    serverInternals.materializeImageInput({ url: 'https://127.0.0.1/private.png' }, 0),
    /public network addresses/,
  );
  assert.throws(
    () => serverInternals.extractImageInputs([{
      role: 'user',
      content: [{ type: 'input_image', file_id: 'file_123' }],
    }]),
    /file_id.*not supported/,
  );
});

test('retry state clears a stale finish reason and failure classes use protocol-appropriate status codes', () => {
  const retry = serverInternals.normalizeRetryResponse({ content: 'recovered', finishReason: null });
  assert.equal(retry.finishReason, null);

  assert.deepEqual(
    serverInternals.classifyRecoveryFailure({ content: 'Maximum context length exceeded' }, false),
    { status: 400, type: 'context_length_exceeded' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, true),
    { status: 504, type: 'request_timeout' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, false),
    { status: 502, type: 'empty_response' },
  );
  assert.equal(serverInternals.isTimeoutError({ name: 'TimeoutError', message: 'operation timed out' }), true);
  assert.equal(serverInternals.isTimeoutError(new Error('ordinary upstream error')), false);
});

test('context-compaction header is marked and exposed to browser clients', () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  serverInternals.setCorsResponseHeaders(response);
  serverInternals.markContextCompacted(response);

  assert.equal(headers.get('Access-Control-Expose-Headers'), serverInternals.CONTEXT_COMPACTED_HEADER);
  assert.equal(headers.get(serverInternals.CONTEXT_COMPACTED_HEADER), 'true');
});

test('only V4.1-Flash aliases are registered', () => {
  const { resolveModelConfig, isKnownModel, isSupportedModel, SUPPORTED_MODEL_IDS, DEFAULT_MODEL_ID, MODEL_CONFIGS } = serverInternals;

  assert.equal(DEFAULT_MODEL_ID, 'deepseek-v4-flash');
  assert.deepEqual(
    Object.keys(MODEL_CONFIGS).sort(),
    [
      'deepseek-v4-flash',
      'deepseek-v4-flash-search',
      'deepseek-v4-flash-thinking',
      'deepseek-v4-flash-thinking-search',
    ].sort(),
  );

  const flash = resolveModelConfig('deepseek-v4-flash');
  assert.equal(flash.model_type, 'default');
  assert.equal(flash.thinking_enabled, false);
  assert.equal(flash.search_enabled, false);
  assert.match(flash.real_model, /V4\.1-Flash/);

  const flashThink = resolveModelConfig('deepseek-v4-flash-thinking');
  assert.equal(flashThink.model_type, 'default');
  assert.equal(flashThink.thinking_enabled, true);

  for (const id of SUPPORTED_MODEL_IDS) assert.equal(isSupportedModel(id), true, id);
  for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'deepseek-v3', 'deepseek-instant', 'deepseek-expert', 'deepseek-vision', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(isKnownModel(id), false, id);
  }

  const { canonicalizeModelId } = serverInternals;
  assert.equal(canonicalizeModelId('claude-sonnet-4-6'), 'deepseek-v4-flash');
  assert.equal(canonicalizeModelId('claude-opus-4-6'), 'deepseek-v4-flash-thinking');
  assert.equal(canonicalizeModelId('deepseek-v4-flash-thinking[1m]'), 'deepseek-v4-flash-thinking');
  assert.equal(canonicalizeModelId('deepseek-flash'), 'deepseek-v4-flash');
  assert.equal(canonicalizeModelId('deepseek-flash-thinking'), 'deepseek-v4-flash-thinking');
  assert.equal(isKnownModel('claude-haiku-4-5'), true);
});

test('stream helpers preserve the request-level exact CORS origin', () => {
  const response = {
    id: 'ds-test',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  for (const send of [
    serverInternals.sendAnthropicStream,
    serverInternals.sendResponsesStream,
    serverInternals.sendOpenAIStream,
  ]) {
    let writeHeadHeaders = null;
    const res = {
      writeHead: (_status, headers) => { writeHeadHeaders = headers; },
      write: () => {},
      end: () => {},
    };
    send(res, response);
    assert.equal(Object.hasOwn(writeHeadHeaders, 'Access-Control-Allow-Origin'), false);
  }
});

test('OpenAI stream emits a usage chunk before DONE so clients can show tokens', () => {
  const response = {
    id: 'ds-test',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
  const chunks = [];
  const res = {
    writeHead: () => {},
    write: (chunk) => { chunks.push(String(chunk)); },
    end: () => {},
  };
  serverInternals.sendOpenAIStream(res, response);
  const body = chunks.join('');
  assert.match(body, /"prompt_tokens":12/);
  assert.match(body, /"completion_tokens":4/);
  assert.match(body, /"choices":\[\]/);
  assert.match(body, /\[DONE\]/);
  assert.ok(body.indexOf('"usage"') < body.indexOf('[DONE]'));
});

test('one-click agent setup adds opt-in providers without replacing native defaults', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.config', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.openclaw'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hermes'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus', env: { KEEP: 'yes' } }));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-native"\nmodel_provider = "openai"\n');
  fs.writeFileSync(path.join(dir, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'openai/gpt-native' }));
  fs.writeFileSync(path.join(dir, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: { primary: 'anthropic/claude-opus' } } } }));
  fs.writeFileSync(path.join(dir, '.hermes', 'config.yaml'), 'model:\n  default: claude-opus\n');
  const res = runNode([
    'scripts/setup-agents.js',
    '--target', 'claude-code,hermes,openclaw,codex,opencode',
    '--model', 'deepseek-v4-flash-thinking-search',
    '--base-url', 'http://127.0.0.1:9655',
    '--api-key', 'local',
    '--scope', 'user',
  ], { env: { SETUP_HOME: dir } });
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const claudeNative = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claudeNative, { model: 'claude-opus', env: { KEEP: 'yes' } });
  const claudeProfile = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'freedeepseek.settings.json'), 'utf8'));
  assert.equal(claudeProfile.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9655');
  assert.equal(claudeProfile.model, 'deepseek-v4-flash-thinking-search');

  const hermesNative = fs.readFileSync(path.join(dir, '.hermes', 'config.yaml'), 'utf8');
  assert.match(hermesNative, /claude-opus/);
  const hermesProfile = fs.readFileSync(path.join(dir, '.hermes', 'freedeepseek.yaml'), 'utf8');
  assert.match(hermesProfile, /provider: custom/);
  assert.match(hermesProfile, /deepseek-v4-flash-thinking-search/);

  const claw = JSON.parse(fs.readFileSync(path.join(dir, '.openclaw', 'openclaw.json'), 'utf8'));
  assert.equal(claw.agents.defaults.model.primary, 'anthropic/claude-opus');
  assert.equal(claw.models.providers.freedeepseek.api, 'openai-completions');
  assert.deepEqual(claw.models.providers.freedeepseek.models[0].input, ['text', 'image']);

  const toml = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.equal(toml, 'model = "gpt-native"\nmodel_provider = "openai"\n');
  const codexProfile = fs.readFileSync(path.join(dir, '.codex', 'freedeepseek.config.toml'), 'utf8');
  assert.match(codexProfile, /model_provider = "freedeepseek"/);
  assert.match(codexProfile, /wire_api = "responses"/);
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'freedeepseek-models.json'), 'utf8'));
  assert.deepEqual(catalog.models[0].input_modalities, ['text', 'image']);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, []);
  assert.equal(catalog.models[0].shell_type, 'shell_command');
  assert.equal(catalog.models[0].supports_reasoning_summary_parameter, false);

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(opencode.model, 'openai/gpt-native');
  assert.equal(opencode.tools.websearch, false);
  assert.equal(opencode.tools.webfetch, false);
  assert.equal(opencode.permission.websearch, 'deny');
  assert.equal(opencode.provider.freedeepseek.name, 'Flash');
  assert.equal(opencode.provider.freedeepseek.models['deepseek-v4-flash'].name, 'DeepSeek 4.1');
  assert.equal(opencode.provider.freedeepseek.models['deepseek-v4-flash-thinking-search'].name, 'DeepSeek 4.1');
  assert.equal(opencode.provider.freedeepseek.models['deepseek-v4-flash-thinking-search'].limit.context, 1048576);
  assert.equal(opencode.provider.freedeepseek.models['deepseek-v4-flash-thinking-search'].attachment, true);
  assert.deepEqual(opencode.provider.freedeepseek.models['deepseek-v4-flash-thinking-search'].modalities.input, ['text', 'image']);
  const agentsMd = fs.readFileSync(path.join(dir, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /<!-- freedeepseek-autonomy -->/);
  assert.match(agentsMd, /Finish the user's task autonomously/);
  assert.match(agentsMd, /Token cost does not matter/);
});

test('agent setup replace mode makes FreeDeepseekAPI the default without discarding unrelated settings', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.config', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.openclaw'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hermes'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { KEEP: 'yes' }, theme: 'dark' }));
  fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-native"\nsandbox_mode = "workspace-write"\n');
  fs.writeFileSync(path.join(dir, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'openai/gpt-native', theme: 'native' }));
  fs.writeFileSync(path.join(dir, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: '/tmp/work' } } }));
  fs.writeFileSync(path.join(dir, '.hermes', 'config.yaml'), 'model:\n  default: claude-opus\nmemory: true\n');

  const res = runNode([
    'scripts/setup-agents.js',
    '--target', 'claude-code,hermes,openclaw,codex,opencode',
    '--mode', 'replace',
    '--model', 'deepseek-v4-flash-thinking',
  ], { env: { SETUP_HOME: dir } });
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.model, 'deepseek-v4-flash-thinking');
  assert.equal(claude.env.KEEP, 'yes');
  assert.equal(claude.theme, 'dark');

  const codex = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /^model = "deepseek-v4-flash-thinking"$/m);
  assert.match(codex, /^model_provider = "freedeepseek"$/m);
  assert.match(codex, /sandbox_mode = "workspace-write"/);
  assert.match(codex, /\[model_providers\.freedeepseek\]/);

  const hermes = fs.readFileSync(path.join(dir, '.hermes', 'config.yaml'), 'utf8');
  assert.match(hermes, /default: deepseek-v4-flash-thinking/);
  assert.match(hermes, /memory: true/);

  const claw = JSON.parse(fs.readFileSync(path.join(dir, '.openclaw', 'openclaw.json'), 'utf8'));
  assert.equal(claw.agents.defaults.model.primary, 'freedeepseek/deepseek-v4-flash-thinking');
  assert.equal(claw.agents.defaults.workspace, '/tmp/work');

  const opencode = JSON.parse(fs.readFileSync(path.join(dir, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(opencode.model, 'freedeepseek/deepseek-v4-flash-thinking');
  assert.equal(opencode.theme, 'native');
});

test('a paused login is skipped so another ready file can serve', (t) => {
  const original = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...original);
  });
  serverInternals.accounts.push(
    { id: 'acct_a', file: 'a.json', config: { token: 'a', cookie: 'a', enabled: false }, cooldownUntil: 0, lastUsedAt: 0, headers: {}, failures: 0 },
    { id: 'acct_b', file: 'b.json', config: { token: 'b', cookie: 'b' }, cooldownUntil: 0, lastUsedAt: 0, headers: {}, failures: 0 },
  );
  const session = serverInternals.createSession();
  session.accountId = 'acct_a';
  const selected = serverInternals.selectAccountForSession(session);
  assert.equal(selected.id, 'acct_b');
  assert.equal(session.accountId, 'acct_b');
});

test('every paused login leaves no account that can serve', (t) => {
  const original = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...original);
  });
  serverInternals.accounts.push({
    id: 'worker',
    file: 'worker.json',
    config: { token: 'tok', cookie: 'ck', enabled: false },
    cooldownUntil: 0,
    lastUsedAt: 0,
    headers: {},
    failures: 0,
  });
  assert.throws(
    () => serverInternals.selectAccountForSession(serverInternals.createSession()),
    (err) => err.status === 503 && err.type === 'no_auth',
  );
});
