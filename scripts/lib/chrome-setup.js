'use strict';

// Finding a Chrome the sign-in flow can drive over DevTools, installing one
// when none is present, saving the captured session, and keeping that profile
// private. Kept out of the sign-in script (which runs on load) so they are testable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE_DIR_MODE = 0o700;

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

// DevTools has no authentication. Bind it to 127.0.0.1 instead of leaving the
// address unset.
function signInChromeArgs(profileDir, port, url) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
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
    url,
  ];
}

// Default mkdir is 0755 under umask 022, and mkdir does not change a directory
// that already exists. chmod afterwards so a leftover profile is tightened too.
function ensurePrivateProfileDir(dir, io = fs) {
  io.mkdirSync(dir, { recursive: true, mode: PROFILE_DIR_MODE });
  io.chmodSync(dir, PROFILE_DIR_MODE);
}

function pauseSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

// Deletes the sign-in profile. If it is busy, move it out of the repo so the
// cookies cannot be committed, lock the copy to 0700, and still try to delete it.
function removeProfileSafely(dir, opts = {}) {
  const io = opts.fs || fs;
  const tmpdir = opts.tmpdir || os.tmpdir();
  const pause = opts.sleepSync || pauseSync;
  const now = opts.now || Date.now;
  const log = opts.log || ((line) => console.log(line));
  if (!io.existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      io.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
      if (!io.existsSync(dir)) return;
    } catch (e) {
      if (i === 4) {
        // Outside the repo, so a leftover copy of the logged-in cookies can never be committed.
        const staleDir = path.join(tmpdir, `${path.basename(dir)}.stale-${now()}`);
        try {
          io.chmodSync(dir, PROFILE_DIR_MODE);
          io.renameSync(dir, staleDir);
          io.chmodSync(staleDir, PROFILE_DIR_MODE);
        } catch (renameErr) {
          throw new Error(
            `Cannot remove the old auth Chrome profile ${dir} (${e.code || e.message}) or move it to ${staleDir} (${renameErr.code || renameErr.message}). Close the DeepSeek auth Chrome window and retry.`,
          );
        }
        try {
          io.rmSync(staleDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 250,
          });
        } catch {}
        log(`[auth] Old profile was busy; moved it aside: ${staleDir}`);
        return;
      }
    }
    pause(300);
  }
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
  PROFILE_DIR_MODE,
  writeCapturedAuth,
  locateChrome,
  findBrew,
  brewInstallCommand,
  signInChromeArgs,
  ensurePrivateProfileDir,
  removeProfileSafely,
};
