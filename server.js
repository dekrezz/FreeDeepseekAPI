#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset when message chain reaches 100 messages or age > 2 hours.
 * Listens on 127.0.0.1:9655 by default (HOST is configurable)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const pow = require('./lib/pow');
const { t, loadUiLang, saveUiLang, pick, pause, printWordmark, browserOpenCommand } = require('./scripts/lib/tui-menu');

// Per-DeepSeek-request network timeout. Plain fetch() has NO default timeout, so a
// stalled upstream would hang the inbound request (and pin the account) forever.
const DS_FETCH_TIMEOUT_MS = Number(process.env.DEEPSEEK_FETCH_TIMEOUT_MS || 60000);
function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

const SERVER_HOST = os.hostname();  // Dynamic hostname detection
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

const PORT = Number(process.env.PORT || 9655);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        // A missing optional secret is equivalent to an unset key. Container
        // deployments set REQUIRE_PROXY_API_KEY=1 and fail closed in main().
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

const PROXY_API_KEY = loadProxyApiKey();
const PROXY_ADMIN_ALLOW_REMOTE = isTruthy(process.env.PROXY_ADMIN_ALLOW_REMOTE);
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));
function printBanner() {
    printWordmark();
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY) {
    if (!expectedKey) return true;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true; // curl, SDKs, and other non-browser clients
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-FreeDeepseek-Context-Compacted';
function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}
function markContextCompacted(res) {
    res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
}

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID (from `user` field)
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_MESSAGE_DEPTH = 100;  // auto-reset after this many messages
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

// === DeepSeek Web API Config — loaded from external config file ===
const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const ACCOUNTS_DIR = process.env.DEEPSEEK_AUTH_DIR || path.join(__dirname, 'accounts');
const DEFAULT_ACCOUNT_COOLDOWN_MS = Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000);
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;
let inFlight = 0;  // concurrent in-flight completions (backpressure cap)
// Overall wall-clock budget for one inbound request (caps the retry/continuation
// loops), max concurrent completions, and the empty-response retry cap.
const REQUEST_DEADLINE_MS = Number(process.env.DEEPSEEK_REQUEST_DEADLINE_MS || 120000);
const ACCOUNT_LOCK_WAIT_MS = Number(process.env.DEEPSEEK_ACCOUNT_LOCK_WAIT_MS || REQUEST_DEADLINE_MS);
const MAX_CONCURRENT = Number(process.env.DEEPSEEK_MAX_CONCURRENT || 24);
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;
const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const CONTEXT_OVERFLOW_MIN_CHARS = 8000;
const MAX_OVERFLOW_RETRIES = 3;
const INSTANT_EMPTY_MS = 1500;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;
function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.2",
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": "2.0.2",
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}
function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    const files = [];
    if (fs.existsSync(DS_CONFIG_PATH)) files.push(path.resolve(DS_CONFIG_PATH));
    try {
        if (fs.existsSync(ACCOUNTS_DIR) && fs.statSync(ACCOUNTS_DIR).isDirectory()) {
            for (const name of fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).sort()) {
                files.push(path.resolve(ACCOUNTS_DIR, name));
            }
        }
    } catch (e) {
        console.error(`[DS-API] Could not read accounts dir: ${e.message}`);
    }
    return files.length ? [...new Set(files)] : [DS_CONFIG_PATH];
}
function uniqueAccountId(file, takenIds) {
    const base = path.basename(file, '.json').replace(/[^a-zA-Z0-9._-]/g, '_') || 'account';
    let id = base;
    let n = 2;
    while (takenIds.has(id)) {
        id = `${base}_${n}`;
        n++;
    }
    return id;
}
// Error text for an unreadable auth file. Never echo JSON.parse snippets (they can
// contain token/cookie fragments) or fs messages (they contain absolute paths).
function describeAuthFileError(error) {
    if (error instanceof SyntaxError) return 'invalid JSON';
    if (error?.code) return `could not read file (${error.code})`;
    return String(error?.message || 'could not load file');
}
function readAccountFiles(paths) {
    const loaded = [];
    const errors = [];
    for (const file of paths) {
        try {
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!config || typeof config !== 'object' || Array.isArray(config)) {
                throw new Error('expected a JSON object');
            }
            loaded.push({ file, config });
        } catch (e) {
            errors.push({ file, message: describeAuthFileError(e) });
        }
    }
    return { loaded, errors };
}
function newAccountRuntimeState() {
    return {
        cooldownUntil: 0,
        cooldownReason: null,
        failures: 0,
        totalFailures: 0,
        lastError: null,
        lastSuccessAt: 0,
        lastUsedAt: 0,
        adminDisabled: false,
    };
}
// Build the next account list. Accounts are matched to `previous` by resolved file
// path: a kept login keeps its id and runtime state (cooldown, admin pause, counters),
// while its config and headers are refreshed. A changed token or cookie is a fresh
// login, so its cooldown and failure state are cleared.
function buildAccountsList(loaded, previous = []) {
    const previousByFile = new Map(previous.filter(a => a.file).map(a => [path.resolve(a.file), a]));
    const takenIds = new Set();
    const result = new Array(loaded.length);
    const added = [];
    const kept = [];
    const relogged = [];
    loaded.forEach(({ file, config }, index) => {
        const prev = previousByFile.get(path.resolve(file));
        if (!prev || takenIds.has(prev.id)) return;
        previousByFile.delete(path.resolve(file));
        takenIds.add(prev.id);
        const credentialsChanged = prev.config?.token !== config.token || prev.config?.cookie !== config.cookie;
        prev.file = file;
        prev.config = config;
        prev.headers = buildBaseHeaders(config);
        if (credentialsChanged) {
            prev.cooldownUntil = 0;
            prev.cooldownReason = null;
            prev.failures = 0;
            prev.lastError = null;
            relogged.push(prev.id);
        }
        result[index] = prev;
        kept.push(prev.id);
    });
    loaded.forEach(({ file, config }, index) => {
        if (result[index]) return;
        const id = uniqueAccountId(file, takenIds);
        takenIds.add(id);
        result[index] = { id, file, config, headers: buildBaseHeaders(config), ...newAccountRuntimeState() };
        added.push(id);
    });
    const removed = [...previousByFile.values()].map(a => a.id);
    return { list: result, added, kept, removed, relogged };
}
function applyAccountsList({ list, relogged = [] }) {
    accounts.splice(0, accounts.length, ...list);
    // Remote chats belong to the DeepSeek user that created them. After a re-login
    // (new token/cookie) they may be foreign, so pinned sessions start a fresh chat
    // with their local recovery history. Removed accounts rotate via selectAccountForSession.
    const reloggedIds = new Set(relogged);
    for (const session of sessions.values()) {
        if (session.id && reloggedIds.has(session.accountId)) resetRemoteSession(session);
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
}
function loadDeepSeekConfig({ fatal = true } = {}) {
    const paths = discoverAuthPaths();
    const { loaded, errors } = readAccountFiles(paths);
    for (const error of errors) {
        console.error(`[DS-API] Could not load auth config ${error.file}: ${error.message}`);
    }
    applyAccountsList(buildAccountsList(loaded, accounts));
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}
function hasAuthConfig() { return accounts.some(accountHasCredentials); }
function accountHasCredentials(account) {
    return Boolean(account?.config?.token && account?.config?.cookie);
}
function isAccountEnabled(account) {
    return account?.config?.enabled !== false && account?.adminDisabled !== true;
}
function accountCanServe(account, now = Date.now()) {
    return accountHasCredentials(account) && isAccountEnabled(account) && (account.cooldownUntil || 0) <= now;
}
const accountLocks = new Map();
const requestLog = [];
const MAX_REQUEST_LOG = 400;
const usageByAccount = new Map();

function accountStatus(account) {
    const lock = accountLocks.get(account.id);
    const usage = usageByAccount.get(account.id) || { prompt_tokens: 0, completion_tokens: 0, usd: 0, requests: 0 };
    return {
        id: account.id,
        name: String(account.config.name || account.id),
        file: path.basename(account.file || ''),
        enabled: isAccountEnabled(account),
        ready: accountHasCredentials(account),
        token: Boolean(account.config.token),
        cookies: String(account.config.cookie || '').split(';').filter(Boolean).length,
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        busy: Boolean(lock),
        busy_agent: lock?.agentId || null,
        // Lifetime count (the pre-admin /health contract). Consecutive failures,
        // which reset on a served request, are in /admin/accounts.
        failures: account.totalFailures || 0,
        last_used_at: account.lastUsedAt || null,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        usd: usage.usd,
        requests: usage.requests,
    };
}
function isLockedByOther(account, holder) {
    const lock = accountLocks.get(account.id);
    return Boolean(lock && holder && lock.holder !== holder);
}
function concurrentChatBlocked(message, extra = {}) {
    const err = new Error(message);
    err.status = 429;
    err.retryAfter = extra.retryAfter || 1;
    err.type = 'concurrent_chat_blocked';
    if (extra.busy_agent) err.busy_agent = extra.busy_agent;
    return err;
}
function createAccountLock(holder) {
    let notify;
    const released = new Promise(resolve => { notify = resolve; });
    return { holder, agentId: holder.agentId || null, since: Date.now(), released, notify };
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function acquireAccountChatLock(account, holder, timeoutMs = ACCOUNT_LOCK_WAIT_MS) {
    if (!account || !holder) return false;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let waited = false;
    while (true) {
        const current = accountLocks.get(account.id);
        if (!current || current.holder === holder) {
            if (!current) accountLocks.set(account.id, createAccountLock(holder));
            return waited;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw concurrentChatBlocked(
                `Account ${account.id} is busy with another request. One DeepSeek login serves one in-flight chat.`,
                { retryAfter: 1, busy_agent: current.agentId },
            );
        }
        waited = true;
        await Promise.race([current.released, sleep(Math.min(remaining, 50))]);
    }
}
function releaseAccountChatLock(holder) {
    if (!holder) return;
    for (const [id, lock] of accountLocks) {
        if (lock.holder === holder) {
            accountLocks.delete(id);
            lock.notify();
        }
    }
}
function listAccountChatLocks() {
    const now = Date.now();
    return [...accountLocks.entries()].map(([id, lock]) => ({
        account: id,
        agent: lock.agentId || null,
        age_ms: now - lock.since,
    }));
}
// The request named one login (x-account-id). Serve it or say exactly why not; never
// hand the request to another login behind the caller's back.
function pinnedAccountError(status, type, message, retryAfter = null) {
    const err = new Error(message);
    err.status = status;
    err.type = type;
    if (retryAfter) err.retryAfter = retryAfter;
    return err;
}
function selectPinnedAccount(session, pinnedId, now) {
    const account = accounts.find(a => a.id === pinnedId);
    if (!account) throw pinnedAccountError(404, 'account_not_found', `Account ${pinnedId} is not loaded. Pick another account or reload accounts.`);
    if (!accountHasCredentials(account)) throw pinnedAccountError(409, 'account_unavailable', `Account ${pinnedId} has no credentials. Import a fresh login for it.`);
    if (!isAccountEnabled(account)) throw pinnedAccountError(409, 'account_unavailable', `Account ${pinnedId} is paused. Resume it in /dashboard or pick another account.`);
    if ((account.cooldownUntil || 0) > now) {
        const waitSec = Math.max(1, Math.ceil((account.cooldownUntil - now) / 1000));
        throw pinnedAccountError(429, 'rate_limit', `Account ${pinnedId} is cooling down for ~${waitSec}s. Wait, or pick another account.`, waitSec);
    }
    if (session.accountId !== account.id) {
        // The remote chat belongs to the login that created it.
        if (session.accountId) resetRemoteSession(session);
        session.accountId = account.id;
    }
    return account;
}
function selectAccountForSession(session, holder = null) {
    const now = Date.now();
    if (holder?.pinnedAccountId) return selectPinnedAccount(session, String(holder.pinnedAccountId), now);
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && accountCanServe(sticky, now)) {
            return sticky;
        }
        // A DeepSeek chat_session belongs to the auth account that created it.
        // If that account disappeared, lost credentials, is paused, or is cooling down,
        // never reuse its session id under a different account.
        resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter(a => accountCanServe(a, now));
    if (ready.length === 0) {
        const waiting = accounts.filter(a => accountHasCredentials(a) && isAccountEnabled(a)).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            // Tagged so the request handler returns 429 + Retry-After instead of a
            // generic 500 (integrator backoff keys on the status code, not the text).
            const err = new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const switchedOff = accounts.filter(a => accountHasCredentials(a) && !isAccountEnabled(a)).map(a => a.id);
        const noAuth = new Error(switchedOff.length
            ? `Every DeepSeek auth account with credentials is paused or disabled (${switchedOff.join(', ')}). Resume one in /dashboard, or set "enabled": true in its auth file and reload.`
            : 'No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const idle = holder ? ready.filter(a => !isLockedByOther(a, holder)) : ready;
    const pool = idle.length > 0 ? idle : ready;
    pool.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0) || a.id.localeCompare(b.id));
    const account = pool[0];
    accountRoundRobin++;
    session.accountId = account.id;
    return account;
}
function clientIp(req) {
    const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (raw === '::1') return '127.0.0.1';
    if (isTruthy(process.env.TRUST_PROXY)) {
        const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (fwd) return fwd;
    }
    return raw || 'unknown';
}
// Flat estimate for every model (DeepSeek API list prices); the web path has no billing.
const USD_PER_M_INPUT = 0.22;
const USD_PER_M_OUTPUT = 0.66;
function modelCostUsd(model, promptTokens, completionTokens) {
    return (Number(promptTokens || 0) / 1e6) * USD_PER_M_INPUT + (Number(completionTokens || 0) / 1e6) * USD_PER_M_OUTPUT;
}
// Request statistics for the dashboard. Metadata only: never prompt or answer text.
// requestLog keeps the last MAX_REQUEST_LOG rows; usageMinutes keeps per-minute
// aggregates (totals plus per account/model/endpoint/agent) for USAGE_RETENTION_MS,
// so time series outlive the row cap. Everything is in memory and resets on restart.
const USAGE_MINUTE_MS = 60 * 1000;
const USAGE_RETENTION_MS = 24 * 60 * 60 * 1000;
const USAGE_MAX_KEYS_PER_DIMENSION = 50;  // per minute; extra keys fold into '(other)'
const LOG_TEXT_MAX_CHARS = 300;
const STATS_STARTED_AT = Date.now();
const usageMinutes = new Map();  // minute start ms -> bucket
let requestSeq = 0;
let lifetimeUsage = newUsageCounters();
function newUsageCounters() {
    return { requests: 0, ok: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, usd: 0, ms_total: 0 };
}
function addUsage(counters, entry) {
    counters.requests += 1;
    if (entry.ok) counters.ok += 1; else counters.errors += 1;
    counters.prompt_tokens += entry.prompt_tokens || 0;
    counters.completion_tokens += entry.completion_tokens || 0;
    counters.reasoning_tokens += entry.reasoning_tokens || 0;
    counters.usd += entry.usd || 0;
    counters.ms_total += entry.ms || 0;
}
function apiForPath(pathname) {
    if (pathname === '/v1/messages') return 'anthropic';
    if (pathname === '/v1/responses') return 'responses';
    return 'openai';
}
// Replace credential values of loaded accounts and bearer tokens, then clip.
// Applied when a row is stored and again when it is served.
function scrubLogText(text) {
    if (text === null || text === undefined || text === '') return null;
    let out = String(text);
    const secrets = new Set();
    for (const account of accounts) {
        const config = account.config || {};
        for (const value of [config.token, config.hif_dliq, config.hif_leim]) {
            if (typeof value === 'string' && value.length >= 6) secrets.add(value);
        }
        for (const pair of String(config.cookie || '').split(';')) {
            const value = pair.slice(pair.indexOf('=') + 1).trim();
            if (pair.includes('=') && value.length >= 6) secrets.add(value);
        }
    }
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
    out = out.replace(/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
    return out.length > LOG_TEXT_MAX_CHARS ? `${out.slice(0, LOG_TEXT_MAX_CHARS - 1)}…` : out;
}
function addUsageToMinute(entry) {
    const now = Date.now();
    const ts = Number(entry.ts) || now;
    if (ts < now - USAGE_RETENTION_MS) return;
    const minute = Math.floor(ts / USAGE_MINUTE_MS) * USAGE_MINUTE_MS;
    let bucket = usageMinutes.get(minute);
    if (!bucket) {
        for (const key of usageMinutes.keys()) if (key < now - USAGE_RETENTION_MS - USAGE_MINUTE_MS) usageMinutes.delete(key);
        bucket = { totals: newUsageCounters(), account: new Map(), model: new Map(), endpoint: new Map(), agent: new Map() };
        usageMinutes.set(minute, bucket);
    }
    addUsage(bucket.totals, entry);
    const dims = { account: entry.account ?? null, model: entry.model ?? null, endpoint: entry.path ?? null, agent: entry.agent ?? null };
    for (const [dim, rawKey] of Object.entries(dims)) {
        const map = bucket[dim];
        const key = rawKey === null ? null : String(rawKey).slice(0, 200);
        const slot = map.has(key) || map.size < USAGE_MAX_KEYS_PER_DIMENSION ? key : '(other)';
        if (!map.has(slot)) map.set(slot, newUsageCounters());
        addUsage(map.get(slot), entry);
    }
}
function recordRequest(entry) {
    entry.id = ++requestSeq;
    if (!entry.api) entry.api = apiForPath(entry.path);
    entry.error_message = scrubLogText(entry.error_message);
    requestLog.push(entry);
    while (requestLog.length > MAX_REQUEST_LOG) requestLog.shift();
    addUsage(lifetimeUsage, entry);
    addUsageToMinute(entry);
    if (!entry.account) return;
    const prev = usageByAccount.get(entry.account) || { prompt_tokens: 0, completion_tokens: 0, usd: 0, requests: 0 };
    prev.prompt_tokens += entry.prompt_tokens || 0;
    prev.completion_tokens += entry.completion_tokens || 0;
    prev.usd += entry.usd || 0;
    prev.requests += 1;
    usageByAccount.set(entry.account, prev);
}
function clearRequestStats() {
    requestLog.length = 0;
    usageByAccount.clear();
    usageMinutes.clear();
    lifetimeUsage = newUsageCounters();
}
function jsonResponse(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
}
// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports both forms: delta-seconds (e.g. "120") and an
// HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Clamped to >= 1s.
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}
function clipText(value, max = 200) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.substring(0, max - 1)}…` : text;
}
function countAccountFailure(account, kind, status, detail) {
    account.failures = (account.failures || 0) + 1;
    account.totalFailures = (account.totalFailures || 0) + 1;
    account.lastError = { kind, status: Number(status) || null, message: clipText(detail), at: Date.now() };
}
// Put a login on cooldown after DeepSeek throttled it (HTTP 429, a "too frequent"
// message in any HTTP/JSON body, or an in-stream hint with rate_limit_reached).
// Retry-After wins when present; otherwise DEEPSEEK_ACCOUNT_COOLDOWN_MS applies.
function markAccountRateLimited(account, detail = '', retryAfterRaw = null, status = 429, reason = '') {
    if (!account) return 0;
    const retryMs = parseRetryAfterMs(retryAfterRaw);
    const cooldownMs = retryMs != null ? retryMs : DEFAULT_ACCOUNT_COOLDOWN_MS;
    account.cooldownUntil = Math.max(account.cooldownUntil || 0, Date.now() + cooldownMs);
    account.cooldownReason = 'rate_limit';
    countAccountFailure(account, 'rate_limit', status, detail);
    console.log(`[account:${account.id}] rate-limited${reason ? ` (${reason})` : ''}: cooldown for ${Math.round(cooldownMs / 1000)}s${retryMs != null ? ' (Retry-After)' : ''} after HTTP ${status}: ${clipText(detail, 120)}`);
    return cooldownMs;
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null, detail = '') {
    if (!account) return;
    const code = Number(status);
    if (code === 429 || isRateLimitSignal(detail)) {
        markAccountRateLimited(account, detail || `HTTP ${code}`, retryAfterRaw, code, reason);
        return;
    }
    if (code === 401 || code === 403) {
        countAccountFailure(account, 'auth', code, detail || `HTTP ${code}`);
        account.cooldownUntil = Math.max(account.cooldownUntil || 0, Date.now() + DEFAULT_ACCOUNT_COOLDOWN_MS);
        account.cooldownReason = 'auth';
        console.log(`[account:${account.id}] cooldown for ${Math.round(DEFAULT_ACCOUNT_COOLDOWN_MS / 1000)}s after HTTP ${code}${reason ? ` (${reason})` : ''}`);
        return;
    }
    // Any other upstream failure (plain 400, 5xx, malformed body) is counted but
    // does not pause the login: it says nothing about this login's quota.
    countAccountFailure(account, 'upstream', code, detail || `HTTP ${code}${reason ? ` (${reason})` : ''}`);
}
function recordAccountSuccess(account) {
    if (!account) return;
    account.failures = 0;
    account.lastSuccessAt = Date.now();
}
// Mark the login as rate-limited and return a typed 429 the request handler
// recognizes as "fail over to another login".
function accountRateLimitError(account, detail, retryAfterRaw, label, status = 429) {
    const cooldownMs = markAccountRateLimited(account, detail, retryAfterRaw, status, label);
    const retryAfterSec = Math.max(1, Math.ceil(cooldownMs / 1000));
    const error = createUpstreamHttpError(429, detail || `DeepSeek rate-limited ${label}`, String(retryAfterSec));
    error.accountId = account?.id || null;
    error.accountRateLimited = true;
    return error;
}
function isAccountRateLimitError(error) {
    return error?.accountRateLimited === true;
}
function deepSeekJsonMessage(json) {
    if (!json || typeof json !== 'object') return '';
    return [json.data?.biz_msg, json.msg, json.message].filter(v => typeof v === 'string' && v.trim()).join(' ');
}
async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    const retryAfter = resp.headers.get('retry-after');
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            if (resp.status === 429 || isRateLimitSignal(text)) {
                throw accountRateLimitError(account, text, retryAfter, label, resp.status);
            }
            markAccountFailure(account, resp.status, label, retryAfter, text);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    const message = deepSeekJsonMessage(json);
    if (resp.status === 429 || isRateLimitSignal(message)) {
        throw accountRateLimitError(account, message || text, retryAfter, label, resp.status);
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label, retryAfter, message || text);
    return { json, text };
}
if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
}

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        sentSystemFingerprint: null,
        lastActivityAt: Date.now(),
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentSystemFingerprint = null;
    // Keep local recovery history and the sticky account assignment. A remote
    // chat can be unhealthy without invalidating either of those local hints.
    return failed;
}

// POST /reset-session: the next request opens a new DeepSeek chat. Local history is
// kept as a recovery hint unless the client drops it (it will send its own transcript,
// e.g. after editing a message, and the replaced turns must not come back).
function resetAgentSession(agentId, { dropHistory = false } = {}) {
    const session = sessions.get(agentId);
    if (!session) return null;
    if (dropHistory) session.history = [];
    const historyCount = session.history.length;
    const historyPreview = session.history.map(e => String(e.user || '').substring(0, 40)).join(' | ');
    resetRemoteSession(session);
    return { status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview };
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    let reason = null;
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth';
    else if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) reason = 'session_ttl';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}

// Evict idle sessions so the Map (keyed by client IP / user id) can't grow without
// bound on a long-running process. Drops entries untouched for 2× the session TTL.
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
    return removed;
}

// solvePOW() lives in lib/pow (compiled-module cache + WASM-fetch timeout),
// shared with client.js. Called as solvePOW(challenge, wasmUrl).

// DeepSeek Web as of 2026-09-20: Instant/Expert/Pro UI gone. One weight: V4.1-Flash.
// Official paid ID: deepseek-flash. Web model_type is always `default`.
// Native Web Search is on for every model unless the ID ends in `-nosearch` or the
// request sends `"web_search": false`. `-thinking` turns DeepThink on.
// The old `-search` IDs are hidden aliases (see LEGACY_SEARCH_SUFFIX).
const DEFAULT_MODEL_ID = 'deepseek-v4-flash';
function webModel({ model_type, thinking_enabled, search_enabled, real_model, capabilities, supported = true }) {
    return { model_type, thinking_enabled, search_enabled, real_model, capabilities, supported };
}

const MODEL_CONFIGS = {
    'deepseek-v4-flash': webModel({
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4.1-Flash (web search)',
        capabilities: { reasoning: false, web_search: true, files: true, vision: true },
    }),
    'deepseek-v4-flash-thinking': webModel({
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4.1-Flash (thinking + web search)',
        capabilities: { reasoning: true, web_search: true, files: true, vision: true },
    }),
    'deepseek-v4-flash-nosearch': webModel({
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4.1-Flash',
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
    }),
    'deepseek-v4-flash-thinking-nosearch': webModel({
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4.1-Flash (thinking)',
        capabilities: { reasoning: true, web_search: false, files: true, vision: true },
    }),
};

// Search used to be opt-in through a `-search` suffix. It is the default now,
// so those IDs resolve to the same model without the suffix.
const LEGACY_SEARCH_SUFFIX = /-search$/;

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

// DeepSeek Web throttles a login with localized text ("Слишком частые сообщения",
// "Too many requests", "请求过于频繁") in an HTTP 400/429 or JSON body, or with an
// in-stream `event: hint` whose finish_reason is rate_limit_reached.
// "rate limit" must not start inside a word ("generate limit", "moderate limit").
const RATE_LIMIT_PATTERN = /(?<![a-z])rate[\s_-]*limit|too\s+many\s+requests|too\s+frequent|слишком\s+част|частые\s+(?:сообщения|запросы)|频繁|请求过多|请求次数过多/i;
function isRateLimitSignal(signal) {
    if (!signal) return false;
    if (typeof signal === 'string') return RATE_LIMIT_PATTERN.test(signal);
    if (typeof signal !== 'object') return false;
    if (/rate_?limit/i.test(String(signal.finish_reason || ''))) return true;
    const text = [signal.content, signal.message, signal.msg, signal.biz_msg, signal.finish_reason, signal.type, signal.detail]
        .filter(value => typeof value === 'string' && value)
        .join(' ');
    return Boolean(text) && RATE_LIMIT_PATTERN.test(text);
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    if (Number(status) === 429 || isRateLimitSignal(detail)) {
        const error = new Error(`DeepSeek rate limit (upstream HTTP ${Number(status) || 429})${detail ? `: ${detail}` : ''}`);
        error.status = 429;
        error.type = 'rate_limit_error';
        if (retryAfter) error.retryAfter = retryAfter;
        return error;
    }
    if (isContextTooLongError(detail)) {
        const error = new Error(detail || 'DeepSeek prompt is too long');
        error.status = 400;
        error.type = 'context_length_exceeded';
        if (retryAfter) error.retryAfter = retryAfter;
        return error;
    }
    const code = Number(status) || 502;
    const type = (code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error';
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        }
    }
    return applied;
}

function canonicalizeModelId(model) {
    let id = String(model || DEFAULT_MODEL_ID).toLowerCase().trim();
    id = id.replace(/\[(?:1m|max|high|low)\]$/i, '');
    if (id === 'deepseek-flash' || id.startsWith('deepseek-flash-')) {
        id = id.replace(/^deepseek-flash/, 'deepseek-v4-flash');
    }
    if (LEGACY_SEARCH_SUFFIX.test(id)) {
        const current = id.replace(LEGACY_SEARCH_SUFFIX, '');
        if (Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, current)) return current;
    }
    if (Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, id)) return id;
    // Claude Code keeps shipping claude-* IDs unless ANTHROPIC_*_MODEL is set.
    if (/claude[-_. ]?opus/.test(id) || /opus-4/.test(id)) return 'deepseek-v4-flash-thinking';
    if (/claude[-_. ]?(sonnet|haiku)/.test(id)) return 'deepseek-v4-flash';
    return id;
}
function resolveModelConfig(model) {
    const requested = canonicalizeModelId(model);
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS[DEFAULT_MODEL_ID];
}
// `web_search` (boolean) in the request body overrides the model's search default.
function resolveRequestWebFlags(model, rawParams) {
    const cfg = resolveModelConfig(model);
    const value = rawParams?.web_search;
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
        const error = new Error(`web_search must be true or false, got ${JSON.stringify(value)}`);
        error.status = 400;
        error.type = 'invalid_request_error';
        throw error;
    }
    return {
        thinking_enabled: cfg.thinking_enabled,
        search_enabled: typeof value === 'boolean' ? value : cfg.search_enabled,
    };
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, canonicalizeModelId(model)); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion';
const DEEPSEEK_UPLOAD_PATH = '/api/v0/file/upload_file';
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_COUNT = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const FILE_PARSE_TIMEOUT_MS = 15000;
const FILE_PARSE_FAILURES = new Set([
    'FAILED', 'CONTENT_FILTER', 'CONTENT_TOO_LONG', 'CANCELLED', 'CONTENT_EMPTY',
    '_CUSTOM_SYSTEM_ERROR_FAIL', '_CUSTOM_FROM_SHARE',
]);

function clientInputError(message, type = 'invalid_request_error') {
    const error = new Error(message);
    error.status = 400;
    error.type = type;
    return error;
}

function normalizeImageMediaType(value) {
    const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType === 'image/jpg') return 'image/jpeg';
    return mediaType;
}

function imageExtension(mediaType) {
    return {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
    }[mediaType] || '';
}

function isPrivateNetworkAddress(address) {
    const value = String(address || '').toLowerCase().split('%', 1)[0];
    if (net.isIPv4(value)) {
        const parts = value.split('.').map(Number);
        const [a, b, c] = parts;
        return a === 0 || a === 10 || a === 127
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0 && (c === 0 || c === 2))
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19 || b === 51))
            || (a === 203 && b === 0 && c === 113)
            || a >= 224;
    }
    if (net.isIPv6(value)) {
        if (value === '::' || value === '::1') return true;
        if (value.startsWith('fc') || value.startsWith('fd')) return true;
        if (/^fe[89ab]/.test(value)) return true;
        const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? isPrivateNetworkAddress(mapped[1]) : false;
    }
    return true;
}

async function assertPublicImageUrl(url) {
    if (url.protocol !== 'https:') {
        throw clientInputError('Image URL must be a public HTTPS URL');
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw clientInputError('Image URL must be a public HTTPS URL');
    }
    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
        throw clientInputError(`Could not resolve image URL host: ${hostname}`);
    }
    if (!addresses.length || addresses.some(entry => isPrivateNetworkAddress(entry.address))) {
        throw clientInputError('Image URL must resolve only to public network addresses');
    }
    return addresses;
}

function safeImageFilename(candidate, mediaType, index) {
    const extension = imageExtension(mediaType);
    const base = path.basename(String(candidate || '')).replace(/[^A-Za-z0-9._-]/g, '_');
    if (base && imageExtension(mediaType) && base.toLowerCase().endsWith(extension)) return base;
    const stem = base ? base.replace(/\.[^.]*$/, '') : `image-${index + 1}`;
    return `${stem || `image-${index + 1}`}${extension}`;
}

function downloadPinnedImage(url, address) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { 'User-Agent': 'FreeDeepseekAPI image input' },
            lookup: (_hostname, options, callback) => {
                if (options?.all) callback(null, [address]);
                else callback(null, address.address, address.family);
            },
        }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                resolve({ status: response.statusCode, headers: response.headers, buffer: null });
                return;
            }
            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_IMAGE_BYTES) {
                    response.destroy(clientInputError(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`, 'payload_too_large'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                buffer: Buffer.concat(chunks),
            }));
            response.on('error', reject);
        });
        request.setTimeout(DS_FETCH_TIMEOUT_MS, () => request.destroy(new Error('Image URL request timed out')));
        request.on('error', reject);
    });
}

async function fetchPublicImage(sourceUrl, index) {
    let current;
    try { current = new URL(sourceUrl); }
    catch (error) { throw clientInputError('Image URL is invalid'); }

    for (let redirect = 0; redirect <= MAX_IMAGE_REDIRECTS; redirect++) {
        const addresses = await assertPublicImageUrl(current);
        let response;
        try {
            response = await downloadPinnedImage(current, addresses[0]);
        } catch (error) {
            if (error.status) throw error;
            throw clientInputError(`Could not download image URL: ${error.message}`);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.location;
            if (!location || redirect === MAX_IMAGE_REDIRECTS) {
                throw clientInputError('Image URL has too many redirects');
            }
            current = new URL(location, current);
            continue;
        }
        if (response.status < 200 || response.status >= 300) {
            throw clientInputError(`Could not download image URL: HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers['content-length'] || 0);
        if (declaredLength > MAX_IMAGE_BYTES) {
            throw clientInputError(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`, 'payload_too_large');
        }
        const mediaType = normalizeImageMediaType(response.headers['content-type']);
        if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
            throw clientInputError(`Unsupported image media type: ${mediaType || 'unknown'}`);
        }
        const buffer = response.buffer;
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
            throw clientInputError(`Image is empty or exceeds ${MAX_IMAGE_BYTES} byte limit`, 'payload_too_large');
        }
        return {
            buffer,
            mediaType,
            filename: safeImageFilename(current.pathname, mediaType, index),
        };
    }
    throw clientInputError('Image URL has too many redirects');
}

async function materializeImageInput(input, index = 0) {
    const url = String(input?.url || '');
    const dataUrl = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!dataUrl) return fetchPublicImage(url, index);

    const mediaType = normalizeImageMediaType(dataUrl[1]);
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        throw clientInputError(`Unsupported image media type: ${mediaType || 'unknown'}`);
    }
    const buffer = Buffer.from(dataUrl[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
        throw clientInputError(`Image is empty or exceeds ${MAX_IMAGE_BYTES} byte limit`, 'payload_too_large');
    }
    return {
        buffer,
        mediaType,
        filename: safeImageFilename(input.filename, mediaType, index),
    };
}

async function createDeepSeekPowHeader(account, targetPath) {
    const response = await dsFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST',
        headers: account.headers,
        body: JSON.stringify({ target_path: targetPath }),
    });
    const text = await response.text();
    const retryAfter = response.headers.get('retry-after');
    const label = `PoW challenge for ${targetPath}`;
    if (!response.ok) {
        if (response.status === 429 || isRateLimitSignal(text)) {
            throw accountRateLimitError(account, text, retryAfter, label, response.status);
        }
        markAccountFailure(account, response.status, label, retryAfter, text);
        throw createUpstreamHttpError(response.status, text, retryAfter);
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch (error) {
        if (isRateLimitSignal(text)) throw accountRateLimitError(account, text, retryAfter, label, response.status);
        throw new Error(`DeepSeek returned non-JSON PoW response for ${targetPath}. First chars: ${text.substring(0, 120)}`);
    }
    const challenge = payload?.data?.biz_data?.challenge;
    if (!challenge && isRateLimitSignal(deepSeekJsonMessage(payload))) {
        throw accountRateLimitError(account, deepSeekJsonMessage(payload), retryAfter, label, response.status);
    }
    if (!challenge) {
        throw new Error(`DeepSeek PoW response has no challenge for ${targetPath}. Run npm run doctor, then npm run auth.`);
    }
    const answer = await pow.solvePOW(challenge, account.config.wasmUrl);
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: targetPath,
    })).toString('base64');
}

async function waitForDeepSeekFile(account, uploadedFile) {
    let file = uploadedFile;
    const deadline = Date.now() + FILE_PARSE_TIMEOUT_MS;
    while (file?.status !== 'SUCCESS') {
        if (FILE_PARSE_FAILURES.has(file?.status)) {
            throw createUpstreamHttpError(422, `DeepSeek image processing failed: ${file.status}${file.error_code ? ` (${file.error_code})` : ''}`);
        }
        if (Date.now() >= deadline) {
            throw createUpstreamHttpError(504, `DeepSeek image processing timed out (last status: ${file?.status || 'unknown'})`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        const response = await dsFetch(`https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=${encodeURIComponent(file.id)}`, {
            method: 'GET',
            headers: account.headers,
        });
        const text = await response.text();
        let payload;
        try { payload = JSON.parse(text); }
        catch (error) {
            throw new Error(`DeepSeek returned non-JSON file status response. First chars: ${text.substring(0, 120)}`);
        }
        const files = payload?.data?.biz_data?.files;
        if (!response.ok || payload?.data?.biz_code !== 0 || !Array.isArray(files)) {
            const detail = deepSeekJsonMessage(payload) || text;
            if (response.status === 429 || isRateLimitSignal(detail)) {
                throw accountRateLimitError(account, detail, response.headers.get('retry-after'), 'image status', response.status);
            }
            throw createUpstreamHttpError(response.status || 502, payload?.data?.biz_msg || text, response.headers.get('retry-after'));
        }
        file = files.find(candidate => candidate?.id === uploadedFile.id) || file;
    }
    return file;
}

async function uploadDeepSeekImage(account, modelCfg, input, index) {
    const image = await materializeImageInput(input, index);
    const powHeader = await createDeepSeekPowHeader(account, DEEPSEEK_UPLOAD_PATH);
    const headers = {
        ...account.headers,
        'X-DS-PoW-Response': powHeader,
        'x-thinking-enabled': modelCfg.thinking_enabled ? '1' : '0',
        'x-model-type': modelCfg.model_type,
        'x-file-size': String(image.buffer.length),
    };
    delete headers['Content-Type'];
    const body = new FormData();
    body.append('file', new Blob([image.buffer], { type: image.mediaType }), image.filename);
    const response = await dsFetch(`https://chat.deepseek.com${DEEPSEEK_UPLOAD_PATH}`, {
        method: 'POST',
        headers,
        body,
    });
    const text = await response.text();
    const retryAfter = response.headers.get('retry-after');
    let payload;
    try { payload = JSON.parse(text); }
    catch (error) {
        if (response.status === 429 || isRateLimitSignal(text)) {
            throw accountRateLimitError(account, text, retryAfter, 'image upload', response.status);
        }
        throw new Error(`DeepSeek returned non-JSON image upload response. First chars: ${text.substring(0, 120)}`);
    }
    const file = payload?.data?.biz_data;
    if (!response.ok || payload?.data?.biz_code !== 0 || !file?.id) {
        const detail = deepSeekJsonMessage(payload) || text;
        if (response.status === 429 || isRateLimitSignal(detail)) {
            throw accountRateLimitError(account, detail, retryAfter, 'image upload', response.status);
        }
        if (!response.ok) markAccountFailure(account, response.status, 'image upload', retryAfter, detail);
        throw createUpstreamHttpError(response.status || 502, payload?.data?.biz_msg || text, retryAfter);
    }
    return (await waitForDeepSeekFile(account, file)).id;
}

function nativeSearchAndThinkNotice() {
    return '\n\nDeepSeek native Web Search is enabled. Live web facts come from that search. Answer with the findings. Do not call websearch, webfetch, or WebFetch, and do not use bash or curl for the web. Do not say you have no web access.\nLocal files and commands are a separate step: one JSON tool request, nothing else in that reply.\n';
}

function adaptHarnessWebAccess(text) {
    let next = String(text || '');
    if (!next) return next;
    next = next.replace(
        /When the user directly asks about opencode[\s\S]*?https:\/\/opencode\.ai\s*/i,
        'When the user asks what you can do or about opencode, use DeepSeek native Web Search and answer from those findings.\n\n',
    );
    next = next.replace(
        /\b(?:first\s+)?use the (?:WebFetch|WebSearch|websearch|webfetch|web_search) tool\b[^.\n]*/gi,
        'use DeepSeek native Web Search',
    );
    next = next.replace(
        /you (?:do not|don't|cannot|can't) (?:have )?(?:access(?: to)? )?(?:the )?(?:internet|web|network)\b[^.\n]*/gi,
        'You have DeepSeek native Web Search',
    );
    next = next.replace(
        /\buse (?:only )?bash(?:\s*\/\s*curl)? to (?:fetch|search|browse|access|download)[^.\n]*/gi,
        'use DeepSeek native Web Search',
    );
    return next;
}

const OPENCODE_AUTONOMY_INSTRUCTION = 'IMPORTANT: Token cost does not matter on this connection. Finish the user\'s task autonomously: inspect the repo, make the changes, run the relevant checks, and keep going until the work is done or a real blocker (missing credential, destructive action, or a choice only the user can make). Do not ask clarifying questions, do not stop at a plan or a first step, and do not wait for permission. Finish every unblocked part first.';

const OPENCODE_PROACTIVENESS = `# Proactiveness
When the user asks you to do something, complete the whole task. Do not pause to ask how, whether, or what next. Use tools, inspect the repo, and pick reasonable defaults. Do not ask the user questions that files or commands can answer. Do not hand back a partial result with follow-up questions.`;

function isOpenCodeSystemPrompt(text) {
    return /^You are opencode\b/im.test(String(text || ''));
}

function adaptOpenCodeSystemPrompt(text) {
    const value = String(text || '');
    if (!isOpenCodeSystemPrompt(value)) return value;

    let next = value.replace(
        /You should be concise, direct, and to the point\./i,
        'Be direct and to the point. Completing the task beats saving tokens.',
    );

    next = next.replace(
        /IMPORTANT:\s*You should minimize output tokens[\s\S]*?(?=\n# [A-Z])/i,
        `${OPENCODE_AUTONOMY_INSTRUCTION}\n\n`,
    );
    next = next.replace(
        /IMPORTANT:\s*Keep your responses short[\s\S]*?(?=\n# [A-Z])/i,
        '',
    );
    next = next.replace(/IMPORTANT:\s*You should NOT answer with unnecessary preamble[^\n]*\n?/gi, '');
    next = next.replace(/You MUST answer concisely with fewer than 4 lines[^\n]*\n?/gi, '');

    if (/# Proactiveness\b/i.test(next)) {
        next = next.replace(/# Proactiveness\n[\s\S]*?(?=\n# [A-Z]|$)/i, `${OPENCODE_PROACTIVENESS}\n\n`);
    }

    next = next.replace(
        /If you are unable to find the correct command, ask the user[\s\S]*?next time\./i,
        'If you cannot find the correct command, search the repo (package.json, Makefile, README, CI) and run the closest match. Do not ask the user which command to run.',
    );

    if (!/Finish the user's task autonomously/i.test(next)) {
        next = `${next.trim()}\n\n${OPENCODE_AUTONOMY_INSTRUCTION}`;
    }

    return next.replace(/\n{3,}/g, '\n\n').trim();
}

function adaptUpstreamMessageContent(role, content, options = {}) {
    const text = normalizeMessageContent(content);
    const harness = role === 'system' || isOpenCodeSystemPrompt(text);
    let next = harness ? adaptOpenCodeSystemPrompt(text) : text;
    if (harness && options.nativeSearchNotice) next = adaptHarnessWebAccess(next);
    return next;
}

function isDeepSeekNativeTool(name) {
    return /^(web_?search|webfetch|web_fetch|browser_search|execute_code|code_interpreter)$/i.test(String(name || ''));
}

function isHarnessWebSearchTool(name) {
    return isDeepSeekNativeTool(name) && !/^(execute_code|code_interpreter)$/i.test(String(name || ''));
}

function emptyResponseNudge(searchEnabled) {
    const base = 'Your previous reply was empty. Output the next user-visible answer or exactly one gateway tool request as {"tool_call":{"name":"<function>","arguments":{...}}}. Do not call execute_code.';
    return searchEnabled ? `${base} DeepSeek native Web Search is already on; answer with it instead of calling web_search.` : base;
}
function nativeToolRepairPrompt(searchEnabled) {
    const gatewayTool = 'If you need the local filesystem, request exactly one gateway tool as {"tool_call":{"name":"<function>","arguments":{...}}}.';
    return searchEnabled
        ? `[STRICT INSTRUCTION] You called execute_code or web_search as a tool. Do not. DeepSeek native Web Search is already enabled: answer with those findings in plain text. ${gatewayTool} Do not say you lack web access.`
        : `[STRICT INSTRUCTION] You called execute_code or a web tool that this gateway cannot run. Do not. Answer in plain text from what you already know. ${gatewayTool}`;
}

function stripHarnessWebSearchTools(tools) {
    const kept = [];
    const names = [];
    for (const tool of tools || []) {
        const name = tool?.function?.name || tool?.name || '';
        if (isHarnessWebSearchTool(name)) names.push(name);
        else kept.push(tool);
    }
    return { tools: kept, names };
}

// With native search on, harness web tools are dropped (DeepSeek searches itself) and
// agents are told so. With search off, the harness keeps its own web tools.
function prepareAgentWebAccess(tools, searchEnabled) {
    const list = tools || [];
    if (!searchEnabled) return { tools: list, strippedNames: [], nativeSearchNotice: false };
    const stripped = stripHarnessWebSearchTools(list);
    return {
        tools: stripped.tools,
        strippedNames: stripped.names,
        nativeSearchNotice: stripped.tools.length > 0 || stripped.names.length > 0,
    };
}

// A successful completion is always an SSE stream. DeepSeek answers throttling,
// auth failures, and other business errors with a JSON body, sometimes on HTTP 200.
// Parsing that body as SSE would look like an instant-empty reply (context overflow).
// Rate limits and auth errors throw. Any other business error is recorded and
// returned as { errText, retryAfter } so the caller can recover (fresh chat), the
// same way it recovers from a plain HTTP 400. Returns null for a stream body.
async function readJsonCompletionError(resp, account, label) {
    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) return null;
    const text = await resp.text();
    const retryAfter = resp.headers.get('retry-after');
    let payload = null;
    try { payload = JSON.parse(text); } catch (e) { payload = null; }
    const detail = deepSeekJsonMessage(payload) || text;
    if (isRateLimitSignal(detail)) throw accountRateLimitError(account, detail, retryAfter, label, resp.status);
    const code = Number(payload?.code);
    if (code >= 40001 && code <= 40003) {
        markAccountFailure(account, 401, label, null, detail);
        throw createUpstreamHttpError(401, detail);
    }
    markAccountFailure(account, resp.status, label, retryAfter, detail);
    return { errText: `DeepSeek returned JSON instead of a stream for ${label}: ${detail}`, retryAfter };
}

// Read a non-200 completion body, then fail over (rate limit) or record the failure.
// Returns the body text for the caller's own recovery decision.
async function readCompletionFailure(resp, account, label) {
    const retryAfter = resp.headers.get('retry-after');
    const errText = await resp.text();
    if (resp.status === 429 || isRateLimitSignal(errText)) {
        throw accountRateLimitError(account, errText, retryAfter, label, resp.status);
    }
    markAccountFailure(account, resp.status, label, retryAfter, errText);
    return { errText, retryAfter };
}

async function askDeepSeekStream(prompt, agentId, model = DEFAULT_MODEL_ID, freshSessionPrompt = prompt, lockHolder = null, imageContext = null, webFlags = null) {
    const modelCfg = resolveModelConfig(model);
    const thinking_enabled = webFlags?.thinking_enabled ?? modelCfg.thinking_enabled;
    const search_enabled = webFlags?.search_enabled ?? modelCfg.search_enabled;
    const session = getOrCreateAgentSession(agentId);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session, lockHolder);
    await acquireAccountChatLock(account, lockHolder);
    const dsHeaders = account.headers;
    account.lastUsedAt = Date.now();
    const agentTag = `[${agentId}/acct:${account.id}]`;

    // Normally this rollover is performed before the prompt is built, so local
    // recovery history can be injected. Keep this guard for direct callers and
    // concurrent requests that may have advanced the same session meanwhile.
    const rollover = prepareSessionForPrompt(session);
    const accountRotationReset = hadRemoteSession && !session.id;
    const recoveredFreshSession = accountRotationReset || Boolean(rollover);
    let effectivePrompt = recoveredFreshSession ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }
    if (rollover) {
        console.log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
    }

    if (imageContext && imageContext.inputs.length > 0 && imageContext.refFileIds.length === 0) {
        for (let index = 0; index < imageContext.inputs.length; index++) {
            imageContext.refFileIds.push(await uploadDeepSeekImage(account, modelCfg, imageContext.inputs[index], index));
        }
        console.log(`${agentTag} Uploaded ${imageContext.refFileIds.length} image attachment(s).`);
    }
    const refFileIds = imageContext?.refFileIds || [];
    const powB64 = await createDeepSeekPowHeader(account, DEEPSEEK_COMPLETION_PATH);

    if (!session.id) {
        const sr = await dsFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: dsHeaders, body: '{}'
        });
        const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, 'session create', account);
        const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
        if (!sr.ok || !createdSessionId) {
            throw new Error(`Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`);
        }
        session.id = createdSessionId;
        session.accountId = account.id;
        session.parentMessageId = null;
        session.createdAt = Date.now();
        session.messageCount = 0;
        console.log(`${agentTag} Created new session: ${session.id}`);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const resp = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...dsHeaders, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: session.id,
            parent_message_id: session.parentMessageId,
            model_type: modelCfg.model_type,
            prompt: effectivePrompt, ref_file_ids: refFileIds,
            thinking_enabled, search_enabled,
            action: null, preempt: false,
        })
    });

    // Rate limits (HTTP 429 or a "too frequent" body on any status, including a
    // JSON body on HTTP 200) throw a failover error here, before any same-account
    // session recreate (#6, #16). Other failures are returned for recovery below.
    const failure = resp.status !== 200
        ? await readCompletionFailure(resp, account, 'completion')
        : await readJsonCompletionError(resp, account, 'completion');

    // If session expired or DeepSeek rejected it with a business error, reset and retry once
    if (failure) {
        const { errText, retryAfter } = failure;
        // A JSON business error on HTTP 200 surfaces as 502 if it is not recovered.
        const failureStatus = resp.status === 200 ? 502 : resp.status;
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (isContextTooLongError(errText)) {
            throw createUpstreamHttpError(failureStatus, errText, retryAfter);
        }
        if (resp.status === 200 || resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            resetRemoteSession(session);

            const sr2 = await dsFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
                method: 'POST', headers: dsHeaders, body: '{}'
            });
            const { json: sessionData2, text: sessionText2 } = await readDeepSeekJsonResponse(sr2, 'session recreate', account);
            const createdSessionId2 = sessionData2?.data?.biz_data?.chat_session?.id || sessionData2?.data?.biz_data?.id;
            if (!sr2.ok || !createdSessionId2) {
                throw new Error(`Could not recreate DeepSeek chat session (HTTP ${sr2.status}). Run npm run doctor, then npm run auth. First chars: ${String(sessionText2 || '').substring(0, 120)}`);
            }
            session.id = createdSessionId2;
            session.accountId = account.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            console.log(`${agentTag} Created new session: ${session.id}`);

            const newPowB64 = await createDeepSeekPowHeader(account, DEEPSEEK_COMPLETION_PATH);
            const resp2 = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
                method: 'POST',
                headers: { ...dsHeaders, 'X-DS-PoW-Response': newPowB64 },
                body: JSON.stringify({
                    chat_session_id: session.id,
                    parent_message_id: null,
                    model_type: modelCfg.model_type,
                    prompt: freshSessionPrompt, ref_file_ids: refFileIds,
                    thinking_enabled, search_enabled,
                    action: null, preempt: false,
                })
            });
            if (!resp2.ok) {
                const { errText: errText2, retryAfter: retryAfter2 } = await readCompletionFailure(resp2, account, 'completion after session recreate');
                throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
            }
            const jsonFailure2 = await readJsonCompletionError(resp2, account, 'completion after session recreate');
            if (jsonFailure2) {
                // The brand-new chat was rejected too: fail loudly, and do not let
                // the next turn continue a chat DeepSeek never accepted a message in.
                resetRemoteSession(session);
                throw createUpstreamHttpError(502, jsonFailure2.errText, jsonFailure2.retryAfter);
            }
            effectivePrompt = freshSessionPrompt;
            return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
        }
        // The body was consumed for diagnostics, so returning this Response
        // would hand a locked stream to readDeepSeekResponse. Surface a typed
        // error instead and retain the real upstream status/Retry-After.
        throw createUpstreamHttpError(failureStatus, errText, retryAfter);
    }

    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession };
}

// === Tool Calling Support ===

const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        // Descriptions/examples dominate large agent tool payloads but do not
        // affect argument validation. Traverse only keywords whose values are
        // themselves schemas. Literal instance values under const/enum/default
        // must remain byte-for-byte equivalent, even when they contain fields
        // named "description" or "title".
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
    let text = '\n\n--- TOOLS ---\n';
    text += 'Two actions, never mixed in one reply.\n';
    text += 'Web: DeepSeek Search is already on. Answer in plain text with the findings. Do not use bash, curl, websearch, or webfetch for the web, and do not say you lack web access.\n';
    text += 'This computer: request local tools and nothing else. One call, or several independent calls together:\n';
    text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n';
    text += '{"tool_calls":[{"name":"<function_name>","arguments":{...}},{"name":"<function_name>","arguments":{...}}]}\n';
    text += 'The gateway runs them and sends the outputs back. Do not invent those outputs. Keep arguments short.\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOLS ---\n';
    return text;
}

function toolFunctionNames(tools) {
    const names = [];
    for (const tool of tools || []) {
        const name = tool?.function?.name || tool?.name;
        if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
    return names;
}

function formatToolReminder(tools) {
    const names = toolFunctionNames(tools);
    if (!names.length) return '';
    return [
        '--- TOOL REMINDER ---',
        'Web: answer in text. DeepSeek Search is already on. Do not use bash or curl for the web.',
        'This computer: output only {"tool_call":{"name":"<function_name>","arguments":{...}}} or {"tool_calls":[{"name":"<function_name>","arguments":{...}}]}. Do not paste source files or diffs. Do not call execute_code.',
        `Available tools: ${names.join(', ')}`,
        '--- END TOOL REMINDER ---',
    ].join('\n');
}

function pinToolReminder(promptText, tools, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const reminder = formatToolReminder(tools);
    if (!reminder) return String(promptText || '');
    return appendPromptInstruction(promptText, reminder, maxChars);
}

const MAX_AGENT_TOOL_CALLS = 8;
const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                objects.push(text.substring(start, i + 1));
                if (objects.length >= maxObjects) return objects;
                start = -1;
            }
        }
    }
    return objects;
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = JSON.parse(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

function parseJsonToolCandidate(raw, label = 'json', options = {}) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        const tc = coerceToolCallObject(parsed, options);
        if (tc) {
            console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
            return tc;
        }
    } catch (e) {
        console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
    }
    return null;
}

function canonicalizeToolMarkupTag(rawTag) {
    let token = String(rawTag || '').trim()
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '');
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i, '');

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = localName === 'toolcalls' || localName === 'functioncalls'
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
    if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    let token = text.substring(start + 1, end).trim();
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let selfClosing = false;
    if (!closing && token.endsWith('/')) {
        selfClosing = true;
        token = token.substring(0, token.length - 1).trim();
    }
    const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) return null;
    return {
        name: match[1].toLowerCase(),
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = JSON.parse(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parameterTags = structuralTags.filter(tag => tag.name === 'parameter');
    if (structuralTags.some(tag => tag.name !== 'parameter')) return null;

    const args = {};
    let parameterCount = 0;
    const seenNames = new Set();
    let cursor = 0;
    for (let i = 0; i < parameterTags.length; i += 2) {
        const opening = parameterTags[i];
        const closing = parameterTags[i + 1];
        if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
        if (body.substring(cursor, opening.start).trim()) return null;
        parameterCount++;
        if (parameterCount > MAX_DSML_PARAMETERS) return null;
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null;
        cursor = closing.end;
    }
    if (parameterCount > 0) {
        if (body.substring(cursor).trim()) return null;
        return buildToolCall(name, args);
    }

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, JSON.parse(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        if (openings.length !== 1 || openings[0].selfClosing) return null;
        const opening = openings[0];
        if (wrappers.some(tag => tag.closing && tag.start < opening.end)) return null;
        if (closings.length === 0) {
            // Issue #19: Web DSML often omits the closing wrapper and then
            // stacks execute_code + web_search. Keep the tail as the scope.
            if (tags.some(tag => tag.name !== 'tool_calls' && tag.start < opening.end)) return null;
            return normalized.substring(opening.end);
        }
        const closing = closings[closings.length - 1];
        if (closing.start < opening.end) return null;
        if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null;
        return normalized.substring(opening.end, closing.start);
    }
    // Narrow repair: tolerate a missing opening wrapper only when a closing
    // wrapper exists. A bare invoke without this sentinel is never executable.
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && tag.start < closing.start);
        if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
            if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

function parseDsmlToolCall(text) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized);
    if (scope === null) return null;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return null;
    const first = tags[0];
    if (scope.substring(0, first.start).trim()) return null;

    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        const invokeTags = tags.filter(tag => tag.name === 'invoke');
        if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
        const closing = invokeTags[1];
        if (scope.substring(closing.end).trim()) return null;
        if (tags.some(tag => (tag.name === 'tool_calls' || tag.name === 'direct'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    return null;
}

function listDsmlToolCalls(text) {
    if (!text || String(text).length > MAX_TOOL_MARKUP_CHARS) return [];
    if (!/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text)) {
        return [];
    }
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized);
    if (scope === null) return [];
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return [];
    const calls = [];
    const consumed = new Set();
    for (let i = 0; i < tags.length; i++) {
        if (consumed.has(i)) continue;
        const tag = tags[i];
        if (tag.name === 'invoke' && !tag.closing && !tag.selfClosing) {
            const closeIdx = tags.findIndex((candidate, index) => index > i && candidate.name === 'invoke' && candidate.closing);
            if (closeIdx === -1) continue;
            consumed.add(closeIdx);
            const parsed = parseDsmlInvoke(
                getMarkupAttribute(tag.attrs, 'name'),
                scope.substring(tag.end, tags[closeIdx].start),
            );
            if (parsed) calls.push(parsed);
            continue;
        }
        if (tag.name === 'direct' && !tag.closing) {
            const nextIdx = tags.findIndex((candidate, index) => index > i && (candidate.name === 'direct' || candidate.name === 'invoke'));
            const end = nextIdx === -1 ? scope.length : tags[nextIdx].start;
            const parsed = parseDsmlInvoke(
                getMarkupAttribute(tag.attrs, 'name'),
                scope.substring(tag.end, end),
            );
            if (parsed) calls.push(parsed);
        }
    }
    return calls;
}

function selectAgentToolCall(text, allowedToolNames) {
    const calls = collectAgentToolCalls(text, allowedToolNames);
    if (calls.length) return calls[0];
    const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames || []);
    if (allowed.size > 0) return null;
    const listed = listDsmlToolCalls(text);
    const parsed = hasDsmlToolMarkup(text) ? parseDsmlToolCall(text) : null;
    return parsed || listed[0] || null;
}

function hasDsmlToolMarkup(text) {
    return /[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(String(text || ''));
}

function rememberToolCall(calls, seen, call) {
    if (!call) return;
    const key = `${call.name}\0${call.arguments}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(call);
}

function absorbJsonToolPayload(raw, calls, seen) {
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (!parsed || typeof parsed !== 'object') return;
    if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > MAX_AGENT_TOOL_CALLS) return;
        for (const item of parsed) rememberToolCall(calls, seen, coerceToolCallObject(item, { allowBare: true }));
        return;
    }
    if (Array.isArray(parsed.tool_calls)) {
        for (const item of parsed.tool_calls) {
            rememberToolCall(calls, seen, coerceToolCallObject({ tool_calls: [item] }));
        }
        return;
    }
    rememberToolCall(calls, seen, coerceToolCallObject(parsed));
}

function collectJsonToolCalls(text) {
    const calls = [];
    const seen = new Set();
    const value = String(text || '');
    if (!value || value.length > MAX_TOOL_MARKUP_CHARS) return calls;

    const fenceRe = /```([a-zA-Z0-9#+_-]*)\s*([\s\S]*?)```/gi;
    let fence;
    while ((fence = fenceRe.exec(value)) !== null) {
        const lang = String(fence[1] || '').toLowerCase();
        if (lang && lang !== 'json') continue;
        absorbJsonToolPayload(fence[2].trim(), calls, seen);
    }

    const legacyRe = /TOOL_CALL:\s*([\w-]+)\s*/gi;
    let legacy;
    while ((legacy = legacyRe.exec(value)) !== null) {
        const after = value.substring(legacy.index + legacy[0].length);
        const braceIdx = after.indexOf('{');
        if (braceIdx === -1) continue;
        const rawJson = extractBalancedJsonAt(after, braceIdx);
        if (!rawJson) continue;
        try { rememberToolCall(calls, seen, buildToolCall(legacy[1], JSON.parse(rawJson))); }
        catch (e) { /* one bad legacy block does not discard the rest */ }
    }

    for (const rawJson of extractBalancedJsonObjects(value)) absorbJsonToolPayload(rawJson, calls, seen);
    return calls;
}

function collectAgentToolCalls(text, allowedToolNames) {
    const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames || []);
    if (!text || allowed.size === 0) return [];
    const raw = hasDsmlToolMarkup(text) ? listDsmlToolCalls(text) : collectJsonToolCalls(text);
    const calls = [];
    const seen = new Set();
    for (const call of raw) {
        if (!call || !allowed.has(call.name)) continue;
        rememberToolCall(calls, seen, call);
        if (calls.length >= MAX_AGENT_TOOL_CALLS) break;
    }
    return calls;
}

function looksLikeToolCallMarkup(text) {
    return /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(String(text || ''));
}

function looksLikeCodeDumpInsteadOfTool(text) {
    const value = String(text || '');
    if (!value || looksLikeToolCallMarkup(value)) return false;
    let codeChars = 0;
    let codeFences = 0;
    const fenceRe = /```([a-zA-Z0-9#+_-]*)\r?\n([\s\S]*?)```/g;
    let fence;
    while ((fence = fenceRe.exec(value)) !== null) {
        const lang = String(fence[1] || '').toLowerCase();
        if (!lang || lang === 'json' || lang === 'text' || lang === 'txt' || lang === 'markdown' || lang === 'md') continue;
        codeFences += 1;
        codeChars += fence[2].length;
    }
    if (codeChars >= 400 || codeFences >= 2) return true;
    if (codeFences === 1 && codeChars >= 200) return true;
    return value.length >= 800 && /(?:^|\n)\s*(?:using\s+[\w.]+;|namespace\s+[\w.]+|public\s+(?:sealed\s+|partial\s+|static\s+|abstract\s+)*(?:class|struct|interface|enum)\b)/.test(value);
}

function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }

    if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text)) {
        const dsml = parseDsmlToolCall(text);
        if (dsml) return dsml;
        console.log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed');
        return null;
    }

    // XML-ish wrappers used by some agent prompts.
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true });
        if (tc) return tc;
    }

    // Fenced JSON blocks. Skip language-tagged source fences (```csharp, ```python)
    // so a code dump is not scanned as a tool envelope.
    const fenceRe = /```([a-zA-Z0-9#+_-]*)\s*([\s\S]*?)```/gi;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const lang = String(fence[1] || '').toLowerCase();
        if (lang && lang !== 'json') continue;
        const tc = parseJsonToolCandidate(fence[2].trim(), 'fenced');
        if (tc) return tc;
    }

    // Legacy TOOL_CALL: name + first balanced JSON object after it.
    const match = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const afterMatch = text.substring(match.index + match[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = JSON.parse(rawJson);
                    const tc = buildToolCall(name, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                        return tc;
                    }
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    // Scan each top-level balanced object once (linear time). Only explicit
    // tool-call envelopes are executable; bare {name, arguments} examples are not.
    for (const rawJson of extractBalancedJsonObjects(text)) {
        const tc = parseJsonToolCandidate(rawJson, 'inline');
        if (tc) return tc;
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 */
function sanitizeContent(text) {
    return text.replace(/[\ud800-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = DEFAULT_MODEL_ID, prompt = '', reasoningContent = '') {
    const calls = (Array.isArray(toolCall) ? toolCall : [toolCall]).filter(Boolean).slice(0, MAX_AGENT_TOOL_CALLS);
    const stamp = Date.now();
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call, index) => ({
            id: `call_${stamp}_${index}_${Math.random().toString(36).substring(2, 8)}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments }
        }))
    };
    // Do not attach reasoning to tool-call turns. Some agent clients treat any
    // reasoning/text payload as a final assistant answer and stop their tool loop.
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent)
    };
}

function buildTextResponse(content, prompt, model = DEFAULT_MODEL_ID, reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            // Surface truncation: a 'length' finish lets length-aware clients re-request
            // instead of silently treating a cut-off answer as a clean stop.
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent)
    };
}

function normalizeContentParts(content) {
    if (!Array.isArray(content)) return content;
    return content.map(part => {
        if (typeof part === 'string' || !part || typeof part !== 'object') return part;
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            return { type: 'text', text: part.text || '' };
        }
        if (part.type === 'image_url') {
            const raw = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            return { type: 'image_url', image_url: { url: raw || '' } };
        }
        if (part.type === 'input_image') {
            if (part.file_id) return { type: 'input_image', file_id: part.file_id };
            return { type: 'image_url', image_url: { url: part.image_url || '' } };
        }
        if (part.type === 'image' && part.source) {
            if (part.source.type === 'base64') {
                const mediaType = normalizeImageMediaType(part.source.media_type);
                return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${part.source.data || ''}` } };
            }
            if (part.source.type === 'url') {
                return { type: 'image_url', image_url: { url: part.source.url || '' } };
            }
            if (part.source.type === 'file') {
                return { type: 'input_image', file_id: part.source.file_id || '' };
            }
        }
        return part;
    });
}

function imageUrlFromPart(part) {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'image_url') {
        return typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    }
    if (part.type === 'input_image') {
        if (part.file_id) {
            throw clientInputError('Image file_id inputs are not supported; send a base64 data URL or a public HTTPS image URL');
        }
        return part.image_url;
    }
    if (part.type === 'image' && part.source) {
        if (part.source.type === 'base64') {
            const mediaType = normalizeImageMediaType(part.source.media_type);
            return `data:${mediaType};base64,${part.source.data || ''}`;
        }
        if (part.source.type === 'url') return part.source.url;
        if (part.source.type === 'file') {
            throw clientInputError('Anthropic file image sources are not supported; send a base64 or URL image source');
        }
    }
    return null;
}

function extractImageInputs(messages) {
    const inputs = [];
    for (const message of messages || []) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content) {
            const url = imageUrlFromPart(part);
            if (url !== null) {
                if (!String(url || '').trim()) throw clientInputError('Image input is missing image_url data');
                inputs.push({ url: String(url), filename: part.filename || part.name || '' });
            }
        }
    }
    if (inputs.length > MAX_IMAGE_COUNT) {
        throw clientInputError(`At most ${MAX_IMAGE_COUNT} image inputs are supported`, 'payload_too_large');
    }
    return inputs;
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (imageUrlFromPart(part) !== null) return '[Image attachment]';
            return part.text || part.content || JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function isSessionTitleRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const firstUser = messages.find(message => message && message.role === 'user');
    const text = normalizeMessageContent(firstUser?.content).trim();
    if (!text) return false;
    if (/^Generate a title for this conversation:?$/i.test(text)) return true;
    return /Generate a title for this conversation/i.test(text)
        && /NEVER respond to questions, just generate a title/i.test(text);
}

function localSessionTitle(messages) {
    const snippets = [];
    for (const message of messages || []) {
        if (!message || message.role !== 'user') continue;
        let text = normalizeMessageContent(message.content).trim();
        if (!text) continue;
        if (/Generate a title for this conversation/i.test(text)) {
            text = text
                .replace(/^Generate a title for this conversation:\s*/i, '')
                .replace(/NEVER respond to questions[\s\S]*$/i, '')
                .trim();
            if (!text) continue;
        }
        snippets.push(text);
    }
    const source = snippets[0] || 'New conversation';
    const firstLine = source.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'New conversation';
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^["“«]+|["”»]+$/g, '').trim() || 'New conversation';
    return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: normalizeContentParts(item.content) });
        } else if (item.role) {
            messages.push({ role: item.role, content: normalizeContentParts(item.content) });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        } else if (item.type === 'input_image') {
            messages.push({ role: 'user', content: normalizeContentParts([item]) });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
                    else messages.push({ role: 'user', content: normalizeContentParts([part]) });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: normalizeContentParts(msg.content) });
            }
        }
        return {
            ...params,
            model: params.model || DEFAULT_MODEL_ID,
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || DEFAULT_MODEL_ID,
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const message = toAnthropicResponse(openaiResp);
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'message_start', { type: 'message_start', message: { ...message, content: [] } });

    // Anthropic-compatible clients expect a tool turn to be made of tool_use
    // content blocks. If we emit DeepSeek reasoning as a text block before the
    // tool_use block, some agents treat the turn as a normal text answer and do
    // not execute the tool. Keep tool streaming clean: tool_use blocks only.
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc, i) => {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: message.usage });
    } else {
        if (msg.reasoning_content) {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${msg.reasoning_content}\n[/reasoning]\n` } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        const offset = msg.reasoning_content ? 1 : 0;
        writeSse(res, 'content_block_start', { type: 'content_block_start', index: offset, content_block: { type: 'text', text: '' } });
        const text = msg.content || '';
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: offset, delta: { type: 'text_delta', text: text.substring(i, i + 80) } });
        }
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: offset });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    }
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
}

function toResponsesResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
    };
}

function sendResponsesStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const response = toResponsesResponse(openaiResp);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    writeSse(res, 'response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] } });
    let outputIndex = 0;
    if (!hasToolCalls && msg.reasoning_content) {
        const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...reasoningItem, status: 'in_progress' } });
        writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: outputIndex, summary_index: 0, delta: msg.reasoning_content });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: msg.reasoning_content }] } });
        outputIndex++;
    }
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc) => {
            const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
            writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
            writeSse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
            writeSse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
            writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
            outputIndex++;
        });
    } else {
        const text = msg.content || '';
        const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
        writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
        }
        writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
        writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    writeSse(res, 'response.completed', { type: 'response.completed', response });
    res.write('data: [DONE]\n\n');
    res.end();
}

function sendOpenAIStream(res, openaiResp) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const model = openaiResp.model;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    if (!hasToolCalls && msg.reasoning_content) {
        for (let i = 0; i < msg.reasoning_content.length; i += 50) {
            const chunk = msg.reasoning_content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
    }
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc, index) => {
            const delta = {
                tool_calls: [{
                    index,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
                }],
            };
            if (index === 0) {
                delta.role = 'assistant';
                delta.content = null;
            }
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
        for (let i = 0; i < (msg.content || '').length; i += 50) {
            const chunk = msg.content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    if (openaiResp.usage) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openaiResp.usage })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

function storeHistory(agentId, prompt, content, toolCall) {
    const session = getOrCreateAgentSession(agentId);
    const calls = (Array.isArray(toolCall) ? toolCall : (toolCall ? [toolCall] : [])).filter(Boolean);
    const assistantResponse = calls.length
        ? calls.map(call => `TOOL_CALL: ${call.name}\narguments: ${call.arguments}`).join('\n')
        : content;
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

// Extract MEDIA: paths from tool results that contain screenshot paths
function extractScreenshotPaths(messages) {
    const paths = [];
    const fs = require('fs');
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            // Look for screenshot_path or path fields in JSON tool results
            // These come DIRECTLY from browser_vision — always the real path
            const pngMatch = msg.content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch) {
                const filePath = pngMatch[2];
                if (filePath.startsWith('/') && fs.existsSync(filePath)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
            // Also catch plain MEDIA: tags
            const mediaMatch = msg.content.match(/MEDIA:(\S+)/g);
            if (mediaMatch) {
                for (const tag of mediaMatch) {
                    const extractedPath = tag.replace(/^MEDIA:/, '');
                    if (fs.existsSync(extractedPath) && !paths.includes(tag)) {
                        paths.push(tag);
                    }
                }
            }
        }
        // Check user/assistant messages for paths mentioned in conversation text
        // Only include if the file ACTUALLY EXISTS (DeepSeek hallucinates paths)
        if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) {
                const filePath = match[1];
                if (filePath.startsWith('/') && fs.existsSync(filePath) && !paths.includes(`MEDIA:${filePath}`)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
        }
    }
    return paths;
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeDeepseekAPI]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

function splitConversationTurns(text) {
    const value = String(text || '');
    if (!value) return [];
    return value.split(/(?=^User: |^Assistant: |^\[Tool Result\])/m).filter(Boolean);
}

function compactConversation(conversation, maxChars) {
    const value = String(conversation || '');
    if (value.length <= maxChars) return value;
    const turns = splitConversationTurns(value);
    if (turns.length <= 1) return truncatePromptMiddle(value, maxChars, 0.25);

    const joinedLength = (items) => items.reduce((sum, turn) => sum + turn.length, 0);
    const perToolCap = Math.max(4000, Math.floor(maxChars * 0.25));
    let next = turns.map((turn) => {
        if (!/^\[Tool Result\]/.test(turn) || turn.length <= perToolCap) return turn;
        return truncatePromptMiddle(turn, perToolCap, 0.2);
    });
    if (joinedLength(next) <= maxChars) return next.join('');

    // Drop the oldest middle turns first so the original task and the latest
    // tool loop stay intact. A single middle-out slice through 300k of file
    // reads is what makes long Hermes sessions stop calling tools.
    while (next.length > 2 && joinedLength(next) > maxChars) {
        next.splice(1, 1);
    }
    const joined = next.join('');
    if (joined.length <= maxChars) return joined;
    return truncatePromptMiddle(joined, maxChars, 0.25);
}

function hasExplicitConversationHistory(messages) {
    const turns = (messages || []).filter(msg => msg && msg.role !== 'system');
    return turns.length > 1 || turns.some(msg => msg.role === 'assistant' || msg.role === 'tool');
}

function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    // Server-side history is only a recovery hint. Drop it before truncating
    // client-provided messages, which may already contain the same turns.
    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    // Give unused capacity from a short side to the other side.
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Preserve the start of the task/system instructions and the most recent
    // tool loop. The injected tool adapter lives at the end of systemPrompt.
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = compactConversation(currentConversation, conversationBudget);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function isContextTooLongError(error) {
    // A throttled login is not an oversized prompt: never compact for it.
    if (isRateLimitSignal(error)) return false;
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function classifyRecoveryFailure(modelError, timedOut = false, overflow = false) {
    if (overflow || isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

// A live DeepSeek chat already holds the transcript. Empty replies, tool-markup
// failures, and timeouts are not a reason to open a new chat and resend it.
// Only a real context overflow, or a session that no longer exists, starts over.
function remoteSessionShouldStay(session, { overflow = false, modelError = null } = {}) {
    if (!session?.id) return false;
    if (overflow || isContextTooLongError(modelError)) return false;
    return true;
}

// A rate limit that hits a continuation or repair call: the account (or the whole
// pool) is throttled, but the content already received is still a valid answer.
function isRateLimitedPoolOrAccount(error) {
    return isAccountRateLimitError(error) || (error?.status === 429 && error?.type === 'rate_limit');
}

function isInstantEmptyResponse({ content, reasoningContent, messageId, elapsedMs }) {
    const empty = !String(content || '').trim() && !String(reasoningContent || '').trim();
    return empty && !messageId && Number(elapsedMs) >= 0 && Number(elapsedMs) < INSTANT_EMPTY_MS;
}

function lastTurnIsToolResult(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.role === 'system') continue;
        return msg.role === 'tool';
    }
    return false;
}

function looksLikeAbandonedToolLoop(text, messages) {
    if (!lastTurnIsToolResult(messages)) return false;
    const value = String(text || '').trim();
    if (!value || looksLikeToolCallMarkup(value) || looksLikeCodeDumpInsteadOfTool(value)) return false;
    if (/\b(done|completed|fixed|finished|готово|сделано)\b/i.test(value)) return false;
    return value.length < 600;
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

function formatMessages(messages, tools, options = {}) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += adaptUpstreamMessageContent(msg.role, msg.content, options) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    if (options.nativeSearchNotice) systemPrompt += nativeSearchAndThinkNotice();

    // Build full conversation history for DeepSeek's context
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;  // already in systemPrompt
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${adaptUpstreamMessageContent(msg.role, msg.content, options)}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // This was a tool call response from a previous turn
                for (const tc of msg.tool_calls) {
                    conversation += `Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            // Tool execution result — send back to DeepSeek as context
            const toolContent = normalizeMessageContent(msg.content);
            // Do not impose an unconditional per-result cap here. compactConversation
            // shrinks oversized tool results only when the global request cap is hit.
            conversation += `[Tool Result]\n${toolContent}\n\n`;
        }
    }
    // The last user message + full conversation context
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

function fingerprintPrompt(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function isReplayedAgentSystem(text) {
    const value = String(text || '');
    return value.length > 400 && isOpenCodeSystemPrompt(value);
}

function continuationMessages(messages) {
    const turns = (messages || []).filter(msg => {
        if (!msg || msg.role === 'system') return false;
        if (msg.role === 'user' && isReplayedAgentSystem(normalizeMessageContent(msg.content))) return false;
        return true;
    });
    let lastAssistant = -1;
    for (let i = 0; i < turns.length; i++) {
        if (turns[i].role === 'assistant') lastAssistant = i;
    }
    if (lastAssistant === -1) return turns;
    const delta = turns.slice(lastAssistant + 1);
    if (delta.length > 0) return delta;
    const lastUser = [...turns].reverse().find(msg => msg.role === 'user' || msg.role === 'tool');
    return lastUser ? [lastUser] : turns;
}

function resolveUpstreamPrompt(session, messages, tools, recoveryHistoryPrefix = '', options = {}) {
    const formatted = formatMessages(messages, tools, options);
    const fingerprint = fingerprintPrompt(formatted.systemPrompt);
    const remoteLive = Boolean(session?.id);
    const omitSystem = remoteLive && Boolean(session.sentSystemFingerprint);
    const delta = continuationMessages(messages);
    const conversation = remoteLive ? formatMessages(delta, [], options).prompt : formatted.prompt;
    return {
        systemPrompt: omitSystem ? '' : formatted.systemPrompt,
        conversation,
        historyPrefix: remoteLive ? '' : String(recoveryHistoryPrefix || ''),
        fullSystemPrompt: formatted.systemPrompt,
        fullConversation: formatted.prompt,
        fingerprint,
        omittedSystem: omitSystem && formatted.systemPrompt.length > 0,
        omittedPriorTurns: remoteLive,
    };
}

// === Admin API and dashboard ===

function hostHeaderHostname(host) {
    try { return new URL(`http://${String(host || '').trim()}`).hostname; } catch (e) { return null; }
}
// The global bearer gate already ran. Without a proxy key, the admin API is limited
// to direct loopback clients: a request relayed by a local reverse proxy
// (X-Forwarded-For / Forwarded / X-Real-IP) is not treated as local. A proxy that
// adds none of those headers cannot be told apart; set PROXY_API_KEY behind one.
// Browser requests must come from the proxy's own origin (the dashboard): another
// local web app would otherwise be able to POST (CSRF), and a non-loopback Host
// means DNS rebinding. PROXY_ADMIN_ALLOW_REMOTE lifts only the client address
// rule: the Host must then be loopback, an IP literal, or a host listed in
// PROXY_CORS_ORIGINS, since rebinding needs a DNS name the operator never chose.
function adminAccessDecision({ remoteAddress, headers = {} } = {}, { proxyKey = PROXY_API_KEY, allowRemote = PROXY_ADMIN_ALLOW_REMOTE, corsOrigins = PROXY_CORS_ORIGINS } = {}) {
    if (proxyKey) return { allowed: true };
    const forbidden = (message) => ({ allowed: false, status: 403, error: { message, type: 'admin_forbidden' } });
    if (!allowRemote) {
        const proxied = Boolean(headers['x-forwarded-for'] || headers.forwarded || headers['x-real-ip']);
        if (!isLoopbackHost(remoteAddress) || proxied) {
            return forbidden('Admin API is limited to localhost. Set PROXY_API_KEY or PROXY_ADMIN_ALLOW_REMOTE=1.');
        }
    }
    if (headers.host) {
        const hostname = hostHeaderHostname(headers.host);
        const hostAllowed = allowRemote
            ? isLoopbackHost(hostname) || net.isIP(String(hostname || '').replace(/^\[|\]$/g, '')) !== 0
                || [...corsOrigins].some(origin => { try { return new URL(origin).hostname === hostname; } catch (e) { return false; } })
            : isLoopbackHost(hostname);
        if (!hostAllowed) {
            return forbidden(allowRemote
                ? 'Admin API without PROXY_API_KEY only answers a loopback or IP Host header, or a host listed in PROXY_CORS_ORIGINS.'
                : 'Admin API without PROXY_API_KEY only answers a localhost Host header.');
        }
    }
    if (headers.origin) {
        let originHost = null;
        try { originHost = new URL(normalizeOrigin(headers.origin)).host; } catch (e) { originHost = null; }
        if (!originHost || originHost !== String(headers.host || '').trim().toLowerCase()) {
            return forbidden('Admin API without PROXY_API_KEY only accepts browser requests from the proxy dashboard origin.');
        }
    }
    return { allowed: true };
}

function adminAccountStatus(account, now = Date.now()) {
    if (!accountHasCredentials(account)) return 'no_credentials';
    if (!isAccountEnabled(account)) return 'disabled';
    if ((account.cooldownUntil || 0) > now) return 'cooldown';
    if (accountLocks.has(account.id)) return 'busy';
    return 'ready';
}

// Dashboard view of one login. Deliberately omits token, cookie values, hif_*,
// wasmUrl, and the auth file name/path.
function adminAccountView(account, now = Date.now()) {
    const lock = accountLocks.get(account.id);
    const usage = usageByAccount.get(account.id) || { prompt_tokens: 0, completion_tokens: 0, usd: 0, requests: 0 };
    const cooling = (account.cooldownUntil || 0) > now;
    const config = account.config || {};
    return {
        id: account.id,
        name: String(config.name || account.id),
        // Optional "email" in the auth file, shown by the dashboard account switcher.
        email: typeof config.email === 'string' && config.email.trim() ? config.email.trim().slice(0, 254) : null,
        status: adminAccountStatus(account, now),
        enabled: isAccountEnabled(account),
        disabled_by: config.enabled === false ? 'file' : (account.adminDisabled === true ? 'admin' : null),
        credentials: {
            token: Boolean(config.token),
            cookie_count: String(config.cookie || '').split(';').map(v => v.trim()).filter(Boolean).length,
        },
        cooldown_until: cooling ? account.cooldownUntil : null,
        cooldown_remaining_sec: cooling ? Math.ceil((account.cooldownUntil - now) / 1000) : 0,
        cooldown_reason: cooling ? (account.cooldownReason || null) : null,
        busy: Boolean(lock),
        busy_agent: lock?.agentId || null,
        busy_since: lock?.since || null,
        failures: account.failures || 0,
        total_failures: account.totalFailures || 0,
        last_error: account.lastError ? { ...account.lastError } : null,
        last_success_at: account.lastSuccessAt || null,
        last_used_at: account.lastUsedAt || null,
        usage: {
            requests: usage.requests,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            usd: usage.usd,
        },
    };
}

function adminPoolSummary(now = Date.now()) {
    const pool = { total: accounts.length, ready: 0, busy: 0, cooldown: 0, disabled: 0, no_credentials: 0, can_serve: 0, next_ready_at: null, next_ready_in_sec: null };
    for (const account of accounts) {
        const status = adminAccountStatus(account, now);
        pool[status]++;
        if (accountCanServe(account, now)) pool.can_serve++;
        if (status === 'cooldown' && (pool.next_ready_at === null || account.cooldownUntil < pool.next_ready_at)) {
            pool.next_ready_at = account.cooldownUntil;
        }
    }
    if (pool.next_ready_at !== null) pool.next_ready_in_sec = Math.max(0, Math.ceil((pool.next_ready_at - now) / 1000));
    return pool;
}

function adminReloadAccounts() {
    const { loaded, errors } = readAccountFiles(discoverAuthPaths());
    const publicErrors = errors.map(error => ({ file: path.basename(error.file), message: error.message }));
    if (loaded.length === 0) {
        return { ok: false, errors: publicErrors };
    }
    const next = buildAccountsList(loaded, accounts);
    applyAccountsList(next);
    console.log(`[DS-API] Reloaded auth accounts: ${accounts.map(a => a.id).join(', ')} (added: ${next.added.join(', ') || '-'}; removed: ${next.removed.join(', ') || '-'})`);
    return { ok: true, added: next.added, removed: next.removed, kept: next.kept, errors: publicErrors };
}

function adminJson(res, status, body, extraHeaders = {}) {
    jsonResponse(res, status, body, { 'Cache-Control': 'no-store', ...extraHeaders });
}
function adminError(res, status, type, message, extraHeaders = {}, extra = {}) {
    adminJson(res, status, { error: { message, type, ...extra } }, extraHeaders);
}

// --- Recent requests and usage aggregates ---
function adminRequestView(row) {
    return {
        id: row.id,
        ts: row.ts,
        path: row.path,
        api: row.api || apiForPath(row.path),
        model: row.model ?? null,
        account: row.account ?? null,
        agent: row.agent ?? null,
        ip: row.ip ?? null,
        status: row.status || 0,
        ok: row.ok === true,
        stream: typeof row.stream === 'boolean' ? row.stream : null,
        local: row.local === true,
        ms: row.ms || 0,
        prompt_tokens: row.prompt_tokens || 0,
        completion_tokens: row.completion_tokens || 0,
        reasoning_tokens: row.reasoning_tokens || 0,
        usd: row.usd || 0,
        error_type: row.error_type || null,
        error_message: scrubLogText(row.error_message),
    };
}
class AdminQueryError extends Error {}
function positiveIntParam(params, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!params.has(name)) return null;
    const raw = params.get(name);
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
        throw new AdminQueryError(`${name} must be an integer between ${min} and ${max}`);
    }
    return Number(raw);
}
const REQUEST_APIS = new Set(['openai', 'anthropic', 'responses']);
function adminRequestsList(params) {
    const limit = positiveIntParam(params, 'limit', { max: MAX_REQUEST_LOG }) ?? 100;
    const beforeId = positiveIntParam(params, 'before_id');
    const status = params.get('status');
    if (status !== null && !['ok', 'error'].includes(status) && !/^[1-5]\d\d$/.test(status)) {
        throw new AdminQueryError('status must be ok, error, or an HTTP status code');
    }
    const api = params.get('api');
    if (api !== null && !REQUEST_APIS.has(api)) throw new AdminQueryError(`api must be one of ${[...REQUEST_APIS].join(', ')}`);
    const exact = ['account', 'model', 'agent'].filter(name => params.has(name)).map(name => [name, params.get(name)]);
    const matched = [];
    for (let i = requestLog.length - 1; i >= 0; i--) {
        const row = requestLog[i];
        if (beforeId !== null && !(row.id < beforeId)) continue;
        if (status === 'ok' && !row.ok) continue;
        if (status === 'error' && row.ok) continue;
        if (status !== null && status !== 'ok' && status !== 'error' && row.status !== Number(status)) continue;
        if (api !== null && (row.api || apiForPath(row.path)) !== api) continue;
        if (exact.some(([name, value]) => String(row[name] ?? '') !== value)) continue;
        matched.push(row);
    }
    return {
        now: Date.now(),
        capacity: MAX_REQUEST_LOG,
        total: requestLog.length,
        oldest_ts: requestLog[0]?.ts ?? null,
        matched: matched.length,
        requests: matched.slice(0, limit).map(adminRequestView),
    };
}
const USAGE_WINDOWS = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000, '24h': USAGE_RETENTION_MS };
const USAGE_BUCKETS = { '1m': 60 * 1000, '5m': 5 * 60 * 1000, '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000 };
const USAGE_DEFAULT_BUCKET = { '15m': '1m', '1h': '1m', '6h': '5m', '24h': '15m' };
function usageCountersView(counters) {
    const { ms_total, ...rest } = counters;
    return { ...rest, avg_ms: counters.requests ? Math.round(ms_total / counters.requests) : 0 };
}
function sortedBreakdown(map) {
    return [...map.entries()]
        .map(([key, counters]) => ({ key, ...usageCountersView(counters) }))
        .sort((a, b) => b.requests - a.requests || (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
}
function adminUsageSummary(params) {
    const windowKey = params.get('window') ?? '24h';
    if (!Object.hasOwn(USAGE_WINDOWS, windowKey)) throw new AdminQueryError(`window must be one of ${Object.keys(USAGE_WINDOWS).join(', ')}`);
    const bucketKey = params.get('bucket') ?? USAGE_DEFAULT_BUCKET[windowKey];
    if (!Object.hasOwn(USAGE_BUCKETS, bucketKey)) throw new AdminQueryError(`bucket must be one of ${Object.keys(USAGE_BUCKETS).join(', ')}`);
    const windowMs = USAGE_WINDOWS[windowKey];
    const bucketMs = USAGE_BUCKETS[bucketKey];
    if (bucketMs > windowMs) throw new AdminQueryError(`bucket ${bucketKey} is larger than window ${windowKey}`);
    const now = Date.now();
    const points = Math.ceil(windowMs / bucketMs);
    const from = Math.floor(now / bucketMs) * bucketMs - (points - 1) * bucketMs;
    const series = Array.from({ length: points }, (_, i) => ({ t: from + i * bucketMs, counters: newUsageCounters() }));
    const totals = newUsageCounters();
    const dims = { account: new Map(), model: new Map(), endpoint: new Map(), agent: new Map() };
    const merge = (target, src) => { for (const k of Object.keys(target)) target[k] += src[k]; };
    for (const [minute, bucket] of usageMinutes) {
        if (minute < from || minute > now) continue;
        merge(series[Math.floor((minute - from) / bucketMs)].counters, bucket.totals);
        merge(totals, bucket.totals);
        for (const dim of Object.keys(dims)) {
            for (const [key, counters] of bucket[dim]) {
                if (!dims[dim].has(key)) dims[dim].set(key, newUsageCounters());
                merge(dims[dim].get(key), counters);
            }
        }
    }
    return {
        now,
        estimated: true,
        pricing: { input_per_m: USD_PER_M_INPUT, output_per_m: USD_PER_M_OUTPUT, currency: 'USD' },
        window: { key: windowKey, ms: windowMs, from, to: now },
        bucket: { key: bucketKey, ms: bucketMs },
        retention_ms: USAGE_RETENTION_MS,
        totals: usageCountersView(totals),
        by_account: sortedBreakdown(dims.account),
        by_model: sortedBreakdown(dims.model),
        by_endpoint: sortedBreakdown(dims.endpoint),
        by_agent: sortedBreakdown(dims.agent),
        series: series.map(({ t, counters }) => ({ t, ...usageCountersView(counters) })),
        lifetime: {
            since: STATS_STARTED_AT,
            ...usageCountersView(lifetimeUsage),
            by_account: [...usageByAccount.entries()]
                .map(([key, u]) => ({ key, requests: u.requests, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, usd: u.usd }))
                .sort((a, b) => b.requests - a.requests),
        },
    };
}

// --- Account files: import, rename / persistent enable, archive ---
const ADMIN_MAX_BODY_BYTES = 64 * 1024;
const ACCOUNT_NAME_MAX_CHARS = 64;
class AdminHttpError extends Error {
    constructor(status, type, message, extra = {}) { super(message); this.status = status; this.type = type; this.extra = extra; }
}
function readAdminJsonBody(req, maxBytes = ADMIN_MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) tooLarge = true;
            if (!tooLarge) chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return reject(new AdminHttpError(413, 'payload_too_large', `Request body is larger than ${maxBytes} bytes`));
            const text = Buffer.concat(chunks).toString('utf8');
            try {
                const value = JSON.parse(text || 'null');
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    return reject(new AdminHttpError(422, 'invalid_request', 'Request body must be a JSON object'));
                }
                resolve(value);
            } catch (e) {
                reject(new AdminHttpError(400, 'invalid_json', 'Request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}
// The directory the dashboard may write auth files to, or null when auth files come
// from an explicit DEEPSEEK_AUTH_PATH list. Mirrors discoverAuthPaths.
function managedAccountsDir() {
    if (process.env.DEEPSEEK_AUTH_DIR) return path.resolve(process.env.DEEPSEEK_AUTH_DIR);
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) return null;
    return path.resolve(ACCOUNTS_DIR);
}
function validAccountName(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new AdminHttpError(422, 'invalid_request', 'name must be a non-empty string');
    }
    const name = value.trim();
    if (name.length > ACCOUNT_NAME_MAX_CHARS) {
        throw new AdminHttpError(422, 'invalid_request', `name must be at most ${ACCOUNT_NAME_MAX_CHARS} characters`);
    }
    return name;
}
function accountSlug(name, taken) {
    const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
    if (slug) return slug;
    let n = 1;
    while (taken(`account-${n}`)) n++;
    return `account-${n}`;
}
function writeAuthFileAtomic(file, data) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (cleanup) { /* temp file was never created */ }
        throw new AdminHttpError(500, 'auth_file_write_failed', `Could not write auth file ${path.basename(file)}: ${e.code || 'error'}`);
    }
}
function adminImportAccount(body) {
    const name = validAccountName(body.name);
    if (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth)) {
        throw new AdminHttpError(422, 'invalid_request', 'auth must be a JSON object with token and cookie (the deepseek-auth.json shape)');
    }
    const dir = managedAccountsDir();
    if (!dir) {
        throw new AdminHttpError(409, 'import_unsupported', 'Auth files come from an explicit DEEPSEEK_AUTH_PATH list. Set DEEPSEEK_AUTH_DIR (or unset DEEPSEEK_AUTH_PATH) to import accounts from the dashboard.');
    }
    // Lazy: the container image ships without scripts/; only this route needs it.
    const { normalizeAuth, validateAuth } = require('./scripts/auth_import');
    const auth = normalizeAuth(body.auth, {}, { useEnv: false });
    const errors = validateAuth(auth);
    if (errors.length) throw new AdminHttpError(422, 'invalid_auth', `Invalid auth: ${errors.join(', ')}`, { errors });
    const duplicate = accounts.find(a => a.config?.token === auth.token);
    if (duplicate) {
        throw new AdminHttpError(409, 'duplicate_account', `This login is already loaded as ${duplicate.id}`, { account: duplicate.id });
    }
    const id = accountSlug(name, candidate => accounts.some(a => a.id === candidate) || fs.existsSync(path.join(dir, `${candidate}.json`)));
    const file = path.join(dir, `${id}.json`);
    if (accounts.some(a => a.id === id)) throw new AdminHttpError(409, 'account_exists', `An account with id ${id} already exists`, { account: id });
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ name, ...auth }, null, 2), { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    } catch (e) {
        if (e.code === 'EEXIST') throw new AdminHttpError(409, 'account_exists', `Auth file ${id}.json already exists`, { account: id });
        throw new AdminHttpError(500, 'auth_file_write_failed', `Could not write auth file ${id}.json: ${e.code || 'error'}`);
    }
    console.log(`[admin] imported account file ${id}.json`);
    const result = adminReloadAccounts();
    const account = accounts.find(a => a.file && path.resolve(a.file) === file);
    if (!result.ok || !account) {
        throw new AdminHttpError(500, 'import_not_loaded', `Wrote ${id}.json but the reload did not load it. Check DEEPSEEK_AUTH_DIR / DEEPSEEK_AUTH_PATH.`, { errors: result.errors || [] });
    }
    return { account, result };
}
const PATCH_FIELDS = new Set(['name', 'enabled']);
function adminPatchAccount(account, body) {
    const keys = Object.keys(body);
    const unknown = keys.filter(k => !PATCH_FIELDS.has(k));
    if (unknown.length) throw new AdminHttpError(422, 'invalid_request', `Unsupported field(s): ${unknown.join(', ')}. Allowed: name, enabled`);
    if (!keys.length) throw new AdminHttpError(422, 'invalid_request', 'Send name and/or enabled');
    const name = 'name' in body ? validAccountName(body.name) : undefined;
    if ('enabled' in body && typeof body.enabled !== 'boolean') throw new AdminHttpError(422, 'invalid_request', 'enabled must be true or false');
    if (!account.file) throw new AdminHttpError(409, 'auth_file_unreadable', `Account ${account.id} has no auth file`);
    let config;
    try {
        config = JSON.parse(fs.readFileSync(account.file, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected a JSON object');
    } catch (e) {
        throw new AdminHttpError(409, 'auth_file_unreadable', `Auth file of ${account.id} could not be read: ${describeAuthFileError(e)}`);
    }
    if (name !== undefined) config.name = name;
    if (body.enabled === false) config.enabled = false;
    if (body.enabled === true) delete config.enabled;
    writeAuthFileAtomic(account.file, config);
    console.log(`[admin] account ${account.id}: updated ${keys.join(', ')} in its auth file`);
    // Reload so the pool reflects the files exactly; kept logins keep their runtime state.
    const result = adminReloadAccounts();
    const file = path.resolve(account.file);
    const updated = accounts.find(a => a.file && path.resolve(a.file) === file);
    if (!result.ok || !updated) {
        throw new AdminHttpError(500, 'reload_failed', `Updated the auth file of ${account.id} but the reload did not load it.`, { errors: result.errors || [] });
    }
    if (body.enabled === true) updated.adminDisabled = false;
    return updated;
}
function adminArchiveAccount(account) {
    const dir = managedAccountsDir();
    const file = account.file ? path.resolve(account.file) : null;
    if (!dir || !file || path.dirname(file) !== dir) {
        throw new AdminHttpError(409, 'account_file_protected', `Account ${account.id} is not loaded from the managed accounts directory. Remove its auth file by hand, then reload accounts.`);
    }
    if (accounts.length === 1) {
        throw new AdminHttpError(409, 'last_account', `Account ${account.id} is the only loaded account. Import another one first.`);
    }
    const archived = `${file}.removed-${Date.now()}`;
    try {
        fs.renameSync(file, archived);
    } catch (e) {
        throw new AdminHttpError(500, 'auth_file_write_failed', `Could not archive ${path.basename(file)}: ${e.code || 'error'}`);
    }
    const result = adminReloadAccounts();
    if (!result.ok) {
        fs.renameSync(archived, file);
        throw new AdminHttpError(422, 'no_accounts_found', 'No other auth account could be loaded, so the account was kept.', { errors: result.errors });
    }
    console.log(`[admin] account ${account.id}: auth file archived as ${path.basename(archived)}`);
    return { archived_as: path.basename(archived), result };
}

const ARCHIVED_AUTH_FILE_RE = /^([A-Za-z0-9._-]+\.json)\.removed-\d+$/;
function adminRestoreAccount(body) {
    const name = body.archived_as;
    const match = typeof name === 'string' && !name.includes('/') && !name.includes('\\') && !name.startsWith('.') ? ARCHIVED_AUTH_FILE_RE.exec(name) : null;
    if (!match) {
        throw new AdminHttpError(422, 'invalid_request', 'archived_as must be the archived_as value returned by DELETE /admin/accounts/:id (<file>.json.removed-<time>)');
    }
    const dir = managedAccountsDir();
    if (!dir) {
        throw new AdminHttpError(409, 'accounts_dir_unmanaged', 'Auth files come from an explicit path list, so there is no accounts directory to restore into.');
    }
    const archived = path.join(dir, name);
    const target = path.join(dir, match[1]);
    if (!fs.existsSync(archived)) {
        throw new AdminHttpError(404, 'archive_not_found', `No archived auth file named ${name} in the accounts directory.`);
    }
    if (fs.existsSync(target)) {
        throw new AdminHttpError(409, 'restore_target_exists', `${match[1]} already exists in the accounts directory. Move it away first; ${name} was left in place.`);
    }
    const before = new Set(accounts.map(a => a.id));
    try {
        fs.renameSync(archived, target);
    } catch (e) {
        throw new AdminHttpError(500, 'auth_file_write_failed', `Could not restore ${name}: ${e.code || 'error'}`);
    }
    const result = adminReloadAccounts();
    const restored = accounts.filter(a => a.file && path.resolve(a.file) === target && !before.has(a.id)).map(a => a.id);
    if (!result.ok || restored.length === 0) {
        fs.renameSync(target, archived);
        adminReloadAccounts();
        throw new AdminHttpError(422, 'restore_failed', `${match[1]} did not load as an account, so it was archived again.`, { errors: result.errors || [] });
    }
    console.log(`[admin] restored ${name} as ${match[1]} (${restored.join(', ')})`);
    return { restored, result };
}

const ADMIN_ACCOUNT_ACTIONS = new Set(['disable', 'enable', 'clear-cooldown']);
const ADMIN_COLLECTION_ACTIONS = new Set(['reload', 'import', 'restore']);
async function handleAdminRequest(req, res, url) {
    const pathname = url.pathname;
    const access = adminAccessDecision({ remoteAddress: req.socket.remoteAddress, headers: req.headers });
    if (!access.allowed) {
        adminJson(res, access.status, { error: access.error });
        return;
    }
    const methodNotAllowed = (allow) => adminError(res, 405, 'method_not_allowed', `Use ${allow} for ${pathname}`, { Allow: allow });
    const parts = pathname.split('/').filter(Boolean); // ['admin', 'accounts', ...]
    try {
        if ((parts[1] === 'requests' || parts[1] === 'usage') && parts.length === 2) {
            if (req.method !== 'GET') return methodNotAllowed('GET');
            adminJson(res, 200, parts[1] === 'requests' ? adminRequestsList(url.searchParams) : adminUsageSummary(url.searchParams));
            return;
        }
        if (parts[1] !== 'accounts' || parts.length > 4) {
            adminError(res, 404, 'not_found', `Unknown admin endpoint: ${pathname}`);
            return;
        }
        if (parts.length === 2) {
            if (req.method !== 'GET') return methodNotAllowed('GET');
            const now = Date.now();
            adminJson(res, 200, { now, pool: adminPoolSummary(now), accounts: accounts.map(a => adminAccountView(a, now)) });
            return;
        }
        if (parts.length === 3 && ADMIN_COLLECTION_ACTIONS.has(parts[2]) && req.method !== 'DELETE' && req.method !== 'PATCH') {
            if (req.method !== 'POST') return methodNotAllowed('POST');
            if (parts[2] === 'reload') {
                const result = adminReloadAccounts();
                if (!result.ok) {
                    adminError(res, 422, 'no_accounts_found', 'No auth account could be loaded. The current pool is unchanged. Import one with npm run auth:import -- --output ./accounts/<name>.json.', {}, { errors: result.errors });
                    return;
                }
                const now = Date.now();
                adminJson(res, 200, {
                    added: result.added,
                    removed: result.removed,
                    kept: result.kept,
                    errors: result.errors,
                    accounts: accounts.map(a => adminAccountView(a, now)),
                    pool: adminPoolSummary(now),
                });
                return;
            }
            if (parts[2] === 'restore') {
                const { restored, result } = adminRestoreAccount(await readAdminJsonBody(req));
                const now = Date.now();
                adminJson(res, 200, {
                    restored,
                    errors: result.errors,
                    accounts: accounts.map(a => adminAccountView(a, now)),
                    pool: adminPoolSummary(now),
                });
                return;
            }
            const { account, result } = adminImportAccount(await readAdminJsonBody(req));
            const now = Date.now();
            adminJson(res, 201, {
                account: adminAccountView(account, now),
                added: result.added,
                removed: result.removed,
                errors: result.errors,
                accounts: accounts.map(a => adminAccountView(a, now)),
                pool: adminPoolSummary(now),
            });
            return;
        }
        if (parts.length === 4 && !ADMIN_ACCOUNT_ACTIONS.has(parts[3])) {
            adminError(res, 404, 'not_found', `Unknown admin endpoint: ${pathname}`);
            return;
        }
        if (parts.length === 4 && req.method !== 'POST') return methodNotAllowed('POST');
        if (parts.length === 3 && req.method !== 'PATCH' && req.method !== 'DELETE') return methodNotAllowed('PATCH, DELETE');
        let accountId;
        try { accountId = decodeURIComponent(parts[2]); }
        catch (e) { accountId = parts[2]; }
        const account = accounts.find(a => a.id === accountId);
        if (!account) {
            adminError(res, 404, 'account_not_found', `No account with id ${accountId}`);
            return;
        }
        if (parts.length === 3) {
            if (req.method === 'PATCH') {
                const updated = adminPatchAccount(account, await readAdminJsonBody(req));
                const now = Date.now();
                adminJson(res, 200, { account: adminAccountView(updated, now), pool: adminPoolSummary(now) });
                return;
            }
            const { archived_as, result } = adminArchiveAccount(account);
            const now = Date.now();
            adminJson(res, 200, {
                removed: [account.id],
                archived_as,
                errors: result.errors,
                accounts: accounts.map(a => adminAccountView(a, now)),
                pool: adminPoolSummary(now),
            });
            return;
        }
        const action = parts[3];
        if (action === 'disable') {
            account.adminDisabled = true;
        } else if (action === 'enable') {
            if (account.config?.enabled === false) {
                adminError(res, 409, 'disabled_in_file', `Account ${account.id} is disabled in its auth file ("enabled": false). Edit the file, then reload accounts.`);
                return;
            }
            account.adminDisabled = false;
        } else {
            account.cooldownUntil = 0;
            account.cooldownReason = null;
        }
        console.log(`[admin] account ${account.id}: ${action}`);
        const now = Date.now();
        adminJson(res, 200, { account: adminAccountView(account, now), pool: adminPoolSummary(now) });
    } catch (e) {
        if (e instanceof AdminQueryError) return adminError(res, 400, 'invalid_query', e.message);
        if (e instanceof AdminHttpError) return adminError(res, e.status, e.type, e.message, {}, e.extra);
        throw e;
    }
}

const DASHBOARD_DIR = path.join(__dirname, 'public', 'dashboard');
const DASHBOARD_FILES = new Map([
    ['/dashboard', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/dashboard/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/dashboard/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/dashboard/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);
const DASHBOARD_HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
};
function isDashboardPath(pathname) {
    return pathname === '/dashboard' || pathname.startsWith('/dashboard/');
}
// Flat dashboard assets: lowercase name without dots or slashes, so the path cannot
// leave public/dashboard and only .js/.css/.svg/.png/.jpg/.mp4 are served (never .md or dotfiles).
const DASHBOARD_ASSET_TYPES = {
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    mp4: 'video/mp4',
};
// Photos and video never change between releases of a file name; let the browser keep them.
const DASHBOARD_MEDIA = new Set(['png', 'jpg', 'mp4']);
function dashboardEntry(pathname) {
    if (DASHBOARD_FILES.has(pathname)) return DASHBOARD_FILES.get(pathname);
    const match = /^\/dashboard\/([a-z0-9][a-z0-9-]*)\.(js|css|svg|png|jpg|mp4)$/.exec(pathname);
    return match ? { file: `${match[1]}.${match[2]}`, type: DASHBOARD_ASSET_TYPES[match[2]], optional: true, media: DASHBOARD_MEDIA.has(match[2]) } : null;
}
// One "bytes=a-b" range (RFC 7233), clamped to the file; null when unsatisfiable or multi-range.
function parseByteRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start;
    let end;
    if (m[1] === '') {
        const suffix = Number(m[2]);
        if (!(suffix > 0)) return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return null;
    return { start, end };
}
// Static files only: index from a fixed map, assets by a strict name pattern.
// Fetch Metadata names how the browser wants a file. Photos and video load inside the
// dashboard as image/video; opening one as a page ("Open image in new tab", a pasted
// address) is refused. Clients that send no Fetch Metadata still get the file.
const MEDIA_DIRECT_OPEN_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

async function serveDashboard(req, res, pathname) {
    const entry = dashboardEntry(pathname);
    if (!entry) {
        jsonResponse(res, 404, { error: { message: `Not found: ${pathname}`, type: 'not_found' } }, { 'X-Content-Type-Options': 'nosniff' });
        return;
    }
    if (entry.media && MEDIA_DIRECT_OPEN_DESTS.has(String(req.headers['sec-fetch-dest'] || '').toLowerCase())) {
        jsonResponse(res, 403, { error: { message: 'Dashboard media is shown only inside the dashboard.', type: 'media_direct_open' } }, { 'X-Content-Type-Options': 'nosniff' });
        return;
    }
    let content;
    try {
        content = await fs.promises.readFile(path.join(DASHBOARD_DIR, entry.file));
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (entry.optional) {
            jsonResponse(res, 404, { error: { message: `Not found: ${pathname}`, type: 'not_found' } }, { 'X-Content-Type-Options': 'nosniff' });
            return;
        }
        jsonResponse(res, 404, { error: { message: `Dashboard files are not installed (expected public/dashboard/${entry.file} next to server.js).`, type: 'dashboard_unavailable' } });
        return;
    }
    const headers = { 'Content-Type': entry.type, ...DASHBOARD_HEADERS };
    // Vary keeps a cached copy loaded by the page from answering a direct open.
    if (entry.media) Object.assign(headers, { 'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'bytes', Vary: 'Origin, Sec-Fetch-Dest' });
    // Video elements (Safari above all) fetch by byte range; answer a single range, refuse the rest.
    if (entry.media && req.headers.range) {
        const size = content.length;
        const range = parseByteRange(req.headers.range, size);
        if (!range) {
            res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
            res.end();
            return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1 });
        res.end(content.subarray(range.start, range.end + 1));
        return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': content.length });
    res.end(content);
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz' || isDashboardPath(url.pathname));
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization)) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }

    // Dashboard: public static page (no data); it calls the gated /admin API.
    if (req.method === 'GET' && isDashboardPath(url.pathname)) {
        try {
            await serveDashboard(req, res, url.pathname);
        } catch (e) {
            console.error('[DS-API] dashboard error:', e.message);
            if (!res.headersSent) jsonResponse(res, 500, { error: { message: 'Could not read dashboard files', type: 'server_error' } });
        }
        return;
    }

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        try {
            await handleAdminRequest(req, res, url);
        } catch (e) {
            console.error('[admin] error:', e.message);
            if (!res.headersSent) adminError(res, 500, 'server_error', `Admin request failed: ${e.message}`);
        }
        return;
    }

    // Health check
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization);
        const health = { status: 'ok', service: 'FreeDeepseekAPI' };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            chat_locks: listAccountChatLocks(),
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    // Readiness probe (distinct from the liveness check above): 503 unless at least
    // one account can serve right now, so an aggregator/LB won't route to a cold pool.
    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => accountCanServe(a, now)).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return;
    }

    // Models: OpenAI-compatible list exposes only aliases verified to work through this proxy.
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    // Full mapping, including Web models observed but not currently usable through the direct API.
    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                account: session.accountId,
                history_size: session.history.length,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const result = resetAgentSession(agentId, { dropHistory: url.searchParams.get('history') === 'drop' });
        if (!result) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    // Backpressure: reject rather than fan out unbounded concurrent upstream work.
    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return;
    }

    let body = '';
    let bodyTooLarge = false;
    const MAX_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES || 30 * 1024 * 1024);
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY_BYTES) { bodyTooLarge = true; req.destroy(); } });
    req.on('end', async () => {
        if (bodyTooLarge) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'payload_too_large' } }));
            return;
        }
        inFlight++;
        let clientGone = false;
        res.on('close', () => { clientGone = true; });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        const lockHolder = { id: crypto.randomUUID(), agentId: null };
        const logRow = {
            ts: requestStartedAt,
            ip: clientIp(req),
            path: url.pathname,
            api: apiMode,
            status: 0,
            ok: false,
            stream: null,
            local: false,
            prompt_tokens: 0,
            completion_tokens: 0,
            reasoning_tokens: 0,
            usd: 0,
            ms: 0,
            agent: null,
            account: null,
            model: null,
            error_type: null,
            error_message: null,
        };
        // Error metadata only; recordRequest scrubs credentials and clips the text.
        const logError = (status, type, message) => {
            logRow.status = status;
            logRow.error_type = type;
            logRow.error_message = message;
        };
        try {
            const rawParams = JSON.parse(body || '{}');
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = params.messages || [];
            const imageContext = { inputs: extractImageInputs(messages), refFileIds: [] };
            const stream = params.stream === true;
            logRow.stream = stream;
            const requestedModel = canonicalizeModelId(params.model || DEFAULT_MODEL_ID);
            const webFlags = resolveRequestWebFlags(requestedModel, rawParams);
            const webAccess = prepareAgentWebAccess(params.tools, webFlags.search_enabled);
            const tools = webAccess.tools;
            const promptOptions = { nativeSearchNotice: webAccess.nativeSearchNotice };
            logRow.model = requestedModel;
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const agentId = requestedSession
                ? String(requestedSession)
                : ((remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') ? 'dev-agent' : remoteAddr);
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;
            lockHolder.agentId = agentId;
            // Optional: serve this request with one named login (the dashboard account switcher).
            const pinnedAccount = String(req.headers['x-account-id'] || '').trim();
            if (pinnedAccount) lockHolder.pinnedAccountId = pinnedAccount;
            logRow.agent = agentId;
            if (webAccess.nativeSearchNotice) {
                console.log(`${agentTag} Native DeepSeek Search on${webAccess.strippedNames.length ? `; stripped harness tools: ${webAccess.strippedNames.join(', ')}` : ''}`);
            }
            if (!isKnownModel(requestedModel)) {
                logError(400, 'invalid_model', `Unknown model: ${requestedModel}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                logError(400, 'unsupported_model', `${requestedModel} is not currently supported through this DeepSeek Web API path`);
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }

            // "/new" command: if the latest user message is exactly "/new" (whitespace-insensitive),
            // reset this agent's DeepSeek session/history instead of forwarding anything to DeepSeek.
            const lastUserMessage = [...messages].reverse().find(m => m && m.role === 'user');
            const lastUserText = lastUserMessage && typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content.trim()
                : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                logRow.status = 200;
                logRow.ok = true;
                logRow.local = true;
                if (stream) {
                    if (apiMode === 'anthropic') {
                        sendAnthropicStream(res, confirmation);
                    } else if (apiMode === 'responses') {
                        sendResponsesStream(res, confirmation);
                    } else {
                        sendOpenAIStream(res, confirmation);
                    }
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (apiMode === 'anthropic') {
                        res.end(JSON.stringify(toAnthropicResponse(confirmation)));
                    } else if (apiMode === 'responses') {
                        res.end(JSON.stringify(toResponsesResponse(confirmation)));
                    } else {
                        res.end(JSON.stringify(confirmation));
                    }
                }
                return;
            }

            if (isSessionTitleRequest(messages)) {
                const title = localSessionTitle(messages);
                console.log(`${agentTag} Answered session-title request locally: ${title}`);
                const confirmation = buildTextResponse(title, normalizeMessageContent(lastUserMessage?.content), requestedModel);
                logRow.status = 200;
                logRow.ok = true;
                logRow.local = true;
                if (stream) {
                    if (apiMode === 'anthropic') {
                        sendAnthropicStream(res, confirmation);
                    } else if (apiMode === 'responses') {
                        sendResponsesStream(res, confirmation);
                    } else {
                        sendOpenAIStream(res, confirmation);
                    }
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (apiMode === 'anthropic') {
                        res.end(JSON.stringify(toAnthropicResponse(confirmation)));
                    } else if (apiMode === 'responses') {
                        res.end(JSON.stringify(toResponsesResponse(confirmation)));
                    } else {
                        res.end(JSON.stringify(confirmation));
                    }
                }
                return;
            }

            const { prompt, systemPrompt } = formatMessages(messages, tools, promptOptions);
            // For usage accounting, count the CLIENT's original input — not the
            // proxy-expanded fullPrompt (system + injected tools + history) — so
            // prompt_tokens reflects what the caller actually sent.
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');

            const session = getOrCreateAgentSession(agentId);
            activeSession = session;

            // Roll over TTL/depth-limited sessions before deciding whether to
            // inject local recovery history into the newly built prompt.
            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            // Keep a recovery prompt available even while the upstream session
            // is healthy. If that remote chat expires mid-request, its opaque
            // state disappears and the replacement must receive local history.
            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages)
                ? ''
                : buildRecoveryHistoryPrefix(session.history);
            const resolved = resolveUpstreamPrompt(session, messages, tools, recoveryHistoryPrefix, promptOptions);
            const historyPrefix = resolved.historyPrefix;

            const promptBuild = buildBoundedPrompt(resolved.systemPrompt, historyPrefix, resolved.conversation);
            const freshPromptBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt);
            let fullPrompt = pinToolReminder(promptBuild.prompt, tools);
            const freshPrompt = pinToolReminder(freshPromptBuild.prompt, tools);
            let promptCompacted = promptBuild.compacted;
            if (!resolved.omittedSystem) session.sentSystemFingerprint = resolved.fingerprint;
            if (resolved.omittedSystem || resolved.omittedPriorTurns) {
                console.log(`${agentTag} Sticky continuation omitted ${resolved.omittedSystem ? `system prompt (${systemPrompt.length} chars)` : 'no system change'}${resolved.omittedPriorTurns ? ' and prior turns' : ''}; upstream ${promptBuild.promptChars} chars`);
            }
            if (promptBuild.compacted) {
                markContextCompacted(res);
                console.log(`${agentTag} Compacted upstream prompt ${promptBuild.originalChars} -> ${promptBuild.promptChars} chars${promptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
            }

            const startTime = Date.now();
            let initialCall = null;
            let fullContent = '';
            let reasoningContent = '';
            let finishReason = null;
            let modelError = null;
            let lastMessageId = null;
            let lastReadMs = 0;
            let overflow = false;

            // Process streaming response from DeepSeek — returns { content, reasoningContent, messageId, finishReason, modelError, rateLimited }
            async function readDeepSeekResponse(readable, account) {
                let buffer = '';
                let lastPath = null;
                const fragments = [];
                let fullContent = '';
                let reasoningContent = '';
                let newMessageId = null;
                let finishReason = null;
                let modelError = null;
                let rateLimitSignal = null;

                const rebuildFragmentState = () => {
                    const { responseText, thinkText } = rebuildFragmentText(fragments);
                    if (responseText) fullContent = responseText;
                    reasoningContent = thinkText;
                };

                const appendFragments = (value) => {
                    const incoming = Array.isArray(value) ? value : [value];
                    for (const fragment of incoming) {
                        if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
                    }
                    rebuildFragmentState();
                };

                const decoder = new TextDecoder();  // one instance: preserves multi-byte (Cyrillic/emoji) split across chunks
                for await (const chunk of readable) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const d = JSON.parse(line.slice(6));
                                if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                                if (isDeepSeekModelErrorEvent(d)) {
                                    modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                                    if (isRateLimitSignal(modelError)) rateLimitSignal = modelError;
                                } else if (isRateLimitSignal({ finish_reason: d.finish_reason })) {
                                    // Only server-controlled fields are inspected here; model
                                    // output text can legitimately mention rate limits.
                                    rateLimitSignal = { type: 'hint', content: d.content || '', finish_reason: d.finish_reason };
                                }
                                if (d.finish_reason) {
                                    finishReason = d.finish_reason;
                                }
                                if (d.p !== undefined) lastPath = d.p;
                                if (d.v && typeof d.v === 'object' && d.v.response) {
                                    if (d.v.response.message_id !== undefined) {
                                        newMessageId = d.v.response.message_id;
                                    }
                                    if (d.v.response.content !== undefined) {
                                        fullContent = d.v.response.content;
                                    }
                                    if (Array.isArray(d.v.response.fragments)) {
                                        fragments.length = 0;
                                        appendFragments(d.v.response.fragments);
                                    }
                                    if (d.v.response.finish_reason !== undefined) {
                                        finishReason = d.v.response.finish_reason;
                                    }
                                }
                                if (lastPath === 'response/fragments' && d.v !== undefined) {
                                    appendFragments(d.v);
                                }
                                if (lastPath === 'response' && d.v !== undefined) {
                                    applyResponsePatchOperations(d.v, appendFragments);
                                }
                                if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                                    if (fragments.length > 0) {
                                        const lastFragment = fragments[fragments.length - 1];
                                        lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                                        rebuildFragmentState();
                                    }
                                }
                                if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                                    fullContent += d.v;
                                }
                                if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                                    finishReason = d.v;
                                }
                                if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                                    finishReason = d.v;
                                }
                            } catch (e) { }
                        }
                    }
                }

                if (rateLimitSignal) {
                    // DeepSeek throttled this login inside a 200 stream (`event: hint`,
                    // finish_reason rate_limit_reached). Nothing was answered, so the
                    // chat must not advance; the caller fails over to another login.
                    const detail = rateLimitSignal.content || rateLimitSignal.finish_reason || 'rate_limit_reached';
                    const rateLimitError = accountRateLimitError(account, detail, null, 'completion stream', 200);
                    return { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: rateLimitSignal, rateLimited: true, rateLimitError };
                }

                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }

                return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError, rateLimited: false };
            }

            // Send one prompt and read it. When DeepSeek rate-limits the serving login
            // (before or inside the stream), that login is already on cooldown, so the
            // next askDeepSeekStream() drops its chat and picks another ready login,
            // which receives the full recovery prompt. When no login is left,
            // selectAccountForSession() throws the pool 429 (type rate_limit).
            // Failover hops do not consume empty/overflow retry budgets.
            async function callDeepSeekWithFailover(promptText, recoveryPrompt) {
                let lastError = null;
                const maxHops = accounts.length + 1;
                for (let hop = 0; hop < maxHops; hop++) {
                    const hopStarted = Date.now();
                    let failedAccountId = null;
                    try {
                        const call = await askDeepSeekStream(hop === 0 ? promptText : recoveryPrompt, agentId, requestedModel, recoveryPrompt, lockHolder, imageContext, webFlags);
                        const result = await readDeepSeekResponse(call.resp.body, call.account);
                        if (!result.rateLimited) return { call, result, elapsedMs: Date.now() - hopStarted };
                        failedAccountId = call.account.id;
                        lastError = result.rateLimitError;
                    } catch (e) {
                        if (!isAccountRateLimitError(e)) throw e;
                        failedAccountId = e.accountId;
                        lastError = e;
                    }
                    if (clientGone || deadlineHit()) throw lastError;
                    // Uploaded file ids and the chat lock belong to the throttled login.
                    releaseAccountChatLock(lockHolder);
                    imageContext.refFileIds.length = 0;
                    console.log(`${agentTag} account ${failedAccountId} rate-limited; failing over (hop ${hop + 1}).`);
                }
                throw lastError;
            }

            try {
                const first = await callDeepSeekWithFailover(fullPrompt, freshPrompt);
                initialCall = first.call;
                const firstRead = first.result;
                fullContent = sanitizeContent(firstRead.content);
                reasoningContent = sanitizeContent(firstRead.reasoningContent || '');
                finishReason = firstRead.finishReason;
                modelError = firstRead.modelError;
                lastMessageId = firstRead.messageId;
                lastReadMs = first.elapsedMs;
            } catch (e) {
                if (!isContextTooLongError(e)) throw e;
                overflow = true;
                modelError = { type: 'context_length_exceeded', content: e.message || e.content || '' };
                lastReadMs = Date.now() - startTime;
                console.log(`${agentTag} Upstream rejected the prompt as too long (${lastReadMs}ms). Compacting instead of resending it.`);
            }
            if (initialCall && initialCall.promptUsed !== fullPrompt) {
                fullPrompt = initialCall.promptUsed;
                if (freshPromptBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
            }

            if (initialCall) {
                overflow = overflow
                    || isContextTooLongError(modelError)
                    || isInstantEmptyResponse({
                        content: fullContent,
                        reasoningContent,
                        messageId: lastMessageId,
                        elapsedMs: lastReadMs,
                    });
                console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${lastReadMs}ms (msg#${session.messageCount})`);
            }

            // Empty/context-overflow recovery. Each retry gets a smaller prompt
            // and a fresh remote session; bounded attempts prevent retry storms.
            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                // Stop early if the client hung up or we've blown the request budget —
                // no point burning more PoW solves + account quota for a dead socket.
                if (clientGone) {
                    console.log(`${agentTag} client disconnected; abandoning empty-retry loop`);
                    logError(499, 'client_disconnected', 'Client disconnected while recovering an empty DeepSeek response');
                    if (!res.headersSent) {
                        res.writeHead(499, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: {
                            message: 'Client disconnected while recovering an empty DeepSeek response',
                            type: 'client_disconnected',
                            agent: agentId,
                        } }));
                    }
                    return;
                }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                overflow = overflow
                    || isContextTooLongError(modelError)
                    || isInstantEmptyResponse({
                        content: fullContent,
                        reasoningContent,
                        messageId: lastMessageId,
                        elapsedMs: lastReadMs,
                    });
                const keepSession = remoteSessionShouldStay(session, { overflow, modelError });
                if (modelError && !overflow && !isContextTooLongError(modelError) && !keepSession) break;
                const retryCap = overflow ? MAX_OVERFLOW_RETRIES : MAX_EMPTY_RETRIES;
                if (retryAttempt >= retryCap) break;
                retryAttempt++;

                const retryRatio = overflow
                    ? Math.max(0.15, 0.45 - retryAttempt * 0.15)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const minChars = overflow ? CONTEXT_OVERFLOW_MIN_CHARS : MIN_UPSTREAM_PROMPT_CHARS;
                const retryBudget = Math.max(minChars, Math.floor(MAX_UPSTREAM_PROMPT_CHARS * retryRatio));
                const retryBuild = keepSession
                    ? null
                    : buildRetryPrompt(systemPrompt, recoveryHistoryPrefix, prompt, fullPrompt, retryBudget);
                const retryPrompt = keepSession
                    ? emptyResponseNudge(webFlags.search_enabled)
                    : pinToolReminder(
                        appendPromptInstruction(retryBuild.prompt, emptyResponseNudge(webFlags.search_enabled), retryBudget),
                        tools,
                        retryBudget,
                    );
                if (retryBuild?.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = overflow ? 'context-too-long or instant-empty response' : 'empty response';
                if (keepSession) {
                    console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${retryCap}). Continuing chat ${session.id}; not resending the transcript.`);
                } else {
                    console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${retryCap}, prompt=${retryPrompt.length} chars). Resetting session...`);
                    resetRemoteSession(session);
                    session.sentSystemFingerprint = fingerprintPrompt(systemPrompt);
                }
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                try {
                    const recoveryPrompt = keepSession ? freshPrompt : retryPrompt;
                    const retry = await callDeepSeekWithFailover(retryPrompt, recoveryPrompt);
                    const retryResult = retry.result;
                    const retryState = normalizeRetryResponse(retryResult);
                    fullPrompt = retry.call.promptUsed;
                    modelError = retryState.modelError;
                    finishReason = retryState.finishReason;
                    lastMessageId = retryResult.messageId;
                    lastReadMs = retry.elapsedMs;
                    if (retryState.content && retryState.content.trim().length > 0) {
                        console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                        fullContent = retryState.content;
                        reasoningContent = retryState.reasoningContent;
                    } else {
                        overflow = overflow
                            || isContextTooLongError(modelError)
                            || isInstantEmptyResponse({
                                content: retryState.content,
                                reasoningContent: retryState.reasoningContent,
                                messageId: lastMessageId,
                                elapsedMs: lastReadMs,
                            });
                    }
                } catch (e) {
                    if (!isContextTooLongError(e)) throw e;
                    overflow = true;
                    modelError = { type: 'context_length_exceeded', content: e.message || e.content || '' };
                    fullPrompt = retryPrompt;
                    console.log(`${agentTag} Retry ${retryAttempt} still too long; shrinking further.`);
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const failureClass = classifyRecoveryFailure(modelError, timedOut, overflow);
                const keepSession = remoteSessionShouldStay(session, { overflow, modelError });
                const failure = keepSession
                    ? { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId }
                    : resetRemoteSession(session);
                if (keepSession) console.log(`${agentTag} Keeping chat ${session.id} after an empty reply so the next turn continues it.`);
                const errorType = failureClass.type;
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'DeepSeek request deadline reached while recovering an empty response'
                        : (overflow
                            ? 'DeepSeek rejected the prompt as too long after compaction retries'
                            : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`));
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                res.writeHead(failureClass.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: errorMessage,
                        type: errorType,
                        agent: agentId,
                        failed_session_id: failure.failedSessionId,
                        message_count: failure.failedMessageCount,
                        history_length: session.history.length,
                        account: failure.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                    }
                }));
                return;
            }

            // Auto-continuation: if finish_reason is 'length' or content is very long (>25000 chars),
            // send a continuation request to get the rest of the response
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while ((finishReason === 'length' || fullContent.length > 25000) && continuationRounds < MAX_CONTINUATION) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPrompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                let continuationCall;
                try {
                    continuationCall = await askDeepSeekStream(
                        'continue',
                        agentId,
                        requestedModel,
                        continuationRecoveryPrompt,
                        lockHolder,
                        imageContext,
                        webFlags
                    );
                } catch (e) {
                    if (!isRateLimitedPoolOrAccount(e)) throw e;
                    console.log(`${agentTag} continuation rate-limited (${e.message}); returning the ${fullContent.length} chars already received.`);
                    break;
                }
                const { resp: contResp, account: contAccount } = continuationCall;
                // A cross-account continuation is valid only when the call
                // detected that reset and sent the full recovery prompt. If an
                // unexpected rotation ever bypasses that guard, discard the new
                // remote session before returning to the client (#20).
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
                    resetRemoteSession(session);
                    break;
                }
                const contResult = await readDeepSeekResponse(contResp.body, contAccount);
                if (contResult.rateLimited) {
                    console.log(`${agentTag} continuation rate-limited on ${contAccount.id}; returning the ${fullContent.length} chars already received.`);
                    break;
                }
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += '\n' + contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            const allowedToolNames = new Set(tools
                .filter(tool => tool?.type === 'function' && tool.function?.name)
                .map(tool => tool.function.name));
            let toolCalls = collectAgentToolCalls(fullContent, allowedToolNames);
            let toolCall = toolCalls[0] || selectAgentToolCall(fullContent, allowedToolNames);
            let ignoredNativeTool = null;
            if (toolCall && isDeepSeekNativeTool(toolCall.name) && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Ignoring DeepSeek-native ${toolCall.name}; gateway tools cannot run it`);
                ignoredNativeTool = toolCall.name;
                toolCall = null;
            } else if (toolCall && allowedToolNames.size > 0 && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
                toolCall = null;
            } else if (toolCall && allowedToolNames.size === 0 && looksLikeToolCallMarkup(fullContent)) {
                // Chat-only clients must not receive raw DSML as the answer.
                ignoredNativeTool = toolCall.name;
                toolCall = null;
            }

            const dsmlCalls = listDsmlToolCalls(fullContent);
            const nativeOnlyDsml = dsmlCalls.length > 0 && dsmlCalls.every(call => isDeepSeekNativeTool(call.name));
            const shouldRepairNative = !toolCall && (Boolean(ignoredNativeTool) || nativeOnlyDsml);
            const shouldRepairMarkup = !toolCall && !shouldRepairNative && looksLikeToolCallMarkup(fullContent);
            const shouldRepairCodeDump = allowedToolNames.size > 0 && !toolCall && !shouldRepairMarkup && !shouldRepairNative && looksLikeCodeDumpInsteadOfTool(fullContent);
            const shouldRepairAbandoned = allowedToolNames.size > 0 && !toolCall && !shouldRepairMarkup && !shouldRepairNative && !shouldRepairCodeDump && looksLikeAbandonedToolLoop(fullContent, messages);
            if ((shouldRepairMarkup || shouldRepairCodeDump || shouldRepairNative || shouldRepairAbandoned) && !clientGone && !deadlineHit()) {
                const reason = shouldRepairNative
                    ? `Model called DeepSeek-native ${ignoredNativeTool || dsmlCalls.map(call => call.name).join(', ') || 'tool'}`
                    : (shouldRepairMarkup
                        ? 'Tool-call markup detected but invalid/truncated'
                        : (shouldRepairCodeDump
                            ? 'Model dumped source code instead of a tool request'
                            : 'Model stopped after a tool result without a next tool call'));
                console.log(`${agentTag} ${reason} (${fullContent.length} chars). Retrying with stricter prompt on the same session...`);
                const strictPrompt = shouldRepairNative
                    ? nativeToolRepairPrompt(webFlags.search_enabled)
                    : (shouldRepairMarkup
                        ? '[STRICT INSTRUCTION] Your previous response contained incomplete tool-call markup. Keep arguments short and output ONLY strict JSON: {"tool_call":{"name":"<function>","arguments":{...}}}'
                        : (shouldRepairCodeDump
                            ? '[STRICT INSTRUCTION] You pasted source code as plain text. This gateway cannot apply pasted files. Request exactly one tool to write or edit the file. Output ONLY strict JSON: {"tool_call":{"name":"<function>","arguments":{...}}}. Put file contents in the tool arguments, not in markdown fences.'
                            : '[STRICT INSTRUCTION] You stopped after a tool result. Continue the task. Output exactly one gateway tool request as {"tool_call":{"name":"<function>","arguments":{...}}} or a complete final answer if the work is finished.'));
                let retryResult2 = null;
                try {
                    const repairCall = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt, lockHolder, imageContext, webFlags);
                    retryResult2 = await readDeepSeekResponse(repairCall.resp.body, repairCall.account);
                } catch (e) {
                    if (!isRateLimitedPoolOrAccount(e)) throw e;
                    console.log(`${agentTag} strict repair skipped: ${e.message}`);
                }
                if (retryResult2?.rateLimited) {
                    console.log(`${agentTag} strict repair rate-limited; keeping the original reply.`);
                    retryResult2 = null;
                }
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = selectAgentToolCall(retryContent2, allowedToolNames);
                    const retryAccepted = retryTc && (
                        (allowedToolNames.size > 0 && allowedToolNames.has(retryTc.name))
                        || (allowedToolNames.size === 0 && !isDeepSeekNativeTool(retryTc.name))
                    );
                    if (retryAccepted) {
                        const retryCalls = collectAgentToolCalls(retryContent2, allowedToolNames);
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${(retryCalls.length ? retryCalls : [retryTc]).map(call => call.name).join(', ')}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCalls = retryCalls.length ? retryCalls : [retryTc];
                        toolCall = toolCalls[0];
                    } else if (!looksLikeToolCallMarkup(retryContent2) && !looksLikeCodeDumpInsteadOfTool(retryContent2)) {
                        console.log(`${agentTag} Retry produced a plain-text answer; using it.`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    } else {
                        console.log(`${agentTag} Retry still has ${shouldRepairMarkup || shouldRepairNative ? 'broken/native tool markup' : 'no tool request'}. ${shouldRepairCodeDump ? 'Passing the original text through.' : 'Returning a safe error instead of leaking it as text.'}`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }

            if (!toolCall && looksLikeToolCallMarkup(fullContent)) {
                const failure = { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId };
                console.log(`${agentTag} Keeping chat ${session.id || '(none)'} after malformed tool markup.`);
                logError(502, 'malformed_tool_call', 'DeepSeek returned malformed or native-only tool-call markup after one repair attempt');
                logRow.account = session.accountId;
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: {
                    message: 'DeepSeek returned malformed or native-only tool-call markup after one repair attempt',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: session.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                } }));
                return;
            }
            
            // Check if any tool results in the current conversation contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            if (!fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            const executableCalls = toolCalls.length ? toolCalls : (toolCall ? [toolCall] : []);
            storeHistory(agentId, prompt, fullContent, executableCalls);

            const openaiResponse = executableCalls.length
                ? buildToolCallResponse(executableCalls, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);

            logRow.ok = true;
            logRow.status = 200;
            logRow.account = session.accountId;
            recordAccountSuccess(accounts.find(a => a.id === session.accountId));
            logRow.prompt_tokens = openaiResponse.usage?.prompt_tokens || 0;
            logRow.completion_tokens = openaiResponse.usage?.completion_tokens || 0;
            logRow.reasoning_tokens = openaiResponse.usage?.completion_tokens_details?.reasoning_tokens || 0;
            logRow.usd = modelCostUsd(requestedModel, logRow.prompt_tokens, logRow.completion_tokens);
            res.setHeader('x-account-id', session.accountId || '');

            if (stream) {
                if (apiMode === 'anthropic') {
                    sendAnthropicStream(res, openaiResponse);
                } else if (apiMode === 'responses') {
                    sendResponsesStream(res, openaiResponse);
                } else {
                    sendOpenAIStream(res, openaiResponse);
                }
                console.log(`${agentTag} Streamed ${apiMode} (tools=${executableCalls.length}) in ${Date.now() - startTime}ms`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (apiMode === 'anthropic') {
                    res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
                } else if (apiMode === 'responses') {
                    res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
                } else {
                    res.end(JSON.stringify(openaiResponse));
                }
                console.log(`${agentTag} Response ${apiMode} (tools=${executableCalls.length}, ${Date.now() - startTime}ms, ${fullContent.length} chars)`);
            }
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            if (clientGone && !res.headersSent) {
                logError(499, 'client_disconnected', `Client disconnected: ${e.message}`);
                return;
            }
            if (res.headersSent) {
                logRow.error_type = logRow.error_type || e.type || 'server_error';
                logRow.error_message = logRow.error_message || e.message;
                return;
            }
            // Pool exhaustion / no-auth carry an explicit status so integrators see
            // 429/503 (not a generic 500) and can honor Retry-After.
            const timedOut = isTimeoutError(e);
            const overflowError = isContextTooLongError(e);
            const status = e.status || (overflowError ? 400 : (timedOut ? 504 : 500));
            const errorType = e.type || (overflowError ? 'context_length_exceeded' : (timedOut ? 'request_timeout' : 'server_error'));
            // A body that is not JSON surfaces as a SyntaxError whose text quotes the body.
            logError(status, errorType, e instanceof SyntaxError ? 'Request body is not valid JSON' : e.message);
            logRow.account = activeSession?.accountId || null;
            const headers = { 'Content-Type': 'application/json' };
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            res.writeHead(status, headers);
            const failure = timedOut && activeSession
                ? { failedSessionId: activeSession.id, failedMessageCount: activeSession.messageCount, accountId: activeSession.accountId }
                : null;
            if (timedOut && activeSession?.id) console.log(`[${activeAgentId}] Keeping chat ${activeSession.id} after timeout.`);
            res.end(JSON.stringify({ error: {
                message: e.message,
                type: errorType,
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            } }));
        } finally {
            logRow.ms = Date.now() - requestStartedAt;
            if (!logRow.status) logRow.status = res.statusCode || 0;
            if (!logRow.account) logRow.account = activeSession?.accountId || null;
            recordRequest(logRow);
            releaseAccountChatLock(lockHolder);
            inFlight--;
        }
    });
});

async function runAuthScript() {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
}

function startupStatus(lang) {
    const ready = hasAuthConfig();
    const active = accounts.filter(a => a.cooldownUntil <= Date.now()).length;
    const count = accounts.length;
    return [
        {
            ok: ready,
            label: '',
            value: ready
                ? `${t(lang, 'found')} · ${active}/${count} ${t(lang, 'accounts').toLowerCase()}`
                : t(lang, 'missing'),
        },
    ];
}

async function showModels(langRef) {
    await pick(
        () => {
            const lang = langRef.current;
            return {
                lang,
                subtitle: t(lang, 'models'),
                status: [
                    { ok: true, label: t(lang, 'standard'), value: 'deepseek-v4-flash' },
                    { ok: true, label: t(lang, 'think'), value: 'deepseek-v4-flash-thinking' },
                    { ok: true, label: t(lang, 'noSearch'), value: 'deepseek-v4-flash-nosearch' },
                    { ok: true, label: t(lang, 'thinkNoSearch'), value: 'deepseek-v4-flash-thinking-nosearch' },
                ],
                items: [
                    { id: 'back', label: t(lang, 'back'), help: t(lang, 'pressEnter') },
                ],
            };
        },
        (next) => { langRef.current = next; saveUiLang(next); },
    );
}

function dashboardUrl(host, port) {
    const h = String(host || '127.0.0.1');
    // A wildcard bind address is not something a browser can open.
    const target = (h === '0.0.0.0' || h === '::' || h === '') ? '127.0.0.1' : h;
    return `http://${target.includes(':') ? `[${target}]` : target}:${port}/dashboard`;
}
function openDashboardInBrowser(url) {
    const { cmd, args } = browserOpenCommand(process.platform, url);
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
        console.error(`[DS-API] Could not open a browser (${cmd}: ${err.code || err.message}). Open ${url} yourself.`);
    });
    child.unref();
}

async function showStartupMenu() {
    const openDashboard = process.argv.includes('--dashboard') || isTruthy(process.env.OPEN_DASHBOARD);
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE) || openDashboard) {
        // The dashboard can import the first account itself, so it starts without one.
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: !openDashboard });
        return { start: true, openDashboard };
    }
    const langRef = { current: loadUiLang() };
    while (true) {
        const chosen = await pick(
            () => {
                const lang = langRef.current;
                return {
                    lang,
                    subtitle: t(lang, 'startSubtitle'),
                    status: startupStatus(lang),
                    items: [
                        { id: 'start', label: t(lang, 'start'), help: t(lang, 'helpStart') },
                        { id: 'dashboard', label: t(lang, 'startDashboard'), help: t(lang, 'helpStartDashboard') },
                        { id: 'login', label: t(lang, 'login'), help: t(lang, 'helpLogin') },
                        { id: 'import', label: t(lang, 'import'), help: t(lang, 'helpImport') },
                        { id: 'models', label: t(lang, 'modelsList'), help: t(lang, 'helpModels') },
                        { id: 'quit', label: t(lang, 'quit'), help: t(lang, 'helpQuit') },
                    ],
                };
            },
            (next) => { langRef.current = next; saveUiLang(next); },
        );
        if (chosen.id === 'login') await runAuthScript();
        else if (chosen.id === 'import') {
            spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env });
            loadDeepSeekConfig({ fatal: false });
        } else if (chosen.id === 'models') {
            await showModels(langRef);
        } else if (chosen.id === 'start' || chosen.id === 'dashboard') {
            // The dashboard can import the first account itself; plain start needs one.
            if (chosen.id === 'start' && !hasAuthConfig()) {
                console.log(t(langRef.current, 'needAuth'));
                await pause(langRef.current);
                continue;
            }
            return { start: true, openDashboard: chosen.id === 'dashboard' };
        } else {
            return { start: false, openDashboard: false };
        }
    }
}

async function main() {
    printBanner();
    requireProxyApiKey(PROXY_API_KEY, isTruthy(process.env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !PROXY_API_KEY) {
        console.warn(`[DS-API] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
        if (PROXY_ADMIN_ALLOW_REMOTE) {
            console.warn('[DS-API] WARNING: PROXY_ADMIN_ALLOW_REMOTE=1 without PROXY_API_KEY lets anyone on the network pause, resume, and reload your DeepSeek accounts.');
        }
    }
    const startup = await showStartupMenu();
    if (!startup.start) process.exit(0);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[DS-API] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[DS-API] server error:', err);
        process.exit(1);
    });
    // Periodically evict idle sessions (unref'd so it never keeps the process alive).
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
        console.log(`[DS-API] GET  /dashboard — account dashboard (admin API: /admin/accounts${PROXY_API_KEY || PROXY_ADMIN_ALLOW_REMOTE ? '' : ', localhost only'})`);
        if (startup.openDashboard) {
            const url = dashboardUrl(HOST, PORT);
            console.log(`[DS-API] Opening ${url}`);
            openDashboardInBrowser(url);
        }
    });
}

if (require.main === module) {
    // Don't let a stray rejection/throw take the whole proxy down silently.
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    process.on('uncaughtException', (err) => console.error('[DS-API] uncaughtException:', err));
    // Graceful shutdown: stop accepting, drain, then exit (force-exit after 10s).
    const shutdown = (sig) => {
        console.log(`[DS-API] ${sig} received — shutting down…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
}

module.exports = {
    __test: {
        server,
        buildBaseHeaders,
        isRateLimitSignal,
        markAccountFailure,
        markAccountRateLimited,
        recordAccountSuccess,
        accountRateLimitError,
        isAccountRateLimitError,
        readAccountFiles,
        buildAccountsList,
        adminAccessDecision,
        adminAccountView,
        adminPoolSummary,
        recordRequest,
        requestLog,
        clearRequestStats,
        scrubLogText,
        isAssistantOutputFragment,
        isReasoningFragment,
        isDeepSeekModelErrorEvent,
        createUpstreamHttpError,
        rebuildFragmentText,
        applyResponsePatchOperations,
        compactToolSchema,
        formatToolDefinitions,
        formatToolReminder,
        pinToolReminder,
        parseToolCall,
        listDsmlToolCalls,
        collectAgentToolCalls,
        buildToolCallResponse,
        selectAgentToolCall,
        parseDsmlToolCall,
        looksLikeToolCallMarkup,
        looksLikeCodeDumpInsteadOfTool,
        isDeepSeekNativeTool,
        emptyResponseNudge,
        nativeToolRepairPrompt,
        splitConversationTurns,
        compactConversation,
        truncatePromptMiddle,
        hasExplicitConversationHistory,
        buildRecoveryHistoryPrefix,
        buildBoundedPrompt,
        buildRetryPrompt,
        isContinuationRecoverySafe,
        isContextTooLongError,
        isInstantEmptyResponse,
        lastTurnIsToolResult,
        looksLikeAbandonedToolLoop,
        normalizeRetryResponse,
        classifyRecoveryFailure,
        remoteSessionShouldStay,
        isTimeoutError,
        normalizeApiParams,
        extractImageInputs,
        materializeImageInput,
        formatMessages,
        isOpenCodeSystemPrompt,
        adaptOpenCodeSystemPrompt,
        OPENCODE_AUTONOMY_INSTRUCTION,
        fingerprintPrompt,
        continuationMessages,
        resolveUpstreamPrompt,
        stripHarnessWebSearchTools,
        isHarnessWebSearchTool,
        prepareAgentWebAccess,
        resolveRequestWebFlags,
        nativeSearchAndThinkNotice,
        adaptHarnessWebAccess,
        createSession,
        resetAgentSession,
        resetRemoteSession,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        accounts,
        selectAccountForSession,
        dashboardUrl,
        dashboardEntry,
        serveDashboard,
        parseByteRange,
        browserOpenCommand,
        acquireAccountChatLock,
        releaseAccountChatLock,
        listAccountChatLocks,
        isSessionTitleRequest,
        localSessionTitle,
        discoverAuthPaths,
        accountCanServe,
        accountStatus,
        clientIp,
        modelCostUsd,
        isProxyAuthorized,
        loadProxyApiKey,
        requireProxyApiKey,
        isLoopbackHost,
        normalizeOrigin,
        isBrowserOriginAllowed,
        DEFAULT_MODEL_ID,
        canonicalizeModelId,
        MODEL_CONFIGS,
        SUPPORTED_MODEL_IDS,
        resolveModelConfig,
        isKnownModel,
        isSupportedModel,
        setCorsResponseHeaders,
        markContextCompacted,
        CONTEXT_COMPACTED_HEADER,
        sendAnthropicStream,
        sendResponsesStream,
        sendOpenAIStream,
    },
};
