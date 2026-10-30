'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_DIR = path.join(__dirname, '..', 'public', 'dashboard');

function loadDashboardScript(file, context) {
  const code = fs.readFileSync(path.join(DASHBOARD_DIR, file), 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: file });
}

test('audit dash-panels-4: status view registers even when localStorage access throws', () => {
  const blocked = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  const FDSA = { h() {}, s() {}, fmt: {}, views: {}, on() {}, charts: {} };
  const window = { FDSA };
  const context = { window, localStorage: blocked };

  assert.doesNotThrow(() => loadDashboardScript('status.js', context));
  assert.equal(typeof window.FDSA.views.status, 'object');
  assert.ok(window.FDSA.views.status, 'F.views.status must be registered');
});

test('every coding agent shows its own logo, not its initials', () => {
  const agents = fs.readFileSync(path.join(DASHBOARD_DIR, 'agents.js'), 'utf8');
  const index = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8');
  const block = agents.match(/const AGENTS = \[([\s\S]*?)\];/);
  assert.ok(block, 'agents.js lists its agents in const AGENTS');
  const ids = [...block[1].matchAll(/id: '([a-z-]+)'/g)].map(m => m[1]);
  assert.deepEqual(ids, ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'cursor']);
  for (const id of ids) {
    assert.match(index, new RegExp(`<symbol id="a-${id}" viewBox="0 0 24 24">`), `index.html has no logo symbol for ${id}`);
  }
  assert.match(agents, /`#a-\$\{/, 'the agent mark draws the logo symbol');
});

test('no scrollbar is drawn anywhere; long commands wrap instead of scrolling', () => {
  const css = fs.readFileSync(path.join(DASHBOARD_DIR, 'app.css'), 'utf8');
  assert.match(css, /^\* \{ scrollbar-width: none; \}$/m, 'scrollbars are hidden for every element');
  assert.match(css, /^\*::-webkit-scrollbar \{ display: none; \}$/m, 'and in WebKit and Blink');
  assert.match(css, /\.code-line code \{[^}]*white-space: pre-wrap;/, 'a long command wraps');
  assert.doesNotMatch(css, /::-webkit-scrollbar-thumb/, 'no scrollbar is styled back in');
  const core = fs.readFileSync(path.join(DASHBOARD_DIR, 'core.js'), 'utf8');
  assert.match(core, /F\.scrollEdges = /, 'scrollable areas mark the edges that have more past them');
});

test('agent tiles take each brand\'s own avatar colours (Lobe Icons), not a computed hue', () => {
  const agents = fs.readFileSync(path.join(DASHBOARD_DIR, 'agents.js'), 'utf8');
  const block = agents.match(/const AGENTS = \[([\s\S]*?)\];/)[1];
  const brand = {
    'claude-code': { bg: '#09090B', fg: '#D97757' },
    codex: { bg: '#FFFFFF', fg: null },
    opencode: { bg: '#000000', fg: '#FFFFFF' },
    hermes: { bg: '#FFFFFF', fg: '#000000' },
    openclaw: { bg: '#000000', fg: null },
    cursor: { bg: '#000000', fg: '#FFFFFF' },
  };
  for (const [id, c] of Object.entries(brand)) {
    const entry = block.match(new RegExp(`\\{ id: '${id}'[^}]*\\}`));
    assert.ok(entry, `no entry for ${id}`);
    assert.match(entry[0], new RegExp(`bg: '${c.bg}'`), `${id} tile background`);
    assert.match(entry[0], c.fg ? new RegExp(`fg: '${c.fg}'`) : /fg: null/, `${id} mark colour (null keeps the logo's own colours)`);
    assert.doesNotMatch(entry[0], /hue:/, `${id} still uses a computed hue`);
  }
});

test('dashboard Chinese covers every English string and translates the main navigation', () => {
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const navigator = { language: 'en-US' };
  const window = { FDSA: {} };
  loadDashboardScript('i18n.js', { window, localStorage, navigator });
  const { en, zh } = window.FDSA.I18N;
  const t = window.FDSA.t;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], 'string', key);
    assert.ok(zh[key].trim(), `empty Chinese for ${key}`);
  }
  for (const key of ['Chat', 'Status', 'Accounts', 'Usage', 'Requests', 'Settings']) {
    assert.equal(en[key], key, key);
    assert.notEqual(zh[key], en[key], key);
  }
  assert.equal(window.FDSA.lang.get(), 'en');
  assert.equal(t('Chat'), 'Chat');
  assert.equal(t('not a stored sentence'), 'not a stored sentence');
  navigator.language = 'zh-CN';
  assert.equal(window.FDSA.lang.get(), 'zh');
  assert.equal(t('Settings'), '设置');
  assert.equal(t('{n} accounts', { n: 4 }), '4 个账号');
  localStorage.setItem('fdsa.lang', 'en');
  assert.equal(window.FDSA.lang.get(), 'en', 'a stored choice wins over the browser language');
  assert.equal(t('Chat'), 'Chat');
  const saved = zh.Chat;
  delete zh.Chat;
  localStorage.setItem('fdsa.lang', 'zh');
  assert.equal(t('Chat'), 'Chat', 'a missing Chinese string falls back to English');
  zh.Chat = saved;
  assert.equal(Object.getPrototypeOf(en), null);
  assert.equal(Object.getPrototypeOf(zh), null);
  assert.equal(t('{toString} {constructor}', {}), '{toString} {constructor}');
});

test('agent rows carry no file/proxy/model chain; channel and mode choices read like the model picker', () => {
  const agents = fs.readFileSync(path.join(DASHBOARD_DIR, 'agents.js'), 'utf8');
  const settings = fs.readFileSync(path.join(DASHBOARD_DIR, 'settings.js'), 'utf8');
  assert.doesNotMatch(agents, /sigpath-sm|smallPath/, 'the roster row repeats the path its subtitle already gives');
  for (const [name, code] of [['agents.js', agents], ['settings.js', settings]]) {
    assert.doesNotMatch(code, /channel-dot/, `${name} still draws a radio dot`);
    assert.match(code, /F\.icon\('check', 'channel-check'\)/, `${name} marks the chosen tile with a check`);
  }
  for (const title of ['Model', 'Install as', 'Proxy address', 'Access key']) {
    assert.match(agents, new RegExp(`cfgSection\\('${title}', '[a-z-]+', '[a-z-]+'`), `${title} has no icon`);
  }
});
