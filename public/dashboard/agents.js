// FreeDeepseekAPI dashboard: Agents view.
// Overview: every coding agent with the path its requests take (agent → the file it reads →
// proxy address → model). Detail: that path drawn large, the agent's options, a preview of what
// applying writes, and the config files themselves as the server shows them (secrets masked).
// Nothing here edits file text: the browser only sends options, the server writes the files.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;

  // Fixed order and marks. Hue feeds the same oklch formula as account avatars; the square
  // shape keeps an agent from ever reading as an account (circles).
  const AGENTS = [
    { id: 'claude-code', name: 'Claude Code', mono: 'CC', hue: 32 },
    { id: 'codex', name: 'Codex', mono: 'CX', hue: 255 },
    { id: 'opencode', name: 'OpenCode', mono: 'OC', hue: 160 },
    { id: 'hermes', name: 'Hermes', mono: 'HE', hue: 300 },
    { id: 'openclaw', name: 'OpenClaw', mono: 'OW', hue: 12 },
    { id: 'cursor', name: 'Cursor', mono: 'CU', hue: 210 },
  ];
  const META = Object.fromEntries(AGENTS.map(a => [a.id, a]));
  const STATES = {
    default: { label: 'Default', tone: 'ok', lamp: 'ready' },
    alongside: { label: 'Alongside', tone: 'signal', lamp: 'busy' },
    none: { label: 'Not set up', tone: 'off', lamp: 'disabled' },
    outdated: { label: 'Needs update', tone: 'warn', lamp: 'cooldown' },
    unreadable: { label: 'Can\'t read file', tone: 'crit', lamp: 'error' },
    manual: { label: 'Set up by hand', tone: 'off', lamp: 'disabled' },
  };
  const ROLES = { native: 'Native config', profile: 'Profile', catalog: 'Model catalog', guidance: 'Guidance', snippet: 'Generated' };
  const SHOWS = [
    { value: 'disk', label: 'On disk' },
    { value: 'after', label: 'After apply' },
    { value: 'diff', label: 'Changes' },
  ];
  const SHOW_LABEL = { disk: 'on disk', after: 'after apply', diff: 'changes' };
  const BACKUPS_SHOWN = 8;
  const PLAN_DEBOUNCE_MS = 250;
  const HERO_IMAGE = '/dashboard/media-milky-way.jpg';

  const st = {
    root: null,
    els: {},
    visible: false,
    data: null,          // GET /admin/agents
    error: null,         // ApiError of the last failed GET /admin/agents
    loading: false,
    loadSeq: 0,
    backups: null,       // GET /admin/agents/backups → backups[]
    backupsError: null,
    showAllBackups: false,
    cursor: null,        // j/k row on the overview
    wrap: false,         // file viewer soft wrap, kept across files
    d: null,             // detail page state, null on the overview
    lastApplied: null,   // agent id whose path plays the fill once
    overviewScroll: 0,   // where the list was before opening an agent
    scrollTo: null,      // 'backups' after #/agents?section=backups
  };

  // ---------------------------------------------------------------- helpers
  const enc = encodeURIComponent;
  const listFmt = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  const listText = (items) => listFmt.format(items);
  // "a.toml and b.json" with each name in the code face.
  const listNodes = (items, make) => listFmt.formatToParts(items).map(p => (p.type === 'element' ? make(p.value) : p.value));
  const plural = (n, one, many = `${one}s`) => `${fmt.int(n)} ${n === 1 ? one : many}`;
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const when = (ts) => dateFmt.format(new Date(ts));
  const hostOf = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const baseName = (p) => String(p || '').split('/').pop();
  const nameOf = (id) => {
    const a = agentById(id);
    return a ? a.name : META[id] ? META[id].name : id;
  };
  const agentById = (id) => (st.data && st.data.agents.find(a => a.id === id)) || null;
  // An older ID (…-search) still reaches its model, so it finds the model it names now.
  const modelById = (id) => (st.data && st.data.models.find(m => m.id === id || (m.aliases || []).includes(id))) || null;
  const stateOf = (state) => STATES[state] || { label: `Unknown state "${state}"`, tone: 'crit', lamp: 'error' };
  const countSecrets = (text) => (String(text || '').match(F.SECRET_TOKEN) || []).length;
  const splitLines = (text) => {
    const lines = String(text).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const sizeText = (n) => (n < 10240 ? `${fmt.int(n)} bytes` : `${fmt.compact(n / 1024)} KB`);
  const features = (m) => `${m.thinking ? 'Thinking' : 'Instant'}, ${m.web_search ? 'web search' : 'no web search'}`;

  // http(s)://host:port with /v1 and trailing slashes dropped; loopback names count as one host.
  function sameProxy(a, b) {
    const norm = (u) => {
      try {
        const x = new URL(String(u).trim());
        const host = ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname) ? 'loopback' : x.hostname;
        return `${x.protocol}//${host}:${x.port || (x.protocol === 'https:' ? '443' : '80')}${x.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
      } catch (e) {
        return null;
      }
    };
    const na = norm(a);
    return na != null && na === norm(b);
  }

  function mark(id, cls) {
    const m = META[id];
    const el = h('span', { class: ['agent-mark', cls], 'aria-hidden': 'true', text: m ? m.mono : String(id).slice(0, 2).toUpperCase() });
    el.style.setProperty('--agent-h', String(m ? m.hue : 220));
    return el;
  }

  // One settings row, same grammar as Settings → General.
  function row(label, hint, control, { icon, cls, hintId } = {}) {
    return h('div', { class: ['set-row', cls, icon && 'has-icon'] },
      icon ? h('span', { class: 'set-icon', 'aria-hidden': 'true' }, F.icon(icon)) : null,
      h('div', { class: 'set-text' },
        label instanceof Node ? label : h('span', { class: 'set-label', text: label }),
        hint ? (hint instanceof Node ? hint : h('span', { class: 'set-hint', id: hintId || null, text: hint })) : null),
      control == null ? null : h('div', { class: 'set-control' }, control));
  }

  function skel(w, hgt, cls) {
    const el = h('span', { class: ['skel', cls], 'aria-hidden': 'true' });
    el.style.setProperty('--w', typeof w === 'number' ? `${w}px` : w);
    if (hgt) el.style.setProperty('height', `${hgt}px`);
    return el;
  }

  // Rebuild a region without losing the user's place: the focused element comes back by its key.
  function keepFocus(fn) {
    const active = document.activeElement;
    const key = active && st.root.contains(active) ? active.getAttribute('data-focus-key') : null;
    fn();
    if (key) focusKey(key);
  }
  // Overview and detail both live in this view; only the visible one is searched.
  function focusKey(key) {
    const scope = st.d ? st.els.detail : st.els.overview;
    const el = scope.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    return Boolean(el);
  }

  // Banners hold role=alert notices. Rebuilding one with the same words would make a screen
  // reader announce it again on every repaint (each keystroke in the address field), so a
  // banner is only replaced when what it says changes.
  function paintBanner(host, notices) {
    const sig = notices.map(n => `${n.className}|${n.textContent}`).join('\n');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    keepFocus(() => host.replaceChildren(...notices));
  }

  // The proxy's own config problems, shown on every Agents page.
  function configNotices() {
    const e = st.data && st.data.proxy && st.data.proxy.base_url_error;
    return e ? [F.notice('warn', 'PROXY_BASE_URL is not used', e.message)] : [];
  }

  // ---------------------------------------------------------------- the signal path
  // The one figure the page is built around: where the agent's requests actually go.
  // Every link is a fact: solid green when it holds, amber when it leads somewhere wrong,
  // dashed when nothing is written yet.
  function pathModel(a) {
    const s = a.setup;
    const issues = s.issues || [];
    const has = (code) => issues.some(i => i.code === code);
    const manual = s.state === 'manual';
    const wired = s.state === 'default' || s.state === 'alongside' || s.state === 'outdated';
    const entry = a.files.find(f => f.id === a.entry_file) || null;
    const proxyBase = st.data.proxy.base_url_default;

    const tool = a.tool.found
      ? { label: a.name, sub: a.tool.detail || (a.tool.how === 'config_dir' ? 'Config folder found' : 'Installed'), tone: 'ok' }
      : { label: a.name, sub: 'Not found on this machine', tone: null };

    let fileSub;
    let fileTone = null;
    if (manual) fileSub = 'Pasted by hand';
    else if (s.state === 'unreadable') { fileSub = 'Can\'t read this file'; fileTone = 'crit'; }
    else if (s.state === 'none') fileSub = entry && entry.exists ? 'No DeepSeek setup in it' : 'Not written yet';
    else fileSub = entry && entry.role === 'profile' ? 'Read with the profile' : 'Read at start';
    const file = {
      kind: 'file',
      fileId: a.entry_file,
      label: manual ? 'Cursor settings (in the app)' : entry ? entry.display_path : a.entry_file,
      short: manual ? 'Cursor settings' : baseName(entry ? entry.display_path : a.entry_file),
      sub: fileSub,
      tone: fileTone,
      mono: !manual,
    };

    let proxy;
    if (s.base_url) {
      const elsewhere = s.points_here === false;
      proxy = {
        label: hostOf(s.base_url), short: hostOf(s.base_url).replace(/\/v1$/, ''), mono: true,
        sub: elsewhere ? 'Another address' : has('key_differs') ? 'Sends an old access key' : 'This proxy',
        tone: elsewhere || has('key_differs') ? 'warn' : null,
      };
    } else {
      proxy = { label: hostOf(proxyBase), short: hostOf(proxyBase), mono: true, sub: manual ? 'Paste into Cursor' : 'This proxy, not used yet', tone: null, muted: true };
    }

    let model;
    if (s.model) {
      const info = modelById(s.model);
      const sub = !info ? 'Not served by this proxy'
        : s.model_written ? 'Older ID, still served' : features(info);
      model = { label: info ? info.id : s.model, short: fmt.shortModel(info ? info.id : s.model), mono: true, sub, tone: info ? null : 'warn' };
    } else {
      model = { label: 'No model yet', short: 'no model', sub: manual ? 'Picked in Cursor' : 'Pick one below', tone: null, muted: true };
    }

    const links = [
      wired ? 'is-live' : s.state === 'unreadable' ? 'is-crit' : null,
      s.points_here === false || (s.points_here && has('key_differs')) ? 'is-warn' : s.points_here === true ? 'is-live' : null,
      !s.model || !wired || s.points_here !== true ? null : has('model_unknown') ? 'is-warn' : 'is-live',
    ];
    return { nodes: [{ kind: 'agent', ...tool }, file, proxy, { kind: 'model', ...model }], links };
  }

  // Overview row: file → proxy → model as dots and short labels. Decorative; the row's own
  // text carries the same facts for assistive tech.
  function smallPath(a) {
    const p = pathModel(a);
    const ol = h('ol', { class: 'sigpath sigpath-sm', 'aria-hidden': 'true' });
    p.nodes.slice(1).forEach((n, i) => {
      if (i) ol.append(h('li', { class: ['sig-link', p.links[i]] }));
      ol.append(h('li', { class: ['sig-node', n.tone && `is-${n.tone}`, n.muted && 'is-muted', p.links[i] === 'is-live' && 'is-on'] },
        h('span', { class: 'sig-dot' }), h('span', { class: 'sig-label', translate: 'no', text: n.short })));
    });
    return ol;
  }

  function bigPath(a) {
    const p = pathModel(a);
    const ol = h('ol', { class: 'sigpath sigpath-lg agent-path', 'aria-label': `How ${a.name} reaches DeepSeek` });
    p.nodes.forEach((n, i) => {
      if (i) ol.append(h('li', { class: ['sig-link', p.links[i - 1]], 'aria-hidden': 'true' }));
      const text = h('span', { class: 'sig-text' },
        h('span', { class: ['sig-label', n.mono && 'is-mono', n.muted && 'is-muted'], translate: n.mono ? 'no' : null, text: n.label }),
        h('span', { class: 'sig-sub', text: n.sub }));
      const li = h('li', { class: ['sig-node', n.tone && `is-${n.tone}`] });
      if (n.kind === 'agent') li.append(mark(a.id), text);
      else if (n.kind === 'file') {
        const btn = h('button', { type: 'button', class: 'sig-btn', 'data-focus-key': 'sig-file', 'data-tip': 'Show this file' }, text);
        btn.addEventListener('click', () => selectFile(n.fileId, { reveal: true }));
        li.append(btn);
      } else li.append(text);
      ol.append(li);
    });
    return ol;
  }

  // After an apply: the links fill left to right, once. Reduced motion gets the end state.
  function playFill(ol) {
    if (F.reducedMotion()) return;
    const links = Array.from(ol.querySelectorAll('.sig-link.is-live'));
    links.forEach((l, i) => {
      l.classList.remove('is-live');
      l.classList.add('is-arming');
      l.style.setProperty('--fill-delay', `${i * 90}ms`);
    });
    void ol.offsetWidth;
    requestAnimationFrame(() => {
      for (const l of links) { l.classList.remove('is-arming'); l.classList.add('is-live'); }
      setTimeout(() => { for (const l of links) l.style.removeProperty('--fill-delay'); }, 360 + links.length * 90);
    });
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const seq = ++st.loadSeq;
    st.loading = true;
    paint();
    const [agents, backups] = await Promise.allSettled([
      F.api('GET', '/admin/agents'),
      F.api('GET', '/admin/agents/backups'),
    ]);
    if (seq !== st.loadSeq) return;
    st.loading = false;
    if (agents.status === 'fulfilled') {
      st.data = agents.value;
      st.error = null;
    } else if (F.handleGate(agents.reason)) {
      paint();
      return;
    } else {
      st.error = agents.reason;
    }
    if (backups.status === 'fulfilled') {
      st.backups = backups.value.backups;
      st.backupsError = null;
    } else if (!F.handleGate(backups.reason)) {
      st.backupsError = backups.reason;
    }
    if (st.d && st.data && !st.error) {
      if (!resolveDetail()) return;
      plan(true);
    }
    paint();
  }

  async function loadBackups() {
    try {
      st.backups = (await F.api('GET', '/admin/agents/backups')).backups;
      st.backupsError = null;
    } catch (e) {
      if (F.handleGate(e)) return;
      st.backupsError = e;
    }
    paint();
  }

  function replaceAgent(agent) {
    if (!st.data || !agent) return;
    const i = st.data.agents.findIndex(a => a.id === agent.id);
    if (i >= 0) st.data.agents[i] = agent;
  }

  // ---------------------------------------------------------------- detail state
  function newDetail(id) {
    return {
      id,
      override: {},        // options the user picked that differ from the agent's defaults
      file: null,
      show: 'disk',
      plan: null,
      planKey: null,
      planError: null,
      planning: false,
      planCtl: null,
      planTimer: null,
      cache: new Map(),    // `${fileId}@${revision}` → { loading } | { body } | { error }
      applying: false,
      applyError: null,
      applyNote: null,
      expanded: new Set(), // diff gaps the user opened
      errorLine: null,     // { fileId, line } to mark in the On disk view
      panelKey: null,
      params: {},          // route params waiting for data
      focusTitle: false,
      baseCheck: true,     // show address errors; false while the user is typing in the field
      pathKey: null,       // what the drawn signal path shows, so a repaint keeps the same node
    };
  }

  function opts() {
    const d = st.d;
    const a = agentById(d.id);
    const def = a.defaults;
    const o = { model: def.model, mode: def.mode, base: def.base_url, ...d.override };
    return o;
  }

  // Applies the route's params once the agent's data is known. Returns false when the route
  // was rewritten (unknown agent).
  function resolveDetail() {
    const d = st.d;
    const a = agentById(d.id);
    if (!a) {
      F.toast(`Unknown agent ${d.id}`, { tone: 'warn' });
      st.d = null;
      F.replaceHash('agents');
      paint();
      return false;
    }
    const p = d.params;
    d.params = {};
    if (p.model != null) {
      const m = modelById(p.model);
      if (m) d.override.model = m.id;
      else F.toast(`This proxy doesn't serve ${p.model}. Showing ${a.defaults.model}.`, { tone: 'warn' });
    }
    if (p.mode != null && a.writable) {
      if (a.modes.some(m => m.value === p.mode)) d.override.mode = p.mode;
      else F.toast(`${a.name} has no install mode "${p.mode}".`, { tone: 'warn' });
    }
    if (p.base != null) d.override.base = p.base;
    if (p.file != null) {
      if (a.files.some(f => f.id === p.file)) d.file = p.file;
      else F.toast(`${a.name} has no file "${p.file}".`, { tone: 'warn' });
    }
    if (!d.file || !a.files.some(f => f.id === d.file)) d.file = a.entry_file;
    if (p.show != null) {
      if (SHOWS.some(s => s.value === p.show)) d.show = p.show;
      else F.toast(`Unknown file view "${p.show}".`, { tone: 'warn' });
    }
    pruneOverride();
    syncHash();
    return true;
  }

  // Drop picks that match the defaults, so the URL only carries real choices.
  function pruneOverride() {
    const d = st.d;
    const a = agentById(d.id);
    if (!a) return;
    const def = { model: a.defaults.model, mode: a.defaults.mode, base: a.defaults.base_url };
    for (const k of Object.keys(d.override)) if (d.override[k] === def[k]) delete d.override[k];
  }

  function syncHash() {
    const d = st.d;
    const a = agentById(d.id);
    const params = { ...d.override };
    if (a && d.file !== a.entry_file) params.file = d.file;
    if (d.show !== 'disk') params.show = d.show;
    F.replaceHash('agents', d.id, params);
  }

  function setOpt(key, value) {
    const d = st.d;
    d.override[key] = value;
    pruneOverride();
    d.applyError = null;
    d.applyNote = null;
    syncHash();
    plan(false);
    paintDetail();
  }

  function resetOpts() {
    st.d.override = {};
    st.d.applyError = null;
    st.d.applyNote = null;
    syncHash();
    plan(false);
    paintDetail();
  }

  // ---------------------------------------------------------------- plan (preview)
  const baseMissing = () => !String(opts().base || '').trim();

  // Debounced POST plan; a newer change aborts the request in flight.
  function plan(now) {
    const d = st.d;
    if (!d || !agentById(d.id)) return;
    clearTimeout(d.planTimer);
    if (d.planCtl) d.planCtl.abort();
    d.planCtl = null;
    if (baseMissing()) {
      d.planning = false;
      d.plan = null;
      d.planError = null;
      return;
    }
    d.planning = true;
    d.planTimer = setTimeout(runPlan, now ? 0 : PLAN_DEBOUNCE_MS);
  }

  async function runPlan() {
    const d = st.d;
    if (!d) return;
    const a = agentById(d.id);
    const o = opts();
    const body = { model: o.model, base_url: o.base.trim() };
    if (o.mode) body.mode = o.mode;
    const ctl = new AbortController();
    d.planCtl = ctl;
    try {
      const res = await F.api('POST', `/admin/agents/${enc(a.id)}/plan`, { body, signal: ctl.signal, timeout: 20000 });
      if (st.d !== d || ctl.signal.aborted) return;
      d.plan = res.plan;
      d.planKey = JSON.stringify(body);
      d.planError = null;
    } catch (e) {
      // Aborted on purpose by a newer change; that request owns the result.
      if (ctl.signal.aborted || st.d !== d) return;
      if (F.handleGate(e)) return;
      d.plan = null;
      d.planError = e;
    }
    d.planning = false;
    d.planCtl = null;
    paintDetail();
  }

  const planFile = (fileId) => (st.d.plan ? st.d.plan.files.find(f => f.id === fileId) || null : null);
  const planErrorFor = (field) => {
    const e = st.d.planError;
    if (!e) return null;
    const f = e.body && e.body.error && e.body.error.field;
    return f === field ? e : null;
  };

  // Why Apply can't run right now; null when it can.
  function applyBlock(a) {
    const d = st.d;
    if (baseMissing()) return 'Enter the proxy address first';
    if (d.planError && planErrorFor('base_url')) return 'Fix the proxy address first';
    if (d.planError && d.planError.type === 'invalid_existing_file') return 'Fix the file or restore a backup first';
    if (d.planError) return 'Fix the error above first';
    if (d.planning || !d.plan) return 'Waiting for the preview';
    if (!d.plan.changes) return 'Nothing to change';
    if (!a.writable) return `${a.name} can't be written from here`;
    return null;
  }

  // ---------------------------------------------------------------- apply, restore
  async function apply() {
    const d = st.d;
    const a = agentById(d.id);
    if (!a || !a.writable || d.applying) return;
    const block = applyBlock(a);
    if (block) {
      if (baseMissing() || planErrorFor('base_url')) {
        d.baseCheck = true;
        paintDetail();
        st.els.base.focus();
      }
      F.announce(block);
      return;
    }
    const o = opts();
    const expect = Object.fromEntries(d.plan.files.map(f => [f.id, f.revision]));
    d.applying = true;
    d.applyError = null;
    d.applyNote = null;
    paintDetail();
    try {
      const res = await F.api('POST', `/admin/agents/${enc(a.id)}/apply`, {
        body: { model: o.model, mode: o.mode, base_url: o.base.trim(), expect },
        timeout: 30000,
      });
      replaceAgent(res.agent);
      if (st.d !== d) return;
      pruneOverride();
      syncHash();
      st.lastApplied = a.id;
      const backup = res.applied.backup;
      F.announce(`Applied to ${a.name}.`);
      F.toast(`Applied to ${a.name}.`, {
        tone: 'success',
        action: backup ? { label: 'Undo', run: () => undoApply(backup.id, a.id, false) } : undefined,
      });
      loadBackups();
      plan(true);
    } catch (e) {
      if (F.handleGate(e)) return;
      const info = (e.body && e.body.error) || {};
      if (e.type === 'file_changed') {
        const paths = (info.files || []).map(f => f.display_path);
        d.applyNote = paths.length
          ? `${listText(paths)} changed on disk after the preview. Showing the new preview.`
          : `${e.message} Showing the new preview.`;
        d.plan = null;
        load();
      } else if (e.type === 'write_failed' && info.rolled_back === true) {
        d.applyError = { text: `${F.errorText(e)} Nothing was left half-written; the files were rolled back.` };
      } else {
        d.applyError = { text: F.errorText(e) };
      }
    } finally {
      d.applying = false;
      paint();
    }
  }

  async function postRestore(backupId, force) {
    const res = await F.api('POST', `/admin/agents/backups/${enc(backupId)}/restore`, { body: force ? { force: true } : {}, timeout: 30000 });
    if (st.data && Array.isArray(res.agents)) st.data.agents = res.agents;
    if (st.d) {
      st.d.cache.clear();
      plan(true);
    }
    loadBackups();
    paint();
    return res;
  }

  function backupNames(b) {
    return b.agents.length ? listText(b.agents.map(nameOf)) : 'An older setup';
  }

  function confirmRestore(b, trigger) {
    const created = b.files.some(f => !f.existed);
    const names = backupNames(b);
    F.confirm(trigger, {
      text: `Restore ${plural(b.files.length, 'file')} for ${names} from ${when(b.created_at)}? ${created ? 'Files that setup created are deleted. ' : ''}The current versions are backed up first.`,
      confirmLabel: 'Restore',
      pendingLabel: 'Restoring…',
      danger: false,
      async run() {
        try {
          const res = await postRestore(b.id, false);
          F.toast(`Restored ${plural(res.restored.files.length, 'file')} for ${names}.`, { tone: 'success' });
          requestAnimationFrame(() => focusKey(`restore-${b.id}`));
        } catch (e) {
          if (e.status !== 409 || e.type !== 'restore_conflict') throw e;
          // A second question needs its own popover; open it once this one has closed.
          setTimeout(() => confirmForce(b, trigger, e), 0);
        }
      },
    });
  }

  function conflictPaths(e) {
    const files = (e.body && e.body.error && e.body.error.files) || [];
    return files.map(f => (f.reason === 'missing' ? `${f.display_path} (deleted since)` : f.display_path));
  }

  function confirmForce(b, trigger, err) {
    if (!document.contains(trigger)) {
      // The list was redrawn meanwhile; ask from a toast instead of a popover.
      F.toast(err.message, { tone: 'warn', action: { label: 'Restore anyway', run: () => forceRestore(b) } });
      return;
    }
    const paths = conflictPaths(err);
    const names = backupNames(b);
    F.confirm(trigger, {
      text: paths.length
        ? `These files changed after the backup: ${listText(paths)}. Restore anyway and overwrite them?`
        : `${err.message} Restore anyway and overwrite them?`,
      confirmLabel: 'Restore anyway',
      pendingLabel: 'Restoring…',
      danger: true,
      async run() {
        const res = await postRestore(b.id, true);
        F.toast(`Restored ${plural(res.restored.files.length, 'file')} for ${names}.`, { tone: 'success' });
        requestAnimationFrame(() => focusKey(`restore-${b.id}`));
      },
    });
  }

  async function forceRestore(b) {
    try {
      const res = await postRestore(b.id, true);
      F.toast(`Restored ${plural(res.restored.files.length, 'file')} for ${backupNames(b)}.`, { tone: 'success' });
    } catch (e) {
      if (!F.handleGate(e)) F.toastError('Restore failed', e);
    }
  }

  async function undoApply(backupId, agentId, force) {
    try {
      const res = await postRestore(backupId, force);
      F.toast(`Restored ${plural(res.restored.files.length, 'file')} for ${nameOf(agentId)}.`, { tone: 'success' });
    } catch (e) {
      if (F.handleGate(e)) return;
      if (e.status === 409 && e.type === 'restore_conflict') {
        const paths = conflictPaths(e);
        F.toast(paths.length ? `Not undone: ${listText(paths)} changed after the apply.` : e.message, {
          tone: 'warn',
          action: { label: 'Restore anyway', run: () => undoApply(backupId, agentId, true) },
        });
        return;
      }
      F.toastError('Undo failed', e);
    }
  }

  // ---------------------------------------------------------------- files
  function selectFile(fileId, { reveal = false, focusTab = false } = {}) {
    const d = st.d;
    if (!d) return;
    d.file = fileId;
    syncHash();
    paintDetail();
    if (reveal) {
      st.els.filebox.scrollIntoView({ block: 'start', behavior: F.reducedMotion() ? 'auto' : 'smooth' });
    }
    if (reveal || focusTab) {
      const tab = st.els.tabs.querySelector(`[data-file="${CSS.escape(fileId)}"]`);
      if (tab) tab.focus({ preventScroll: true });
    }
  }

  function setShow(show) {
    const d = st.d;
    d.show = show;
    syncHash();
    paintDetail();
  }

  async function fetchFile(a, f) {
    const d = st.d;
    const key = `${f.id}@${f.revision}`;
    if (d.cache.has(key)) return;
    d.cache.set(key, { loading: true });
    try {
      const body = await F.api('GET', `/admin/agents/${enc(a.id)}/files/${enc(f.id)}`);
      if (st.d !== d) return;
      d.cache.set(key, { body });
    } catch (e) {
      if (st.d !== d) return;
      if (F.handleGate(e)) { d.cache.delete(key); return; }
      d.cache.set(key, { error: e });
    }
    paintDetail();
  }

  // What the viewer shows for the selected file: a text, a diff, or a state with words.
  function viewFor(a, f) {
    const d = st.d;
    const o = opts();
    const pf = planFile(f.id);
    // Cursor's files are generated for the options above; the plan carries them.
    if (f.virtual) {
      if (baseMissing()) return { kind: 'note', title: 'Nothing generated yet', text: 'Enter the proxy address to generate these settings.' };
      if (d.planError) return { kind: 'planerror' };
      if (!pf) return { kind: 'loading' };
      return { kind: 'text', text: pf.after };
    }
    if (d.show === 'disk') {
      if (f.error) return { kind: 'error', error: f.error };
      if (!f.exists) return { kind: 'missing' };
      const c = d.cache.get(`${f.id}@${f.revision}`);
      if (!c || c.loading) return { kind: 'loading' };
      if (c.error) return { kind: 'error', error: c.error };
      return { kind: 'text', text: c.body.content, masked: c.body.masked };
    }
    if (baseMissing()) return { kind: 'note', title: 'No preview yet', text: 'Enter the proxy address to see what applying writes.' };
    if (d.planError) return { kind: 'planerror' };
    if (!d.plan) return { kind: 'loading' };
    if (!pf) {
      const mode = a.modes.find(m => m.value === o.mode);
      return { kind: 'note', title: `${f.label} doesn't change`, text: `Applying ${mode ? mode.title.toLowerCase() : o.mode} leaves this file as it is.` };
    }
    if (d.show === 'after') return { kind: 'text', text: pf.after };
    if (pf.action === 'unchanged') return { kind: 'note', title: 'No changes', text: `${f.label} already matches these options.` };
    return { kind: 'diff', pf };
  }

  // ---------------------------------------------------------------- mount
  function mount(root) {
    st.root = root;
    // Overview
    const heroO = F.pageHero({ image: HERO_IMAGE, label: 'Coding agents', position: '50% 74%' });
    const ovBanner = h('div', { class: 'view-banner' });
    const roster = h('ul', { class: 'agents-roster set-group', role: 'list', 'aria-label': 'Agents' });
    // The j/k cursor follows Tab focus, so Enter and j/k always agree on the row.
    roster.addEventListener('focusin', (e) => {
      const rowEl = e.target.closest('.agent-row[data-id]');
      if (!rowEl || st.cursor === rowEl.dataset.id) return;
      st.cursor = rowEl.dataset.id;
      for (const r of roster.querySelectorAll('.agent-row')) r.classList.toggle('is-cursor', r === rowEl);
    });
    const rosterSection = h('section', { class: 'agents-section', 'aria-labelledby': 'agents-roster-title' },
      h('header', { class: 'settings-head' },
        h('h2', { class: 'settings-title', id: 'agents-roster-title', text: 'Agents' }),
        h('p', { class: 'settings-desc', text: 'Each agent reads its own config file. Pick one to see the file and point it at this proxy.' })),
      roster);
    const backupBody = h('div', { class: 'set-stack' });
    const backupSection = h('section', { class: 'agents-section', id: 'agents-backups', 'aria-labelledby': 'agents-backups-title' },
      h('header', { class: 'settings-head' },
        h('h2', { class: 'settings-title', id: 'agents-backups-title', text: 'Restore points' }),
        h('p', { class: 'settings-desc', text: 'Every apply backs up the files it changes first. Restoring also deletes files that setup created.' })),
      backupBody);
    const overview = h('div', { class: 'agents-page' }, heroO,
      h('div', { class: 'view-pad agents' }, ovBanner, rosterSection, backupSection));

    // Detail
    const heroD = F.pageHero({ image: HERO_IMAGE, label: 'Agent', position: '50% 80%' });
    heroD.classList.add('hero-agent');
    const pathHost = h('div', { class: 'agent-path-host' });
    const dBanner = h('div', { class: 'view-banner' });

    const modelHost = h('div', { class: 'set-stack' });
    const modeHost = h('div');
    const secModel = cfgSection('Model', 'cfg-model', modelHost);
    const secMode = cfgSection('Install as', 'cfg-mode', modeHost);

    const base = h('input', {
      class: 'input', id: 'agent-base', type: 'url', name: 'base_url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': 'agent-base-hint agent-base-error', translate: 'no',
    });
    // Checked when the field is left, not on every keystroke while the address is half typed.
    base.addEventListener('input', () => { if (st.d) st.d.baseCheck = false; setOpt('base', base.value.trim()); });
    base.addEventListener('blur', () => {
      if (!st.d || st.d.baseCheck) return;
      st.d.baseCheck = true;
      paintDetail();
    });
    const useOrigin = h('div', { class: 'base-use' });
    const baseError = h('p', { class: 'form-error base-error', id: 'agent-base-error', role: 'alert', hidden: true });
    const baseHint = h('p', { class: 'field-help', id: 'agent-base-hint' });
    const secBase = cfgSection('Proxy address', 'cfg-base',
      h('div', { class: 'set-group' },
        h('div', { class: 'set-row set-row-form base-row' },
          h('label', { class: 'sr-only', for: 'agent-base', text: 'Proxy address' }), base, useOrigin)),
      baseHint, baseError);

    const keyHost = h('div');
    const secKey = cfgSection('Access key', 'cfg-key', keyHost);
    const notesHost = h('div', { class: 'set-stack cfg-notes' });
    const usageHost = h('div');
    // The apply bar is built once and updated in place: its alert and live summary must not be
    // re-inserted on every repaint. Its host is display: contents, so the sticky bar's
    // containing block is the whole form and it can stay pinned while the options scroll.
    const manualHost = h('div', { hidden: true });
    const applyNote = h('p', { class: 'apply-note', role: 'status', hidden: true }, F.icon('alert'), h('span'));
    const applySummary = h('p', { class: 'apply-summary', 'aria-live': 'polite' });
    const applyErr = h('p', { class: 'inline-error-block', role: 'alert', hidden: true });
    const applyActions = h('div', { class: 'apply-actions' });
    const applyBar = h('div', { class: 'apply-bar', role: 'group', 'aria-label': 'Apply', hidden: true }, applyNote, applySummary, applyErr, applyActions);
    const applyHost = h('div', { class: 'apply-host' }, manualHost, applyBar);
    const form = h('form', { class: 'agent-config', novalidate: true, 'aria-label': 'Options' },
      secModel, secMode, secBase, secKey, notesHost, usageHost, applyHost);
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });

    const tabs = h('div', { class: 'filebox-tabs', role: 'tablist' });
    tabs.addEventListener('keydown', onTabKey);
    const barHost = h('div', { class: 'file-bar' });
    const codeHost = h('div', { class: 'codeblock set-code file-code' });
    const footHost = h('div');
    const panel = h('div', { class: 'file-panel', id: 'fpanel', role: 'tabpanel' }, barHost, codeHost, footHost);
    const filebox = h('section', { class: 'filebox', 'aria-label': 'Files' }, tabs, panel);
    const body = h('div', { class: 'agent-detail' }, form, filebox);
    const restoreHost = h('section', { class: 'agents-section agent-restore', 'aria-labelledby': 'agent-restore-title' });
    const detail = h('div', { class: 'agents-page', hidden: true }, heroD,
      h('div', { class: 'view-pad agents agents-detail-pad' }, pathHost, dBanner, body, restoreHost));

    root.append(overview, detail);
    Object.assign(st.els, {
      overview, heroO, ovBanner, roster, rosterSection, backupBody, backupSection,
      detail, heroD, pathHost, dBanner, body, form, modelHost, modeHost, secMode, secBase, secKey, base, useOrigin, baseError, baseHint,
      keyHost, notesHost, usageHost, applyHost, manualHost, applyBar, applyNote, applySummary, applyErr, applyActions,
      tabs, panel, barHost, codeHost, footHost, filebox, restoreHost,
    });

    const scroller = document.getElementById('scroll');
    scroller.addEventListener('scroll', markScrolled, { passive: true });
    // Files change outside the browser: read them again when the tab comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && st.visible) load();
    });
    F.on('tick', () => { if (st.visible && st.d) paintFileFacts(); });
  }

  // The hero toolbar is see-through; past the photo it needs a ground (see app.css).
  function markScrolled() {
    if (!st.visible) return;
    const hero = st.d ? st.els.heroD : st.els.heroO;
    const past = document.getElementById('scroll').scrollTop > hero.offsetHeight - 52;
    document.getElementById('app').classList.toggle('agents-scrolled', past);
  }

  function cfgSection(title, id, ...body) {
    return h('section', { class: 'cfg-section', 'aria-labelledby': id },
      h('h2', { class: 'cfg-title', id, text: title }), ...body);
  }

  // ---------------------------------------------------------------- paint: overview
  function paint() {
    if (!st.visible) return;
    if (st.d) paintDetail();
    else paintOverview();
  }

  function errorNotices() {
    const e = st.error;
    if (!e) return [];
    if (e.type === 'agents_unavailable') {
      return [F.notice('info', 'Agent setup runs on your computer', h('div', { class: 'notice-stack' },
        h('p', { class: 'notice-text', text: 'This proxy runs without scripts/setup-agents.js (the container image leaves it out). On the machine where your agents are installed, run:' }),
        F.codeLine(`npm run setup:agents -- --all --base-url ${location.origin}`)))];
    }
    if (e.type === 'agents_local_only') return [F.notice('warn', 'Agent files are only shown on the proxy\'s machine', e.message)];
    if (e.status === 404 && e.type === 'not_found') return [F.endpointMissing('/admin/agents')];
    return [F.notice('crit', 'Can\'t read agent config', F.errorText(e), [F.btn('Retry', { icon: 'reload', size: 'sm', onclick: () => load() })])];
  }

  function heroError(hero) {
    const e = st.error;
    if (e.type === 'agents_unavailable') hero.set('Agents are set up on your computer');
    else if (e.type === 'agents_local_only') hero.set('Agent files stay on this machine');
    else if (e.status === 404 && e.type === 'not_found') hero.set('This server has no agents page yet');
    else hero.set('Can\'t read agent config', '', 'crit');
  }

  // Groups names into short sentences: who starts on DeepSeek, who has it alongside, who is off.
  function overviewSentence(agents) {
    const names = (pred) => agents.filter(pred).map(a => a.name);
    const out = [];
    const verb = (list, one, many) => `${listText(list)} ${list.length === 1 ? one : many}`;
    const def = names(a => a.setup.state === 'default' && a.setup.points_here === true);
    const along = names(a => a.setup.state === 'alongside' && a.setup.points_here === true);
    const away = names(a => a.setup.points_here === false);
    const stale = names(a => a.setup.state === 'outdated' && a.setup.points_here !== false);
    const broken = names(a => a.setup.state === 'unreadable');
    if (def.length) out.push(`${verb(def, 'starts', 'start')} on DeepSeek.`);
    if (along.length) out.push(`${verb(along, 'has', 'have')} it alongside ${along.length === 1 ? 'its' : 'their'} own models.`);
    if (away.length) out.push(`${verb(away, 'points', 'point')} at another address.`);
    if (stale.length) out.push(`${verb(stale, 'needs', 'need')} an update.`);
    if (broken.length) out.push(`Can't read the config of ${listText(broken)}.`);
    return out.join(' ');
  }

  function paintOverview() {
    const { els } = st;
    els.overview.hidden = false;
    els.detail.hidden = true;
    paintBanner(els.ovBanner, [...errorNotices(), ...configNotices()]);
    const blocked = Boolean(st.error) && !st.data;
    els.rosterSection.hidden = blocked;
    els.backupSection.hidden = blocked;
    if (blocked) { heroError(els.heroO); return; }
    if (!st.data) {
      els.heroO.set('Reading agent config');
    } else {
      const writable = st.data.agents.filter(a => a.writable);
      const wired = writable.filter(a => (a.setup.state === 'default' || a.setup.state === 'alongside') && a.setup.points_here === true);
      if (!wired.length) {
        const issues = overviewSentence(st.data.agents);
        els.heroO.set('No agent uses this proxy yet', issues || 'Pick an agent below to write its config. The files it changes are backed up first.');
      } else {
        els.heroO.set(`${wired.length} of ${writable.length} agents ${wired.length === 1 ? 'uses' : 'use'} this proxy`, overviewSentence(st.data.agents));
      }
    }
    paintRoster();
    paintBackupList(els.backupBody, null);
    if (st.scrollTo === 'backups' && st.data) {
      st.scrollTo = null;
      requestAnimationFrame(() => els.backupSection.scrollIntoView({ block: 'start' }));
    }
  }

  function paintRoster() {
    const ul = st.els.roster;
    keepFocus(() => {
      if (!st.data) {
        ul.setAttribute('aria-busy', 'true');
        ul.replaceChildren(...AGENTS.map(() => h('li', null, h('div', { class: 'agent-row is-skel' },
          skel(36, 36, 'skel-mark'), h('span', { class: 'agent-id' }, skel(140, 14), skel(220, 10)), h('span'), skel(72, 24, 'skel-pill'), h('span')))));
        return;
      }
      ul.removeAttribute('aria-busy');
      ul.replaceChildren(...st.data.agents.map(rosterRow));
    });
  }

  function rosterRow(a) {
    const s = stateOf(a.setup.state);
    const entry = a.files.find(f => f.id === a.entry_file);
    let sub;
    if (!a.tool.found) sub = h('span', { class: 'agent-sub', text: 'Not found on this machine' });
    else if (entry && entry.virtual) sub = h('span', { class: 'agent-sub', text: 'Keeps its settings inside the app' });
    else sub = h('span', { class: 'agent-sub' }, 'Reads ', h('span', { translate: 'no', text: entry ? entry.display_path : a.entry_file }));
    const link = h('a', { class: ['agent-row', st.cursor === a.id && 'is-cursor'], href: F.hashFor('agents', a.id), 'data-id': a.id, 'data-focus-key': `row-${a.id}` },
      mark(a.id),
      h('span', { class: 'agent-id' }, h('span', { class: 'agent-name', text: a.name }), sub),
      smallPath(a),
      h('span', { class: `agent-state is-${s.tone}` }, F.lamp(s.lamp), h('span', { text: s.label })),
      F.icon('chevron-right', 'agent-chev'));
    return h('li', null, link);
  }

  function backupRow(b) {
    const source = { dashboard: 'from the dashboard', cli: 'from the terminal', restore: 'before a restore' }[b.source] || `from ${b.source}`;
    const btn = F.btn('Restore…', { size: 'sm', 'data-focus-key': `restore-${b.id}` });
    let hint;
    if (b.restorable) {
      hint = `${when(b.created_at)}, ${source}, ${plural(b.files.length, 'file')}`;
      btn.addEventListener('click', () => confirmRestore(b, btn));
    } else {
      hint = `${when(b.created_at)}. ${b.reason}`;
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('data-tip', 'Restore it from a terminal');
    }
    return h('li', { class: 'set-row backup-row' },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label', text: backupNames(b) }), h('span', { class: 'set-hint', text: hint })),
      h('div', { class: 'set-control' }, btn));
  }

  // agentId: only that agent's newest three, for its own page; null: all of them.
  function paintBackupList(host, agentId) {
    keepFocus(() => {
      if (st.backupsError && !st.backups) {
        host.replaceChildren(F.notice('crit', 'Can\'t list restore points', F.errorText(st.backupsError), [F.btn('Retry', { icon: 'reload', size: 'sm', onclick: loadBackups })]));
        return;
      }
      if (!st.backups) {
        host.replaceChildren(h('div', { class: 'set-group' }, h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, skel(160, 14), skel(240, 10)))));
        return;
      }
      let list = st.backups;
      if (agentId) list = list.filter(b => b.agents.includes(agentId)).slice(0, 3);
      if (!list.length) {
        host.replaceChildren(h('div', { class: 'set-group' }, row(agentId ? 'No restore points for this agent yet' : 'No restore points yet',
          'Applying to an agent backs up the files it changes first, so you can undo it here.')));
        return;
      }
      const all = agentId || st.showAllBackups ? list : list.slice(0, BACKUPS_SHOWN);
      const parts = [h('ul', { class: 'backup-rows set-group', role: 'list' }, all.map(backupRow))];
      if (!agentId && list.length > all.length) {
        // The button goes away once pressed: focus moves to the first restore point it revealed.
        const firstNew = list[all.length];
        parts.push(h('div', { class: 'agents-more' }, F.btn(`Show all ${fmt.int(list.length)}`, {
          kind: 'ghost', size: 'sm', 'data-focus-key': 'backups-all',
          onclick: () => { st.showAllBackups = true; paint(); focusKey(`restore-${firstNew.id}`); },
        })));
      }
      if (st.backupsError) parts.unshift(F.notice('warn', 'Restore points may be out of date', F.errorText(st.backupsError)));
      host.replaceChildren(...parts);
    });
  }

  // ---------------------------------------------------------------- paint: detail
  function stateSentence(a) {
    const s = a.setup;
    const model = s.model ? ` with ${s.model}` : '';
    switch (s.state) {
      case 'default': return `Starts on DeepSeek by default${model}.`;
      case 'alongside': return `Keeps its own default and has DeepSeek alongside${model}.`;
      case 'none': return 'Not set up. Pick a model and how to install it, then apply.';
      case 'outdated': return s.points_here === false ? `Set up, but sends requests to ${hostOf(s.base_url)}. Apply to point it here.` : 'Set up, but out of date. Apply to fix it.';
      case 'unreadable': return 'Its config file can\'t be read. Fix the file or restore a backup.';
      case 'manual': return 'Cursor keeps its settings inside the app. Copy them from below.';
      default: return stateOf(s.state).label;
    }
  }

  function paintDetail() {
    if (!st.visible || !st.d) return;
    const { els } = st;
    const d = st.d;
    const a = agentById(d.id);
    els.overview.hidden = true;
    els.detail.hidden = false;
    if (!a) {
      const blocked = Boolean(st.error);
      paintBanner(els.dBanner, errorNotices());
      if (blocked) heroError(els.heroD); else els.heroD.set(META[d.id] ? META[d.id].name : d.id, 'Reading its config…');
      els.pathHost.replaceChildren(blocked ? '' : h('div', { class: 'sigpath sigpath-lg agent-path is-skel', 'aria-hidden': 'true' }, skel('22%', 14), skel('26%', 14), skel('18%', 14), skel('24%', 14)));
      d.pathKey = null;
      els.body.hidden = blocked;
      els.restoreHost.hidden = true;
      if (!blocked) paintSkeletonBody();
      return;
    }
    els.body.hidden = false;
    els.heroD.set(a.name, stateSentence(a), a.setup.state === 'unreadable' ? 'crit' : null);

    // The path is redrawn only when it says something new, so the fill after an apply is not
    // cut short by the repaints that follow it (the new preview, the restore point list).
    const pathKey = JSON.stringify([a.id, pathModel(a)]);
    const fill = st.lastApplied === a.id;
    if (fill || pathKey !== d.pathKey || !els.pathHost.firstChild) {
      d.pathKey = pathKey;
      const ol = bigPath(a);
      keepFocus(() => els.pathHost.replaceChildren(ol));
      if (fill) { st.lastApplied = null; playFill(ol); }
    }

    paintDetailBanner(a);
    paintModel(a);
    paintModes(a);
    paintBase(a);
    paintKey(a);
    paintNotes(a);
    paintUsage(a);
    paintApply(a);
    paintTabs(a);
    paintPanel(a);
    paintRestore(a);
    if (d.focusTitle) {
      d.focusTitle = false;
      const title = document.getElementById('view-title');
      title.setAttribute('tabindex', '-1');
      requestAnimationFrame(() => title.focus({ preventScroll: true }));
    }
  }

  function paintSkeletonBody() {
    const { els } = st;
    const group = (n) => h('div', { class: 'set-group' }, Array.from({ length: n }, () => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, skel(120, 14), skel(200, 10)))));
    els.modelHost.replaceChildren(group(3));
    els.modeHost.replaceChildren(group(2));
    for (const host of [els.keyHost, els.notesHost, els.usageHost, els.manualHost, els.barHost, els.footHost, els.tabs]) host.replaceChildren();
    paintBanner(els.dBanner, []);
    els.applyBar.hidden = true;
    els.codeHost.replaceChildren(codeSkeleton());
    st.d.panelKey = null;
  }

  function codeSkeleton() {
    const widths = ['40%', '72%', '58%', '86%', '64%', '90%', '48%', '76%', '62%', '54%'];
    return h('div', { class: 'file-skel', 'aria-busy': 'true', 'aria-label': 'Loading the file' }, widths.map(w => skel(w, 10)));
  }

  function paintDetailBanner(a) {
    const notices = [...errorNotices(), ...configNotices()];
    for (const issue of a.setup.issues || []) {
      if (issue.code === 'file_unreadable') {
        const actions = issue.line ? [F.btn('Show the line', { size: 'sm', 'data-focus-key': `issue-${issue.file_id}`, onclick: () => showLine(issue.file_id, issue.line) })] : [];
        notices.push(F.notice('crit', issue.message, null, actions));
      } else {
        notices.push(F.notice('warn', null, issue.message));
      }
    }
    if (st.backupsError && st.backups) notices.push(F.notice('warn', 'Restore points may be out of date', F.errorText(st.backupsError)));
    paintBanner(st.els.dBanner, notices);
  }

  function showLine(fileId, line) {
    const d = st.d;
    d.errorLine = { fileId, line };
    d.show = 'disk';
    d.panelKey = null;
    selectFile(fileId, { reveal: true });
  }

  function paintModel(a) {
    const o = opts();
    const m = modelById(o.model);
    const host = st.els.modelHost;
    if (!m) {
      host.replaceChildren(F.notice('crit', `This proxy doesn't serve ${o.model}`, 'Pick another model after the proxy reloads its model list.'));
      return;
    }
    const find = (thinking, web) => st.data.models.find(x => x.thinking === thinking && x.web_search === web) || null;
    const sw = (label, hint, icon, key) => {
      const on = m[key];
      const next = key === 'thinking' ? find(!on, m.web_search) : find(m.thinking, !on);
      const hintId = `agent-${key}-hint`;
      const el = F.switchEl(label, on, () => setOpt('model', next.id));
      el.classList.add('cfg-switch');
      el.input.setAttribute('data-focus-key', `sw-${key}`);
      el.input.setAttribute('aria-describedby', hintId);
      if (!next) {
        el.input.disabled = true;
        el.setAttribute('data-tip', 'This proxy has no model for that combination');
      }
      return row(label, hint, el, { icon, hintId });
    };
    const idRow = row('Model ID', null, h('span', { class: 'set-url' }, h('code', { class: 'mono-id', translate: 'no', text: m.id }), F.copyBtn(m.id, 'Copy model ID')), { cls: 'model-id-row' });
    const parts = [h('div', { class: 'set-group' },
      sw('Thinking', 'Reasons before answering. Slower, better on hard tasks.', 'think', 'thinking'),
      sw('Web search', 'DeepSeek searches the web itself.', 'search-web', 'web_search'),
      idRow)];
    if (a.fixed_models && a.fixed_models.length) {
      parts.push(h('div', { class: 'set-group' }, a.fixed_models.map(fm => row(fm.slot, null, h('code', { class: 'mono-id fixed-model', translate: 'no', text: fm.model }), { cls: 'fixed-model-row' }))),
        h('p', { class: 'settings-foot', text: `${a.name} picks these by task. They are fixed.` }));
    }
    keepFocus(() => host.replaceChildren(...parts));
  }

  function paintModes(a) {
    const { els } = st;
    els.secMode.hidden = !a.writable || !a.modes.length;
    if (els.secMode.hidden) { els.modeHost.replaceChildren(); return; }
    const o = opts();
    const fileLabel = (fid) => { const f = a.files.find(x => x.id === fid); return f ? f.label : fid; };
    const anyOn = a.modes.some(md => md.value === o.mode);
    const group = h('div', { class: 'channel-tiles mode-tiles', role: 'radiogroup', 'aria-labelledby': 'cfg-mode' });
    const tiles = a.modes.map((md, i) => {
      const on = md.value === o.mode;
      const b = h('button', {
        type: 'button', role: 'radio', class: ['channel-tile', on && 'is-on'], 'aria-checked': String(on),
        tabindex: on || (!anyOn && i === 0) ? '0' : '-1', 'data-value': md.value, 'data-focus-key': `mode-${md.value}`,
      },
      h('span', { class: 'channel-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'channel-text' },
        h('span', { class: 'channel-title' }, h('span', { text: md.title }), a.setup.mode === md.value ? h('span', { class: 'channel-current', text: 'Now' }) : null),
        h('span', { class: 'channel-desc', text: md.description }),
        md.writes.length ? h('span', { class: 'channel-writes' }, 'Writes ', ...listNodes(md.writes.map(fileLabel), (v) => h('code', { class: 'mono-id', translate: 'no', text: v }))) : null));
      b.addEventListener('click', () => { if (md.value !== opts().mode) setOpt('mode', md.value); });
      return b;
    });
    group.append(...tiles);
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = Math.max(0, a.modes.findIndex(md => md.value === opts().mode));
      const next = a.modes[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + a.modes.length) % a.modes.length];
      setOpt('mode', next.value);
      const t = els.modeHost.querySelector(`[data-value="${CSS.escape(next.value)}"]`);
      if (t) t.focus();
    });
    keepFocus(() => els.modeHost.replaceChildren(group));
  }

  function paintBase(a) {
    const { els } = st;
    const d = st.d;
    const o = opts();
    const input = els.base;
    if (document.activeElement !== input && input.value !== o.base) input.value = o.base;
    const err = !d.baseCheck ? null
      : baseMissing() ? `Enter the address agents should use, like ${a.defaults.base_url}.`
        : planErrorFor('base_url') ? F.errorText(planErrorFor('base_url')) : null;
    // Only a changed message is written: rewriting an alert's text re-announces it.
    if (els.baseError.textContent !== (err || '')) els.baseError.textContent = err || '';
    els.baseError.hidden = !err;
    input.setAttribute('aria-invalid', String(Boolean(err)));
    els.baseHint.textContent = a.kind === 'editor' ? 'Cursor takes it with /v1; the settings below add it.' : 'Agents add /v1 where they need it.';
    const origin = location.origin;
    const show = /^https?:/.test(origin) && !sameProxy(origin, o.base);
    keepFocus(() => els.useOrigin.replaceChildren(show ? F.btn(`Use ${origin}`, {
      kind: 'ghost', size: 'sm', 'data-focus-key': 'use-origin',
      // The button hides once the address matches; focus goes to the field it filled.
      onclick: () => { input.value = origin; d.baseCheck = true; setOpt('base', origin); input.focus(); },
    }) : ''));
  }

  function paintKey(a) {
    const src = st.data.proxy.key_source;
    const editor = a.kind === 'editor';
    let label;
    let hint;
    if (src === 'none') {
      label = 'No access key';
      hint = `This proxy has no PROXY_API_KEY, so ${a.name} sends "local".`;
    } else {
      label = src === 'file' ? 'PROXY_API_KEY_FILE' : 'PROXY_API_KEY';
      hint = editor
        ? 'The launcher reads PROXY_API_KEY from your shell. For settings pasted by hand, type the key into Cursor yourself.'
        : 'This proxy\'s key. Written to the file, never shown here.';
    }
    const extra = !editor && a.setup.key === 'differs' ? 'The file has a different key now. Applying writes the current one.'
      : !editor && a.setup.key === 'missing' && a.setup.state !== 'none' ? 'The file has no key yet. Applying writes it.' : null;
    st.els.keyHost.replaceChildren(h('div', { class: 'set-group' },
      row(h('span', { class: 'set-label', translate: 'no', text: label }),
        h('span', { class: 'set-hint' }, hint, extra ? h('span', { class: 'is-warn-text key-extra', text: ` ${extra}` }) : null),
        null, { icon: 'key' })));
  }

  function paintNotes(a) {
    const d = st.d;
    const effects = (d.plan && d.plan.effects) || a.effects || [];
    const notes = [];
    if (effects.length) notes.push(F.notice('info', 'Also changes', h('ul', { class: 'effects-list' }, effects.map(t => h('li', { text: t })))));
    if (!a.tool.found) {
      notes.push(F.notice('warn', null, a.kind === 'editor'
        ? `${a.name} wasn't found on this machine. You can still copy its settings.`
        : `${a.name} isn't on this machine's PATH. You can still write its config; ${a.name} reads it once installed.`));
    }
    st.els.notesHost.replaceChildren(...notes);
  }

  function paintUsage(a) {
    const d = st.d;
    const usage = d.plan ? d.plan.usage : a.usage;
    const host = st.els.usageHost;
    if (!usage || (!usage.command && !usage.note)) { host.replaceChildren(); return; }
    host.replaceChildren(h('div', { class: 'agent-usage' },
      usage.command ? h('p', { class: 'meta', text: usage.label }) : null,
      usage.command ? F.codeLine(usage.command) : null,
      usage.note ? h('p', { class: 'meta', text: usage.note }) : null));
  }

  function paintApply(a) {
    const d = st.d;
    const { els } = st;
    if (!a.writable) {
      els.applyBar.hidden = true;
      els.manualHost.hidden = false;
      keepFocus(() => els.manualHost.replaceChildren(manualSteps(a)));
      return;
    }
    els.manualHost.hidden = true;
    els.manualHost.replaceChildren();
    els.applyBar.hidden = false;
    const block = applyBlock(a);
    const outdated = a.setup.state === 'outdated';
    // The bar is pinned over the options, so it says itself why nothing can be applied yet.
    // While the address is being typed it says nothing about it (the field checks it on leave).
    let summary = '';
    const baseBad = baseMissing() || planErrorFor('base_url');
    if (baseBad && !d.baseCheck) summary = '';
    else if (baseMissing()) summary = 'Enter the proxy address to see what changes.';
    else if (planErrorFor('base_url')) summary = 'Fix the proxy address to see what changes.';
    else if (d.planning || (!d.plan && !d.planError)) summary = 'Checking what changes…';
    else if (d.plan && d.plan.changes) {
      const changed = d.plan.files.filter(f => f.action !== 'unchanged');
      const names = changed.map(f => baseName(f.display_path));
      const backed = changed.some(f => f.action === 'update');
      const one = changed.length === 1;
      const backup = backed ? `The current ${one ? 'version is' : 'versions are'} backed up first.` : `${one ? 'It is' : 'They are'} new, so there is nothing to back up.`;
      summary = `${outdated ? 'Applying fixes this. ' : ''}${plural(changed.length, 'file')} ${one ? 'changes' : 'change'}: ${listText(names)}. ${backup}`;
    } else if (d.plan) summary = 'The files already match these options.';

    const errText = d.applyError ? d.applyError.text
      : d.planError && !planErrorFor('base_url') ? F.errorText(d.planError) : null;
    // Live regions are updated in place and only when their words change.
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    const noteText = els.applyNote.lastChild;
    if (noteText.textContent !== (d.applyNote || '')) noteText.textContent = d.applyNote || '';
    els.applyNote.hidden = !d.applyNote;
    setText(els.applySummary, summary);
    setText(els.applyErr, errText || '');
    els.applyErr.hidden = !errText;

    const btn = h('button', {
      type: 'submit', class: 'btn btn-primary apply-btn', 'data-focus-key': 'apply',
      'aria-disabled': block || d.applying ? 'true' : null, 'data-tip': d.applying ? null : block,
      'aria-busy': d.applying ? 'true' : null,
    }, d.applying ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'btn-label', text: 'Applying…' })]
      : h('span', { class: 'btn-label', text: `Apply to ${a.name}` }));
    // Reset goes away once the options are back to the current setup; focus moves to Apply.
    const reset = Object.keys(d.override).length
      ? F.btn('Reset', { kind: 'ghost', 'data-focus-key': 'reset', onclick: () => { resetOpts(); focusKey('apply'); }, title: 'Back to the current setup' }) : null;
    keepFocus(() => els.applyActions.replaceChildren(...[reset, btn].filter(Boolean)));
  }

  // Cursor: nothing to write, so the page says what to paste and where.
  function manualSteps(a) {
    const o = opts();
    const base = `${String(o.base || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
    const keyText = st.data.proxy.key_source === 'none'
      ? 'Set OpenAI API Key to local.'
      : 'Set OpenAI API Key to this proxy\'s PROXY_API_KEY.';
    const code = (t) => h('code', { class: 'mono-id', translate: 'no', text: t });
    return h('section', { class: 'cfg-section manual', 'aria-labelledby': 'cfg-manual' },
      h('h2', { class: 'cfg-title', id: 'cfg-manual', text: 'Set it up in Cursor' }),
      h('ol', { class: 'manual-steps' },
        h('li', null, `Open Cursor Settings, then Models. ${keyText}`),
        h('li', null, h('span', { text: 'Turn on Override OpenAI Base URL and paste:' }), baseMissing() ? null : F.codeLine(base)),
        h('li', null, 'Add the models: ', ...listNodes(st.data.models.map(m => m.id), code), '.'),
        h('li', null, 'Or start Cursor with the launcher below, which reads PROXY_API_KEY from your shell.')));
  }

  // ---------------------------------------------------------------- files: tabs, panel
  function deltaNode(pf) {
    if (!pf || pf.action === 'unchanged') return null;
    if (pf.action === 'create') return h('span', { class: 'file-delta' }, h('span', { class: 'new', text: 'New' }));
    return h('span', { class: 'file-delta' },
      h('span', { class: 'add', 'aria-hidden': 'true', text: `+${fmt.int(pf.diff.added)}` }), ' ',
      h('span', { class: 'del', 'aria-hidden': 'true', text: `−${fmt.int(pf.diff.removed)}` }),
      h('span', { class: 'sr-only', text: `, ${plural(pf.diff.added, 'line')} added, ${fmt.int(pf.diff.removed)} removed` }));
  }

  function paintTabs(a) {
    const d = st.d;
    const { tabs, panel } = st.els;
    tabs.setAttribute('aria-label', `Files ${a.name} reads`);
    keepFocus(() => tabs.replaceChildren(...a.files.map(f => {
      const sel = f.id === d.file;
      const b = h('button', {
        type: 'button', role: 'tab', class: 'file-tab', id: `ftab-${f.id}`, 'aria-controls': 'fpanel',
        'aria-selected': String(sel), tabindex: sel ? '0' : '-1', 'data-file': f.id, 'data-focus-key': `tab-${f.id}`,
      },
      h('span', { class: 'file-tab-name', translate: 'no', text: f.label }),
      h('span', { class: 'file-tab-role', text: ROLES[f.role] || f.role }),
      f.virtual ? null : deltaNode(planFile(f.id)));
      b.addEventListener('click', () => { if (d.file !== f.id) selectFile(f.id); });
      return b;
    })));
    panel.setAttribute('aria-labelledby', `ftab-${d.file}`);
  }

  // WAI-ARIA tabs: arrows, Home and End move and select (activation follows focus).
  function onTabKey(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !st.d) return;
    const a = agentById(st.d.id);
    if (!a) return;
    e.preventDefault();
    const ids = a.files.map(f => f.id);
    const i = ids.indexOf(st.d.file);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    selectFile(ids[next], { focusTab: true });
  }

  function paintFileFacts() {
    const d = st.d;
    const a = d && agentById(d.id);
    const facts = st.els.barHost.querySelector('.file-facts');
    if (!a || !facts) return;
    const f = a.files.find(x => x.id === d.file);
    const ago = facts.querySelector('[data-mtime]');
    if (ago && f && f.mtime) ago.textContent = `Edited ${fmt.ago(f.mtime)}`;
  }

  function paintPanel(a) {
    const d = st.d;
    const { barHost, codeHost, footHost } = st.els;
    const f = a.files.find(x => x.id === d.file);
    if (!f) return;
    if (!f.virtual && d.show === 'disk' && f.exists && !f.error) fetchFile(a, f);
    const view = viewFor(a, f);
    const shownText = view.kind === 'text' ? view.text : view.kind === 'diff' ? view.pf.diff.unified : null;

    // Bar: where the file is, its facts, how to look at it.
    const path = h('code', { class: 'file-path mono-id', translate: 'no' }, f.virtual ? 'Generated, not written to disk' : f.display_path,
      f.symlink_target ? h('span', { class: 'file-link' }, ` → ${f.symlink_target}`) : null);
    const facts = h('span', { class: 'file-facts meta' });
    if (!f.virtual && f.exists) {
      facts.append(h('span', { text: sizeText(f.size) }));
      if (f.mtime) facts.append(h('span', { 'data-mtime': '', 'data-tip': fmt.dateTime(f.mtime), text: `Edited ${fmt.ago(f.mtime)}` }));
      if (f.file_mode) facts.append(h('span', { translate: 'no', text: `mode ${f.file_mode}` }));
    } else if (f.virtual && shownText != null) {
      facts.append(h('span', { text: sizeText(new TextEncoder().encode(shownText).length) }));
    }
    const actions = h('div', { class: 'file-actions' });
    if (!f.virtual) {
      const seg = F.segmented('Show', SHOWS, d.show, setShow);
      seg.classList.add('segmented-sm', 'file-show');
      for (const b of seg.querySelectorAll('.seg')) b.setAttribute('data-focus-key', `show-${b.dataset.value}`);
      actions.append(seg);
    }
    const wrap = h('button', { type: 'button', class: 'code-btn', 'aria-pressed': String(st.wrap), 'data-focus-key': 'wrap' }, F.icon('stream'), h('span', { class: 'btn-label', text: 'Wrap' }));
    wrap.addEventListener('click', () => { st.wrap = !st.wrap; d.panelKey = null; paintDetail(); });
    const copy = h('button', { type: 'button', class: 'code-btn', 'aria-label': 'Copy the file as shown, with secrets hidden', 'data-focus-key': 'copy' }, F.icon('copy'), h('span', { class: 'btn-label', text: 'Copy' }));
    if (shownText == null) copy.setAttribute('aria-disabled', 'true');
    copy.addEventListener('click', () => { if (shownText != null) F.copy(shownText, copy); });
    actions.append(wrap, copy);
    if (!f.virtual) actions.append(F.iconBtn('files', 'Copy path', { cls: 'icon-btn-sm', 'data-focus-key': 'copy-path', onclick: (e) => F.copy(f.path, e.currentTarget) }));
    if (f.virtual && f.format === 'shell') {
      const masked = countSecrets(shownText);
      const dl = F.btn('Download launcher', { size: 'sm', icon: 'download', 'data-focus-key': 'download' });
      if (shownText == null || masked) {
        dl.setAttribute('aria-disabled', 'true');
        dl.setAttribute('data-tip', masked ? 'The launcher has hidden values, so it can\'t run as shown' : 'Waiting for the launcher');
      } else {
        dl.addEventListener('click', () => F.download('launch-cursor-deepseek.sh', shownText, 'text/x-shellscript'));
      }
      actions.append(dl);
    }
    keepFocus(() => barHost.replaceChildren(path, facts, actions));

    // Code: rebuilt only when what it shows changes, so scroll position survives repaints.
    const key = JSON.stringify([d.id, f.id, f.revision, d.show, view.kind, shownText, st.wrap, [...d.expanded], d.errorLine]);
    if (key !== d.panelKey) {
      d.panelKey = key;
      codeHost.classList.toggle('is-wrap', st.wrap);
      keepFocus(() => codeHost.replaceChildren(codeView(a, f, view)));
      markErrorLine(f);
    }

    const hidden = view.kind === 'text' && view.masked != null ? view.masked : countSecrets(shownText);
    footHost.replaceChildren(hidden ? h('p', { class: 'file-foot meta' }, F.icon('lock'), `${plural(hidden, 'value')} hidden. Secrets never leave this machine.`) : '');
  }

  function codeView(a, f, view) {
    const d = st.d;
    const showName = f.virtual ? 'generated' : SHOW_LABEL[d.show];
    switch (view.kind) {
      case 'loading': return codeSkeleton();
      case 'error': {
        const e = view.error;
        const retry = e instanceof F.ApiError && e.type !== 'file_too_large' && e.type !== 'file_not_text' && e.type !== 'file_outside_home'
          ? [F.btn('Retry', { size: 'sm', icon: 'reload', onclick: () => { d.cache.delete(`${f.id}@${f.revision}`); d.panelKey = null; paintDetail(); } })] : [];
        return h('div', { class: 'file-msg' }, F.notice('crit', `Can't show ${f.label}`, `${e.message}${e.type ? ` (${e.type})` : ''}`, retry));
      }
      case 'planerror':
        return h('div', { class: 'file-msg' }, F.notice('crit', 'No preview', F.errorText(d.planError)));
      case 'missing': {
        const o = opts();
        const writes = f.modes.includes(o.mode);
        const modeTitle = (v) => { const m = a.modes.find(x => x.value === v); return m ? m.title.toLowerCase() : v; };
        const text = writes
          ? `Applying ${modeTitle(o.mode)} creates it.`
          : `${a.name} only reads it when installed ${listText(f.modes.map(modeTitle))}.`;
        return h('div', { class: 'file-empty' }, F.icon('files'),
          h('p', { class: 'file-empty-title', translate: 'no', text: `${f.label} doesn't exist yet` }),
          h('p', { class: 'meta', text }),
          // The empty state goes away with the switch; focus lands on the view control it set.
          writes && planFile(f.id) ? F.btn('Show it after apply', { size: 'sm', kind: 'ghost', 'data-focus-key': 'empty-show-after', onclick: () => { setShow('after'); focusKey('show-after'); } }) : null);
      }
      case 'note':
        return h('div', { class: 'file-empty' }, F.icon('files'), h('p', { class: 'file-empty-title', text: view.title }), h('p', { class: 'meta', text: view.text }));
      case 'diff':
        return diffView(view.pf, f);
      default:
        return h('pre', { class: 'code-pre code-vs', tabindex: '0', 'data-focus-key': 'code', 'aria-label': `${f.virtual ? f.label : f.display_path}, ${showName}` },
          h('code', null, F.colorize(view.text, f.format, { secrets: true })));
    }
  }

  function markErrorLine(f) {
    const d = st.d;
    const el = d.errorLine;
    if (!el || el.fileId !== f.id || d.show !== 'disk') return;
    const line = st.els.codeHost.querySelector(`.code-vs > code > .vs-line:nth-child(${Number(el.line)})`);
    if (!line) return;
    line.classList.add('is-error');
    requestAnimationFrame(() => line.scrollIntoView({ block: 'center' }));
  }

  // Unified view of the plan's hunks. Unchanged runs between hunks fold into a button that
  // opens them from the masked "before" text the plan already carries.
  function diffView(pf, f) {
    const d = st.d;
    const pre = h('pre', { class: 'code-pre code-vs code-diff', tabindex: '0', 'data-focus-key': 'code', 'aria-label': `${f.display_path}, changes` });
    const before = pf.before == null ? [] : splitLines(pf.before);
    let delta = 0;
    let lastOld = 0;
    const gap = (from, to, key) => {
      if (to < from) return;
      if (d.expanded.has(key)) {
        for (let n = from; n <= to; n++) pre.append(diffLine(' ', before[n - 1], n, n + delta, f.format));
        return;
      }
      const btn = h('button', { type: 'button', class: 'df-gap', 'aria-expanded': 'false', 'data-focus-key': `gap-${key}`, text: `Show ${plural(to - from + 1, 'unchanged line')}` });
      // The button turns into the lines it hid; focus stays in the (rebuilt) code view.
      btn.addEventListener('click', () => { d.expanded.add(key); d.panelKey = null; paintDetail(); focusKey('code'); });
      pre.append(btn);
    };
    pf.diff.hunks.forEach((hk, i) => {
      const olds = hk.lines.filter(l => l.old != null).map(l => l.old);
      if (olds.length) gap(lastOld + 1, olds[0] - 1, `g${i}`);
      for (const l of hk.lines) pre.append(diffLine(l.op, l.text, l.old, l.new, f.format));
      for (const l of hk.lines) delta += l.op === '+' ? 1 : l.op === '-' ? -1 : 0;
      if (olds.length) lastOld = olds[olds.length - 1];
    });
    if (pf.diff.hunks.length && lastOld) gap(lastOld + 1, before.length, 'tail');
    return pre;
  }

  function diffLine(op, text, oldN, newN, lang) {
    const cls = op === '+' ? 'is-add' : op === '-' ? 'is-del' : 'is-ctx';
    const line = F.colorize(text, lang, { secrets: true })[0];
    return h('span', { class: ['df-line', cls] },
      h('span', { class: 'df-old', 'aria-hidden': 'true', text: oldN == null ? '' : String(oldN) }),
      h('span', { class: 'df-new', 'aria-hidden': 'true', text: newN == null ? '' : String(newN) }),
      h('span', { class: 'df-sign', 'aria-hidden': 'true', text: op === '+' ? '+' : op === '-' ? '−' : '' }),
      op === '+' ? h('span', { class: 'sr-only', text: 'Added: ' }) : op === '-' ? h('span', { class: 'sr-only', text: 'Removed: ' }) : null,
      h('span', { class: 'df-text' }, ...line.childNodes));
  }

  function paintRestore(a) {
    const host = st.els.restoreHost;
    host.hidden = !a.writable;
    if (!a.writable) return;
    if (!host.firstChild) {
      host.append(h('header', { class: 'settings-head' },
        h('h2', { class: 'settings-title', id: 'agent-restore-title', text: 'Restore points' }),
        h('p', { class: 'settings-desc', text: 'The newest backups that include this agent. Restoring puts every file in a backup back.' })),
      h('div', { class: 'set-stack agent-restore-list' }),
      h('a', { class: 'link agents-all-backups', href: F.hashFor('agents', '', { section: 'backups' }), text: 'All restore points' }));
    }
    paintBackupList(host.querySelector('.agent-restore-list'), a.id);
  }

  // ---------------------------------------------------------------- keyboard
  function onKey(e) {
    if (st.d) {
      const a = agentById(st.d.id);
      if (!a) return false;
      if (e.key === '[' || e.key === ']') {
        const ids = a.files.map(f => f.id);
        const i = ids.indexOf(st.d.file);
        selectFile(ids[(i + (e.key === ']' ? 1 : -1) + ids.length) % ids.length], { focusTab: true });
        return true;
      }
      if (e.key === 'd') {
        const f = a.files.find(x => x.id === st.d.file);
        if (!f || f.virtual) return false;
        setShow(st.d.show === 'diff' ? 'disk' : 'diff');
        return true;
      }
      return false;
    }
    if (!st.data || !['j', 'k', 'Enter'].includes(e.key)) return false;
    const ids = st.data.agents.map(a => a.id);
    if (e.key === 'Enter') {
      if (!st.cursor) return false;
      F.navigate('agents', st.cursor);
      return true;
    }
    const i = ids.indexOf(st.cursor);
    st.cursor = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === 'j' ? 1 : -1)))];
    paintRoster();
    const rowEl = st.els.roster.querySelector(`[data-id="${CSS.escape(st.cursor)}"]`);
    if (rowEl) rowEl.focus();
    return true;
  }

  function onEscape() {
    if (!st.d) return false;
    if (document.activeElement === st.els.base) { st.els.base.blur(); return true; }
    F.navigate('agents');
    return true;
  }

  // ---------------------------------------------------------------- view
  function show(route) {
    st.visible = true;
    const id = route.sub;
    const p = route.params || {};
    const scroller = document.getElementById('scroll');
    if (!id) {
      const back = st.d ? st.d.id : null;
      if (st.d) leaveDetail();
      st.scrollTo = p.section === 'backups' ? 'backups' : null;
      paint();
      // Back from an agent's page: the list is where it was, focus on that agent's row.
      if (back) {
        scroller.scrollTop = st.overviewScroll || 0;
        requestAnimationFrame(() => focusKey(`row-${back}`));
      }
      markScrolled();
      load();
      return;
    }
    if (!META[id]) {
      F.toast(`Unknown agent ${id}`, { tone: 'warn' });
      if (st.d) leaveDetail();
      F.replaceHash('agents');
      paint();
      load();
      return;
    }
    const fresh = !st.d || st.d.id !== id;
    if (fresh) {
      if (!st.d) st.overviewScroll = scroller.scrollTop;
      scroller.scrollTop = 0;
      if (st.d) leaveDetail();
      st.d = newDetail(id);
      st.d.focusTitle = true;
      st.els.base.value = '';
      st.els.restoreHost.replaceChildren();
    } else {
      // Same agent, new params (history, palette "Files: …"): the route is the whole truth.
      st.d.override = {};
      st.d.file = null;
      st.d.show = 'disk';
    }
    st.d.params = p;
    st.cursor = id;
    // Apply the route's picks now so nothing flickers; load() reads the files and plans.
    if (st.data && !st.error && !resolveDetail()) return;
    paint();
    markScrolled();
    load();
  }

  function leaveDetail() {
    const d = st.d;
    clearTimeout(d.planTimer);
    if (d.planCtl) d.planCtl.abort();
    st.d = null;
  }

  F.views.agents = {
    title: () => (st.d ? nameOf(st.d.id) : 'Agents'),
    live: false,
    mount,
    show,
    hide() {
      st.visible = false;
      document.getElementById('app').classList.remove('agents-scrolled');
      if (st.d) leaveDetail();
    },
    actions() {
      const refresh = F.btn('Refresh', { icon: 'reload', title: 'Read the files again' });
      refresh.addEventListener('click', async () => {
        if (refresh.getAttribute('aria-busy') === 'true') return;
        F.setPending(refresh, 'Refreshing…');
        if (st.d) { st.d.cache.clear(); st.d.panelKey = null; }
        try { await load(); } finally { F.clearPending(refresh); }
      });
      if (!st.d) return [refresh];
      return [F.btn('All agents', { kind: 'ghost', icon: 'chevron-left', onclick: () => F.navigate('agents') }), refresh];
    },
    onKey,
    onEscape,
    catalog: () => AGENTS.map(m => {
      const a = agentById(m.id);
      return { id: m.id, name: a ? a.name : m.name, state: a ? stateOf(a.setup.state).label : null };
    }),
    get filterInput() { return null; },
  };
})();
