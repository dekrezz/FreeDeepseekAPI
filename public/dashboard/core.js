// FreeDeepseekAPI dashboard: shared core (window.FDSA).
// Fetch wrapper, auth gates, poller and shared store, router helpers, toasts,
// popovers, tooltips, inspector, formatters. No dependencies, no modules.
//
// Safety rule for every file: server and model text is written only through
// textContent / createTextNode. Nothing here or elsewhere assigns innerHTML.
(() => {
  'use strict';

  const F = window.FDSA = window.FDSA || {};
  const SVGNS = 'http://www.w3.org/2000/svg';
  const KEY_STORAGE = 'freedeepseek.proxyKey';
  const POLL_MS = 5000;
  const MAX_BACKOFF_MS = 30000;
  const REQUEST_CAPACITY = 400;

  F.views = F.views || {};
  F.SVGNS = SVGNS;
  F.POLL_MS = POLL_MS;

  // ---------------------------------------------------------------- events
  const listeners = new Map();
  F.on = (evt, fn) => {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  };
  F.emit = (evt, data) => {
    for (const fn of listeners.get(evt) || []) {
      try { fn(data); } catch (e) { console.error(`[dashboard] ${evt} handler failed`, e); }
    }
  };

  // ---------------------------------------------------------------- DOM
  function append(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function applyProps(el, props) {
    if (!props) return;
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate') el[k] = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  // h('div', {class:'x', text:'y', onclick}, ...children)
  F.h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    applyProps(el, props);
    return append(el, kids);
  };
  F.s = (tag, props, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    applyProps(el, props);
    return append(el, kids);
  };
  F.icon = (name, cls = '') => {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', `icon ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };
  const LAMP_STATES = new Set(['ready', 'busy', 'cooldown', 'disabled', 'no_credentials', 'error']);
  F.lamp = (state, cls = '') => {
    const s = LAMP_STATES.has(state) ? state : 'disabled';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', `lamp lamp-${s} ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', `#l-${s}`);
    svg.append(use);
    return svg;
  };
  F.setLamp = (svg, state) => {
    const s = LAMP_STATES.has(state) ? state : 'disabled';
    svg.setAttribute('class', svg.getAttribute('class').replace(/\blamp-[a-z_]+\b/g, '').trim() + ` lamp-${s}`);
    svg.querySelector('use').setAttribute('href', `#l-${s}`);
  };
  F.$ = (sel, root = document) => root.querySelector(sel);
  F.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  F.btn = (label, { kind = 'secondary', icon, onclick, size, title, type = 'button', ...rest } = {}) =>
    F.h('button', { type, class: ['btn', `btn-${kind}`, size && `btn-${size}`], onclick, 'data-tip': title, ...rest },
      icon ? F.icon(icon) : null, label ? F.h('span', { class: 'btn-label', text: label }) : null);
  F.iconBtn = (icon, label, { onclick, cls = '', ...rest } = {}) =>
    F.h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), 'aria-label': label, 'data-tip': label, onclick, ...rest }, F.icon(icon));

  F.reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  F.announce = (text) => {
    const el = document.getElementById('announcer');
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = text; });
  };

  // ---------------------------------------------------------------- formatting
  const nf = new Intl.NumberFormat(undefined);
  const nfCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const nfPct = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
  F.fmt = {
    int: (n) => (Number.isFinite(n) ? nf.format(Math.round(n)) : '—'),
    compact: (n) => (Number.isFinite(n) ? (Math.abs(n) < 10000 ? nf.format(Math.round(n)) : nfCompact.format(n)) : '—'),
    pct: (n) => (Number.isFinite(n) ? nfPct.format(n) : '—'),
    usd(n) {
      if (!Number.isFinite(n)) return '—';
      if (n === 0) return '$0';
      if (n < 0.01) return `$${n.toFixed(4)}`;
      if (n < 100) return `$${n.toFixed(2)}`;
      return `$${nf.format(Math.round(n))}`;
    },
    ms(ms) {
      if (!Number.isFinite(ms)) return '—';
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
      return F.fmt.clock(ms / 1000);
    },
    // m:ss (or h:mm:ss) countdown
    clock(sec) {
      const s = Math.max(0, Math.ceil(sec));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
    },
    time(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    },
    hm(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    },
    dateTime(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    },
    ago(ts, now = F.now()) {
      if (!ts) return '—';
      const d = Math.max(0, now - ts) / 1000;
      if (d < 5) return 'just now';
      if (d < 60) return `${Math.floor(d)}s ago`;
      if (d < 3600) return `${Math.floor(d / 60)}m ago`;
      if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
      return `${Math.floor(d / 86400)}d ago`;
    },
    shortModel: (id) => (id ? String(id).replace(/^deepseek-v4-/, '') : '—'),
    endpoint(path) {
      if (path === '/v1/chat/completions') return 'OpenAI chat';
      if (path === '/v1/messages') return 'Anthropic messages';
      if (path === '/v1/responses') return 'Responses';
      return path || '—';
    },
    api(api) {
      return { openai: 'OpenAI chat', anthropic: 'Anthropic messages', responses: 'Responses' }[api] || api || '—';
    },
    cooldownReason: (r) => ({ rate_limit: 'rate limit', auth: 'auth error' }[r] || r || 'cooldown'),
  };

  // ---------------------------------------------------------------- clock
  let offsetMs = 0;
  F.now = () => Date.now() + offsetMs;
  F.syncClock = (serverNow) => {
    if (Number.isFinite(serverNow)) offsetMs = serverNow - Date.now();
  };

  // ---------------------------------------------------------------- API
  class ApiError extends Error {
    constructor(message, { status = 0, type = null, body = null, endpoint = '', retryAfter = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.type = type;
      this.body = body;
      this.endpoint = endpoint;
      this.retryAfter = retryAfter;
    }
  }
  F.ApiError = ApiError;

  F.key = {
    get() { try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; } },
    set(v) { sessionStorage.setItem(KEY_STORAGE, v); },
    clear() { try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* storage blocked: nothing stored */ } },
  };

  F.authHeaders = (extra = {}) => {
    const headers = { ...extra };
    const key = F.key.get();
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  };

  // Turns a non-OK fetch Response into an ApiError, reading the JSON error body.
  F.errorFromResponse = async (res, endpoint) => {
    let body = null;
    const text = await res.text().catch(() => '');
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    const err = body && body.error;
    let message;
    if (typeof err === 'string') message = err;
    else if (err && err.message) message = err.message;
    else message = `${endpoint} answered HTTP ${res.status}${text && !body ? `: ${text.slice(0, 200)}` : ''}.`;
    const ra = Number(res.headers.get('retry-after'));
    return new ApiError(message, {
      status: res.status,
      type: (err && typeof err === 'object' && err.type) || null,
      body,
      endpoint,
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null,
    });
  };

  F.networkError = (e, endpoint) => new ApiError(
    e && e.name === 'AbortError' && e.timeout
      ? `${endpoint} did not answer within ${Math.round(e.timeout / 1000)}s.`
      : `Can't reach the proxy at ${location.host} (${(e && e.name) || 'Error'}).`,
    { status: 0, type: 'network', endpoint },
  );

  // JSON API call. Errors throw ApiError with the server's message and type.
  F.api = async (method, path, { body, timeout = 15000, signal } = {}) => {
    const endpoint = `${method} ${path.split('?')[0]}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const headers = F.authHeaders({ Accept: 'application/json' });
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, {
        method, headers, cache: 'no-store', credentials: 'omit', signal: controller.signal,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      const err = timedOut ? Object.assign(new Error('timeout'), { name: 'AbortError', timeout }) : e;
      throw F.networkError(err, endpoint);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw await F.errorFromResponse(res, endpoint);
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      throw new ApiError(`${endpoint} sent a response that is not JSON.`, { status: res.status, type: 'invalid_response', endpoint });
    }
  };

  // ---------------------------------------------------------------- gates
  const gate = { mode: null, keyRejected: false };
  F.gate = gate;
  // Shows the key or forbidden gate for auth errors. Returns true when it did.
  F.handleGate = (err) => {
    if (!err) return false;
    if (err.status === 401) {
      gate.keyRejected = Boolean(F.key.get());
      showGate('key');
      return true;
    }
    if (err.status === 403 && err.type === 'admin_forbidden') {
      showGate('forbidden', err.message);
      return true;
    }
    return false;
  };
  function showGate(mode, serverMessage = '') {
    gate.mode = mode;
    const root = document.getElementById('gate');
    const wasHidden = root.hidden;
    root.hidden = false;
    document.getElementById('app').setAttribute('inert', '');
    document.getElementById('gate-key').hidden = mode !== 'key';
    document.getElementById('gate-forbidden').hidden = mode !== 'forbidden';
    document.getElementById('gate-title').textContent = mode === 'key' ? 'Enter the proxy access key' : 'This browser is not allowed to use the admin API';
    document.getElementById('gate-key-text').textContent = gate.keyRejected
      ? 'The saved key was refused by the server. Enter the current PROXY_API_KEY.'
      : 'This proxy has PROXY_API_KEY set. The key is kept in this tab only and sent as a Bearer header.';
    document.getElementById('gate-server-message').textContent = serverMessage ? `Server: ${serverMessage}` : '';
    poller.stop();
    if (wasHidden && mode === 'key') requestAnimationFrame(() => document.getElementById('gate-input').focus());
  }
  F.hideGate = () => {
    gate.mode = null;
    document.getElementById('gate').hidden = true;
    document.getElementById('app').removeAttribute('inert');
  };
  F.openKeyGate = () => { gate.keyRejected = false; showGate('key'); };

  // ---------------------------------------------------------------- store + poller
  // One poller feeds every view: GET /admin/accounts and GET /admin/requests.
  const store = {
    accounts: null,       // last /admin/accounts body
    requests: [],         // RequestView rows, newest first, deduped by id (mirror of the server buffer)
    requestsMeta: null,   // { capacity, total, oldest_ts }
    requestsMissing: false, // server build without GET /admin/requests
    requestsError: null,
    lastOkAt: null,
    error: null,          // ApiError of the last failed accounts poll
    failStreak: 0,
    nextPollAt: null,
    live: true,
    firstLoadDone: false,
  };
  F.store = store;
  F.REQUEST_CAPACITY = REQUEST_CAPACITY;

  F.accountById = (id) => (store.accounts && store.accounts.accounts.find(a => a.id === id)) || null;

  // Merges new rows into the mirror. Detects a server restart (ids went backwards).
  function mergeRequests(body, full) {
    const rows = Array.isArray(body.requests) ? body.requests : [];
    const maxKnown = store.requests.length ? store.requests[0].id : 0;
    const maxNew = rows.length ? rows[0].id : 0;
    if (full || maxNew < maxKnown || (body.total != null && body.total < Math.min(store.requests.length, REQUEST_CAPACITY) && !full)) {
      store.requests = rows.slice();
    } else {
      const fresh = rows.filter(r => r.id > maxKnown);
      store.requests = fresh.concat(store.requests).slice(0, body.capacity || REQUEST_CAPACITY);
    }
    store.requestsMeta = { capacity: body.capacity || REQUEST_CAPACITY, total: body.total, oldest_ts: body.oldest_ts };
  }

  async function pollRequests() {
    const first = store.requests.length === 0;
    const limit = first ? REQUEST_CAPACITY : 100;
    const body = await F.api('GET', `/admin/requests?limit=${limit}`);
    const maxKnown = store.requests.length ? store.requests[0].id : 0;
    const rows = body.requests || [];
    // More than `limit` rows arrived since the last poll: fetch the whole buffer.
    const gap = !first && rows.length === limit && rows[rows.length - 1].id > maxKnown + 1;
    if (gap) {
      const all = await F.api('GET', `/admin/requests?limit=${REQUEST_CAPACITY}`);
      mergeRequests(all, true);
    } else {
      mergeRequests(body, first);
    }
  }

  const poller = {
    timer: null,
    inFlight: null,
    stop() { clearTimeout(this.timer); this.timer = null; store.nextPollAt = null; },
    schedule(delay) {
      this.stop();
      if (!store.live || document.visibilityState !== 'visible' || gate.mode) return;
      const d = delay != null ? delay : (store.failStreak ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** store.failStreak) : POLL_MS);
      store.nextPollAt = Date.now() + d;
      this.timer = setTimeout(() => this.run(), d);
    },
    run() {
      if (this.inFlight) return this.inFlight;
      this.stop();
      this.inFlight = (async () => {
        const [acc, req] = await Promise.allSettled([
          F.api('GET', '/admin/accounts'),
          store.requestsMissing ? Promise.resolve(null) : pollRequests(),
        ]);
        if (acc.status === 'fulfilled') {
          store.accounts = acc.value;
          F.syncClock(acc.value.now);
          store.lastOkAt = Date.now();
          store.error = null;
          store.failStreak = 0;
          if (gate.mode) F.hideGate();
        } else {
          const err = acc.reason;
          if (!F.handleGate(err)) {
            store.error = err;
            store.failStreak += 1;
          }
        }
        if (req.status === 'rejected') {
          const err = req.reason;
          if (err && err.status === 404 && err.type === 'not_found') store.requestsMissing = true;
          else if (!F.handleGate(err)) store.requestsError = err;
        } else if (!store.requestsMissing) {
          store.requestsError = null;
        }
        store.firstLoadDone = true;
        F.emit('accounts', store.accounts);
        F.emit('requests', store.requests);
        F.emit('poll', store);
      })().finally(() => {
        this.inFlight = null;
        this.schedule();
      });
      return this.inFlight;
    },
  };
  F.poller = poller;
  F.refresh = () => poller.run();
  // Apply an action response ({account, pool}) to the store without waiting for a poll.
  F.applyAccountUpdate = (body) => {
    if (!store.accounts || !body) return;
    if (Array.isArray(body.accounts)) store.accounts.accounts = body.accounts;
    else if (body.account) {
      const i = store.accounts.accounts.findIndex(a => a.id === body.account.id);
      if (i >= 0) store.accounts.accounts[i] = body.account;
      else store.accounts.accounts.push(body.account);
    }
    if (body.pool) store.accounts.pool = body.pool;
    F.emit('accounts', store.accounts);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (store.live && !gate.mode) poller.run(); }
    else poller.stop();
  });

  // Live remaining seconds for a cooldown, from the server clock.
  F.cooldownLeft = (account) => (account && account.cooldown_until ? Math.max(0, (account.cooldown_until - F.now()) / 1000) : 0);

  // Pool summary sentence pieces shared by the sidebar, Status and Chat.
  F.poolSignal = () => {
    const data = store.accounts;
    if (!data) return { state: 'disabled', text: store.error ? 'Pool unknown' : 'Loading pool…' };
    const pool = data.pool;
    if (!pool.total || pool.total === pool.no_credentials) return { state: 'no_credentials', text: 'No accounts', tone: 'crit' };
    if (pool.can_serve > 0) return { state: 'ready', text: `${pool.can_serve} of ${pool.total} ready` };
    const next = pool.next_ready_at ? Math.max(0, (pool.next_ready_at - F.now()) / 1000) : null;
    return { state: 'cooldown', text: next != null ? `None ready · next in ${F.fmt.clock(next)}` : 'None ready', tone: 'warn', nextSec: next };
  };

  // 1s ticker for countdowns and relative times.
  setInterval(() => F.emit('tick', F.now()), 1000);

  // ---------------------------------------------------------------- route helpers
  F.parseHash = (hash = location.hash) => {
    const raw = hash.replace(/^#\/?/, '');
    const [pathPart, query = ''] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    return { view: parts[0] || '', sub: parts[1] || '', params: Object.fromEntries(new URLSearchParams(query)) };
  };
  F.hashFor = (view, sub, params) => {
    const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')).toString();
    return `#/${view}${sub ? `/${encodeURIComponent(sub)}` : ''}${qs ? `?${qs}` : ''}`;
  };
  F.navigate = (view, sub, params) => { location.hash = F.hashFor(view, sub, params); };
  // Replace the hash without adding history or re-routing.
  F.replaceHash = (view, sub, params) => {
    F._suppressRoute = true;
    history.replaceState(null, '', F.hashFor(view, sub, params));
    F._suppressRoute = false;
    try { localStorage.setItem('fdsa.lastRoute', location.hash); } catch (e) { /* preference only */ }
  };

  // ---------------------------------------------------------------- clipboard
  F.copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      F.toast(`Copy failed: ${e.message || e.name}. Select the text and copy it by hand.`, { tone: 'error' });
      return false;
    }
    if (btn) {
      btn.classList.add('is-copied');
      const use = btn.querySelector('use');
      const label = btn.querySelector('.btn-label');
      const prevIcon = use && use.getAttribute('href');
      const prevLabel = label && label.textContent;
      if (use) use.setAttribute('href', '#i-check');
      if (label) label.textContent = 'Copied';
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        btn.classList.remove('is-copied');
        if (use && prevIcon) use.setAttribute('href', prevIcon);
        if (label && prevLabel) label.textContent = prevLabel;
      }, 1500);
    } else {
      F.toast('Copied');
    }
    return true;
  };
  F.copyBtn = (getText, label = 'Copy') => {
    const b = F.btn(null, { kind: 'ghost', icon: 'copy', size: 'sm', 'aria-label': label, title: label });
    b.addEventListener('click', (e) => { e.stopPropagation(); F.copy(typeof getText === 'function' ? getText() : getText, b); });
    return b;
  };

  F.download = (filename, text, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = F.h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ---------------------------------------------------------------- toasts
  const MAX_TOASTS = 3;
  F.toast = (message, { tone = 'info', action, detail, duration } = {}) => {
    const root = document.getElementById('toasts');
    const isError = tone === 'error';
    const t = F.h('div', { class: `toast glass glass-regular toast-${tone}`, role: isError ? 'alert' : null });
    const iconName = { error: 'error-x', success: 'success', warn: 'alert' }[tone] || 'info';
    // One-sentence toasts read as labels: no closing period ("Saved the key for this tab").
    const text = typeof message === 'string' && /^[^.]+\.$/.test(message) ? message.slice(0, -1) : message;
    const body = F.h('div', { class: 'toast-body' }, F.h('p', { class: 'toast-text', text }));
    if (detail) body.append(detail);
    t.append(F.icon(iconName, 'toast-icon'), body);
    const close = () => {
      if (t._closing) return;
      t._closing = true;
      clearTimeout(t._timer);
      t.classList.remove('is-in');
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 200);
    };
    if (action) {
      t.append(F.btn(action.label, { kind: 'ghost', size: 'sm', onclick: () => { action.run(); close(); } }));
    }
    t.append(F.iconBtn('close', 'Dismiss', { onclick: close, cls: 'icon-btn-sm' }));
    root.append(t);
    const toasts = root.querySelectorAll('.toast:not(.is-out)');
    if (toasts.length > MAX_TOASTS) {
      for (const old of Array.from(toasts).slice(0, toasts.length - MAX_TOASTS)) old._close && old._close();
    }
    t._close = close;
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-in')));
    // Errors stay until dismissed. Timers pause on hover, focus and hidden tab.
    if (!isError) {
      let remaining = duration || (action ? 10000 : 5000);
      let started = Date.now();
      const start = () => { started = Date.now(); clearTimeout(t._timer); t._timer = setTimeout(close, remaining); };
      const pause = () => { clearTimeout(t._timer); remaining -= Date.now() - started; };
      t.addEventListener('pointerenter', pause);
      t.addEventListener('pointerleave', start);
      t.addEventListener('focusin', pause);
      t.addEventListener('focusout', start);
      const vis = () => (document.hidden ? pause() : start());
      document.addEventListener('visibilitychange', vis);
      t.addEventListener('transitionend', () => { if (t._closing) document.removeEventListener('visibilitychange', vis); });
      start();
    }
    return { close };
  };
  F.toastError = (prefix, err) => F.toast(`${prefix}: ${err.message}${err.type ? ` (${err.type})` : ''}`, { tone: 'error' });

  // ---------------------------------------------------------------- tooltips
  // [data-tip] on any element. 500ms delay; instant once one is open.
  (() => {
    let showTimer = null;
    let hideTimer = null;
    let current = null;
    let warm = false;
    let warmTimer = null;
    const tip = () => document.getElementById('tooltip');
    const place = (target) => {
      const el = tip();
      const r = target.getBoundingClientRect();
      el.hidden = false;
      const tr = el.getBoundingClientRect();
      let top = r.bottom + 8;
      if (top + tr.height > innerHeight - 8) top = r.top - tr.height - 8;
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, innerWidth - tr.width - 8));
      el.style.setProperty('top', `${top}px`);
      el.style.setProperty('left', `${left}px`);
    };
    const show = (target) => {
      const text = target.getAttribute('data-tip');
      if (!text) return;
      current = target;
      const el = tip();
      el.textContent = text;
      el.classList.toggle('is-instant', warm);
      place(target);
      requestAnimationFrame(() => el.classList.add('is-in'));
      warm = true;
      clearTimeout(warmTimer);
    };
    const hide = () => {
      clearTimeout(showTimer);
      current = null;
      const el = tip();
      el.classList.remove('is-in');
      el.hidden = true;
      clearTimeout(warmTimer);
      warmTimer = setTimeout(() => { warm = false; }, 400);
    };
    const shouldShow = (t) => {
      // Rail labels make tooltips redundant when the full sidebar is visible.
      if (t.closest('.rail') && innerWidth >= 1100) return false;
      if (t.matches('.rail-new') && innerWidth >= 1100) return false;
      return true;
    };
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === current || e.pointerType === 'touch' || !shouldShow(t)) return;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (warm) show(t); else showTimer = setTimeout(() => show(t), 500);
    });
    document.addEventListener('pointerout', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) return;
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;
      clearTimeout(showTimer);
      hideTimer = setTimeout(hide, 50);
    });
    document.addEventListener('focusin', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && t.matches(':focus-visible') && shouldShow(t)) { clearTimeout(showTimer); showTimer = setTimeout(() => show(t), warm ? 0 : 500); }
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
    F.hideTooltip = hide;
  })();

  // ---------------------------------------------------------------- popovers / menus
  // A single open popover at a time. Anchored to its trigger, origin-aware.
  let openPop = null;
  F.closePopover = (restoreFocus = true) => {
    if (!openPop) return false;
    const { el, trigger, onClose } = openPop;
    openPop = null;
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 120);
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
    if (onClose) onClose();
    return true;
  };
  F.popover = (trigger, content, { width, align = 'end', onClose, glass = false, role = 'dialog', label } = {}) => {
    if (openPop && openPop.trigger === trigger) { F.closePopover(); return null; }
    F.closePopover(false);
    const el = F.h('div', { class: ['popover', glass ? 'glass glass-regular' : 'popover-solid'], role, 'aria-label': label || null });
    if (width) el.style.setProperty('width', `${width}px`);
    el.append(content);
    document.body.append(el);
    const r = trigger.getBoundingClientRect();
    // Layout size, not getBoundingClientRect: the entry animation scales the box down.
    const pr = { width: el.offsetWidth, height: el.offsetHeight };
    // Keep popovers off the window edges: a start-aligned one that would run past the
    // right edge flips to end-aligned (its right edge under the trigger's right edge).
    const EDGE = 16;
    let top = r.bottom + 6;
    let originY = 'top';
    if (top + pr.height > innerHeight - EDGE && r.top - pr.height - 6 > EDGE) { top = r.top - pr.height - 6; originY = 'bottom'; }
    // 'auto' opens toward the middle of the window: end-aligned for a trigger on the right.
    let side = align === 'auto' ? ((r.left + r.right) / 2 > innerWidth / 2 ? 'end' : 'start') : align;
    if (side === 'start' && r.left + pr.width > innerWidth - EDGE) side = 'end';
    let left = side === 'end' ? r.right - pr.width : r.left;
    left = Math.max(EDGE, Math.min(left, innerWidth - pr.width - EDGE));
    el.style.setProperty('top', `${Math.max(EDGE, top)}px`);
    el.style.setProperty('left', `${left}px`);
    el.style.setProperty('transform-origin', `${side === 'end' ? 'right' : 'left'} ${originY}`);
    trigger.setAttribute('aria-expanded', 'true');
    openPop = { el, trigger, onClose };
    requestAnimationFrame(() => el.classList.add('is-in'));
    const first = el.querySelector('[role=menuitem], button, input, textarea, select, a[href]');
    if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
    return el;
  };
  document.addEventListener('pointerdown', (e) => {
    if (!openPop) return;
    if (openPop.el.contains(e.target) || openPop.trigger.contains(e.target)) return;
    F.closePopover(false);
  });
  window.addEventListener('resize', () => F.closePopover(false));

  // items: [{label, icon, run, danger, disabled, reason}] | 'sep'
  F.menu = (trigger, items, opts = {}) => {
    const list = F.h('div', { class: 'menu', role: 'menu' });
    for (const item of items) {
      if (item === 'sep') { list.append(F.h('div', { class: 'menu-sep', role: 'separator' })); continue; }
      const b = F.h('button', {
        type: 'button', role: 'menuitem', class: ['menu-item', item.danger && 'is-danger'],
        'aria-disabled': item.disabled ? 'true' : null, 'data-tip': item.disabled ? item.reason : null,
      }, item.icon ? F.icon(item.icon) : F.h('span', { class: 'icon-spacer' }), F.h('span', { text: item.label }));
      b.addEventListener('click', () => {
        if (item.disabled) return;
        if (item.keepOpen) { item.run(b); return; }
        F.closePopover(!item.movesFocus);
        item.run(trigger);
      });
      list.append(b);
    }
    list.addEventListener('keydown', (e) => {
      const btns = Array.from(list.querySelectorAll('.menu-item'));
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
    });
    return F.popover(trigger, list, { width: opts.width || 232, role: 'presentation', ...opts });
  };

  // Confirmation popover anchored to its trigger. run() may throw an ApiError;
  // its message renders inline and the popover stays open.
  F.confirm = (trigger, { text, confirmLabel, pendingLabel, danger = true, run }) => {
    const err = F.h('p', { class: 'inline-error', role: 'alert', hidden: true });
    const ok = F.btn(confirmLabel, { kind: danger ? 'danger' : 'primary' });
    const cancel = F.btn('Cancel', { kind: 'secondary', onclick: () => F.closePopover() });
    const box = F.h('div', { class: 'confirm' }, F.h('p', { class: 'confirm-text', text }), err, F.h('div', { class: 'confirm-actions' }, cancel, ok));
    ok.addEventListener('click', async () => {
      if (ok.getAttribute('aria-busy') === 'true') return;
      F.setPending(ok, pendingLabel || `${confirmLabel}…`);
      err.hidden = true;
      try {
        await run();
        F.closePopover(false);
      } catch (e) {
        F.clearPending(ok);
        err.textContent = `${e.message}${e.type ? ` (${e.type})` : ''}`;
        err.hidden = false;
      }
    });
    F.popover(trigger, box, { width: 320, role: 'alertdialog', label: confirmLabel });
    requestAnimationFrame(() => cancel.focus());
  };

  // Pending state for buttons: width kept, spinner + verb label, repeat clicks ignored.
  F.setPending = (btn, label) => {
    if (!btn) return;
    btn.style.setProperty('min-width', `${btn.getBoundingClientRect().width}px`);
    btn.setAttribute('aria-busy', 'true');
    btn._prev = Array.from(btn.childNodes);
    btn.replaceChildren(F.h('span', { class: 'spinner', 'aria-hidden': 'true' }), F.h('span', { class: 'btn-label', text: label }));
  };
  F.clearPending = (btn) => {
    if (!btn || !btn._prev) return;
    btn.replaceChildren(...btn._prev);
    btn._prev = null;
    btn.removeAttribute('aria-busy');
    btn.style.removeProperty('min-width');
  };

  // ---------------------------------------------------------------- segmented control
  // options: [{value, label, icon}] ; returns element with .value and onchange(value)
  F.segmented = (label, options, value, onchange) => {
    const group = F.h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
    const btns = options.map(o => {
      const b = F.h('button', { type: 'button', role: 'radio', class: 'seg', 'aria-checked': String(o.value === value), tabindex: o.value === value ? '0' : '-1', 'data-value': o.value, 'aria-label': o.ariaLabel || null, 'data-tip': o.ariaLabel || null },
        o.icon ? F.icon(o.icon) : null, o.label ? F.h('span', { text: o.label }) : null);
      b.addEventListener('click', () => set(o.value, true));
      return b;
    });
    group.append(...btns);
    function set(v, fire) {
      group.value = v;
      for (const b of btns) {
        const on = b.dataset.value === String(v);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (fire) onchange(v);
    }
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = btns.findIndex(b => b.dataset.value === String(group.value));
      const n = btns[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      set(n.dataset.value, true);
      n.focus();
    });
    group.set = (v) => set(v, false);
    set(value, false);
    return group;
  };

  F.select = (label, options, value, onchange) => {
    const sel = F.h('select', { class: 'select', 'aria-label': label });
    for (const o of options) sel.append(F.h('option', { value: o.value, text: o.label, selected: o.value === value }));
    sel.addEventListener('change', () => onchange(sel.value));
    return F.h('label', { class: 'select-wrap' }, F.h('span', { class: 'select-label', text: label }), sel, F.icon('chevron-down', 'select-chevron'));
  };

  // Switch: <label class=switch><input role=switch>…
  F.switchEl = (label, checked, onchange, { id } = {}) => {
    const input = F.h('input', { type: 'checkbox', role: 'switch', checked, id });
    input.addEventListener('change', () => onchange(input.checked, input));
    const el = F.h('label', { class: 'switch' }, input, F.h('span', { class: 'switch-track', 'aria-hidden': 'true' }), F.h('span', { class: 'switch-label', text: label }));
    el.input = input;
    return el;
  };

  // ---------------------------------------------------------------- notices
  // Photo hero for the settings-window views (SpaceX grammar, like the Status video): a still
  // NASA frame, a caps headline built from live data, and one quieter line under it.
  F.pageHero = ({ image, label, position = '50% 50%' }) => {
    const img = F.h('img', { class: 'hero-media', src: image, alt: '', decoding: 'async', 'aria-hidden': 'true' });
    img.style.setProperty('object-position', position);
    const title = F.h('p', { class: 'status-sentence hero-title' });
    const sub = F.h('p', { class: 'hero-sub' });
    const el = F.h('section', { class: 'hero hero-page', 'aria-label': label }, img,
      F.h('div', { class: 'hero-inner' }, F.h('header', { class: 'status-head' }, title, sub)));
    el.set = (headline, detail = '', tone = null) => {
      title.textContent = headline;
      title.classList.toggle('is-crit', tone === 'crit');
      sub.textContent = detail;
      sub.hidden = !detail;
    };
    return el;
  };

  F.notice = (tone, title, body, actions = []) => F.h('div', { class: `notice notice-${tone}`, role: tone === 'crit' ? 'alert' : null },
    F.icon(tone === 'crit' ? 'error-x' : tone === 'warn' ? 'alert' : 'info', 'notice-icon'),
    F.h('div', { class: 'notice-body' }, title ? F.h('p', { class: 'notice-title', text: title }) : null, body ? (body instanceof Node ? body : F.h('p', { class: 'notice-text', text: body })) : null),
    actions.length ? F.h('div', { class: 'notice-actions' }, actions) : null);

  F.endpointMissing = (endpoint) => F.notice('info', null,
    `This server build doesn't expose ${endpoint}. Update server.js to the version that ships with this dashboard.`);

  F.errorText = (err) => `${err.message}${err.type ? ` (${err.type})` : ''}`;

  // ---------------------------------------------------------------- code colouring
  // A small VS Code Dark+ style tokenizer for code the dashboard shows: the Settings examples
  // (Python, shell) and agent config files (JSON, TOML, YAML, Markdown, shell). Each line becomes
  // a .vs-line so CSS can draw line numbers that selection and copy never pick up.
  const TOKENS = {
    Python: /(#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(from|import|as|return|if|elif|else|for|while|in|with|try|except)\b|\b(def|class|None|True|False|lambda)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([A-Za-z_]\w*)(?=\()|\b([A-Za-z_]\w*)\b/g,
    Shell: /(#.*)|('[^']*'|"(?:\\.|[^"\\])*")|(^\s*[a-z][\w-]*)|((?:^|\s)-{1,2}[A-Za-z][\w-]*)|(\\$)|(\$[A-Z_][A-Z0-9_]*)/g,
    JSON: /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    TOML: /(#.*)|^(\s*\[\[?[^\]]+\]\]?)|^(\s*[A-Za-z0-9_."-]+)(?=\s*=)|("(?:\\.|[^"\\])*"|'[^']*')|\b(true|false)\b|(-?\b\d+(?:\.\d+)?\b)/g,
    YAML: /(#.*)|^(\s*-?\s*[A-Za-z0-9_."'-]+)(?=\s*:)|("(?:\\.|[^"\\])*"|'[^']*')|\b(true|false|null|yes|no)\b|(-?\b\d+(?:\.\d+)?\b)/g,
    Markdown: /(<!--.*?-->)|^(#{1,6} .*)|(`[^`]+`)/g,
  };
  const KINDS = {
    Python: ['com', 'str', 'ctrl', 'kw', 'num', 'cls', 'fn', 'var'],
    Shell: ['com', 'str', 'fn', 'kw', 'esc', 'var'],
    JSON: ['var', 'str', 'kw', 'num'],
    TOML: ['com', 'cls', 'var', 'str', 'kw', 'num'],
    YAML: ['com', 'var', 'str', 'kw', 'num'],
    Markdown: ['com', 'kw', 'str'],
  };
  // Server formats (lowercase) and the Settings names both resolve here.
  const LANGS = { python: 'Python', shell: 'Shell', json: 'JSON', toml: 'TOML', yaml: 'YAML', markdown: 'Markdown' };
  // The server replaces secret values with ‹proxy-key› or ‹secret:abc123› before text leaves it.
  const SECRET_TOKEN = /‹(proxy-key|secret:([0-9a-f]{6}))›/g;
  F.SECRET_TOKEN = SECRET_TOKEN;
  F.secretChip = (kind, fp) => F.h('span', { class: 'secret-chip', title: 'Hidden. Secrets never leave this machine.' },
    F.icon('lock'), F.h('span', { text: kind === 'proxy-key' ? 'proxy key' : `secret ${fp}` }));
  function withSecrets(text) {
    if (text.indexOf('‹') < 0) return [text];
    const out = [];
    let at = 0;
    SECRET_TOKEN.lastIndex = 0;
    for (let m = SECRET_TOKEN.exec(text); m; m = SECRET_TOKEN.exec(text)) {
      if (m.index > at) out.push(text.slice(at, m.index));
      out.push(F.secretChip(m[1], m[2]));
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  // Returns one span.vs-line per line. {secrets: true} turns mask tokens into labelled chips;
  // the tokenizer sees them as same-length private-use runs, so a token never splits a mask.
  F.colorize = (code, lang, { secrets = false } = {}) => {
    const name = LANGS[String(lang).toLowerCase()];
    const re = name ? TOKENS[name] : null;
    return String(code).split('\n').map((line) => {
      const el = F.h('span', { class: 'vs-line' });
      const piece = (text) => (secrets ? withSecrets(text) : [text]);
      if (!re) { el.append(...piece(line)); if (!line) el.append('\u200b'); return el; }
      const scan = secrets ? line.replace(SECRET_TOKEN, (m) => '\uE000'.repeat(m.length)) : line;
      re.lastIndex = 0;
      let at = 0;
      for (let m = re.exec(scan); m; m = re.exec(scan)) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const g = m.findIndex((v, i) => i > 0 && v !== undefined);
        if (m.index > at) el.append(...piece(line.slice(at, m.index)));
        el.append(F.h('span', { class: `tk-${KINDS[name][g - 1]}` }, ...piece(line.slice(m.index, m.index + m[0].length))));
        at = m.index + m[0].length;
      }
      if (at < line.length) el.append(...piece(line.slice(at)));
      if (!line) el.append('\u200b');
      return el;
    });
  };

  F.codeLine = (text) => {
    const code = F.h('code', { class: 'mono-id', text });
    // The scrollbar is hidden, so mark clipped sides and let a plain mouse wheel scroll sideways.
    const mark = () => {
      const max = code.scrollWidth - code.clientWidth;
      code.classList.toggle('is-clip-start', max > 1 && code.scrollLeft > 1);
      code.classList.toggle('is-clip-end', max > 1 && code.scrollLeft < max - 1);
    };
    code.addEventListener('scroll', mark, { passive: true });
    code.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = code.scrollWidth - code.clientWidth;
      // At either end the wheel goes back to scrolling the page.
      if (max <= 0 || (e.deltaY < 0 && code.scrollLeft <= 0) || (e.deltaY > 0 && code.scrollLeft >= max - 1)) return;
      e.preventDefault();
      code.scrollLeft += e.deltaY;
    }, { passive: false });
    if (typeof ResizeObserver === 'function') new ResizeObserver(mark).observe(code);
    requestAnimationFrame(mark);
    return F.h('div', { class: 'code-line' }, code, F.copyBtn(text, 'Copy command'));
  };

  F.emptyRequests = (sinceTs) => {
    return F.h('div', { class: 'empty' },
      F.h('p', { class: 'empty-title', text: sinceTs ? `No requests since the server started at ${F.fmt.hm(sinceTs)}.` : 'No requests since the server started.' }),
      F.h('p', { class: 'empty-text', text: 'Send one from Chat, or call the proxy from a terminal:' }),
      F.codeLine(`curl ${location.origin}/v1/chat/completions -H 'Content-Type: application/json'${F.key.get() ? " -H \"Authorization: Bearer $PROXY_API_KEY\"" : ''} -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'`),
      F.h('div', { class: 'empty-actions' }, F.h('a', { class: 'btn btn-primary', href: '#/chat' }, F.icon('chat'), F.h('span', { class: 'btn-label', text: 'Send one from Chat' }))));
  };

  // ---------------------------------------------------------------- inspector
  // Non-modal side panel (bottom sheet under 720px). One at a time.
  const insp = { open: false, onClose: null, returnFocus: null, owner: null };
  F.inspector = {
    get isOpen() { return insp.open; },
    get owner() { return insp.owner; },
    open({ title, sub, body, owner, onClose, returnFocus }) {
      const el = document.getElementById('inspector');
      if (insp.open && insp.onClose && insp.owner !== owner) { const fn = insp.onClose; insp.onClose = null; fn(); }
      document.getElementById('inspector-title').replaceChildren(...(Array.isArray(title) ? title : [title]));
      const subEl = document.getElementById('inspector-sub');
      subEl.replaceChildren(...(sub ? (Array.isArray(sub) ? sub : [sub]) : []));
      subEl.hidden = !sub;
      document.getElementById('inspector-body').replaceChildren(body);
      insp.onClose = onClose || null;
      insp.owner = owner || null;
      insp.returnFocus = returnFocus || insp.returnFocus || null;
      const wasOpen = insp.open;
      insp.open = true;
      el.hidden = false;
      el.style.removeProperty('transform');
      document.getElementById('app').classList.add('has-inspector');
      if (!wasOpen) {
        el.classList.remove('is-in');
        void el.offsetWidth;
        requestAnimationFrame(() => el.classList.add('is-in'));
        document.getElementById('inspector-title').focus({ preventScroll: true });
      }
    },
    // Re-render the body without moving focus (live data).
    update({ title, sub, body }) {
      if (!insp.open) return;
      if (title) document.getElementById('inspector-title').replaceChildren(...(Array.isArray(title) ? title : [title]));
      if (sub) document.getElementById('inspector-sub').replaceChildren(...(Array.isArray(sub) ? sub : [sub]));
      if (body) {
        const host = document.getElementById('inspector-body');
        const active = document.activeElement;
        const key = active && host.contains(active) ? active.getAttribute('data-focus-key') : null;
        host.replaceChildren(body);
        if (key) { const again = host.querySelector(`[data-focus-key="${CSS.escape(key)}"]`); if (again) again.focus({ preventScroll: true }); }
      }
    },
    close({ silent = false } = {}) {
      if (!insp.open) return false;
      const el = document.getElementById('inspector');
      insp.open = false;
      el.classList.remove('is-in');
      document.getElementById('app').classList.remove('has-inspector');
      const fn = insp.onClose;
      insp.onClose = null;
      insp.owner = null;
      const back = insp.returnFocus;
      insp.returnFocus = null;
      setTimeout(() => { if (!insp.open) el.hidden = true; }, 220);
      if (fn && !silent) fn();
      if (back && document.contains(back)) back.focus({ preventScroll: true });
      return true;
    },
  };

  // Bottom-sheet drag for the inspector under 720px: 1:1 tracking with grab
  // offset, rubber-band above the top, momentum projection on release.
  (() => {
    const el = () => document.getElementById('inspector');
    let drag = null;
    const rubber = (o, d) => (o * d * 0.55) / (d + 0.55 * Math.abs(o));
    const project = (v) => (v / 1000) * 0.998 / (1 - 0.998);
    function down(e) {
      if (innerWidth >= 720 || drag || !insp.open) return;
      if (!e.target.closest('#inspector-grabber, .inspector-head')) return;
      if (e.target.closest('button')) return;
      const sheet = el();
      sheet.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, startY: e.clientY, y: 0, h: sheet.getBoundingClientRect().height, hist: [{ y: 0, t: performance.now() }] };
      sheet.classList.add('is-dragging');
    }
    function move(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.startY;
      drag.y = dy < 0 ? rubber(dy, drag.h) : dy;
      drag.hist.push({ y: dy, t: performance.now() });
      if (drag.hist.length > 6) drag.hist.shift();
      el().style.setProperty('transform', `translateY(${drag.y}px)`);
    }
    function up(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const sheet = el();
      const a = drag.hist[0];
      const b = drag.hist[drag.hist.length - 1];
      const v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s
      const end = drag.y + project(v);
      sheet.classList.remove('is-dragging');
      const dismiss = end > drag.h * 0.5 || (v > 500 && drag.y > 0);
      drag = null;
      if (dismiss) {
        sheet.style.setProperty('transform', 'translateY(100%)');
        setTimeout(() => F.inspector.close(), 10);
      } else {
        sheet.style.removeProperty('transform');
      }
    }
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  })();

  // ---------------------------------------------------------------- misc
  F.uid = (len = 12) => {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => (b % 36).toString(36)).join('');
  };

  // Photos and video: no right-click save or copy, no drag-out. A surface counts when it is
  // an <img>/<video> or paints a background photo itself; text on top keeps its menu.
  const isMediaSurface = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'PICTURE') return true;
    return getComputedStyle(el).backgroundImage.includes('url(');
  };
  for (const type of ['contextmenu', 'dragstart']) {
    document.addEventListener(type, (e) => { if (isMediaSurface(e.target)) e.preventDefault(); }, true);
  }

  F.isLoopbackHost = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.endsWith('.localhost');

  // Fuzzy subsequence score; higher is better, -1 means no match.
  F.fuzzy = (query, label) => {
    const q = query.toLowerCase().trim();
    if (!q) return 0;
    const s = label.toLowerCase();
    const direct = s.indexOf(q);
    if (direct >= 0) return 1000 - direct * 2 - s.length * 0.1;
    let score = 0;
    let pos = -1;
    let streak = 0;
    for (const ch of q) {
      if (ch === ' ') continue;
      const next = s.indexOf(ch, pos + 1);
      if (next < 0) return -1;
      streak = next === pos + 1 ? streak + 1 : 0;
      score += 10 + streak * 5 - (next - pos);
      pos = next;
    }
    return score;
  };
})();
