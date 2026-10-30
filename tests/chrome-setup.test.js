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

test('sign-in Chrome binds DevTools to 127.0.0.1', () => {
  assert.deepEqual(
    chrome.signInChromeArgs('/data/profile', 9334, 'https://chat.deepseek.com/'),
    [
      '--user-data-dir=/data/profile',
      '--remote-debugging-port=9334',
      '--remote-debugging-address=127.0.0.1',
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      'https://chat.deepseek.com/',
    ],
  );
  const custom = chrome.signInChromeArgs('/tmp/p', 9444, 'https://chat.deepseek.com/');
  assert.ok(custom.includes('--remote-debugging-port=9444'));
  assert.equal(custom.filter((arg) => arg.startsWith('--remote-debugging-address=')).join(','), '--remote-debugging-address=127.0.0.1');
});

test('sign-in profile directory is created mode 0700 and an existing one is tightened', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-mode-'));
  const dir = path.join(root, 'profile');
  const calls = [];
  const prev = process.umask(0);
  try {
    chrome.ensurePrivateProfileDir(dir, {
      mkdirSync(target, opts) {
        calls.push(['mkdir', target, opts]);
        fs.mkdirSync(target, opts);
      },
      chmodSync(target, mode) {
        calls.push(['chmod', target, mode]);
        fs.chmodSync(target, mode);
      },
    });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(calls, [
      ['mkdir', dir, { recursive: true, mode: 0o700 }],
      ['chmod', dir, 0o700],
    ]);
    fs.chmodSync(dir, 0o755);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    chrome.ensurePrivateProfileDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    process.umask(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a busy sign-in profile is mode 0700 before and after it is moved aside', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-busy-'));
  const dir = path.join(root, 'profile');
  const stale = path.join(root, 'profile.stale-1');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'Cookies'), 'secret', { mode: 0o644 });
  const events = [];
  const logs = [];
  try {
    chrome.removeProfileSafely(dir, {
      tmpdir: root,
      now: () => 1,
      sleepSync() {},
      log: (line) => logs.push(line),
      fs: {
        existsSync: (p) => fs.existsSync(p),
        chmodSync(p, mode) {
          events.push(['chmod', p, mode]);
          fs.chmodSync(p, mode);
        },
        renameSync(from, to) {
          events.push(['rename', from, to]);
          fs.renameSync(from, to);
        },
        rmSync(p) {
          events.push(['rm', p]);
          const err = new Error('busy');
          err.code = 'EBUSY';
          throw err;
        },
      },
    });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.statSync(stale).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(stale, 'Cookies'), 'utf8'), 'secret');
    const chmodDir = events.findIndex((e) => e[0] === 'chmod' && e[1] === dir);
    const rename = events.findIndex((e) => e[0] === 'rename');
    const chmodStale = events.findIndex((e) => e[0] === 'chmod' && e[1] === stale);
    const rmStale = events.findIndex((e) => e[0] === 'rm' && e[1] === stale);
    assert.equal(events.filter((e) => e[0] === 'chmod' && e[1] === dir).length, 1);
    assert.ok(chmodDir !== -1 && chmodDir < rename, 'chmod the profile before moving it');
    assert.equal(events[chmodDir][2], 0o700);
    assert.ok(chmodStale > rename, 'chmod the destination after the move');
    assert.equal(events[chmodStale][2], 0o700);
    assert.ok(rmStale > chmodStale, 'still try to delete the moved profile');
    assert.equal(logs[0], `[auth] Old profile was busy; moved it aside: ${stale}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeProfileSafely deletes a profile that is not busy', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-profile-rm-'));
  const dir = path.join(root, 'profile');
  try {
    assert.equal(chrome.removeProfileSafely(path.join(root, 'missing')), undefined);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Cookies'), 'secret');
    chrome.removeProfileSafely(dir, { tmpdir: root, sleepSync() {} });
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('profile.stale-')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('audit auth-1: a failed capture never overwrites a working auth file', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-auth-1-'));
  try {
    const file = path.join(dir, 'deepseek-auth.json');
    const good = { token: 'good', cookie: 'a=b' };
    fs.writeFileSync(file, JSON.stringify(good), { mode: 0o600 });
    assert.equal(typeof chrome.writeCapturedAuth, 'function', 'scripts/lib/chrome-setup.js must export writeCapturedAuth(outPath, auth)');
    const empty = { token: '', cookie: '', hif_dliq: '', hif_leim: '', wasmUrl: 'x' };
    const partial = { token: '', cookie: 'a=b', hif_dliq: '', hif_leim: '', wasmUrl: 'x' };
    for (const captured of [empty, partial]) {
      let outcome;
      try { outcome = chrome.writeCapturedAuth(file, captured); } catch { outcome = false; }
      assert.equal(outcome, false, 'a failed capture must throw or return false');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), good, 'the existing auth file must stay untouched');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
