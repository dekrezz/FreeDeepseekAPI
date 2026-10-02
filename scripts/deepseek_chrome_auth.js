#!/usr/bin/env node
/*
  Opens/reuses a separate Chrome for Testing profile for DeepSeek Web login and extracts
  the minimum auth metadata into deepseek-auth.json.

  Usage:
    node scripts/deepseek_chrome_auth.js
    # optional override: CHROME_PATH="/path/to/browser" node scripts/deepseek_chrome_auth.js
    # optional reuse: DEEPSEEK_REUSE_CHROME=1 DEEPSEEK_KEEP_CHROME_PROFILE=1 node scripts/deepseek_chrome_auth.js

  Default auth starts a clean disposable Chrome for Testing profile and uses
  --use-mock-keychain to avoid macOS Keychain prompts.

  Flow:
    1. Log in at chat.deepseek.com in the opened Chrome profile.
    2. Send one short prompt (for example: ok) so the frontend initializes state.
    3. Return to terminal and press Enter.
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { t, loadUiLang, saveUiLang, pick, runProgress, browserOpenCommand, visibleWidth, C } = require('./lib/tui-menu');
const {
    CHROME_DOWNLOAD_URL,
    locateChrome,
    findBrew,
    brewInstallCommand,
} = require('./lib/chrome-setup');

const repoRoot = path.resolve(__dirname, '..');
const qwenRepoRoot = path.resolve(repoRoot, '..', 'FreeQwenApi');
const profileDir =
    process.env.DEEPSEEK_CHROME_PROFILE ||
    path.join(repoRoot, '.chrome-for-testing-profile-deepseek');
// Use a dedicated default port so an older normal-Chrome auth window on 9333 is not reused.
const port = Number(process.env.DEEPSEEK_CHROME_PORT || 9334);
const outPath =
    process.env.DEEPSEEK_AUTH_PATH || path.join(repoRoot, 'deepseek-auth.json');
const url = 'https://chat.deepseek.com/';
const reuseChrome = /^(1|true|yes|on)$/i.test(
    process.env.DEEPSEEK_REUSE_CHROME || '',
);
const keepProfile = /^(1|true|yes|on)$/i.test(
    process.env.DEEPSEEK_KEEP_CHROME_PROFILE || '',
);

function shellPatternSafe(s) {
    return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
}

function killExistingTestingChrome() {
    if (process.platform !== 'darwin') return;
    const patterns = [`--remote-debugging-port=${port}`, profileDir].map(
        shellPatternSafe,
    );
    for (const pattern of patterns) {
        try {
            execFileSync('/usr/bin/pkill', ['-f', pattern], {
                stdio: 'ignore',
            });
        } catch {}
    }
    sleepSync(800);
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 250,
            });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                const staleDir = `${dir}.stale-${Date.now()}`;
                fs.renameSync(dir, staleDir);
                try {
                    fs.rmSync(staleDir, {
                        recursive: true,
                        force: true,
                        maxRetries: 3,
                        retryDelay: 250,
                    });
                } catch {}
                console.log(
                    `[auth] Old profile was busy; moved it aside: ${staleDir}`,
                );
                return;
            }
        }
        sleepSync(300);
    }
}

// Puppeteer's bundled "Google Chrome for Testing", when puppeteer is installed here or
// next to FreeQwenApi. The rest of the search lives in lib/chrome-setup.js.
function puppeteerExecutables() {
    const found = [];
    for (const base of [repoRoot, qwenRepoRoot]) {
        try {
            const puppeteer = require(require.resolve('puppeteer', { paths: [base] }));
            if (typeof puppeteer.executablePath === 'function') {
                const p = puppeteer.executablePath();
                if (p) found.push(p);
            }
        } catch {}
    }
    return found;
}

function locate() {
    return locateChrome({ puppeteer: puppeteerExecutables() });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function fetchJson(u, opts) {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
    return await r.json();
}
async function devtoolsReady() {
    try {
        return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
        return null;
    }
}
async function waitDevtools() {
    for (let i = 0; i < 80; i++) {
        const v = await devtoolsReady();
        if (v) return v;
        await sleep(250);
    }
    throw new Error('Chrome DevTools endpoint did not start');
}
async function getPageTarget() {
    for (let i = 0; i < 40; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
        const page =
            targets.find(
                (t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url),
            ) || targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No Chrome page target found');
}
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                msg.error
                    ? reject(new Error(JSON.stringify(msg.error)))
                    : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 1000) this.events.shift();
            }
        };
    }
    ready() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Chrome DevTools timed out: ${method}`));
            }, 10000);
            this.pending.set(id, { resolve, reject, timer });
        });
    }
    close() {
        try {
            this.ws.close();
        } catch {}
    }
}
function parseMaybeJson(s) {
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}
function normalizeToken(raw) {
    if (!raw) return '';
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object')
        return (
            parsed.value ||
            parsed.token ||
            parsed.access_token ||
            parsed.accessToken ||
            ''
        );
    return String(raw).trim();
}
async function readPageAuth(cdp) {
    const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
      const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
      for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
      for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
      out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
      return out;
    })()`,
        returnByValue: true,
    });
    const pageState = evalRes.result.value || {};
    const stores = [
        pageState.localStorage || {},
        pageState.sessionStorage || {},
    ];
    let token = '';
    for (const store of stores) {
        for (const key of [
            'userToken',
            'token',
            'auth_token',
            'access_token',
            'accessToken',
        ]) {
            token = normalizeToken(store[key]);
            if (token) break;
        }
        if (token) break;
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k)) {
                    token = normalizeToken(v);
                    if (token) break;
                }
            }
            if (token) break;
        }
    }

    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter((c) =>
        /deepseek\.com$/.test(c.domain),
    );
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    let hif_dliq = '',
        hif_leim = '';
    for (const ev of cdp.events) {
        const headers = ev.params?.headers || ev.params?.request?.headers;
        if (!headers) continue;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'x-hif-dliq') hif_dliq = String(v);
            if (lk === 'x-hif-leim') hif_leim = String(v);
            if (
                lk === 'authorization' &&
                !token &&
                /^Bearer\s+/i.test(String(v))
            )
                token = String(v).replace(/^Bearer\s+/i, '');
        }
    }

    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    return {
        token,
        cookie,
        hif_dliq,
        hif_leim,
        wasmUrl,
        baseUrl: 'https://chat.deepseek.com',
        href: pageState.href,
        cookiesCount: cookies.length,
    };
}
function chromeInstallHelp(checked) {
    const list = checked.length
        ? checked.map((c) => `  ✗ ${c.path}  (${c.source})`).join('\n')
        : '  (no locations for this platform)';
    return `Chrome/Chrome for Testing not found. Checked:
${list}

How to fix:
  Windows PowerShell:
    $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; npm run auth
    # or install Chrome normally: ${CHROME_DOWNLOAD_URL}

  macOS:
    brew install --cask google-chrome
    # or download it: ${CHROME_DOWNLOAD_URL}
    # or point at another install:
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth

  Linux / Chromium:
    CHROME_PATH=$(which chromium) npm run auth
    # Ubuntu example: sudo apt install chromium-browser || sudo apt install chromium

If Chrome is installed elsewhere, set CHROME_PATH to the real executable path.`;
}

// A missing browser is a setup problem with its own help text, not a crash.
class ChromeMissingError extends Error {}

const SPIN = ['◐', '◓', '◑', '◒'];
const isInteractive = () =>
    Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

function shortPath(p) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" → "/Applications/Google Chrome.app".
function displayPath(p) {
    return shortPath(p.replace(/(\.app)\/Contents\/MacOS\/[^/]+$/, '$1'));
}

// Rows are padded to one width so the centered list lines up as a column.
function checkedRows(lang, checked, shown = checked.length) {
    const rows = checked.map((c) => ({
        ok: c.ok,
        label: c.source === 'CHROME_PATH' ? 'CHROME_PATH' : t(lang, 'chromeChecked'),
        value: displayPath(c.path),
    }));
    const width = Math.max(0, ...rows.map((r) => visibleWidth(r.value)));
    return rows.slice(0, shown).map((r) => ({ ...r, value: r.value.padEnd(width) }));
}

// Searches with a short reveal animation so the user sees what was checked.
async function searchAnimated(langRef) {
    const found = locate();
    const stepMs = 110;
    const tickMs = 180;
    await runProgress(
        (tick) => {
            const shown = Math.min(found.checked.length, Math.floor((tick * tickMs) / stepMs));
            return {
                lang: langRef.current,
                subtitle: t(langRef.current, 'login'),
                status: [
                    { ok: true, label: '', value: `${SPIN[tick % 4]}  ${t(langRef.current, 'chromeSearching')}` },
                    ...checkedRows(langRef.current, found.checked, shown),
                ],
                items: [],
            };
        },
        () => sleep(Math.min(2000, stepMs * found.checked.length + 400)),
    );
    return found;
}

function lastLines(text, n) {
    return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n);
}

// Runs `brew install --cask google-chrome` behind a spinner. stdin is closed, so a
// sudo or confirmation prompt fails fast instead of hanging under the raw-mode TUI.
async function brewInstall(langRef, brew) {
    const { cmd, args } = brewInstallCommand(brew);
    let output = '';
    const startedAt = Date.now();
    const code = await runProgress(
        (tick) => {
            const secs = Math.floor((Date.now() - startedAt) / 1000);
            const tail = lastLines(output, 1)[0] || `${cmd} ${args.join(' ')}`;
            return {
                lang: langRef.current,
                subtitle: t(langRef.current, 'installBrew'),
                status: [
                    { ok: true, label: '', value: `${SPIN[tick % 4]}  ${t(langRef.current, 'brewInstalling')}  ${secs}s` },
                    { ok: true, label: 'brew', value: tail.length > 70 ? `${tail.slice(0, 69)}…` : tail },
                ],
                items: [],
            };
        },
        () => new Promise((resolve) => {
            const child = spawn(cmd, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
            });
            child.stdout.on('data', (d) => { output += d; });
            child.stderr.on('data', (d) => { output += d; });
            child.on('error', (err) => { output += `\n${err.message}`; resolve(-1); });
            child.on('close', (status) => resolve(status));
        }),
    );
    return { ok: code === 0, output };
}

function openUrl(target) {
    const { cmd, args } = browserOpenCommand(process.platform, target);
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', (err) => resolve(err.message));
        child.on('spawn', () => { child.unref(); resolve(null); });
    });
}

// Returns a Chrome executable path, or null when the user backs out.
async function ensureChrome(langRef) {
    const quick = locate();
    if (quick.path) return quick.path;
    if (!isInteractive()) throw new ChromeMissingError(chromeInstallHelp(quick.checked));

    let found = await searchAnimated(langRef);
    let notes = [];
    while (!found.path) {
        const brew = findBrew();
        const chosen = await pick(
            () => {
                const lang = langRef.current;
                const items = [];
                if (brew) items.push({ id: 'brew', label: t(lang, 'installBrew'), help: t(lang, 'helpInstallBrew') });
                items.push(
                    { id: 'site', label: t(lang, 'openChromeSite'), help: t(lang, 'helpOpenChromeSite') },
                    { id: 'retry', label: t(lang, 'retryChrome'), help: t(lang, 'helpRetryChrome') },
                    { id: 'back', label: t(lang, 'back'), help: t(lang, 'pressEnter') },
                );
                return {
                    lang,
                    subtitle: t(lang, 'chromeMissing'),
                    status: [
                        { ok: false, label: '', value: `${C.bold}${t(lang, 'chromeMissing')}${C.reset}` },
                        ...checkedRows(lang, found.checked),
                        ...(process.platform === 'darwin'
                            ? [{ ok: Boolean(brew), label: 'Homebrew', value: brew ? shortPath(brew) : t(lang, 'brewMissing') }]
                            : []),
                        ...notes.map((n) => ({ ok: n.ok, label: '', value: n.text })),
                    ],
                    items,
                };
            },
            (next) => { langRef.current = next; saveUiLang(next); },
            { cancelId: 'back' },
        );
        notes = [];
        if (chosen.id === 'brew') {
            const res = await brewInstall(langRef, brew);
            if (!res.ok) {
                notes = [
                    { ok: false, text: t(langRef.current, 'brewFailed') },
                    ...lastLines(res.output, 3).map((l) => ({ ok: false, text: l.length > 90 ? `${l.slice(0, 89)}…` : l })),
                ];
            }
            found = await searchAnimated(langRef);
        } else if (chosen.id === 'site') {
            const err = await openUrl(CHROME_DOWNLOAD_URL);
            notes = [{ ok: !err, text: err ? `${CHROME_DOWNLOAD_URL} — ${err}` : t(langRef.current, 'siteOpened') }];
        } else if (chosen.id === 'retry') {
            found = await searchAnimated(langRef);
        } else {
            return null;
        }
    }
    return found.path;
}

async function main() {
    const langRef = { current: loadUiLang() };
    const chromePath = await ensureChrome(langRef);
    if (!chromePath) {
        process.exitCode = 3;
        return;
    }
    const cdp = await runProgress(
        (tick) => ({
            lang: langRef.current,
            subtitle: t(langRef.current, 'login'),
            status: [{
                ok: true,
                label: '',
                value: `${['◐', '◓', '◑', '◒'][tick % 4]}  ${t(langRef.current, 'openingChrome')}`,
            }],
            items: [],
        }),
        async () => {
            if (!reuseChrome) {
                killExistingTestingChrome();
                if (!keepProfile && fs.existsSync(profileDir)) {
                    removeProfileSafely(profileDir);
                }
            }
            fs.mkdirSync(profileDir, { recursive: true });

            if (!(reuseChrome && (await devtoolsReady()))) {
                const chrome = spawn(
                    chromePath,
                    [
                        `--user-data-dir=${profileDir}`,
                        `--remote-debugging-port=${port}`,
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
                    ],
                    { stdio: 'ignore', detached: true },
                );
                chrome.unref();
            }

            await waitDevtools();
            const target = await getPageTarget();
            const connection = new CDP(target.webSocketDebuggerUrl);
            await connection.ready();
            await connection.send('Runtime.enable');
            await connection.send('Network.enable');
            return connection;
        },
    );

    const ready = await pick(
        () => ({
            lang: langRef.current,
            subtitle: t(langRef.current, 'login'),
            status: [
                { ok: true, label: 'Chrome', value: t(langRef.current, 'chromeOpen') },
                { ok: true, label: '', value: t(langRef.current, 'sendTest') },
            ],
            items: [
                { id: 'continue', label: t(langRef.current, 'continue'), help: t(langRef.current, 'sendTest') },
                { id: 'quit', label: t(langRef.current, 'cancelled'), help: t(langRef.current, 'back') },
            ],
        }),
        (next) => { langRef.current = next; saveUiLang(next); },
    );
    if (ready.id !== 'continue') {
        cdp.close();
        return;
    }

    const auth = await runProgress(
        (tick) => ({
            lang: langRef.current,
            subtitle: t(langRef.current, 'login'),
            status: [{
                ok: true,
                label: '',
                value: `${['◐', '◓', '◑', '◒'][tick % 4]}  ${t(langRef.current, 'readingSession')}`,
            }],
            items: [],
        }),
        async () => {
            let captured = null;
            for (let i = 0; i < 20; i++) {
                captured = await readPageAuth(cdp);
                if (captured.token && captured.cookie) break;
                await sleep(500);
            }
            return captured;
        },
    );
    const { href, cookiesCount, ...persisted } = auth;
    fs.writeFileSync(outPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(outPath, 0o600);
    cdp.close();
    const success = Boolean(persisted.token && persisted.cookie);
    const result = await pick(
        () => ({
            lang: langRef.current,
            subtitle: t(langRef.current, success ? 'done' : 'importFail'),
            status: [
                { ok: success, label: '', value: success ? t(langRef.current, 'authReady') : t(langRef.current, 'importFail') },
                { ok: Boolean(persisted.token), label: t(langRef.current, 'token'), value: persisted.token ? `${persisted.token.length} chars` : t(langRef.current, 'missing') },
                { ok: Boolean(persisted.cookie), label: t(langRef.current, 'cookies'), value: persisted.cookie ? String(cookiesCount) : t(langRef.current, 'missing') },
                { ok: Boolean(href), label: t(langRef.current, 'session'), value: outPath },
            ],
            items: success && process.env.FREDEEPSEEK_EMBEDDED
                ? [
                    { id: 'setup', label: t(langRef.current, 'configureAgents'), help: t(langRef.current, 'setupSubtitle') },
                    { id: 'back', label: t(langRef.current, 'back'), help: t(langRef.current, 'pressEnter') },
                ]
                : [
                    { id: 'back', label: t(langRef.current, 'done'), help: t(langRef.current, 'pressEnter') },
                ],
        }),
        (next) => { langRef.current = next; saveUiLang(next); },
    );
    if (!success) process.exitCode = 2;
    else if (result.id === 'setup') process.exitCode = 10;
}
main().catch((e) => {
    if (e instanceof ChromeMissingError) console.error(`[auth] ${e.message}`);
    else console.error('[auth] ERROR:', e);
    process.exit(1);
});
