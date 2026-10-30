'use strict';
// Proof-of-work solver for the DeepSeek Web API.
//
// The PoW WASM module is immutable per URL, so we compile it ONCE and cache the
// compiled WebAssembly.Module; each solve only spins up a fresh instance (clean
// linear memory). This removes a network download + recompile from every single
// completion (and every retry), and gives the WASM fetch a hard timeout so a
// stalled CDN can never hang a request forever.
//
// Fetch uses redirect: 'manual' and refuses every redirect, so a 302 cannot
// supply bytes from another host. wasm_solve runs on a worker_thread; the worker
// is terminated when the solve times out, so a module that never returns cannot
// freeze the HTTP thread.
//
// Used by server.js. solvePOW(challenge, wasmUrl, opts).

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_SOLVE_TIMEOUT_MS = 15000;

// The proxy downloads and runs this WebAssembly for every PoW challenge.
// scripts/auth_import.js re-exports this so import, account files, and Chrome
// capture all share one host rule. The container image ships lib/pow.js and
// not scripts/auth_import.js.
function isDeepseekWasmUrl(value) {
    let parsed;
    try { parsed = new URL(String(value)); }
    catch { return false; }
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'deepseek.com' || host.endsWith('.deepseek.com'));
}

function wasmUrlOrDefault(value) {
    return isDeepseekWasmUrl(value) ? String(value) : DEFAULT_WASM;
}

function solveModule(wasmModule, challenge) {
    const instance = new WebAssembly.Instance(wasmModule, { wbg: {} });
    const e = instance.exports;
    const encoder = new TextEncoder();
    const prefix = challenge.salt + '_' + challenge.expire_at + '_';
    const cBytes = encoder.encode(challenge.challenge);
    const pBytes = encoder.encode(prefix);
    const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
    const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
    new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
    const sp = e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const ans = dv.getFloat64(sp + 8, true);
    e.__wbindgen_add_to_stack_pointer(16);
    if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
    return Math.floor(ans);
}

if (!isMainThread) {
    try {
        const answer = solveModule(workerData.wasmModule, workerData.challenge);
        parentPort.postMessage({ ok: true, answer });
    } catch (err) {
        parentPort.postMessage({ ok: false, error: err && err.message ? err.message : 'POW failed' });
    }
    return;
}

const moduleCache = new Map(); // wasmUrl -> Promise<WebAssembly.Module>

function isRedirectResponse(resp) {
    if (!resp) return false;
    if (resp.redirected || resp.type === 'opaqueredirect') return true;
    return resp.status >= 300 && resp.status < 400;
}

async function loadModule(wasmUrl, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
    if (!isDeepseekWasmUrl(wasmUrl)) {
        throw new Error('POW: wasmUrl must be an https://*.deepseek.com URL');
    }
    if (!moduleCache.has(wasmUrl)) {
        const pending = (async () => {
            const resp = await fetch(wasmUrl, {
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
            });
            // A redirect's body is the other host's payload when a client follows
            // it. Drop the response before arrayBuffer/compile.
            if (isRedirectResponse(resp)) throw new Error('POW: refusing redirect');
            if (!resp.ok) throw new Error(`POW: could not fetch WASM (HTTP ${resp.status})`);
            if (resp.url && !isDeepseekWasmUrl(resp.url)) {
                throw new Error('POW: refusing WASM from another host');
            }
            const bytes = await resp.arrayBuffer();
            return WebAssembly.compile(bytes);
        })();
        moduleCache.set(wasmUrl, pending);
        // Don't cache a failed download — let the next solve retry the fetch.
        pending.catch(() => moduleCache.delete(wasmUrl));
    }
    return moduleCache.get(wasmUrl);
}

function solveTimeoutMs(opts) {
    const value = opts && opts.solveTimeoutMs;
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SOLVE_TIMEOUT_MS;
}

function solveInWorker(wasmModule, challenge, timeoutMs) {
    // execArgv is empty so a parent `node --test` does not relaunch the worker
    // as another test runner. The worker only has to instantiate and solve.
    const worker = new Worker(__filename, {
        workerData: { wasmModule, challenge },
        execArgv: [],
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => done(new Error('POW: wasm_solve timed out')), timeoutMs);
        function done(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            // terminate() emits exit. That must not turn a finished solve into a failure,
            // so there is no exit listener; a crashed worker emits error, and a module
            // that never returns is stopped by the timer above.
            worker.terminate().then(
                () => (err ? reject(err) : resolve(value)),
                () => (err ? reject(err) : resolve(value)),
            );
        }
        worker.on('message', (msg) => {
            if (msg && msg.ok) done(null, msg.answer);
            else done(new Error((msg && msg.error) || 'POW failed'));
        });
        worker.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
    });
}

async function solvePOW(challenge, wasmUrl, opts = {}) {
    const wasmModule = await loadModule(wasmUrl, opts);
    return solveInWorker(wasmModule, challenge, solveTimeoutMs(opts));
}

module.exports = {
    solvePOW,
    isDeepseekWasmUrl,
    wasmUrlOrDefault,
    DEFAULT_WASM,
    _moduleCache: moduleCache,
};
