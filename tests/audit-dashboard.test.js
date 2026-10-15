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
