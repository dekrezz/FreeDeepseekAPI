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
