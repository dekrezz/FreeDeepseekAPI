'use strict';
// FreeDeepseekAPI account dashboard. Vanilla JS, no dependencies.
// Every piece of server data reaches the page through textContent or attributes,
// never innerHTML. Data: GET /admin/accounts. Actions: POST /admin/accounts/:id/
// {disable,enable,clear-cooldown} and POST /admin/accounts/reload.
(() => {
  const KEY_STORAGE = 'freedeepseek.proxyKey';
  const POLL_MS = 5000;
  const MAX_BACKOFF_MS = 30000;
  const REQUEST_TIMEOUT_MS = 10000;
  const TOAST_MS = 6000;

  const STATUS_LABEL = {
    ready: 'Ready',
    busy: 'Busy',
    cooldown: 'Cooling down',
    disabled: 'Disabled',
    no_credentials: 'No credentials',
  };
  const REASON_LABEL = { rate_limit: 'Rate limited', auth: 'Login rejected' };
  const ERROR_KIND_LABEL = { rate_limit: 'Rate limit', auth: 'Auth', upstream: 'Upstream' };
  const STATUSES = Object.keys(STATUS_LABEL);

  const $ = (id) => document.getElementById(id);
  const el = {
    updated: $('updated'),
    auto: $('auto'),
    refresh: $('refresh'),
    forgetKey: $('forget-key'),
    reload: $('reload'),
    headline: $('headline'),
    headlineSub: $('headline-sub'),
    strip: $('strip'),
    legend: $('legend'),
    banner: $('banner'),
    bannerIcon: $('banner-icon'),
    bannerTitle: $('banner-title'),
    bannerBody: $('banner-body'),
    bannerRetry: $('banner-retry'),
    gateKey: $('gate-key'),
    gateKeyBody: $('gate-key-body'),
    keyForm: $('key-form'),
    keyInput: $('key'),
    gateForbidden: $('gate-forbidden'),
    accounts: $('accounts'),
    table: $('table'),
    rows: $('rows'),
    empty: $('empty'),
    emptyReload: $('empty-reload'),
    toasts: $('toasts'),
    rowTemplate: $('row-template'),
  };

  const state = {
    data: null,          // last good { now, pool, accounts }
    offsetMs: 0,         // server clock minus client clock
    lastOkAt: 0,         // client time of the last good response
    gate: null,          // null | 'key' | 'forbidden'
    keyRejected: false,
    error: null,         // { message } while the last poll failed
    failStreak: 0,
    inFlight: null,
    pollTimer: null,
    expiryRefreshAt: 0,
  };
  const rowsById = new Map();
  const pending = new Set(); // account ids with an action in flight
  let rowSerial = 0;

  // ---------- Formatting ----------

  const serverNow = () => Date.now() + state.offsetMs;
  const pad = (n) => String(n).padStart(2, '0');

  function clockTime(ms) {
    const d = new Date(ms - state.offsetMs);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fullTime(ms) {
    return new Date(ms - state.offsetMs).toLocaleString();
  }

  function duration(totalSec) {
    const s = Math.max(0, Math.ceil(totalSec));
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${pad(m)}m`;
    return `${m}m ${pad(sec)}s`;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function compact(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
    return `${(v / 1e6).toFixed(1)}M`;
  }

  function usd(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0';
    if (v < 0.01) return '<$0.01';
    return `$${v.toFixed(2)}`;
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  function setTime(node, ms, text) {
    if (ms) {
      node.dateTime = new Date(ms - state.offsetMs).toISOString();
      node.title = fullTime(ms);
    } else {
      node.removeAttribute('datetime');
      node.removeAttribute('title');
    }
    node.textContent = text;
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(message, { status = 0, type = null, body = null } = {}) {
      super(message);
      this.status = status;
      this.type = type;
      this.body = body;
    }
  }

  function storedKey() {
    try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }

  async function api(method, path) {
    const headers = { Accept: 'application/json' };
    const key = storedKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(path, { method, headers, cache: 'no-store', credentials: 'omit', signal: controller.signal });
    } catch (e) {
      const message = e.name === 'AbortError'
        ? `The proxy did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : 'Could not reach the proxy. Is it still running?';
      throw new ApiError(message);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const message = body?.error?.message || `The proxy answered HTTP ${res.status}.`;
      throw new ApiError(message, { status: res.status, type: body?.error?.type || null, body });
    }
    if (!body || typeof body !== 'object') {
      throw new ApiError('The proxy sent a response that is not JSON.', { status: res.status });
    }
    return body;
  }

  // Maps auth failures to the right gate. Returns true when the error was a gate.
  function handleGateError(error) {
    if (error.status === 401) {
      state.keyRejected = Boolean(storedKey());
      state.gate = 'key';
      render();
      return true;
    }
    if (error.status === 403 && error.type === 'admin_forbidden') {
      state.gate = 'forbidden';
      render();
      return true;
    }
    return false;
  }

  // ---------- Polling ----------

  function nextDelay() {
    if (state.failStreak === 0) return POLL_MS;
    return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** state.failStreak);
  }

  function schedule(delay = nextDelay()) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (!el.auto.checked || document.visibilityState !== 'visible') return;
    if (state.gate) return; // waiting for a key or an env change; no point polling
    state.pollTimer = setTimeout(() => refresh(), delay);
  }

  function refresh() {
    if (state.inFlight) return state.inFlight;
    clearTimeout(state.pollTimer);
    state.inFlight = (async () => {
      try {
        const data = await api('GET', '/admin/accounts');
        accept(data, data.now);
        state.gate = null;
        state.keyRejected = false;
        state.error = null;
        state.failStreak = 0;
      } catch (error) {
        if (!handleGateError(error)) {
          state.error = { message: error.message, status: error.status };
          state.failStreak += 1;
        }
      } finally {
        state.inFlight = null;
        render();
        schedule();
      }
    })();
    return state.inFlight;
  }

  function accept(data, now) {
    if (typeof now === 'number') state.offsetMs = now - Date.now();
    state.data = { pool: data.pool, accounts: Array.isArray(data.accounts) ? data.accounts : [] };
    state.lastOkAt = Date.now();
  }

  // ---------- Actions ----------

  const ACTION_COPY = {
    disable: { pending: 'Disabling…', done: 'Disabled' },
    enable: { pending: 'Enabling…', done: 'Enabled' },
    'clear-cooldown': { pending: 'Clearing…', done: 'Cleared cooldown for' },
  };

  async function runAction(account, action, button) {
    if (pending.has(account.id)) return;
    pending.add(account.id);
    const originalLabel = button.textContent;
    button.textContent = ACTION_COPY[action].pending;
    button.setAttribute('aria-busy', 'true');
    syncRowButtons(account.id);
    try {
      const result = await api('POST', `/admin/accounts/${encodeURIComponent(account.id)}/${action}`);
      if (state.data && result.account) {
        const i = state.data.accounts.findIndex(a => a.id === result.account.id);
        if (i >= 0) state.data.accounts[i] = result.account;
        state.data.pool = result.pool;
      }
      toast({ title: `${ACTION_COPY[action].done} ${account.name || account.id}.` });
    } catch (error) {
      if (!handleGateError(error)) {
        toast({ title: `Could not ${action.replace('-', ' ')} ${account.id}.`, body: error.message, tone: 'error' });
        if (error.status === 404) refresh();
      }
    } finally {
      pending.delete(account.id);
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
      render();
      // Clear cooldown hides its own button; keep keyboard focus in the row.
      if (action === 'clear-cooldown' && button.hidden) rowsById.get(account.id)?.toggle.focus();
    }
  }

  async function reloadAccounts(trigger) {
    const buttons = [el.reload, el.emptyReload];
    for (const b of buttons) { b.disabled = true; }
    trigger.setAttribute('aria-busy', 'true');
    const label = trigger.querySelector('.btn-label');
    if (label) label.textContent = 'Reloading…';
    try {
      const result = await api('POST', '/admin/accounts/reload');
      accept(result, null);
      state.error = null;
      const parts = [];
      parts.push(result.added.length ? `Added ${result.added.join(', ')}.` : 'No new accounts.');
      if (result.removed.length) parts.push(`Removed ${result.removed.join(', ')}.`);
      if (result.errors.length) {
        parts.push(`Skipped ${result.errors.map(e => `${e.file} (${e.message})`).join(', ')}.`);
      }
      toast({
        title: `Reloaded ${plural(result.accounts.length, 'account', 'accounts')}.`,
        body: parts.join(' '),
        tone: result.errors.length ? 'error' : null,
      });
    } catch (error) {
      if (!handleGateError(error)) {
        const skipped = Array.isArray(error.body?.error?.errors) && error.body.error.errors.length
          ? ` Files: ${error.body.error.errors.map(e => `${e.file} (${e.message})`).join(', ')}.`
          : '';
        toast({ title: 'Could not reload accounts.', body: `${error.message}${skipped}`, tone: 'error' });
      }
    } finally {
      for (const b of buttons) { b.disabled = false; }
      trigger.removeAttribute('aria-busy');
      if (label) label.textContent = 'Reload accounts';
      render();
    }
  }

  // ---------- Toasts ----------

  function toast({ title, body = '', tone = null }) {
    const node = document.createElement('div');
    node.className = 'toast';
    if (tone) {
      node.dataset.tone = tone;
      node.setAttribute('role', 'alert');
    }
    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const t = document.createElement('p');
    t.className = 'toast-title';
    t.textContent = title;
    copy.append(t);
    if (body) {
      const b = document.createElement('p');
      b.className = 'toast-body';
      b.textContent = body;
      copy.append(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.append(svgIcon('close'));
    node.append(copy, close);

    let timer = null;
    const dismiss = () => { clearTimeout(timer); node.remove(); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, tone === 'error' ? TOAST_MS * 2 : TOAST_MS); };
    close.addEventListener('click', dismiss);
    // Hovering or focusing a toast keeps it open long enough to read.
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('focusout', arm);
    el.toasts.append(node);
    while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
    arm();
  }

  function svgIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // ---------- Rendering ----------

  function render() {
    renderMasthead();
    renderGates();
    renderPool();
    renderBanner();
    renderTable();
  }

  function renderMasthead() {
    const stale = Boolean(state.error) && Boolean(state.data);
    if (state.lastOkAt) {
      const at = new Date(state.lastOkAt);
      const hhmmss = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      el.updated.textContent = stale ? `Stale since ${hhmmss}` : `Updated ${hhmmss}`;
    } else {
      el.updated.textContent = state.gate ? '' : (state.error ? 'Not loaded' : 'Loading…');
    }
    el.updated.classList.toggle('is-stale', stale);
    el.refresh.hidden = el.auto.checked || Boolean(state.error);
    el.forgetKey.hidden = !storedKey();
    el.auto.closest('.switch').hidden = Boolean(state.gate);
    // The empty state carries its own Reload button; one is enough.
    el.reload.hidden = Boolean(state.gate) || state.data?.accounts.length === 0;
  }

  function renderGates() {
    const enteringKeyGate = state.gate === 'key' && el.gateKey.hidden;
    el.gateKey.hidden = state.gate !== 'key';
    el.gateForbidden.hidden = state.gate !== 'forbidden';
    if (state.gate === 'key') {
      el.gateKeyBody.textContent = state.keyRejected
        ? 'The proxy rejected that key. Check PROXY_API_KEY and enter it again.'
        : 'This proxy has PROXY_API_KEY set, so the admin API needs it as a Bearer token.';
      el.gateKeyBody.classList.toggle('error-line', state.keyRejected);
      el.keyInput.setAttribute('aria-invalid', String(state.keyRejected));
      if (enteringKeyGate) el.keyInput.focus();
    }
  }

  function poolSummary() {
    const pool = state.data?.pool;
    if (!pool) return null;
    const nextInSec = pool.next_ready_at ? Math.max(0, (pool.next_ready_at - serverNow()) / 1000) : null;
    return { ...pool, nextInSec };
  }

  function renderPool() {
    const pool = poolSummary();
    const section = el.headline.parentElement;
    section.hidden = Boolean(state.gate) || (pool !== null && pool.total === 0);
    section.classList.toggle('is-stale', Boolean(state.error) && Boolean(pool));
    el.legend.hidden = !pool;
    if (!pool) {
      el.headline.textContent = state.error ? 'Account status unavailable' : 'Loading accounts…';
      el.headlineSub.textContent = '';
      renderStrip(null);
      return;
    }
    const { total, can_serve: canServe } = pool;
    let headline;
    if (total === 0) headline = 'No accounts loaded';
    else if (canServe === total) headline = total === 1 ? 'The account can take requests' : total === 2 ? 'Both accounts can take requests' : `All ${total} accounts can take requests`;
    else if (canServe === 0) headline = total === 1 ? 'The account cannot take requests' : total === 2 ? 'Neither account can take requests' : `None of ${total} accounts can take requests`;
    else headline = `${canServe} of ${plural(total, 'account', 'accounts')} can take requests`;
    el.headline.textContent = headline;

    const sub = [];
    if (pool.nextInSec !== null) {
      sub.push(pool.cooldown === 1
        ? `One is cooling down, back in ${duration(pool.nextInSec)}.`
        : `${pool.cooldown} are cooling down; the first is back in ${duration(pool.nextInSec)}.`);
    }
    if (pool.busy > 0) sub.push(`${plural(pool.busy, 'login is', 'logins are')} serving a request.`);
    el.headlineSub.textContent = sub.join(' ');

    for (const status of STATUSES) {
      const count = pool[status] || 0;
      const item = el.legend.querySelector(`[data-status="${status}"]`);
      item.querySelector('strong').textContent = String(count);
      item.classList.toggle('is-zero', count === 0);
    }
    renderStrip(state.data.accounts);
  }

  function cooldownProgress(account) {
    // Progress needs a start time. The cooldown starts when last_error is recorded
    // with the same kind; without that pairing no bar is drawn rather than a guess.
    const until = account.cooldown_until;
    const err = account.last_error;
    if (!until || !err || !err.at || err.kind !== account.cooldown_reason || err.at >= until) return null;
    const p = (serverNow() - err.at) / (until - err.at);
    return Math.min(1, Math.max(0, p));
  }

  function renderStrip(accounts) {
    if (!accounts) {
      if (el.strip.childElementCount === 0) {
        for (let i = 0; i < 3; i++) {
          const seg = document.createElement('span');
          seg.className = 'segment is-skeleton';
          el.strip.append(seg);
        }
      }
      el.strip.setAttribute('aria-label', state.error ? 'Account status unavailable' : 'Loading');
      return;
    }
    const rank = (a) => { const i = STATUSES.indexOf(a.status); return i < 0 ? STATUSES.length : i; };
    const ordered = [...accounts].sort((a, b) => rank(a) - rank(b) || (a.cooldown_until || 0) - (b.cooldown_until || 0));
    while (el.strip.childElementCount > ordered.length) el.strip.lastElementChild.remove();
    while (el.strip.childElementCount < ordered.length) el.strip.append(document.createElement('span'));
    ordered.forEach((account, i) => {
      const seg = el.strip.children[i];
      seg.className = 'segment';
      seg.dataset.status = account.status;
      const p = account.status === 'cooldown' ? cooldownProgress(account) : null;
      if (p === null) seg.style.removeProperty('--p');
      else seg.style.setProperty('--p', p.toFixed(3));
      seg.title = `${account.name}: ${STATUS_LABEL[account.status] || account.status}`;
    });
    const counts = STATUSES.filter(s => state.data.pool[s]).map(s => `${state.data.pool[s]} ${STATUS_LABEL[s].toLowerCase()}`);
    el.strip.setAttribute('aria-label', counts.length ? `Pool: ${counts.join(', ')}` : 'Pool is empty');
  }

  function showBanner({ tone, icon, title, body = '', retry = false }) {
    el.banner.hidden = false;
    el.banner.dataset.tone = tone;
    el.bannerIcon.setAttribute('href', `#i-${icon}`);
    el.bannerTitle.textContent = title;
    el.bannerBody.textContent = body;
    el.bannerRetry.hidden = !retry;
  }

  function renderBanner() {
    if (state.gate) { el.banner.hidden = true; return; }
    if (state.error) {
      const retryIn = el.auto.checked && document.visibilityState === 'visible'
        ? ` Trying again in ${Math.round(nextDelay() / 1000)}s.`
        : '';
      const since = state.lastOkAt ? new Date(state.lastOkAt) : null;
      showBanner({
        tone: 'stale',
        icon: 'alert',
        title: state.error.message,
        body: since
          ? `The table shows the last data received at ${pad(since.getHours())}:${pad(since.getMinutes())}:${pad(since.getSeconds())}.${retryIn}`
          : `No account data yet.${retryIn}`,
        retry: true,
      });
      return;
    }
    const pool = poolSummary();
    if (pool && pool.total > 0 && pool.can_serve === 0 && pool.cooldown > 0 && pool.next_ready_at) {
      showBanner({
        tone: 'cooldown',
        icon: 'cooldown',
        title: `All accounts are cooling down. Requests get 429 until ${clockTime(pool.next_ready_at)} (in ${duration(pool.nextInSec)}).`,
        body: 'Clients receive Retry-After and can back off. Clear a cooldown only if you know the limit has lifted; DeepSeek may limit the login again.',
      });
      return;
    }
    if (pool && pool.total > 0 && pool.can_serve === 0) {
      const accounts = state.data.accounts;
      const paused = accounts.filter(a => a.status === 'disabled' && a.disabled_by === 'admin').length;
      const offInFile = accounts.filter(a => a.status === 'disabled' && a.disabled_by === 'file').length;
      const why = [];
      if (paused) why.push(`${paused} paused from this page`);
      if (offInFile) why.push(`${offInFile} off in ${offInFile === 1 ? 'its auth file' : 'their auth files'}`);
      if (pool.no_credentials) why.push(`${pool.no_credentials} without a token or cookie`);
      const fixes = [];
      if (paused) fixes.push(paused === 1 ? 'enable the paused account below' : 'enable a paused account below');
      if (offInFile) fixes.push('set "enabled": true in an auth file, then reload accounts');
      if (pool.no_credentials) fixes.push('import a fresh login with npm run auth:import, then reload accounts');
      const advice = fixes.map((f, i) => `${i === 0 ? f[0].toUpperCase() + f.slice(1) : `Or ${f}`}.`);
      showBanner({
        tone: 'error',
        icon: 'alert',
        title: 'No account can take requests. The proxy answers 503.',
        body: `${plural(pool.total, 'account', 'accounts')}: ${why.join(', ')}. ${advice.join(' ')}`,
      });
      return;
    }
    el.banner.hidden = true;
  }

  function renderTable() {
    const hasData = Boolean(state.data);
    const empty = hasData && state.data.accounts.length === 0;
    el.accounts.hidden = Boolean(state.gate) || empty || (!hasData && Boolean(state.error));
    el.empty.hidden = Boolean(state.gate) || !empty;
    el.accounts.classList.toggle('is-stale', Boolean(state.error) && hasData);
    el.table.setAttribute('aria-busy', String(!hasData));
    if (!hasData) { renderSkeleton(); return; }
    el.rows.querySelectorAll('.skeleton').forEach(n => n.remove());

    const seen = new Set();
    state.data.accounts.forEach((account, index) => {
      seen.add(account.id);
      let row = rowsById.get(account.id);
      if (!row) {
        row = createRow(account.id);
        rowsById.set(account.id, row);
      }
      const at = el.rows.children[index];
      if (at !== row.tr) el.rows.insertBefore(row.tr, at || null);
      updateRow(row, account);
    });
    for (const [id, row] of rowsById) {
      if (!seen.has(id)) { row.tr.remove(); rowsById.delete(id); }
    }
  }

  function renderSkeleton() {
    if (el.rows.querySelector('.skeleton')) return;
    // One bone per column of the table header.
    const widths = [['60%', '70%', '40%', '30%', '80%', '60%', '50%', '70%'], ['55%', '60%', '30%', '30%', '65%', '55%', '45%', '70%'], ['65%', '75%', '35%', '30%', '70%', '50%', '55%', '70%']];
    for (const row of widths) {
      const tr = document.createElement('tr');
      tr.className = 'skeleton';
      tr.setAttribute('aria-hidden', 'true');
      for (const w of row) {
        const td = document.createElement('td');
        const bone = document.createElement('span');
        bone.className = 'bone';
        bone.style.setProperty('width', w);
        td.append(bone);
        tr.append(td);
      }
      el.rows.append(tr);
    }
  }

  function createRow(id) {
    const tr = el.rowTemplate.content.firstElementChild.cloneNode(true);
    const q = (sel) => tr.querySelector(sel);
    const row = {
      id,
      tr,
      badgeUse: q('.badge use'),
      badgeText: q('.badge-text'),
      statusDetail: q('.status-detail'),
      name: q('.acct-name'),
      acctId: q('.acct-id'),
      countdown: q('.countdown'),
      coolBar: q('.cool-bar'),
      coolBarFill: q('.cool-bar-fill'),
      cooldownCell: q('.c-cooldown'),
      errorCell: q('.c-error'),
      cooldownDetail: q('.cooldown-detail'),
      failRun: q('.fail-run'),
      failTotal: q('.fail-total'),
      errorNone: q('.error-none'),
      errorDetails: q('.error-details'),
      errorKind: q('.error-kind'),
      errorWhen: q('.error-when'),
      errorPreview: q('.error-preview'),
      errorMessage: q('.error-message'),
      successLine: q('.activity-success'),
      successLabel: q('.activity-success .activity-label'),
      successAt: q('.success-at'),
      usedLine: q('.activity-used'),
      usedLabel: q('.activity-used .activity-label'),
      usedAt: q('.used-at'),
      usageRequests: q('.usage-requests'),
      usageTokens: q('.usage-tokens'),
      usageCost: q('.usage-cost'),
      toggle: q('.act-toggle'),
      clear: q('.act-clear'),
      note: q('.act-note'),
      account: null,
    };
    row.note.id = `note-${++rowSerial}`;
    row.toggle.setAttribute('aria-describedby', row.note.id);
    row.toggle.addEventListener('click', () => {
      const a = row.account;
      if (!a || row.toggle.getAttribute('aria-disabled') === 'true') return;
      runAction(a, a.disabled_by === 'admin' ? 'enable' : 'disable', row.toggle);
    });
    row.clear.addEventListener('click', () => {
      if (!row.account || row.clear.getAttribute('aria-disabled') === 'true') return;
      runAction(row.account, 'clear-cooldown', row.clear);
    });
    return row;
  }

  function statusDetail(account) {
    switch (account.status) {
      case 'busy': {
        const who = account.busy_agent ? `Serving ${account.busy_agent}` : 'Serving a request';
        return account.busy_since ? `${who} for ${duration((serverNow() - account.busy_since) / 1000)}` : who;
      }
      case 'disabled':
        return account.disabled_by === 'file' ? 'Off in its auth file. Edit it, then reload.' : 'Paused from this page';
      case 'no_credentials': {
        const missing = [];
        if (!account.credentials?.token) missing.push('token');
        if (!account.credentials?.cookie_count) missing.push('cookie');
        return missing.length ? `Missing ${missing.join(' and ')}` : '';
      }
      default:
        return '';
    }
  }

  function updateRow(row, account) {
    row.account = account;
    const { tr } = row;
    tr.dataset.status = account.status;
    row.badgeUse.setAttribute('href', `#i-${STATUS_LABEL[account.status] ? account.status : 'alert'}`);
    row.badgeText.textContent = STATUS_LABEL[account.status] || account.status;
    row.statusDetail.textContent = statusDetail(account);

    row.name.textContent = account.name || account.id;
    row.acctId.textContent = account.name && account.name !== account.id ? account.id : '';

    updateCooldown(row);

    row.failRun.textContent = String(account.failures);
    row.failRun.classList.toggle('is-hot', account.failures > 0);
    row.failTotal.textContent = String(account.total_failures);
    row.failRun.title = `${plural(account.failures, 'failure', 'failures')} in a row`;
    row.failTotal.title = `${plural(account.total_failures, 'failure', 'failures')} since the proxy started`;

    const err = account.last_error;
    row.errorCell.classList.toggle('is-empty', !err);
    row.errorNone.hidden = Boolean(err);
    row.errorDetails.hidden = !err;
    if (err) {
      row.errorDetails.dataset.kind = err.kind;
      const kind = ERROR_KIND_LABEL[err.kind] || err.kind;
      row.errorKind.textContent = err.status ? `${kind} (HTTP ${err.status})` : kind;
      row.errorPreview.textContent = err.message || 'No message';
      if (row.errorMessage.textContent !== (err.message || 'No message')) {
        row.errorMessage.textContent = err.message || 'No message';
      }
      row.errorWhen.dataset.at = String(err.at || '');
    }

    const usage = account.usage || {};
    const requests = usage.requests || 0;
    row.usageRequests.textContent = requests ? plural(requests, 'request', 'requests') : 'No requests';
    row.usageRequests.classList.toggle('none', !requests);
    row.usageTokens.textContent = requests ? `${compact((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))} tokens` : '';
    row.usageTokens.title = `${(usage.prompt_tokens || 0).toLocaleString()} prompt, ${(usage.completion_tokens || 0).toLocaleString()} completion`;
    row.usageCost.textContent = requests ? `${usd(usage.usd)} at API prices` : '';
    row.usageCost.title = 'What these tokens would cost on the paid DeepSeek API. Nothing is billed.';

    updateTimes(row);
    syncRowButtons(account.id);
  }

  function syncRowButtons(id) {
    const row = rowsById.get(id);
    if (!row || !row.account) return;
    const a = row.account;
    const busy = pending.has(id);
    if (!row.toggle.hasAttribute('aria-busy')) {
      row.toggle.textContent = a.disabled_by ? 'Enable' : 'Disable';
    }
    // aria-disabled keeps the button focusable so keyboard users reach the note that explains it.
    row.toggle.setAttribute('aria-disabled', String(busy || a.disabled_by === 'file'));
    row.clear.hidden = a.status !== 'cooldown' && !row.clear.hasAttribute('aria-busy');
    row.clear.setAttribute('aria-disabled', String(busy));
    row.note.textContent = a.disabled_by === 'file'
      ? 'Turned off in its auth file ("enabled": false). To turn it on, set "enabled": true in that file, then reload accounts.'
      : '';
    row.toggle.setAttribute('aria-label', `${row.toggle.textContent} ${a.name || a.id}`);
    row.clear.setAttribute('aria-label', `Clear cooldown for ${a.name || a.id}`);
  }

  function updateCooldown(row) {
    const a = row.account;
    const remaining = a.cooldown_until ? (a.cooldown_until - serverNow()) / 1000 : 0;
    const cooling = a.status === 'cooldown' && Boolean(a.cooldown_until);
    row.cooldownCell.classList.toggle('is-empty', !cooling);
    if (cooling) {
      row.countdown.classList.remove('none');
      row.countdown.textContent = remaining > 0 ? duration(remaining) : 'Ending now';
      const reason = REASON_LABEL[a.cooldown_reason] || 'Cooling down';
      row.cooldownDetail.textContent = `${reason}, until ${clockTime(a.cooldown_until)}`;
      const p = cooldownProgress(a);
      row.coolBar.hidden = p === null;
      if (p !== null) row.coolBarFill.style.setProperty('--p', p.toFixed(3));
      if (remaining <= 0) requestExpiryRefresh();
    } else {
      row.countdown.classList.add('none');
      row.countdown.textContent = 'None';
      row.cooldownDetail.textContent = '';
      row.coolBar.hidden = true;
    }
  }

  function updateTimes(row) {
    const a = row.account;
    const succeeded = Boolean(a.last_success_at);
    const used = Boolean(a.last_used_at);
    row.successLabel.textContent = succeeded ? 'Succeeded ' : (used ? 'No success yet' : 'Never used');
    setTime(row.successAt, a.last_success_at, succeeded ? ago(a.last_success_at) : '');
    row.successLine.classList.toggle('none', !succeeded);
    row.usedLine.hidden = !used;
    row.usedLabel.textContent = used ? 'Used ' : '';
    setTime(row.usedAt, a.last_used_at, used ? ago(a.last_used_at) : '');
    if (a.last_error?.at) setTime(row.errorWhen, a.last_error.at, ago(a.last_error.at));
  }

  // When a countdown reaches zero, fetch fresh state once instead of waiting for the poll.
  function requestExpiryRefresh() {
    const now = Date.now();
    if (now - state.expiryRefreshAt < 3000 || state.gate || state.error) return;
    state.expiryRefreshAt = now;
    setTimeout(() => refresh(), 600);
  }

  // One-second tick: countdowns, relative times, and the pool sentence. No network.
  function tick() {
    if (!state.data || state.gate) return;
    for (const row of rowsById.values()) {
      if (!row.account) continue;
      updateCooldown(row);
      updateTimes(row);
      if (row.account.status === 'busy') row.statusDetail.textContent = statusDetail(row.account);
    }
    renderPool();
    renderBanner();
  }

  // ---------- Wiring ----------

  el.auto.addEventListener('change', () => {
    if (el.auto.checked) refresh(); else schedule();
    renderMasthead();
  });
  el.refresh.addEventListener('click', () => refresh());
  $('forbidden-retry').addEventListener('click', () => { state.gate = null; refresh(); });
  el.bannerRetry.addEventListener('click', () => refresh());
  el.reload.addEventListener('click', () => reloadAccounts(el.reload));
  el.emptyReload.addEventListener('click', () => reloadAccounts(el.emptyReload));
  el.forgetKey.addEventListener('click', () => {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) { /* storage blocked: nothing stored */ }
    toast({ title: 'Forgot the proxy key for this tab.' });
    refresh();
  });
  el.keyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const key = el.keyInput.value.trim();
    if (!key) return;
    try {
      sessionStorage.setItem(KEY_STORAGE, key);
    } catch (e) {
      toast({ title: 'Could not store the key.', body: 'This browser blocks sessionStorage for this page.', tone: 'error' });
      return;
    }
    el.keyInput.value = '';
    state.gate = null;
    refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (el.auto.checked && !state.gate) refresh();
    } else {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  });

  render();
  refresh();
  setInterval(tick, 1000);
})();
