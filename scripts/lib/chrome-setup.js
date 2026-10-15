'use strict';

// Finding a Chrome the sign-in flow can drive over DevTools, and installing one
// when none is present, and saving the captured session. Kept out of the sign-in
// script (which runs on load) so they are testable.

const fs = require('fs');
const path = require('path');

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
const BREW_PREFIXES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

function puppeteerCacheCandidates(platform, home, readdir) {
  if (!home) return [];
  const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
  let dirs;
  try {
    dirs = readdir(cacheRoot);
  } catch {
    return [];
  }
  // Newest version first: the cache directory names end in the Chrome version.
  const sorted = [...dirs].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return sorted.flatMap((dir) => {
    const base = path.join(cacheRoot, dir);
    if (platform === 'darwin') {
      return ['chrome-mac-arm64', 'chrome-mac-x64'].map(arch =>
        path.join(base, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
    }
    if (platform === 'win32') return [path.join(base, 'chrome-win64', 'chrome.exe')];
    return [path.join(base, 'chrome-linux64', 'chrome')];
  });
}

function systemCandidates(platform, home, env) {
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome for Testing.app', 'Google Chrome for Testing'],
      ['Google Chrome.app', 'Google Chrome'],
      ['Chromium.app', 'Chromium'],
    ];
    const roots = ['/Applications', home && path.join(home, 'Applications')].filter(Boolean);
    return roots.flatMap(root => apps.map(([app, exe]) => path.join(root, app, 'Contents', 'MacOS', exe)));
  }
  if (platform === 'win32') {
    return [
      env.PROGRAMFILES && `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter((p, i, all) => p && all.indexOf(p) === i);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

// Returns { path, checked: [{ source, path, ok }] }. path is null when nothing usable
// exists; checked lists every location in search order for the diagnostics screen.
function locateChrome({
  env = process.env,
  platform = process.platform,
  home = env.HOME || env.USERPROFILE || '',
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  puppeteer = [],
} = {}) {
  const candidates = env.CHROME_PATH
    ? [{ source: 'CHROME_PATH', path: env.CHROME_PATH }]
    : [
      ...puppeteer.map(p => ({ source: 'puppeteer', path: p })),
      ...puppeteerCacheCandidates(platform, home, readdir).map(p => ({ source: 'puppeteer cache', path: p })),
      ...systemCandidates(platform, home, env).map(p => ({ source: 'system', path: p })),
    ];
  const checked = candidates.map(c => ({ ...c, ok: Boolean(c.path && exists(c.path)) }));
  return { path: checked.find(c => c.ok)?.path || null, checked };
}

function findBrew(platform = process.platform, exists = fs.existsSync) {
  if (platform !== 'darwin') return null;
  return BREW_PREFIXES.find(p => exists(p)) || null;
}

function brewInstallCommand(brew) {
  return { cmd: brew, args: ['install', '--cask', 'google-chrome'] };
}

// Saves a captured session only when it holds both a token and a cookie, so a login
// that did not finish never replaces a working auth file. Writes a 0600 temp file
// next to outPath and renames it over the target. Returns false when nothing was written.
function writeCapturedAuth(outPath, auth) {
  if (!auth || !auth.token || !auth.cookie) return false;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  return true;
}

module.exports = {
  CHROME_DOWNLOAD_URL,
  writeCapturedAuth,
  locateChrome,
  findBrew,
  brewInstallCommand,
};
