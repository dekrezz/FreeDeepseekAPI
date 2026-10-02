const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const chrome = require('../scripts/lib/chrome-setup');
const tui = require('../scripts/lib/tui-menu');

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function existsOnly(...present) {
  const set = new Set(present);
  return (p) => set.has(p);
}

test('CHROME_PATH is the only place searched when it is set', () => {
  const found = chrome.locateChrome({
    env: { CHROME_PATH: '/opt/custom/chrome' },
    platform: 'darwin',
    home: '/Users/me',
    exists: existsOnly(MAC_CHROME),
    readdir: () => [],
  });
  assert.equal(found.path, null, 'an explicit but missing CHROME_PATH must not fall back to another browser');
  assert.deepEqual(found.checked, [{ source: 'CHROME_PATH', path: '/opt/custom/chrome', ok: false }]);
});

test('macOS search reports every location it checked when nothing is installed', () => {
  const found = chrome.locateChrome({
    env: {},
    platform: 'darwin',
    home: '/Users/me',
    exists: () => false,
    readdir: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
  });
  assert.equal(found.path, null);
  const paths = found.checked.map(c => c.path);
  assert.ok(paths.includes(MAC_CHROME));
  assert.ok(paths.includes('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(paths.includes('/Applications/Chromium.app/Contents/MacOS/Chromium'));
  assert.ok(found.checked.every(c => c.ok === false));
});

test('macOS search finds a normal Google Chrome install', () => {
  const found = chrome.locateChrome({
    env: {}, platform: 'darwin', home: '/Users/me', exists: existsOnly(MAC_CHROME), readdir: () => [],
  });
  assert.equal(found.path, MAC_CHROME);
  assert.equal(found.checked.find(c => c.path === MAC_CHROME).ok, true);
});

test('the newest Puppeteer Chrome for Testing wins over system Chrome', () => {
  const cache = '/Users/me/.cache/puppeteer/chrome';
  const exe = (v) => path.join(cache, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  const found = chrome.locateChrome({
    env: {},
    platform: 'darwin',
    home: '/Users/me',
    exists: existsOnly(exe('mac_arm-120.0.1'), exe('mac_arm-131.0.2'), MAC_CHROME),
    readdir: (dir) => (dir === cache ? ['mac_arm-120.0.1', 'mac_arm-131.0.2'] : []),
  });
  assert.equal(found.path, exe('mac_arm-131.0.2'));
});

test('Linux search covers the usual Chrome and Chromium binaries', () => {
  const found = chrome.locateChrome({
    env: {}, platform: 'linux', home: '/home/me', exists: existsOnly('/usr/bin/chromium'), readdir: () => [],
  });
  assert.equal(found.path, '/usr/bin/chromium');
  const paths = found.checked.map(c => c.path);
  assert.ok(paths.includes('/usr/bin/google-chrome'));
  assert.ok(paths.includes('/usr/bin/chromium-browser'));
});

test('Homebrew is offered on macOS only, from its standard prefixes', () => {
  assert.equal(chrome.findBrew('darwin', existsOnly('/opt/homebrew/bin/brew')), '/opt/homebrew/bin/brew');
  assert.equal(chrome.findBrew('darwin', existsOnly('/usr/local/bin/brew')), '/usr/local/bin/brew');
  assert.equal(chrome.findBrew('darwin', () => false), null);
  assert.equal(chrome.findBrew('linux', () => true), null);
  assert.equal(chrome.findBrew('win32', () => true), null);
  assert.deepEqual(chrome.brewInstallCommand('/opt/homebrew/bin/brew'), {
    cmd: '/opt/homebrew/bin/brew',
    args: ['install', '--cask', 'google-chrome'],
  });
  assert.equal(chrome.CHROME_DOWNLOAD_URL, 'https://www.google.com/chrome/');
});

test('browserOpenCommand opens a URL without a shell on every platform', () => {
  const url = 'https://www.google.com/chrome/';
  assert.deepEqual(tui.browserOpenCommand('darwin', url), { cmd: 'open', args: [url] });
  assert.deepEqual(tui.browserOpenCommand('linux', url), { cmd: 'xdg-open', args: [url] });
  assert.deepEqual(tui.browserOpenCommand('win32', url), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
});

test('every Chrome install string is translated', () => {
  const keys = ['chromeMissing', 'chromeSearching', 'chromeChecked', 'installBrew', 'helpInstallBrew',
    'openChromeSite', 'helpOpenChromeSite', 'retryChrome', 'helpRetryChrome', 'brewInstalling',
    'brewFailed', 'brewMissing', 'chromeFound', 'siteOpened'];
  for (const lang of tui.LANGS) {
    for (const key of keys) assert.ok(tui.STRINGS[lang][key], `${lang}.${key} is missing`);
  }
});

test('a missing Chrome in a non-interactive run lists the checked paths without a stack trace', () => {
  const res = spawnSync(process.execPath, ['scripts/deepseek_chrome_auth.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHROME_PATH: '/nonexistent/chrome-for-test' },
  });
  assert.equal(res.status, 1);
  const out = res.stdout + res.stderr;
  assert.match(out, /\/nonexistent\/chrome-for-test/);
  assert.match(out, /CHROME_PATH/);
  assert.doesNotMatch(out, /\n\s+at main \(/, 'a missing browser is a setup problem, not a crash');
});
