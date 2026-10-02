// FreeDeepseekAPI dashboard: Usage view (GET /admin/usage).
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;
  const WINDOWS = [{ value: '15m', label: '15m' }, { value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }];
  const METRICS = [{ value: 'tokens', label: 'Tokens' }, { value: 'requests', label: 'Requests' }, { value: 'usd', label: 'Cost' }];
  const REFRESH_MS = 15000;

  const st = {
    root: null, els: {}, visible: false,
    window: '1h', metric: 'tokens', account: '',
    data: null, error: null, missing: false, loading: false, timer: null, fetchedAt: null,
    modes: { tokens: 'chart', requests: 'chart', breakdown: 'chart' },
  };

  function mount(root) {
    st.root = root;
    const windowSeg = F.segmented('Window', WINDOWS, st.window, (v) => { st.window = v; syncHash(); load(); });
    const accountSlot = h('div', { class: 'account-filter' });
    const caveat = h('div', { class: 'caveat' });
    const status = h('div', { class: 'usage-status' });
    const readouts = h('div', { class: 'readouts', role: 'group', 'aria-label': 'Totals for this window' });
    const tokensHost = h('div', { class: 'chart-host' });
    const reqHost = h('div', { class: 'chart-host' });
    const breakdown = h('div', { class: 'breakdowns' });
    const lifetime = h('div');
    const metricSeg = F.segmented('Breakdown metric', METRICS, st.metric, (v) => { st.metric = v; renderBreakdowns(); });
    const body = h('div', { class: 'usage-body' },
      readouts,
      h('div', { class: 'rule' }),
      h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', { class: 'section-title', text: 'Tokens over time' }),
          h('div', { class: 'section-controls' }, h('ul', { class: 'legend', 'aria-label': 'Series' },
            h('li', null, h('span', { class: 'key key-data-2', 'aria-hidden': 'true' }), 'Prompt'),
            h('li', null, h('span', { class: 'key key-data-1', 'aria-hidden': 'true' }), 'Completion')), modeToggle('tokens'))),
        tokensHost),
      h('section', { class: 'section section-tight' },
        h('div', { class: 'section-head' }, h('h3', { class: 'section-title', text: 'Requests and errors' }),
          h('div', { class: 'section-controls' }, h('ul', { class: 'legend', 'aria-label': 'Series' },
            h('li', null, h('span', { class: 'key key-ink', 'aria-hidden': 'true' }), 'Requests'),
            h('li', null, F.lamp('error', 'key-x'), 'Errors')), modeToggle('requests'))),
        reqHost),
      h('div', { class: 'rule' }),
      h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h3', { class: 'section-title', text: 'Where it went' }), h('div', { class: 'section-controls' }, metricSeg, modeToggle('breakdown'))),
        breakdown),
      h('div', { class: 'rule' }),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h3', { class: 'section-title', text: 'Lifetime by account' })), lifetime));
    const hero = F.pageHero({ image: '/dashboard/media-aurora-arc.jpg', label: 'Usage', position: '50% 38%' });
    root.append(hero, h('div', { class: 'view-pad' },
      h('div', { class: 'filter-row' }, windowSeg, accountSlot),
      caveat, status, body));
    Object.assign(st.els, { hero, windowSeg, accountSlot, caveat, status, readouts, tokensHost, reqHost, breakdown, lifetime, body, metricSeg });
    F.on('accounts', () => { if (st.visible) renderAccountFilter(); });
  }

  function modeToggle(key) {
    return F.segmented('View as', [{ value: 'chart', icon: 'chart-view', ariaLabel: 'Chart' }, { value: 'table', icon: 'table-view', ariaLabel: 'Table' }], st.modes[key], (v) => {
      st.modes[key] = v;
      render();
    });
  }

  function syncHash() {
    F.replaceHash('usage', '', { w: st.window !== '1h' ? st.window : null, account: st.account || null });
  }

  async function load() {
    clearTimeout(st.timer);
    if (!st.visible) return;
    st.loading = true;
    st.els.body.classList.add('is-refetching');
    try {
      const data = await F.api('GET', `/admin/usage?window=${encodeURIComponent(st.window)}`);
      F.syncClock(data.now);
      st.data = data;
      st.error = null;
      st.missing = false;
      st.fetchedAt = Date.now();
    } catch (e) {
      if (!F.handleGate(e)) {
        if (e.status === 404 && e.type === 'not_found') st.missing = true;
        else st.error = e;
      }
    } finally {
      st.loading = false;
      st.els.body.classList.remove('is-refetching');
      render();
      if (st.visible && F.store.live) st.timer = setTimeout(load, REFRESH_MS);
    }
  }

  function renderAccountFilter() {
    const accounts = (F.store.accounts && F.store.accounts.accounts) || [];
    const opts = [{ value: '', label: 'All accounts' }].concat(accounts.map(a => ({ value: a.id, label: a.name || a.id })));
    if (st.account && !accounts.some(a => a.id === st.account)) opts.push({ value: st.account, label: `${st.account} (not loaded)` });
    const sel = F.select('Account', opts, st.account, (v) => { st.account = v; syncHash(); render(); });
    st.els.accountSlot.replaceChildren(sel);
  }

  const xLabelFor = (bucketMs) => (t, long) => {
    const d = new Date(t);
    const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (!long) return hm;
    const end = new Date(t + bucketMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${hm}–${end}`;
  };

  // Hero line: this window's totals from GET /admin/usage.
  function renderHero() {
    const hero = st.els.hero;
    if (st.missing) { hero.set('Usage unavailable.', 'This proxy has no GET /admin/usage.', 'crit'); return; }
    if (st.error && !st.data) { hero.set('Usage failed to load.', F.errorText(st.error), 'crit'); return; }
    const d = st.data;
    if (!d) { hero.set('Loading usage…'); return; }
    const t = d.totals;
    hero.set(`${fmt.int(t.requests)} request${t.requests === 1 ? '' : 's'} in the last ${d.window.key}.`,
      [`≈ ${fmt.compact(t.prompt_tokens + t.completion_tokens)} tokens`, `≈ ${fmt.usd(t.usd)} at API prices`, `${fmt.int(t.errors)} error${t.errors === 1 ? '' : 's'}`].join(' · '),
      t.requests && t.errors === t.requests ? 'crit' : null);
  }

  function render() {
    if (!st.root) return;
    const { caveat, status, readouts, tokensHost, reqHost, lifetime, body } = st.els;
    status.replaceChildren();
    renderHero();
    if (st.missing) {
      body.hidden = true;
      caveat.replaceChildren();
      status.append(F.endpointMissing('GET /admin/usage'));
      return;
    }
    if (st.error) status.append(F.notice('crit', 'Usage failed to load', F.errorText(st.error), [F.btn('Retry', { size: 'sm', onclick: () => load() })]));
    const d = st.data;
    if (!d) {
      body.hidden = false;
      readouts.replaceChildren(...['requests', 'tokens', 'prompt / completion', 'at API prices', 'errors'].map(l => h('div', { class: 'readout' }, h('span', { class: 'skel skel-lg', style: { '--w': '64px' } }), h('p', { class: 'readout-label', text: l }))));
      return;
    }
    body.hidden = false;
    const p = d.pricing || {};
    caveat.replaceChildren(
      h('p', null, `Tokens are estimates (≈ characters ÷ 4). Cost uses a flat $${p.input_per_m} / $${p.output_per_m} per 1M prompt / completion tokens for every model.`),
      h('p', null, `Charts cover ${fmt.dateTime(d.window.from)} to ${fmt.time(d.window.to)} in ${d.bucket.key} buckets; the server keeps 24 hours of buckets in memory. Lifetime totals cover everything since ${fmt.dateTime(d.lifetime.since)}.`));
    if (st.account) {
      caveat.append(h('p', { class: 'is-signal-text' }, `Showing ${st.account} highlighted. The time series and totals cover every account; the server breaks usage down per account only below. `,
        h('a', { href: F.hashFor('requests', '', { account: st.account }), text: `Open its requests` })));
    }

    const t = d.totals;
    const errRate = t.requests ? t.errors / t.requests : 0;
    if (!t.requests && !d.lifetime.requests) {
      readouts.replaceChildren();
      tokensHost.replaceChildren(F.emptyRequests(d.lifetime.since));
      reqHost.replaceChildren();
      st.els.breakdown.replaceChildren();
      lifetime.replaceChildren();
      return;
    }
    readouts.replaceChildren(
      readout(fmt.int(t.requests), 'requests'),
      readout(`${fmt.compact(t.prompt_tokens + t.completion_tokens)} ≈`, 'tokens'),
      readout(`${fmt.compact(t.prompt_tokens)} / ${fmt.compact(t.completion_tokens)} ≈`, 'prompt / completion'),
      readout(`${fmt.usd(t.usd)} ≈`, 'at API prices'),
      readout(t.requests ? fmt.pct(errRate) : '—', `errors (${fmt.int(t.errors)})`, t.errors ? 'crit' : null),
      readout(t.avg_ms ? fmt.ms(t.avg_ms) : '—', 'average latency'));

    const xLabel = xLabelFor(d.bucket.ms);
    const series = d.series || [];
    if (!t.requests) {
      tokensHost.replaceChildren(h('p', { class: 'quiet chart-empty', text: `No requests in the last ${d.window.key}. Pick a longer window.` }));
      reqHost.replaceChildren();
    } else {
      if (!(t.prompt_tokens + t.completion_tokens)) {
        tokensHost.replaceChildren(h('p', { class: 'quiet chart-empty', text: `${fmt.int(t.requests)} request${t.requests === 1 ? '' : 's'} in this window, none with tokens (rejected before reaching DeepSeek, or answered locally).` }));
      } else if (st.modes.tokens === 'chart') {
        F.charts.stackedTokens(tokensHost, series.map(b => ({ t: b.t, prompt: b.prompt_tokens, completion: b.completion_tokens })), {
          label: `Estimated tokens per ${d.bucket.key} over the last ${d.window.key}: ${fmt.compact(t.prompt_tokens)} prompt, ${fmt.compact(t.completion_tokens)} completion`, xLabel,
        });
      } else {
        tokensHost.replaceChildren(F.charts.table('Tokens over time', [
          { label: 'Bucket', get: b => xLabel(b.t, true) },
          { label: 'Prompt ≈', num: true, get: b => fmt.int(b.prompt_tokens) },
          { label: 'Completion ≈', num: true, get: b => fmt.int(b.completion_tokens) },
          { label: 'Reasoning ≈', num: true, get: b => fmt.int(b.reasoning_tokens) },
        ], series.filter(b => b.requests).reverse()));
      }
      if (st.modes.requests === 'chart') {
        F.charts.requestColumns(reqHost, series.map(b => ({ t: b.t, requests: b.requests, errors: b.errors })), {
          label: `Requests per ${d.bucket.key}: ${t.requests} total, ${t.errors} errors`, xLabel,
        });
      } else {
        reqHost.replaceChildren(F.charts.table('Requests and errors', [
          { label: 'Bucket', get: b => xLabel(b.t, true) },
          { label: 'Requests', num: true, get: b => fmt.int(b.requests) },
          { label: 'Errors', num: true, get: b => fmt.int(b.errors) },
          { label: 'Avg latency', num: true, get: b => (b.avg_ms ? fmt.ms(b.avg_ms) : '—') },
        ], series.filter(b => b.requests).reverse()));
      }
    }
    renderBreakdowns();

    const life = (d.lifetime.by_account || []).slice().sort((a, b) => (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
    lifetime.replaceChildren(life.length ? F.charts.table('Lifetime usage by account since server start', [
      { label: 'Account', get: r => accountLink(r.key) },
      { label: 'Requests', num: true, get: r => fmt.int(r.requests) },
      { label: 'Prompt ≈', num: true, get: r => fmt.compact(r.prompt_tokens) },
      { label: 'Completion ≈', num: true, get: r => fmt.compact(r.completion_tokens) },
      { label: 'Cost ≈', num: true, get: r => fmt.usd(r.usd) },
    ], life) : h('p', { class: 'quiet', text: 'No account has served a request since the server started.' }));
    for (const tr of lifetime.querySelectorAll('tbody tr')) {
      if (st.account && tr.firstChild.textContent === nameForId(st.account)) tr.classList.add('is-selected');
    }
  }

  function nameForId(id) {
    const a = F.accountById(id);
    return a ? (a.name || a.id) : id;
  }
  function accountLink(id) {
    if (!id) return h('span', { class: 'quiet', text: 'No account (rejected or local)' });
    return h('a', { href: `#/accounts/${encodeURIComponent(id)}`, text: nameForId(id) });
  }

  function metricValue(r) {
    if (st.metric === 'requests') return r.requests;
    if (st.metric === 'usd') return r.usd;
    return r.prompt_tokens + r.completion_tokens;
  }
  function metricText(v) {
    if (st.metric === 'requests') return fmt.int(v);
    if (st.metric === 'usd') return `${fmt.usd(v)}`;
    return fmt.compact(v);
  }

  function renderBreakdowns() {
    const d = st.data;
    const host = st.els.breakdown;
    if (!d || !d.totals.requests) { host.replaceChildren(); return; }
    const dims = [
      { key: 'by_account', title: 'By account', label: (k) => (k ? nameForId(k) : 'No account'), href: (k) => (k ? F.hashFor('requests', '', { account: k }) : F.hashFor('requests', '', { status: 'error' })), highlight: (k) => st.account && k === st.account },
      { key: 'by_model', title: 'By model', label: (k) => fmt.shortModel(k) || 'No model', href: (k) => (k ? F.hashFor('requests', '', { model: k }) : null), mono: true },
      { key: 'by_agent', title: 'By client', label: (k) => k || 'Unknown', href: (k) => (k && k !== '(other)' ? F.hashFor('requests', '', { client: k }) : null) },
      { key: 'by_endpoint', title: 'By endpoint', label: (k) => fmt.endpoint(k), href: (k) => apiHref(k) },
    ];
    const unit = st.metric === 'tokens' ? 'tokens ≈' : st.metric === 'usd' ? 'at API prices ≈' : 'requests';
    const plural = (n, one) => `${fmt.int(n)} ${one}${n === 1 ? '' : 's'}`;
    host.replaceChildren(...dims.map(dim => {
      const raw = d[dim.key] || [];
      // Colour follows the entity: slots go to the busiest entries by request count,
      // so switching Tokens / Requests / Cost never repaints a row.
      const slots = new Map(raw.slice().sort((a, b) => b.requests - a.requests || String(a.key).localeCompare(String(b.key)))
        .slice(0, F.charts.SHARE_SLOTS).map((r, i) => [r.key, i + 1]));
      const rows = raw.map(r => ({
        key: r.key,
        label: dim.label(r.key),
        title: r.key || '',
        value: metricValue(r),
        valueText: metricText(metricValue(r)),
        href: dim.href(r.key),
        highlight: dim.highlight ? dim.highlight(r.key) : false,
        slot: slots.get(r.key),
        tip: [plural(r.requests, 'request'), `${fmt.compact(r.prompt_tokens)} → ${fmt.compact(r.completion_tokens)} tokens ≈`, `${fmt.usd(r.usd)} ≈`, plural(r.errors, 'error')].join(' · '),
      })).sort((a, b) => b.value - a.value);
      const total = rows.reduce((a, r) => a + r.value, 0);
      const box = h('div', { class: 'breakdown' }, h('h4', { class: 'breakdown-title', text: dim.title.replace('By ', '').replace(/^./, c => c.toUpperCase()) }));
      const inner = h('div', { class: 'breakdown-body' });
      if (!rows.length) inner.append(h('p', { class: 'quiet', text: 'Nothing in this window.' }));
      else if (st.modes.breakdown === 'chart') F.charts.shareList(inner, rows, { label: `${dim.title}, ${unit}`, total, totalText: metricText(total), unit, fmtValue: metricText });
      else {
        inner.append(F.charts.table(dim.title, [
          { label: dim.title.replace('By ', '').replace(/^./, c => c.toUpperCase()), get: r => r.label },
          { label: 'Requests', num: true, get: r => fmt.int((d[dim.key].find(x => x.key === r.key) || {}).requests) },
          { label: 'Tokens ≈', num: true, get: r => { const x = d[dim.key].find(y => y.key === r.key) || {}; return fmt.compact((x.prompt_tokens || 0) + (x.completion_tokens || 0)); } },
          { label: 'Errors', num: true, get: r => fmt.int((d[dim.key].find(x => x.key === r.key) || {}).errors) },
        ], rows));
      }
      box.append(inner);
      return box;
    }));
  }

  function apiHref(path) {
    const api = { '/v1/chat/completions': 'openai', '/v1/messages': 'anthropic', '/v1/responses': 'responses' }[path];
    return api ? F.hashFor('requests', '', { api }) : null;
  }

  function readout(value, label, tone) {
    return h('div', { class: 'readout' }, h('p', { class: ['readout-value', tone && `is-${tone}`], text: value }), h('p', { class: 'readout-label', text: label }));
  }

  F.views.usage = {
    title: 'Usage',
    live: true,
    mount,
    show(route) {
      st.visible = true;
      const w = route.params.w;
      st.window = WINDOWS.some(o => o.value === w) ? w : (st.window || '1h');
      st.account = route.params.account || '';
      st.els.windowSeg.set(st.window);
      renderAccountFilter();
      render();
      load();
    },
    hide() { st.visible = false; clearTimeout(st.timer); F.charts.hideTip(); },
    updatedAt: () => st.fetchedAt,
  };
})();
