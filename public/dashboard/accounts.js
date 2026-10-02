// FreeDeepseekAPI dashboard: Accounts view, account inspector, add / remove flows.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;

  const FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'ready', label: 'Ready' },
    { value: 'busy', label: 'Busy' },
    { value: 'cooldown', label: 'Cooldown' },
    { value: 'disabled', label: 'Paused' },
    { value: 'problems', label: 'Problems' },
  ];

  const st = {
    root: null,
    els: {},
    filter: 'all',
    query: '',
    rows: new Map(),       // id -> { tr, sig }
    pending: new Map(),    // id -> action verb
    rowErrors: new Map(),  // id -> message
    selected: null,
    cursor: null,
    visible: false,
    reloadErrors: null,
    inspectorErrors: new Map(),
  };

  const nameOf = (a) => a.name || a.id;

  // ---------------------------------------------------------------- actions
  async function action(account, kind, trigger) {
    const id = account.id;
    if (st.pending.has(id)) return;
    const verbs = {
      disable: ['Pausing…', 'POST', `/admin/accounts/${encodeURIComponent(id)}/disable`, undefined, `Paused ${nameOf(account)}. It stops receiving requests until you resume it or the server restarts.`],
      enable: ['Resuming…', 'POST', `/admin/accounts/${encodeURIComponent(id)}/enable`, undefined, `Resumed ${nameOf(account)}.`],
      'clear-cooldown': ['Clearing…', 'POST', `/admin/accounts/${encodeURIComponent(id)}/clear-cooldown`, undefined, `Cleared the cooldown on ${nameOf(account)}.`],
      'file-disable': ['Disabling…', 'PATCH', `/admin/accounts/${encodeURIComponent(id)}`, { enabled: false }, `Disabled ${nameOf(account)} in its file. It stays disabled after a restart.`],
      'file-enable': ['Enabling…', 'PATCH', `/admin/accounts/${encodeURIComponent(id)}`, { enabled: true }, `Enabled ${nameOf(account)} in its file.`],
    };
    const [pendingLabel, method, path, body, done] = verbs[kind];
    st.pending.set(id, pendingLabel);
    st.rowErrors.delete(id);
    st.inspectorErrors.delete(id);
    if (trigger && trigger.tagName === 'BUTTON' && !trigger.closest('.popover')) F.setPending(trigger, pendingLabel);
    render();
    try {
      const res = await F.api(method, path, { body });
      F.applyAccountUpdate(res);
      F.toast(done, { tone: 'success' });
    } catch (e) {
      if (!F.handleGate(e)) {
        const msg = F.errorText(e);
        st.rowErrors.set(id, msg);
        st.inspectorErrors.set(id, { kind, message: msg, type: e.type });
        F.toastError(`${pendingLabel.replace('…', '')} ${nameOf(account)} failed`, e);
      }
    } finally {
      st.pending.delete(id);
      if (trigger) F.clearPending(trigger);
      render();
      renderInspector();
    }
  }

  async function reload(btn) {
    if (btn && btn.getAttribute('aria-busy') === 'true') return;
    F.setPending(btn, 'Reloading…');
    try {
      const res = await F.api('POST', '/admin/accounts/reload');
      st.reloadErrors = null;
      F.applyAccountUpdate(res);
      const errs = res.errors || [];
      const detail = errs.length ? h('details', { class: 'toast-details' }, h('summary', { text: `${errs.length} file${errs.length === 1 ? '' : 's'} could not load` }),
        h('ul', null, errs.map(e => h('li', null, h('code', { class: 'mono-id', text: e.file }), ` ${e.message}`)))) : null;
      F.toast(`Reloaded: ${(res.added || []).length} added, ${(res.removed || []).length} removed, ${(res.kept || []).length} kept`, { tone: errs.length ? 'warn' : 'success', detail });
    } catch (e) {
      if (!F.handleGate(e)) {
        if (e.status === 422) {
          st.reloadErrors = { message: e.message, errors: (e.body && e.body.error && e.body.error.errors) || [] };
          render();
        } else F.toastError('Reload failed', e);
      }
    } finally {
      F.clearPending(btn);
    }
  }

  async function restoreAccount(account, archivedAs) {
    try {
      const res = await F.api('POST', '/admin/accounts/restore', { body: { archived_as: archivedAs } });
      F.applyAccountUpdate(res);
      F.toast(`Restored ${nameOf(account)}.`, { tone: 'success' });
      F.refresh();
    } catch (e) {
      if (F.handleGate(e)) return;
      if (e.status === 404 && e.type === 'not_found') {
        F.toastError('Undo failed', new F.ApiError(`This server build can't restore accounts. Rename ${archivedAs} back to ${account.id}.json in the accounts folder, then Reload from disk.`, { type: 'endpoint_missing' }));
        return;
      }
      F.toastError('Undo failed', e);
    }
  }

  function confirmRemove(account, trigger) {
    F.confirm(trigger, {
      text: `Remove ${nameOf(account)} from the pool? Its auth file is renamed to ${account.id}.json.removed-<time> and kept on disk, credentials included. Delete that file by hand to erase them.`,
      confirmLabel: 'Remove account',
      pendingLabel: 'Removing…',
      async run() {
        try {
          const res = await F.api('DELETE', `/admin/accounts/${encodeURIComponent(account.id)}`);
          F.applyAccountUpdate(res);
          if (st.selected === account.id) F.inspector.close();
          F.toast(`Removed ${nameOf(account)}. File kept as ${res.archived_as}.`, {
            tone: 'success',
            duration: 10000,
            action: { label: 'Undo', run: () => restoreAccount(account, res.archived_as) },
          });
          F.refresh();
        } catch (e) {
          if (F.handleGate(e)) return;
          if (e.status === 404 && e.type === 'not_found') {
            throw new F.ApiError('This server build can\'t remove accounts from the dashboard. Move the file out of the accounts folder by hand, then Reload from disk.', { type: 'endpoint_missing' });
          }
          throw e;
        }
      },
    });
  }

  function rowMenu(account, trigger) {
    const paused = account.status === 'disabled';
    const items = [];
    if (paused && account.disabled_by === 'file') items.push({ label: 'Enable in file', icon: 'play', run: () => action(account, 'file-enable') });
    else if (paused) items.push({ label: 'Resume routing', icon: 'play', run: () => action(account, 'enable') });
    else items.push({ label: 'Pause routing', icon: 'pause', run: () => action(account, 'disable') });
    items.push({ label: 'Clear cooldown', icon: 'clear-cooldown', disabled: account.status !== 'cooldown', reason: 'Not cooling down', run: () => action(account, 'clear-cooldown') });
    if (account.disabled_by !== 'file') items.push({ label: 'Disable in file', icon: 'lock', run: () => action(account, 'file-disable') });
    items.push('sep');
    items.push({ label: 'View requests', icon: 'requests', run: () => F.navigate('requests', '', { account: account.id }) });
    items.push({ label: 'View usage', icon: 'usage', run: () => F.navigate('usage', '', { account: account.id }) });
    items.push('sep');
    items.push({ label: 'Remove account…', icon: 'trash', danger: true, movesFocus: true, run: () => confirmRemove(account, trigger) });
    F.menu(trigger, items, { label: `Actions for ${nameOf(account)}` });
  }

  // ---------------------------------------------------------------- state text
  function stateCell(a) {
    const kids = [F.lamp(a.status)];
    if (a.status === 'busy') {
      kids.push(h('span', { class: 'state-word', text: 'Busy' }), ' ', h('span', { class: 'readout-inline', 'data-busy-since': a.busy_since || '', text: fmt.clock((F.now() - (a.busy_since || F.now())) / 1000) }));
      if (a.busy_agent) kids.push(h('span', { class: 'state-extra', text: ` · ${a.busy_agent}` }));
    } else if (a.status === 'cooldown') {
      const total = Math.max(1, (a.cooldown_until - (a.last_error && a.last_error.at ? a.last_error.at : a.cooldown_until - 60000)));
      const meter = h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill', 'data-meter-until': a.cooldown_until, 'data-meter-total': total }));
      kids.push(h('span', { class: 'state-word', text: 'Cooldown' }), ' ', h('span', { class: 'readout-inline', 'data-cooldown-until': a.cooldown_until, text: fmt.clock(F.cooldownLeft(a)) }), meter);
    } else if (a.status === 'disabled') {
      kids.push(h('span', { class: 'state-word', text: a.disabled_by === 'file' ? 'Disabled in file' : 'Paused by admin' }));
    } else if (a.status === 'no_credentials') {
      kids.push(h('span', { class: 'state-word', text: 'No credentials' }));
    } else {
      kids.push(h('span', { class: 'state-word', text: 'Ready' }));
    }
    return h('span', { class: `state state-${a.status}` }, kids);
  }

  function lastErrorShort(a) {
    const e = a.last_error;
    if (!e) return null;
    const kind = { rate_limit: 'rate limit', auth: 'auth', upstream: 'upstream' }[e.kind] || e.kind || 'error';
    return `${e.status ? `${e.status} ` : ''}${kind}`;
  }

  function tokens(a) {
    return (a.usage.prompt_tokens || 0) + (a.usage.completion_tokens || 0);
  }

  function matches(a) {
    if (st.query) {
      const q = st.query.toLowerCase();
      if (!nameOf(a).toLowerCase().includes(q) && !a.id.toLowerCase().includes(q)) return false;
    }
    if (st.filter === 'all') return true;
    if (st.filter === 'problems') return a.status === 'no_credentials' || a.failures > 0 || (a.last_error && a.status !== 'ready' && a.status !== 'busy');
    return a.status === st.filter;
  }

  // ---------------------------------------------------------------- view
  function mount(root) {
    st.root = root;
    const filterInput = h('input', { type: 'search', class: 'input input-search', placeholder: 'Filter accounts', 'aria-label': 'Filter accounts', 'data-view-filter': '', spellcheck: 'false' });
    filterInput.addEventListener('input', () => { st.query = filterInput.value.trim(); render(); });
    const chips = F.segmented('Account state', FILTERS, st.filter, (v) => { st.filter = v; render(); });
    const count = h('p', { class: 'meta count' });
    const banner = h('div', { class: 'view-banner' });
    const table = h('table', { class: 'data-table accounts-table rows-clickable' });
    table.append(h('caption', { class: 'sr-only', text: 'Accounts' }));
    table.append(h('thead', null, h('tr', null,
      h('th', { scope: 'col', text: 'State' }),
      h('th', { scope: 'col', text: 'Account' }),
      h('th', { scope: 'col', class: 'num', text: 'Failures', title: 'In a row / total since start' }),
      h('th', { scope: 'col', text: 'Last error' }),
      h('th', { scope: 'col', text: 'Last ok' }),
      h('th', { scope: 'col', class: 'num', text: 'Requests' }),
      h('th', { scope: 'col', class: 'num', text: 'Tokens ≈' }),
      h('th', { scope: 'col', class: 'col-actions' }, h('span', { class: 'sr-only', text: 'Actions' })))));
    const tbody = h('tbody');
    table.append(tbody);
    const empty = h('div', { class: 'empty-host' });
    const note = h('p', { class: 'meta table-note', text: 'Usage is since the server started. Tokens are estimates (characters ÷ 4). Pause is runtime only; Disable in file survives a restart.' });

    const hero = F.pageHero({ image: '/dashboard/media-arrays-aurora.jpg', label: 'Account pool', position: '50% 45%' });
    root.append(hero, h('div', { class: 'view-pad' },
      h('div', { class: 'filter-row' }, h('label', { class: 'search-field search-field-inline' }, F.icon('search'), filterInput), chips, count),
      banner,
      h('div', { class: 'table-scroll' }, table),
      empty,
      note));
    Object.assign(st.els, { hero, filterInput, chips, count, banner, table, tbody, empty, note });

    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || e.target.closest('button, a, input')) return;
      select(tr.dataset.id, tr);
    });
    tbody.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && e.key === 'Enter' && e.target === tr) select(tr.dataset.id, tr);
    });

    F.on('accounts', () => { if (st.visible) { render(); renderInspector(); } });
    F.on('requests', () => { if (st.visible && st.selected) renderInspector(); });
    F.on('tick', tick);
  }

  function select(id, tr) {
    st.selected = id;
    st.cursor = id;
    F.replaceHash('accounts', id, {});
    openInspector(id, tr);
    render();
  }

  // Hero line: the roster at a glance, every number from GET /admin/accounts.
  function renderHero(data) {
    const hero = st.els.hero;
    if (!data) { hero.set(F.store.error ? 'Accounts unavailable.' : 'Loading accounts…', F.store.error ? F.errorText(F.store.error) : '', F.store.error ? 'crit' : null); return; }
    const all = data.accounts;
    if (!all.length) { hero.set('No accounts yet.', 'Add a DeepSeek login to start serving requests.'); return; }
    const by = (st$) => all.filter(a => a.status === st$).length;
    const parts = [[by('ready'), 'ready'], [by('busy'), 'busy'], [by('cooldown'), 'cooling down'], [by('disabled'), 'paused'], [by('no_credentials'), 'without credentials']]
      .filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
    hero.set(`${all.length} account${all.length === 1 ? '' : 's'} in the pool.`, parts.join(' · '), data.pool.can_serve === 0 ? 'crit' : null);
  }

  function render() {
    if (!st.root || !st.visible) return;
    const data = F.store.accounts;
    const { tbody, count, empty, banner, table } = st.els;
    renderHero(data);

    banner.replaceChildren();
    if (st.reloadErrors) {
      banner.append(F.notice('crit', 'Reload found no usable account. The pool is unchanged.', h('div', null,
        h('p', { class: 'notice-text', text: st.reloadErrors.message }),
        st.reloadErrors.errors.length ? h('ul', { class: 'notice-list' }, st.reloadErrors.errors.map(e => h('li', null, h('code', { class: 'mono-id', text: e.file }), ` ${e.message}`))) : null),
      [F.btn('Dismiss', { kind: 'ghost', size: 'sm', onclick: () => { st.reloadErrors = null; render(); } })]));
    }
    if (!data) {
      if (!tbody.querySelector('.skel-row')) {
        tbody.replaceChildren(...[40, 60, 30].map(w => h('tr', { class: 'skel-row' }, Array.from({ length: 8 }, (_, i) => h('td', null, i < 7 ? h('span', { class: 'skel', style: { '--w': `${(w + i * 13) % 70 + 20}%` } }) : null)))));
        st.rows.clear();
      }
      count.textContent = F.store.error ? F.errorText(F.store.error) : '';
      empty.replaceChildren();
      return;
    }
    tbody.querySelectorAll('.skel-row').forEach(r => r.remove());
    const all = data.accounts;
    if (!all.length) {
      table.hidden = true;
      empty.replaceChildren(emptyPool());
      count.textContent = '';
      return;
    }
    table.hidden = false;
    empty.replaceChildren();
    const list = all.filter(matches);
    count.textContent = list.length === all.length ? `${all.length} account${all.length === 1 ? '' : 's'}` : `${list.length} of ${all.length} accounts`;
    if (!list.length) empty.replaceChildren(h('p', { class: 'quiet', text: 'No account matches this filter.' }));

    const seen = new Set();
    const ordered = [];
    for (const a of list) {
      seen.add(a.id);
      const sig = JSON.stringify([a, st.pending.get(a.id) || null, st.rowErrors.get(a.id) || null, st.selected === a.id]);
      let row = st.rows.get(a.id);
      if (!row) { row = { tr: h('tr', { 'data-id': a.id, tabindex: '-1' }), sig: '' }; st.rows.set(a.id, row); }
      if (row.sig !== sig) {
        // Keep focus if a control inside this row had it.
        const focused = row.tr.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus-key') : null;
        buildRow(row.tr, a);
        row.sig = sig;
        if (focused) { const again = row.tr.querySelector(`[data-focus-key="${focused}"]`); if (again) again.focus({ preventScroll: true }); }
      }
      row.tr.classList.toggle('is-selected', st.selected === a.id);
      row.tr.classList.toggle('is-cursor', st.cursor === a.id);
      row.tr.setAttribute('aria-selected', String(st.selected === a.id));
      ordered.push(row.tr);
    }
    for (const id of Array.from(st.rows.keys())) if (!seen.has(id)) { st.rows.get(id).tr.remove(); st.rows.delete(id); }
    // reorder only when needed
    ordered.forEach((tr, i) => { if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] || null); });
    tick();
  }

  function buildRow(tr, a) {
    const pending = st.pending.get(a.id);
    tr.setAttribute('aria-busy', pending ? 'true' : 'false');
    tr.classList.toggle('is-out', a.status === 'disabled' || a.status === 'no_credentials');
    const inline = [];
    if (a.status === 'cooldown') inline.push(F.btn('Clear', { size: 'sm', onclick: (e) => action(a, 'clear-cooldown', e.currentTarget), 'data-focus-key': `clear-${a.id}` }));
    if (a.status === 'disabled' && a.disabled_by === 'admin') inline.push(F.btn('Resume', { size: 'sm', onclick: (e) => action(a, 'enable', e.currentTarget), 'data-focus-key': `resume-${a.id}` }));
    const more = F.iconBtn('more', `Actions for ${nameOf(a)}`, { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-focus-key': `more-${a.id}` });
    more.addEventListener('click', (e) => { e.stopPropagation(); rowMenu(a, more); });
    const err = st.rowErrors.get(a.id);
    const errShort = lastErrorShort(a);
    tr.replaceChildren(
      h('td', { class: 'cell-state' }, stateCell(a), pending ? h('span', { class: 'row-pending' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), pending) : null),
      h('td', { class: 'cell-account' },
        h('span', { class: 'acct-name', text: nameOf(a) }),
        a.name && a.name !== a.id ? h('span', { class: 'mono-id acct-id', text: a.id }) : null,
        h('span', { class: 'cell-mobile-meta meta', text: `${a.failures} / ${a.total_failures} failures · ${fmt.compact(tokens(a))} tokens ≈` })),
      h('td', { class: 'num', text: `${a.failures} / ${a.total_failures}` }),
      h('td', { class: 'cell-error', title: a.last_error ? a.last_error.message || '' : '' }, errShort ? h('span', { class: a.status === 'ready' || a.status === 'busy' ? 'quiet' : 'is-crit-text', text: errShort }) : h('span', { class: 'quiet', text: '—' })),
      h('td', { class: 'num-left', 'data-ago': a.last_success_at || '', text: fmt.ago(a.last_success_at) }),
      h('td', { class: 'num', text: fmt.int(a.usage.requests) }),
      h('td', { class: 'num', text: fmt.compact(tokens(a)) }),
      h('td', { class: 'cell-actions' }, h('div', { class: 'row-actions' }, inline, more), err ? h('p', { class: 'inline-error', role: 'alert', text: err }) : null));
  }

  // 1s: countdowns, meters, relative times. No re-render.
  function tick() {
    if (!st.visible || !st.root) return;
    const now = F.now();
    for (const el of st.root.querySelectorAll('[data-cooldown-until]')) el.textContent = fmt.clock((Number(el.dataset.cooldownUntil) - now) / 1000);
    for (const el of st.root.querySelectorAll('[data-busy-since]')) if (el.dataset.busySince) el.textContent = fmt.clock((now - Number(el.dataset.busySince)) / 1000);
    for (const el of st.root.querySelectorAll('[data-meter-until]')) {
      const left = Math.max(0, Number(el.dataset.meterUntil) - now);
      el.style.setProperty('transform', `scaleX(${Math.min(1, left / Number(el.dataset.meterTotal))})`);
    }
    for (const el of st.root.querySelectorAll('[data-ago]')) if (el.dataset.ago) el.textContent = fmt.ago(Number(el.dataset.ago), now);
    if (F.inspector.isOpen && F.inspector.owner === 'account') {
      const insp = document.getElementById('inspector');
      for (const el of insp.querySelectorAll('[data-cooldown-until]')) el.textContent = fmt.clock((Number(el.dataset.cooldownUntil) - now) / 1000);
      for (const el of insp.querySelectorAll('[data-busy-since]')) if (el.dataset.busySince) el.textContent = fmt.clock((now - Number(el.dataset.busySince)) / 1000);
    }
  }

  function emptyPool() {
    const add = F.btn('Add account', { kind: 'primary', icon: 'plus', onclick: (e) => openAdd(e.currentTarget) });
    return h('div', { class: 'empty' },
      h('p', { class: 'empty-title', text: 'No accounts are loaded.' }),
      h('p', { class: 'empty-text', text: 'Add a DeepSeek login exported by the DeepSeek Auth Exporter extension, or import one from a terminal and reload:' }),
      F.codeLine('npm run auth:import'),
      h('div', { class: 'empty-actions' }, add, F.btn('Reload from disk', { icon: 'reload', onclick: (e) => reload(e.currentTarget) })));
  }

  // ---------------------------------------------------------------- inspector
  function openInspector(id, returnFocus) {
    const a = F.accountById(id);
    if (!a) {
      F.toast(`No account ${id} is loaded.`, { tone: 'warn' });
      F.replaceHash('accounts', '', {});
      return;
    }
    const parts = inspectorParts(a);
    F.inspector.open({
      ...parts, owner: 'account', returnFocus: returnFocus || null,
      onClose: () => { st.selected = null; if (st.visible) { F.replaceHash('accounts', '', {}); render(); } },
    });
  }

  function renderInspector() {
    if (!F.inspector.isOpen || F.inspector.owner !== 'account' || !st.selected) return;
    const a = F.accountById(st.selected);
    if (!a) { F.inspector.close(); return; }
    // Do not rebuild while the user is typing a new name.
    const active = document.activeElement;
    if (active && active.matches && active.matches('#inspector input[type=text]')) return;
    F.inspector.update(inspectorParts(a));
  }

  function inspectorParts(a) {
    const title = [F.lamp(a.status, 'lamp-lg'), h('span', { text: nameOf(a) })];
    const sub = [h('span', { class: 'state-word', text: F.charts.stateLabel(a) }), h('code', { class: 'mono-id', text: a.id }), F.copyBtn(a.id, 'Copy account id')];
    const body = h('div', { class: 'insp' });
    const pending = st.pending.get(a.id);
    const ierr = st.inspectorErrors.get(a.id);

    // credentials
    body.append(section('Credentials', h('ul', { class: 'facts' },
      fact('Token', a.credentials.token ? h('span', null, F.icon('check', 'icon-sm is-ok-text'), ' present') : h('span', { class: 'is-crit-text', text: 'missing' })),
      fact('Cookie parts', fmt.int(a.credentials.cookie_count)),
      fact('Stored', 'Values are never sent to the browser.'))));

    // lane trace (1h)
    const trace = h('div', { class: 'lanes-host lanes-host-mini' });
    body.append(section('Last hour', trace, F.store.requestsMissing ? h('p', { class: 'meta', text: 'Traffic history needs GET /admin/requests.' }) : null));
    requestAnimationFrame(() => {
      if (!document.contains(trace)) return;
      F.charts.lanes(trace, {
        accounts: [a], rows: F.store.requests.filter(r => r.account === a.id), windowMs: 3600000, now: F.now(),
        laneH: 40, labelW: 0, compact: true, label: `Requests on ${nameOf(a)} in the last hour`,
        onPick: (r) => F.navigate('requests', '', { id: r.id }),
      });
    });

    // state actions
    const routing = a.status !== 'disabled';
    const sw = F.switchEl('Route requests to this account', routing, (on, input) => {
      input.checked = !on; // reverts until the server confirms
      action(a, on ? (a.disabled_by === 'file' ? 'file-enable' : 'enable') : 'disable');
    });
    sw.classList.add('switch-wide');
    sw.input.setAttribute('data-focus-key', 'route');
    if (pending || a.status === 'no_credentials') sw.input.disabled = true;
    const stateBox = h('div', { class: 'insp-actions' }, sw);
    if (a.status === 'no_credentials') stateBox.append(h('p', { class: 'meta', text: 'This account has no usable credentials, so it can\'t serve. Remove it and add a fresh export.' }));
    if (a.disabled_by === 'file') stateBox.append(h('p', { class: 'meta', text: 'Disabled in its auth file ("enabled": false). Turning routing on rewrites the file.' }));
    else if (a.disabled_by === 'admin') stateBox.append(h('p', { class: 'meta', text: 'Paused at runtime. It comes back after a server restart.' }));
    if (a.status === 'cooldown') {
      stateBox.append(h('div', { class: 'insp-row' },
        h('p', { class: 'is-warn-text' }, 'Cooling down for ', h('span', { class: 'readout-inline', 'data-cooldown-until': a.cooldown_until, text: fmt.clock(F.cooldownLeft(a)) }), ` (${fmt.cooldownReason(a.cooldown_reason)})`),
        F.btn('Clear cooldown', { size: 'sm', icon: 'clear-cooldown', 'data-focus-key': 'clear', onclick: (e) => action(a, 'clear-cooldown', e.currentTarget) })));
    }
    if (a.status === 'busy') {
      stateBox.append(h('p', { class: 'is-signal-text' }, 'Busy for ', h('span', { class: 'readout-inline', 'data-busy-since': a.busy_since || '', text: fmt.clock((F.now() - (a.busy_since || F.now())) / 1000) }), a.busy_agent ? ` · ${a.busy_agent}` : ''));
    }
    if (a.disabled_by !== 'file') {
      stateBox.append(h('div', { class: 'insp-row' }, h('p', { class: 'meta', text: 'Keep it out of the pool across restarts:' }),
        F.btn('Disable in file', { size: 'sm', icon: 'lock', 'data-focus-key': 'file-disable', onclick: (e) => action(a, 'file-disable', e.currentTarget) })));
    }
    if (ierr) {
      const errBox = h('div', { class: 'inline-error-block', role: 'alert' }, h('p', { text: ierr.message }));
      if (ierr.type === 'disabled_in_file') errBox.append(F.btn('Enable in file', { size: 'sm', onclick: (e) => action(a, 'file-enable', e.currentTarget) }));
      stateBox.append(errBox);
    }
    body.append(section('Routing', stateBox));

    // rename
    const nameInput = h('input', { type: 'text', class: 'input', value: nameOf(a), 'aria-label': 'Account name', maxlength: '64', spellcheck: 'false', 'data-focus-key': 'rename' });
    const renameErr = h('p', { class: 'inline-error', role: 'alert', hidden: true });
    const saveBtn = F.btn('Rename', { size: 'sm' });
    const doRename = async () => {
      const name = nameInput.value.trim();
      if (!name || name === nameOf(a)) return;
      renameErr.hidden = true;
      F.setPending(saveBtn, 'Saving…');
      try {
        const res = await F.api('PATCH', `/admin/accounts/${encodeURIComponent(a.id)}`, { body: { name } });
        F.clearPending(saveBtn);
        nameInput.blur();
        F.applyAccountUpdate(res);
        F.toast(`Renamed to ${name}. The id stays ${a.id}.`, { tone: 'success' });
      } catch (e) {
        F.clearPending(saveBtn);
        if (!F.handleGate(e)) { renameErr.textContent = F.errorText(e); renameErr.hidden = false; }
      }
    };
    saveBtn.addEventListener('click', doRename);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRename(); } if (e.key === 'Escape') { nameInput.value = nameOf(a); nameInput.blur(); e.stopPropagation(); } });
    body.append(section('Name', h('div', { class: 'insp-row insp-rename' }, nameInput, saveBtn), renameErr, h('p', { class: 'meta', text: 'Stored in the auth file. The id comes from the file name and does not change.' })));

    // last error
    if (a.last_error) {
      body.append(section('Last error', h('div', { class: 'error-full' },
        h('p', { class: 'meta', text: `${lastErrorShort(a)} · ${fmt.dateTime(a.last_error.at)}` }),
        h('p', { class: 'mono-id selectable', text: a.last_error.message || '(no message)' }))));
    }

    // usage by model on this account (from the in-memory request log)
    const rows = F.store.requests.filter(r => r.account === a.id);
    const byModel = new Map();
    for (const r of rows) {
      const k = r.model || '(none)';
      byModel.set(k, (byModel.get(k) || 0) + (r.prompt_tokens || 0) + (r.completion_tokens || 0));
    }
    const bars = h('div');
    const list = Array.from(byModel, ([k, v]) => ({ key: k, label: fmt.shortModel(k), title: k, value: v, valueText: fmt.compact(v) })).sort((x, y) => y.value - x.value);
    if (list.length) F.charts.hbars(bars, list, { label: 'Tokens by model on this account', top: 5 });
    body.append(section('Tokens by model', list.length ? bars : h('p', { class: 'quiet', text: 'No requests on this account in the request log.' }),
      h('p', { class: 'meta', text: `Lifetime: ${fmt.int(a.usage.requests)} requests, ${fmt.compact(tokens(a))} tokens ≈, ${fmt.usd(a.usage.usd)} ≈ at API prices. The breakdown covers the requests still in the log.` })));

    // links + remove
    body.append(h('div', { class: 'insp-links' },
      h('a', { class: 'link', href: F.hashFor('requests', '', { account: a.id }), text: 'Requests from this account' }),
      h('a', { class: 'link', href: F.hashFor('usage', '', { account: a.id }), text: 'Usage for this account' })));
    const removeBtn = F.btn('Remove account…', { kind: 'danger-text', icon: 'trash', 'data-focus-key': 'remove' });
    removeBtn.addEventListener('click', () => confirmRemove(a, removeBtn));
    body.append(h('div', { class: 'insp-foot' }, removeBtn));
    return { title, sub, body };
  }

  function section(title, ...kids) {
    return h('section', { class: 'insp-section' }, h('h3', { class: 'insp-h', text: title }), kids);
  }
  function fact(label, value) {
    return h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: label }), h('span', { class: 'fact-value' }, value));
  }

  // ---------------------------------------------------------------- add account
  function slugFor(name) {
    return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
  }

  // Mirrors scripts/auth_import.js normalizeAuth/validateAuth for live feedback.
  function inspectAuth(text) {
    if (!text.trim()) return { empty: true };
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { parseError: e.message }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { parseError: 'The JSON must be an object like {"token": "…", "cookie": "…"}.' };
    }
    const token = String(obj.token || obj.access_token || obj.accessToken || obj.auth_token || '').trim().replace(/^Bearer\s+/i, '');
    let cookieParts = 0;
    if (typeof obj.cookie === 'string') cookieParts = obj.cookie.split(';').map(s => s.trim()).filter(Boolean).length;
    else if (Array.isArray(obj.cookies)) cookieParts = obj.cookies.filter(c => c && c.name).length;
    else if (typeof obj.cookies === 'string') cookieParts = obj.cookies.split(';').map(s => s.trim()).filter(Boolean).length;
    return {
      obj,
      token: Boolean(token),
      cookieParts,
      hifDliq: Boolean(obj.hif_dliq || obj['x-hif-dliq']),
      hifLeim: Boolean(obj.hif_leim || obj['x-hif-leim']),
      wasm: Boolean(obj.wasmUrl || obj.wasm_url),
      ok: Boolean(token) && cookieParts > 0,
    };
  }

  function openAdd(trigger) {
    const dlg = document.getElementById('add-account');
    const close = () => dlg.close();
    const textarea = h('textarea', { class: 'input input-code', rows: '8', spellcheck: 'false', 'aria-label': 'deepseek-auth.json contents', placeholder: '{ "token": "…", "cookie": "…", "hif_dliq": "…", "hif_leim": "…" }' });
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'add-file' });
    const drop = h('label', { class: 'dropzone', for: 'add-file' },
      F.icon('upload', 'dropzone-icon'),
      h('span', { class: 'dropzone-text', text: 'Drop deepseek-auth.json (exported by the DeepSeek Auth Exporter extension) or paste it below.' }),
      h('span', { class: 'link', text: 'Choose a file' }));
    const checks = h('ul', { class: 'checks', 'aria-live': 'polite' });
    const nameInput = h('input', { type: 'text', class: 'input', id: 'add-name', maxlength: '64', spellcheck: 'false', autocomplete: 'off', required: true });
    const nameHelp = h('p', { class: 'meta', id: 'add-name-help' });
    nameInput.setAttribute('aria-describedby', 'add-name-help');
    const formErr = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = F.btn('Add account', { kind: 'primary', type: 'submit' });
    const cancel = F.btn('Cancel', { onclick: close });
    const warn = (location.protocol === 'http:' && !F.isLoopbackHost())
      ? F.notice('warn', 'This page is not on HTTPS', `The credentials travel unencrypted to ${location.host}. Anyone on the network path can read them. Import from the machine running the proxy, or put it behind HTTPS.`)
      : null;

    const check = (ok, text, optional) => h('li', { class: ['check', ok ? 'is-ok' : optional ? 'is-optional' : 'is-bad'] }, F.lamp(ok ? 'ready' : optional ? 'disabled' : 'error'), h('span', { text }));
    let state = { empty: true };
    const validate = () => {
      state = inspectAuth(textarea.value);
      checks.replaceChildren();
      if (state.empty) checks.append(h('li', { class: 'check quiet', text: 'Waiting for the JSON.' }));
      else if (state.parseError) checks.append(check(false, `Not valid JSON: ${state.parseError}`));
      else {
        checks.append(
          check(state.token, state.token ? 'Token found' : 'Token missing: the file has no token field'),
          check(state.cookieParts > 0, state.cookieParts ? `Cookie found, ${state.cookieParts} part${state.cookieParts === 1 ? '' : 's'}` : 'Cookie missing: the file has no cookie or cookies field'),
          check(state.hifDliq, state.hifDliq ? 'hif_dliq found' : 'hif_dliq not found (optional)', true),
          check(state.hifLeim, state.hifLeim ? 'hif_leim found' : 'hif_leim not found (optional)', true));
      }
      const slug = slugFor(nameInput.value.trim());
      nameHelp.textContent = nameInput.value.trim()
        ? (slug ? `Saved as accounts/${slug}.json` : 'Saved as accounts/account-N.json (the server picks N because the name has no Latin letters or digits)')
        : 'Required, up to 64 characters.';
      const ready = state.ok && nameInput.value.trim().length > 0;
      submit.setAttribute('aria-disabled', String(!ready));
      submit.setAttribute('data-tip', ready ? '' : !state.ok ? 'Paste a valid auth JSON first' : 'Enter a name');
    };
    const loadFile = (file) => {
      if (!file) return;
      if (file.size > 64 * 1024) { textarea.value = ''; checks.replaceChildren(check(false, `${file.name} is ${fmt.int(file.size / 1024)} KB. The import limit is 64 KB.`)); return; }
      const reader = new FileReader();
      reader.onload = () => {
        textarea.value = String(reader.result || '');
        if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.json$/i, '').replace(/^deepseek-auth$/i, '');
        validate();
        nameInput.focus();
      };
      reader.onerror = () => checks.replaceChildren(check(false, `Could not read ${file.name}: ${reader.error ? reader.error.name : 'unknown error'}`));
      reader.readAsText(file);
    };
    fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); loadFile(e.dataTransfer.files[0]); });
    textarea.addEventListener('input', validate);
    nameInput.addEventListener('input', validate);

    const form = h('form', { class: 'dialog-form', method: 'dialog', novalidate: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true' || submit.getAttribute('aria-busy') === 'true') return;
      formErr.hidden = true;
      F.setPending(submit, 'Adding…');
      try {
        const res = await F.api('POST', '/admin/accounts/import', { body: { name: nameInput.value.trim(), auth: state.obj } });
        F.applyAccountUpdate(res);
        const acc = res.account;
        textarea.value = '';
        close();
        F.toast(acc && acc.status === 'ready' ? `Added ${nameOf(acc)}. Ready to serve.` : `Added ${acc ? nameOf(acc) : 'the account'}${acc ? ` (${F.charts.stateWord(acc)})` : ''}.`, { tone: 'success' });
        F.refresh();
      } catch (err) {
        F.clearPending(submit);
        if (F.handleGate(err)) { close(); return; }
        if (err.status === 404 && err.type === 'not_found') { showImportMissing(); return; }
        const list = err.body && err.body.error && Array.isArray(err.body.error.errors) ? err.body.error.errors : [];
        formErr.replaceChildren(h('p', { text: F.errorText(err) }), list.length ? h('ul', null, list.map(x => h('li', { text: String(x) }))) : '');
        formErr.hidden = false;
      }
    });

    const showImportMissing = () => {
      form.replaceChildren(
        h('p', { class: 'dialog-text', text: 'This server build can\'t import accounts from the dashboard. Run this where the proxy runs, then Reload from disk:' }),
        F.codeLine('npm run auth:import -- --output ./accounts/<name>.json'),
        h('div', { class: 'dialog-actions' }, F.btn('Close', { onclick: close })));
    };

    if (warn) form.append(warn);
    form.append(
      fileInput, drop,
      h('label', { class: 'field-label', for: 'add-json', text: 'Auth JSON' }),
      textarea,
      checks,
      h('label', { class: 'field-label', for: 'add-name', text: 'Name' }), nameInput, nameHelp,
      h('p', { class: 'meta disclosure', text: 'Credentials are sent once to this server and written to disk readable only by your user. They are never shown again.' }),
      formErr,
      h('div', { class: 'dialog-actions' }, cancel, submit));
    textarea.id = 'add-json';
    dlg.replaceChildren(
      h('div', { class: 'dialog-head' }, h('h2', { class: 'dialog-title', id: 'add-title', text: 'Add a DeepSeek account' }), F.iconBtn('close', 'Close', { onclick: close })),
      form);
    validate();
    dlg.onclose = () => { textarea.value = ''; state = { empty: true }; if (trigger && document.contains(trigger)) trigger.focus(); };
    dlg.showModal();
    textarea.focus();
  }

  // ---------------------------------------------------------------- keyboard
  function onKey(e) {
    if (e.key !== 'j' && e.key !== 'k' && e.key !== 'Enter') return false;
    const ids = Array.from(st.els.tbody.querySelectorAll('tr[data-id]')).map(tr => tr.dataset.id);
    if (!ids.length) return false;
    if (e.key === 'Enter') { if (st.cursor) { select(st.cursor, st.rows.get(st.cursor) && st.rows.get(st.cursor).tr); return true; } return false; }
    const i = ids.indexOf(st.cursor);
    const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === 'j' ? 1 : -1)))];
    st.cursor = next;
    render();
    const tr = st.rows.get(next).tr;
    tr.focus({ preventScroll: false });
    return true;
  }

  F.views.accounts = {
    title: 'Accounts',
    live: true,
    mount,
    actions() {
      return [
        F.btn('Reload from disk', { icon: 'reload', onclick: (e) => reload(e.currentTarget) }),
        F.btn('Add account', { kind: 'primary', icon: 'plus', onclick: (e) => openAdd(e.currentTarget) }),
      ];
    },
    show(route) {
      st.visible = true;
      if (st.els.filterInput) st.els.filterInput.value = st.query;
      render();
      if (route.sub) {
        st.selected = route.sub;
        st.cursor = route.sub;
        if (F.store.accounts) openInspector(route.sub);
        else {
          const off = F.on('accounts', () => { off(); if (st.visible && st.selected === route.sub) openInspector(route.sub); });
        }
        render();
      } else if (F.inspector.isOpen && F.inspector.owner === 'account') {
        F.inspector.close({ silent: true });
        st.selected = null;
        render();
      }
    },
    hide() { st.visible = false; if (F.inspector.owner === 'account') F.inspector.close({ silent: true }); st.selected = null; },
    onKey,
    get filterInput() { return st.els.filterInput; },
    // shared
    openAdd,
    reload,
    action,
    emptyPool,
  };
})();
