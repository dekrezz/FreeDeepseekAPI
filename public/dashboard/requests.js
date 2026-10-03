// FreeDeepseekAPI dashboard: Requests view (live request log + row inspector).
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;

  const st = {
    root: null, els: {}, visible: false,
    f: { status: '', account: '', model: '', api: '', client: '' },
    rowEls: new Map(),   // id -> tr
    shownIds: new Set(), // ids currently rendered (to flash only new ones)
    queued: 0,
    held: null,          // ids list rendered while the reader is scrolled down
    selected: null,
    cursor: null,
    firstRender: true,
  };

  const API_OPTIONS = [{ value: '', label: 'All endpoints' }, { value: 'openai', label: 'OpenAI chat' }, { value: 'anthropic', label: 'Anthropic messages' }, { value: 'responses', label: 'Responses' }];

  function mount(root) {
    st.root = root;
    const statusSeg = F.segmented('Status', [{ value: '', label: 'All' }, { value: 'error', label: 'Errors' }], st.f.status, (v) => { st.f.status = v; changed(); });
    const selects = h('div', { class: 'filter-selects' });
    const client = h('input', { type: 'search', class: 'input input-search', placeholder: 'Client', 'aria-label': 'Filter by client', 'data-view-filter': '', spellcheck: 'false' });
    client.addEventListener('input', () => { st.f.client = client.value.trim(); changed(); });
    const notice = h('div', { class: 'view-banner' });
    const table = h('table', { class: 'data-table requests-table rows-clickable' });
    table.append(h('caption', { class: 'sr-only', text: 'Recent requests, newest first' }));
    table.append(h('thead', null, h('tr', null,
      h('th', { scope: 'col', text: 'Time' }), h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Endpoint' }),
      h('th', { scope: 'col', text: 'Model' }), h('th', { scope: 'col', text: 'Account' }), h('th', { scope: 'col', text: 'Client' }),
      h('th', { scope: 'col', class: 'num', text: 'In ≈' }), h('th', { scope: 'col', class: 'num', text: 'Out ≈' }), h('th', { scope: 'col', class: 'num', text: 'Latency' }))));
    const tbody = h('tbody');
    table.append(tbody);
    const empty = h('div');
    const foot = h('p', { class: 'meta table-note' });
    const pill = h('button', { type: 'button', class: 'new-pill glass glass-regular', hidden: true });
    pill.addEventListener('click', () => {
      document.getElementById('scroll').scrollTo({ top: 0, behavior: F.reducedMotion() ? 'auto' : 'smooth' });
      st.held = null;
      render();
    });
    const hero = F.pageHero({ image: '/dashboard/media-airglow-cities.jpg', label: 'Request log', position: '40% 30%' });
    root.append(hero, h('div', { class: 'view-pad' },
      h('div', { class: 'filter-row' }, statusSeg, selects, h('label', { class: 'search-field search-field-inline' }, F.icon('search'), client)),
      notice,
      h('div', { class: 'table-scroll' }, table),
      empty, foot),
      pill);
    Object.assign(st.els, { hero, statusSeg, selects, client, notice, table, tbody, empty, foot, pill });

    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || e.target.closest('a, button')) return;
      select(Number(tr.dataset.id), tr);
    });
    tbody.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && e.key === 'Enter' && e.target === tr) select(Number(tr.dataset.id), tr);
    });
    document.getElementById('scroll').addEventListener('scroll', () => {
      if (!st.visible) return;
      if (document.getElementById('scroll').scrollTop <= 80 && st.held) { st.held = null; render(); }
    }, { passive: true });

    F.on('requests', () => { if (st.visible) render(); });
    F.on('accounts', () => { if (st.visible) renderSelects(); });
    F.on('tick', () => { if (st.visible) for (const el of st.root.querySelectorAll('[data-ago]')) el.textContent = fmt.ago(Number(el.dataset.ago)); });
  }

  function changed() {
    syncHash();
    st.held = null;
    render();
  }

  function syncHash() {
    F.replaceHash('requests', '', { status: st.f.status, account: st.f.account, model: st.f.model, api: st.f.api, client: st.f.client, id: st.selected });
  }

  function matches(r) {
    const f = st.f;
    if (f.status === 'error' && r.ok) return false;
    if (f.status === 'ok' && !r.ok) return false;
    if (/^\d{3}$/.test(f.status) && String(r.status) !== f.status) return false;
    if (f.account && r.account !== f.account) return false;
    if (f.model && r.model !== f.model) return false;
    if (f.api && r.api !== f.api) return false;
    if (f.client && !(r.agent || '').toLowerCase().includes(f.client.toLowerCase())) return false;
    return true;
  }

  function renderSelects() {
    const rows = F.store.requests;
    const uniq = (key) => Array.from(new Set(rows.map(r => r[key]).filter(Boolean))).sort();
    const accounts = new Set(uniq('account'));
    for (const a of (F.store.accounts && F.store.accounts.accounts) || []) accounts.add(a.id);
    if (st.f.account) accounts.add(st.f.account);
    const models = new Set(uniq('model'));
    if (st.f.model) models.add(st.f.model);
    const key = JSON.stringify([Array.from(accounts), Array.from(models), st.f.account, st.f.model, st.f.api]);
    if (st.els.selects._key === key) return;
    st.els.selects._key = key;
    st.els.selects.replaceChildren(
      F.select('Account', [{ value: '', label: 'All accounts' }].concat(Array.from(accounts).sort().map(a => ({ value: a, label: (F.accountById(a) && F.accountById(a).name) || a }))), st.f.account, (v) => { st.f.account = v; changed(); }),
      F.select('Model', [{ value: '', label: 'All models' }].concat(Array.from(models).sort().map(m => ({ value: m, label: fmt.shortModel(m) }))), st.f.model, (v) => { st.f.model = v; changed(); }),
      F.select('Endpoint', API_OPTIONS, st.f.api, (v) => { st.f.api = v; changed(); }));
  }

  function rowEl(r) {
    let tr = st.rowEls.get(r.id);
    if (tr) return tr;
    const local = r.local ? F.icon('local', 'icon-sm') : null;
    const stream = r.stream ? F.icon('stream', 'icon-sm') : null;
    const acc = r.account ? (F.accountById(r.account) ? F.accountById(r.account).name || r.account : r.account) : '—';
    tr = h('tr', { 'data-id': String(r.id), tabindex: '-1', class: r.ok ? null : 'is-error' },
      h('td', { class: 'num-left', title: fmt.dateTime(r.ts), text: fmt.time(r.ts) }),
      h('td', null, h('span', { class: ['status-code', r.ok ? 'is-ok' : 'is-crit'] }, F.lamp(r.ok ? 'ready' : 'error'), String(r.status))),
      h('td', { class: 'cell-endpoint' }, h('span', { text: fmt.api(r.api) || fmt.endpoint(r.path) }),
        stream ? h('span', { class: 'glyph', 'data-tip': 'Streamed', 'aria-label': 'streamed' }, stream) : null,
        local ? h('span', { class: 'glyph', 'data-tip': 'Answered locally, no DeepSeek call', 'aria-label': 'answered locally' }, local) : null),
      h('td', { class: 'mono-id', title: r.model || '', text: r.model ? fmt.shortModel(r.model) : '—' }),
      h('td', { class: 'cell-trunc', title: r.account || '', text: acc }),
      h('td', { class: 'cell-trunc mono-id', title: r.agent || '', text: r.agent || '—' }),
      h('td', { class: 'num', text: r.prompt_tokens ? fmt.compact(r.prompt_tokens) : '—' }),
      h('td', { class: 'num', text: r.completion_tokens ? fmt.compact(r.completion_tokens) : '—' }),
      h('td', { class: 'num', text: fmt.ms(r.ms) }));
    st.rowEls.set(r.id, tr);
    return tr;
  }

  function errRowEl(r) {
    const key = `e${r.id}`;
    let tr = st.rowEls.get(key);
    if (tr) return tr;
    tr = h('tr', { class: 'err-line', 'data-for': String(r.id) },
      h('td'), h('td', { colspan: '8' }, h('span', { class: 'mono-id', text: r.error_type || 'error' }), r.error_message ? h('span', { class: 'err-msg', text: ` ${r.error_message}` }) : null));
    tr.addEventListener('click', () => select(r.id, st.rowEls.get(r.id)));
    st.rowEls.set(key, tr);
    return tr;
  }

  // Hero line: the in-memory request log from GET /admin/requests.
  function renderHero() {
    const hero = st.els.hero;
    if (F.store.requestsMissing) { hero.set('Request log unavailable.', 'This proxy has no GET /admin/requests.', 'crit'); return; }
    if (!F.store.firstLoadDone) { hero.set('Loading requests…'); return; }
    const all = F.store.requests;
    if (!all.length) { hero.set('No requests yet.', 'Point a client at this proxy and requests show up here.'); return; }
    const failed = all.filter(r => !r.ok).length;
    const newest = all.reduce((m, r) => Math.max(m, r.ts || 0), 0);
    hero.set(`${fmt.int(all.length)} request${all.length === 1 ? '' : 's'} in the log.`,
      [failed ? `${fmt.int(failed)} failed` : 'none failed', newest ? `newest at ${fmt.hm(newest)}` : null].filter(Boolean).join(' · '));
  }

  function render() {
    if (!st.root || !st.visible) return;
    const { tbody, empty, foot, notice, pill, table } = st.els;
    renderSelects();
    renderHero();
    notice.replaceChildren();
    if (F.store.requestsMissing) {
      table.hidden = true;
      foot.textContent = '';
      empty.replaceChildren(F.endpointMissing('GET /admin/requests'));
      return;
    }
    if (F.store.requestsError) notice.append(F.notice('warn', 'The request log failed to refresh', F.errorText(F.store.requestsError)));
    if (!F.store.firstLoadDone) {
      if (!tbody.querySelector('.skel-row')) tbody.replaceChildren(...[40, 60, 30, 50].map(w => h('tr', { class: 'skel-row' }, Array.from({ length: 9 }, (_, i) => h('td', null, h('span', { class: 'skel', style: { '--w': `${(w + i * 17) % 60 + 25}%` } }))))));
      return;
    }
    const all = F.store.requests;
    let list = all.filter(matches);

    // Reader scrolled down: hold the list and queue new rows behind the pill.
    const scroller = document.getElementById('scroll');
    if (!st.firstRender && scroller.scrollTop > 80 && !st.held) st.held = new Set(st.shownIds);
    if (st.held) {
      const fresh = list.filter(r => !st.held.has(r.id));
      list = list.filter(r => st.held.has(r.id));
      st.queued = fresh.length;
    } else st.queued = 0;
    pill.hidden = !st.queued;
    pill.textContent = `${st.queued} new · Show`;

    table.hidden = !all.length;
    if (!all.length) {
      empty.replaceChildren(F.emptyRequests());
      foot.textContent = '';
      tbody.replaceChildren();
      return;
    }
    empty.replaceChildren(list.length ? '' : h('p', { class: 'quiet', text: 'No request in the log matches these filters.' }));

    const nodes = [];
    const nextShown = new Set();
    for (const r of list) {
      const tr = rowEl(r);
      tr.classList.toggle('is-selected', st.selected === r.id);
      tr.classList.toggle('is-cursor', st.cursor === r.id);
      if (!st.firstRender && !st.shownIds.has(r.id) && !tr._flashed) {
        tr._flashed = true;
        tr.classList.add('is-new');
        setTimeout(() => tr.classList.remove('is-new'), 1300);
      }
      nodes.push(tr);
      if (!r.ok) nodes.push(errRowEl(r));
      nextShown.add(r.id);
    }
    // In-place reconcile keeps scroll and focus stable.
    nodes.forEach((n, i) => { if (tbody.children[i] !== n) tbody.insertBefore(n, tbody.children[i] || null); });
    while (tbody.children.length > nodes.length) tbody.lastChild.remove();
    st.shownIds = nextShown;
    st.firstRender = false;
    // drop cached rows that left the server buffer
    const alive = new Set(all.map(r => r.id));
    for (const k of Array.from(st.rowEls.keys())) {
      const id = typeof k === 'string' ? Number(k.slice(1)) : k;
      if (!alive.has(id)) st.rowEls.delete(k);
    }
    const meta = F.store.requestsMeta;
    foot.textContent = meta ? `Showing ${fmt.int(list.length)} of ${fmt.int(all.length)} kept in memory${meta.oldest_ts ? ` (oldest ${fmt.time(meta.oldest_ts)})` : ''}. The server keeps the last ${meta.capacity}; 503 overload rejections, oversized bodies and 404s are not logged. Tokens are estimates.` : '';
    if (st.selected != null && !F.inspector.isOpen) openInspector(st.selected);
  }

  function select(id, tr) {
    st.selected = id;
    st.cursor = id;
    syncHash();
    openInspector(id, tr);
    render();
  }

  function openInspector(id, returnFocus) {
    const r = F.store.requests.find(x => x.id === id);
    if (!r) {
      if (F.store.firstLoadDone) {
        F.toast(`Request ${id} is no longer in the log. The server keeps the last ${F.REQUEST_CAPACITY}.`, { tone: 'warn' });
        st.selected = null;
        syncHash();
      }
      return;
    }
    const title = [F.lamp(r.ok ? 'ready' : 'error', 'lamp-lg'), h('span', { text: `${r.status} ${fmt.api(r.api) || fmt.endpoint(r.path)}` })];
    const sub = [h('span', { text: fmt.dateTime(r.ts) }), h('code', { class: 'mono-id', text: `#${r.id}` })];
    const body = h('div', { class: 'insp' });
    if (!r.ok) {
      body.append(h('section', { class: 'insp-section' }, h('h3', { class: 'insp-h', text: 'Error' }),
        h('div', { class: 'inline-error-block' }, h('p', { class: 'mono-id', text: r.error_type || 'error' }), h('p', { class: 'selectable', text: r.error_message || '(no message)' }))));
    }
    const field = (label, value, mono, copy) => h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: label }),
      h('span', { class: ['fact-value', mono && 'mono-id'] }, value == null || value === '' ? '—' : String(value)), copy && value != null && value !== '' ? F.copyBtn(String(value), `Copy ${label.toLowerCase()}`) : null);
    body.append(h('section', { class: 'insp-section' }, h('h3', { class: 'insp-h', text: 'Route' }), h('ul', { class: 'facts' },
      field('Path', r.path, true, true),
      field('Model', r.model, true, true),
      field('Account', r.account, true, true),
      field('Client', r.agent, true, true),
      field('IP', r.ip, true, true),
      field('Streamed', r.stream == null ? null : r.stream ? 'yes' : 'no'),
      field('Answered locally', r.local ? 'yes, no DeepSeek call' : 'no'))));
    body.append(h('section', { class: 'insp-section' }, h('h3', { class: 'insp-h', text: 'Cost and time' }), h('ul', { class: 'facts' },
      field('Latency', fmt.ms(r.ms)),
      field('Prompt tokens ≈', fmt.int(r.prompt_tokens)),
      field('Completion tokens ≈', fmt.int(r.completion_tokens)),
      field('Reasoning tokens ≈', `${fmt.int(r.reasoning_tokens)} (part of completion)`),
      field('Cost ≈', fmt.usd(r.usd)),
      field('Started', fmt.dateTime(r.ts)))));
    const links = h('div', { class: 'insp-links' });
    if (r.agent && r.agent.startsWith('dashboard:')) links.append(h('a', { class: 'btn btn-secondary btn-sm', href: `#/chat/${encodeURIComponent(r.agent.slice('dashboard:'.length))}` }, F.icon('chat'), h('span', { class: 'btn-label', text: 'Open conversation' })));
    if (r.account) links.append(h('a', { class: 'btn btn-secondary btn-sm', href: `#/accounts/${encodeURIComponent(r.account)}` }, F.icon('accounts'), h('span', { class: 'btn-label', text: 'Open account' })));
    if (r.agent) links.append(h('a', { class: 'link', href: F.hashFor('requests', '', { client: r.agent }), text: 'Only this client' }));
    body.append(links);
    body.append(h('p', { class: 'meta', text: 'The log keeps metadata only. Prompts and answers are never stored or shown here.' }));
    F.inspector.open({
      title, sub, body, owner: 'request', returnFocus: returnFocus || null,
      onClose: () => { st.selected = null; if (st.visible) { syncHash(); render(); } },
    });
  }

  function onKey(e) {
    if (e.key !== 'j' && e.key !== 'k' && e.key !== 'Enter') return false;
    const ids = Array.from(st.els.tbody.querySelectorAll('tr[data-id]')).map(tr => Number(tr.dataset.id));
    if (!ids.length) return false;
    if (e.key === 'Enter') { if (st.cursor != null) { select(st.cursor, st.rowEls.get(st.cursor)); return true; } return false; }
    const i = ids.indexOf(st.cursor);
    st.cursor = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === 'j' ? 1 : -1)))];
    render();
    st.rowEls.get(st.cursor).focus();
    return true;
  }

  F.views.requests = {
    title: 'Requests',
    live: true,
    mount,
    show(route) {
      st.visible = true;
      const p = route.params;
      st.f = { status: p.status || '', account: p.account || '', model: p.model || '', api: p.api || '', client: p.client || '' };
      st.els.statusSeg.set(st.f.status === 'error' ? 'error' : '');
      st.els.client.value = st.f.client;
      st.els.selects._key = null;
      st.held = null;
      st.firstRender = true;
      const id = p.id ? Number(p.id) : null;
      st.selected = Number.isFinite(id) ? id : null;
      st.cursor = st.selected;
      if (st.selected == null && F.inspector.owner === 'request') F.inspector.close({ silent: true });
      render();
      if (st.selected != null && F.store.firstLoadDone) {
        openInspector(st.selected);
        const tr = st.rowEls.get(st.selected);
        if (tr) tr.scrollIntoView({ block: 'center' });
      }
    },
    hide() { st.visible = false; st.held = null; if (F.inspector.owner === 'request') F.inspector.close({ silent: true }); },
    onKey,
    get filterInput() { return st.els.client; },
  };
})();
