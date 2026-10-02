// FreeDeepseekAPI dashboard: Status view (the track diagram).
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;
  const WINDOWS = { '15m': 900000, '1h': 3600000, '6h': 21600000 };

  const st = {
    root: null,
    els: {},
    windowKey: localStorage.getItem('fdsa.status.window') || '15m',
    mode: 'diagram',
    visible: false,
  };
  if (!WINDOWS[st.windowKey]) st.windowKey = '15m';

  function mount(root) {
    st.root = root;
    const sentence = h('h2', { class: 'status-sentence' });
    const windowSeg = F.segmented('Time window', [{ value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '6h', label: '6h' }], st.windowKey, (v) => {
      st.windowKey = v;
      try { localStorage.setItem('fdsa.status.window', v); } catch (e) { /* preference only */ }
      render();
    });
    const modeSeg = F.segmented('Traffic view', [{ value: 'diagram', icon: 'chart-view', ariaLabel: 'Diagram' }, { value: 'table', icon: 'table-view', ariaLabel: 'Table' }], st.mode, (v) => { st.mode = v; render(); });
    const lanes = h('div', { class: 'lanes-host' });
    const twin = h('div', { class: 'lanes-twin', hidden: true });
    const trafficNote = h('div', { class: 'traffic-note' });
    const readouts = h('div', { class: 'readouts', role: 'group', 'aria-label': 'Traffic in this window' });
    const errorsHead = h('div', { class: 'section-head' }, h('h3', { class: 'section-title', text: 'Recent errors' }), h('a', { class: 'link-quiet', href: '#/requests?status=error', text: 'Open Requests' }));
    const errors = h('div', { class: 'recent-errors' });
    const emptyPool = h('div', { class: 'empty-pool', hidden: true });

    lanes.addEventListener('pointerenter', () => { lanes._hold = true; });
    lanes.addEventListener('pointerleave', () => { lanes._hold = false; });
    lanes.addEventListener('focusin', () => { lanes._hold = true; });
    lanes.addEventListener('focusout', () => { lanes._hold = false; });

    root.append(
      hero(h('header', { class: 'status-head' }, sentence)),
      h('div', { class: 'view-pad' },
        emptyPool,
        h('section', { class: 'section', 'aria-labelledby': 'traffic-h' },
          h('div', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'traffic-h', text: 'Traffic' }), h('div', { class: 'section-controls' }, windowSeg, modeSeg)),
          trafficNote, lanes, twin),
        h('div', { class: 'rule' }),
        readouts,
        h('div', { class: 'rule' }),
        h('section', { class: 'section' }, errorsHead, errors)));
    Object.assign(st.els, { sentence, lanes, twin, trafficNote, readouts, errors, emptyPool, windowSeg, modeSeg });

    F.on('accounts', () => { if (st.visible) render(); });
    F.on('requests', () => { if (st.visible) render(); });
    F.on('tick', () => { if (st.visible) tick(); });
  }

  // Full-bleed launch footage behind the pool sentence. Muted, looped, and only playing
  // while Status is on screen and the reader has not asked for reduced motion.
  function hero(content) {
    const video = document.createElement('video');
    video.className = 'hero-media';
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = '/dashboard/media-liftoff.jpg';
    video.setAttribute('aria-hidden', 'true');
    video.src = '/dashboard/media-liftoff.mp4';
    st.els.video = video;
    return h('section', { class: 'hero', 'aria-label': 'Account pool' },
      video,
      h('div', { class: 'hero-inner' }, content));
  }
  function playHero() {
    const v = st.els.video;
    if (!v) return;
    // Autoplay can be refused (power saving, browser policy); the poster stays, which is fine.
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }

  function rowsInWindow(now) {
    const t0 = now - WINDOWS[st.windowKey];
    return F.store.requests.filter(r => r.ts >= t0 || r.ts + (r.ms || 0) >= t0);
  }

  function sentenceParts() {
    const data = F.store.accounts;
    if (!data) return { text: F.store.error ? 'Account pool unavailable.' : 'Loading accounts…', tone: F.store.error ? 'crit' : null };
    const { pool, accounts } = data;
    if (!pool.total) return { text: 'No accounts are loaded.', tone: null, empty: true };
    if (pool.can_serve === 0) {
      const next = pool.next_ready_at ? (pool.next_ready_at - F.now()) / 1000 : null;
      return { text: next != null && next > 0 ? `No account can serve. The next one is ready in ${fmt.clock(next)}.` : 'No account can serve.', tone: 'crit' };
    }
    let text = pool.can_serve === pool.total ? `All ${pool.total} accounts can serve.` : `${pool.can_serve} of ${pool.total} accounts can serve.`;
    if (pool.total === 1 && pool.can_serve === 1) text = 'The only account can serve.';
    const cooling = accounts.filter(a => a.cooldown_until && a.cooldown_until > F.now()).sort((a, b) => a.cooldown_until - b.cooldown_until)[0];
    if (cooling) text += ` ${cooling.name || cooling.id} cools down for ${fmt.clock((cooling.cooldown_until - F.now()) / 1000)} more.`;
    return { text, tone: null };
  }

  function tick() {
    const p = sentenceParts();
    st.els.sentence.replaceChildren(p.tone === 'crit' ? F.icon('alert', 'sentence-icon') : '', p.text);
    st.els.sentence.classList.toggle('is-crit', p.tone === 'crit');
    // Lanes step once per second for busy and cooldown projections, unless the
    // reader is pointing at or focused in the plot.
    if (st.mode === 'diagram' && F.store.accounts && !st.els.lanes._hold && !st.els.lanes.hidden) drawLanes();
  }

  function drawLanes() {
    const data = F.store.accounts;
    const now = F.now();
    const rows = F.store.requestsMissing ? [] : rowsInWindow(now);
    const errs = rows.filter(r => !r.ok).length;
    const cooling = data.accounts.filter(a => a.status === 'cooldown').map(a => a.name || a.id);
    const label = `${data.accounts.length} lanes, ${rows.length} requests in the last ${st.windowKey}, ${errs} errors${cooling.length ? `, ${cooling.join(', ')} in cooldown` : ''}`;
    const opts = {
      accounts: data.accounts, rows, windowMs: WINDOWS[st.windowKey], now, label,
      labelHref: (a) => `#/accounts/${encodeURIComponent(a.id)}`,
      onPick: (r) => F.navigate('requests', '', { id: r.id }),
    };
    if (!st.els.lanes._drawn) { F.charts.lanes(st.els.lanes, opts); st.els.lanes._drawn = true; }
    else F.charts.redrawLanes(st.els.lanes, opts);
  }

  function render() {
    if (!st.root) return;
    tick();
    const data = F.store.accounts;
    const { lanes, twin, trafficNote, readouts, errors, emptyPool } = st.els;

    // loading skeleton in real geometry
    if (!data) {
      lanes.hidden = false;
      twin.hidden = true;
      if (!lanes.querySelector('.lanes-skeleton')) {
        lanes._drawn = false;
        lanes.replaceChildren(h('div', { class: 'lanes-skeleton' }, [0, 1, 2].map(() => h('div', { class: 'lane-skel' }, h('span', { class: 'skel', style: { '--w': '60%' } }), h('span', { class: 'skel-track' }))), h('p', { class: 'meta', text: F.store.error ? F.errorText(F.store.error) : 'Loading traffic…' })));
      }
      readouts.replaceChildren();
      errors.replaceChildren();
      return;
    }

    const empty = !data.pool.total;
    emptyPool.hidden = !empty;
    if (empty) {
      emptyPool.replaceChildren(F.views.accounts.emptyPool());
    }

    trafficNote.replaceChildren();
    if (F.store.requestsMissing) {
      trafficNote.append(F.notice('info', null, 'Traffic history needs GET /admin/requests. This server build doesn\'t expose it.'));
    } else if (F.store.requestsError) {
      trafficNote.append(F.notice('warn', 'Traffic history failed to load', F.errorText(F.store.requestsError)));
    }

    const now = F.now();
    const rows = F.store.requestsMissing ? [] : rowsInWindow(now);
    lanes.hidden = st.mode !== 'diagram' || empty;
    twin.hidden = st.mode !== 'table' || empty;
    if (!empty) {
      if (st.mode === 'diagram') { if (!lanes._hold) drawLanes(); }
      else twin.replaceChildren(laneTable(data.accounts, rows));
    }

    // coverage caveat: the request buffer keeps 400 rows
    const meta = F.store.requestsMeta;
    const t0 = now - WINDOWS[st.windowKey];
    const partial = meta && meta.total >= meta.capacity && meta.oldest_ts > t0;
    // readouts
    const ok = rows.filter(r => r.ok);
    const tokens = rows.reduce((a, r) => a + (r.prompt_tokens || 0) + (r.completion_tokens || 0), 0);
    const lat = ok.map(r => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
    const p50 = lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null;
    const errCount = rows.length - ok.length;
    readouts.replaceChildren(
      readout(fmt.int(rows.length), 'requests'),
      readout(`${fmt.compact(tokens)} ≈`, 'tokens'),
      readout(fmt.int(errCount), errCount === 1 ? 'error' : 'errors', errCount ? 'crit' : null),
      readout(p50 != null ? fmt.ms(p50) : '—', 'p50 latency, successful'),
    );
    if (partial) readouts.append(h('p', { class: 'meta readouts-note', text: `Covers the last ${meta.capacity} requests, since ${fmt.hm(meta.oldest_ts)}.` }));
    readouts.hidden = F.store.requestsMissing;

    // recent errors
    const errRows = rows.filter(r => !r.ok).slice(0, 8);
    errors.closest('.section').querySelector('.section-title').textContent = errRows.length ? `Recent errors (${rows.length - ok.length})` : 'Recent errors';
    if (F.store.requestsMissing) errors.replaceChildren(h('p', { class: 'meta', text: 'Needs GET /admin/requests.' }));
    else if (!errRows.length) errors.replaceChildren(h('p', { class: 'quiet', text: `No errors in the last ${st.windowKey}.` }));
    else errors.replaceChildren(errorTable(errRows));
  }

  function readout(value, label, tone) {
    return h('div', { class: 'readout' }, h('p', { class: ['readout-value', tone && `is-${tone}`], text: value }), h('p', { class: 'readout-label', text: label }));
  }

  function laneTable(accounts, rows) {
    const per = new Map(accounts.map(a => [a.id, { n: 0, err: 0, last: null }]));
    for (const r of rows) {
      const p = per.get(r.account);
      if (!p) continue;
      p.n++;
      if (!r.ok) p.err++;
      if (!p.last || r.ts > p.last) p.last = r.ts;
    }
    return F.charts.table('Traffic per account', [
      { label: 'Account', get: a => a.name || a.id },
      { label: 'State', get: a => stateText(a) },
      { label: 'Requests', num: true, get: a => fmt.int(per.get(a.id).n) },
      { label: 'Errors', num: true, get: a => fmt.int(per.get(a.id).err) },
      { label: 'Last request', get: a => (per.get(a.id).last ? fmt.time(per.get(a.id).last) : '—') },
    ], accounts);
  }

  function stateText(a) {
    if (a.status === 'busy') return `Busy ${fmt.clock((F.now() - (a.busy_since || F.now())) / 1000)}${a.busy_agent ? ` · ${a.busy_agent}` : ''}`;
    if (a.status === 'cooldown') return `Cooldown ${fmt.clock(F.cooldownLeft(a))} (${fmt.cooldownReason(a.cooldown_reason)})`;
    if (a.status === 'disabled') return a.disabled_by === 'file' ? 'Disabled in file' : 'Paused by admin';
    if (a.status === 'no_credentials') return 'No credentials';
    return 'Ready';
  }

  function errorTable(rows) {
    const table = h('table', { class: 'data-table rows-clickable' });
    table.append(h('caption', { class: 'sr-only', text: 'Recent errors' }));
    table.append(h('thead', null, h('tr', null,
      h('th', { scope: 'col', text: 'Time' }), h('th', { scope: 'col', text: 'Account' }), h('th', { scope: 'col', text: 'Model' }),
      h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Error' }))));
    const body = h('tbody');
    for (const r of rows) {
      const tr = h('tr', { tabindex: '0', 'aria-label': `Open request ${r.id}` },
        h('td', { class: 'num-left', text: fmt.time(r.ts) }),
        h('td', { text: r.account || '—' }),
        h('td', { class: 'mono-id', title: r.model || '', text: fmt.shortModel(r.model) }),
        h('td', null, h('span', { class: 'status-code is-crit' }, F.lamp('error'), String(r.status))),
        h('td', { class: 'err-cell' }, h('span', { class: 'mono-id', text: r.error_type || 'error' }), r.error_message ? h('span', { class: 'err-msg', text: r.error_message }) : null));
      const open = () => F.navigate('requests', '', { id: r.id });
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      body.append(tr);
    }
    table.append(body);
    return h('div', { class: 'table-scroll' }, table);
  }

  F.views.status = {
    title: 'Status',
    live: true,
    mount,
    show() { st.visible = true; render(); if (!F.reducedMotion()) playHero(); },
    hide() { st.visible = false; F.charts.hideTip(); if (st.els.video) st.els.video.pause(); },
    filterInput: null,
  };
})();
