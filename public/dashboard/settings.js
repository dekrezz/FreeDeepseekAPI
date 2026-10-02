// FreeDeepseekAPI dashboard: Settings view.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;

  const PREFS = {
    material: { key: 'fdsa.material', attr: 'data-material', values: ['system', 'glass', 'solid'] },
    density: { key: 'fdsa.density', attr: 'data-density', values: ['comfortable', 'compact'] },
  };

  F.prefs = {
    get(name) {
      const p = PREFS[name];
      let v = null;
      try { v = localStorage.getItem(p.key); } catch (e) { /* storage blocked */ }
      return p.values.includes(v) ? v : p.values[0];
    },
    set(name, value) {
      const p = PREFS[name];
      try { localStorage.setItem(p.key, value); } catch (e) { F.toast(`Could not save the ${name} preference: ${e.name}`, { tone: 'error' }); }
      F.prefs.apply(name, value);
    },
    apply(name, value) {
      const p = PREFS[name];
      const root = document.documentElement;
      if (value === p.values[0] && name !== 'density') root.removeAttribute(p.attr);
      else root.setAttribute(p.attr, value);
    },
    applyAll() { for (const name of Object.keys(PREFS)) F.prefs.apply(name, F.prefs.get(name)); },
  };
  F.prefs.applyAll();

  const st = { root: null, els: {}, health: null, healthError: null, visible: false, snippet: 'openai' };

  function mount(root) {
    st.root = root;
    const key = h('div', { class: 'set-group' });
    const conn = h('div', { class: 'set-stack' });
    const server = h('div', { class: 'set-stack' });
    const appearance = h('div', { class: 'set-group' });
    const chat = h('div', { class: 'set-stack' });
    root.append(h('div', { class: 'view-pad settings' },
      section('Access key', 'Sent as a Bearer header to the admin API and to /v1. Kept in this tab only (sessionStorage), never in localStorage.', key),
      section('Connection', 'Point any OpenAI- or Anthropic-compatible client at this proxy.', conn),
      section('Server', 'Facts from GET /health.', server),
      section('Appearance', null, appearance),
      section('Chat data', `Stored in this browser only, for ${location.origin}. 127.0.0.1 and localhost keep separate stores.`, chat)));
    Object.assign(st.els, { key, conn, server, appearance, chat });
    F.on('accounts', () => { if (st.visible) renderServer(); });
  }

  function section(title, lead, body) {
    return h('section', { class: 'settings-section' },
      h('header', { class: 'settings-head' }, h('h2', { class: 'settings-title', text: title }), lead ? h('p', { class: 'settings-desc', text: lead }) : null),
      body);
  }

  // One settings row: label (and an optional hint) on the left, the control or value on the right.
  function row(label, hint, control, cls, icon) {
    return h('div', { class: ['set-row', cls, icon && 'has-icon'] },
      icon ? h('span', { class: 'set-icon', 'aria-hidden': 'true' }, F.icon(icon)) : null,
      h('div', { class: 'set-text' }, h('span', { class: 'set-label', text: label }), hint ? (hint instanceof Node ? hint : h('span', { class: 'set-hint', text: hint })) : null),
      control == null || control === '' ? null : h('div', { class: 'set-control' }, control instanceof Node ? control : String(control)));
  }

  function renderKey() {
    const has = Boolean(F.key.get());
    const input = h('input', { type: 'password', class: 'input', id: 'settings-key', autocomplete: 'off', spellcheck: 'false', placeholder: has ? 'Replace the stored key' : 'PROXY_API_KEY' });
    const save = F.btn(has ? 'Replace' : 'Save key', { kind: 'primary', type: 'submit' });
    const form = h('form', { class: 'set-form' }, h('label', { class: 'sr-only', for: 'settings-key', text: 'Access key' }), input, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      try { F.key.set(v); } catch (err) { F.toast(`Could not store the key: ${err.name}`, { tone: 'error' }); return; }
      input.value = '';
      F.toast('Saved the key for this tab.', { tone: 'success' });
      F.refresh();
      render();
    });
    const state = h('span', { class: 'set-hint set-state' }, F.lamp(has ? 'ready' : 'disabled'),
      has ? 'A key is stored for this tab only.' : 'No key stored. Keyless access works only from this machine when PROXY_API_KEY is not set.');
    const forget = has ? F.btn('Forget key', { kind: 'ghost', icon: 'key', onclick: () => { F.key.clear(); F.toast('Forgot the key. Admin calls now go without one.'); F.refresh(); render(); } }) : null;
    st.els.key.replaceChildren(
      row('Key for this tab', state, forget),
      h('div', { class: 'set-row set-row-form' }, form));
  }

  // ---------------------------------------------------------------- code colouring
  // A small VS Code Dark+ style tokenizer for the Connection examples (Python and shell).
  // Each line becomes a .vs-line so CSS can draw line numbers that copy never picks up.
  const TOKENS = {
    Python: /(#.*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(from|import|as|return|if|elif|else|for|while|in|with|try|except)\b|\b(def|class|None|True|False|lambda)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([A-Za-z_]\w*)(?=\()|\b([A-Za-z_]\w*)\b/g,
    Shell: /(#.*)|('[^']*'|"(?:\\.|[^"\\])*")|(^\s*[a-z][\w-]*)|((?:^|\s)-{1,2}[A-Za-z][\w-]*)|(\\$)|(\$[A-Z_][A-Z0-9_]*)/g,
  };
  const KINDS = {
    Python: ['com', 'str', 'ctrl', 'kw', 'num', 'cls', 'fn', 'var'],
    Shell: ['com', 'str', 'fn', 'kw', 'esc', 'var'],
  };
  function colorize(code, lang) {
    const re = TOKENS[lang];
    return code.split('\n').map((line) => {
      const el = h('span', { class: 'vs-line' });
      if (!re) { el.append(line); return el; }
      re.lastIndex = 0;
      let at = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const g = m.findIndex((v, i) => i > 0 && v !== undefined);
        if (m.index > at) el.append(line.slice(at, m.index));
        el.append(h('span', { class: `tk-${KINDS[lang][g - 1]}`, text: m[0] }));
        at = m.index + m[0].length;
      }
      if (at < line.length) el.append(line.slice(at));
      if (!line) el.append('\u200b');
      return el;
    });
  }

  function renderConn() {
    const base = location.origin;
    const keyRef = '$PROXY_API_KEY';
    const snippets = {
      openai: { label: 'OpenAI SDK', lang: 'Python', code: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="${keyRef}")\nreply = client.chat.completions.create(\n    model="deepseek-v4-flash",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(reply.choices[0].message.content)` },
      anthropic: { label: 'Anthropic SDK', lang: 'Python', code: `from anthropic import Anthropic\n\nclient = Anthropic(base_url="${base}", api_key="${keyRef}")\nreply = client.messages.create(\n    model="deepseek-v4-flash",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(reply.content[0].text)` },
      curl: { label: 'curl', lang: 'Shell', code: `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${keyRef}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'` },
    };
    const lang = h('span', { class: 'code-lang' });
    const code = h('code');
    const copy = h('button', { type: 'button', class: 'code-btn' }, F.icon('copy'), h('span', { class: 'btn-label', text: 'Copy' }));
    copy.addEventListener('click', () => F.copy(snippets[st.snippet].code, copy));
    const show = (name) => {
      st.snippet = name;
      lang.textContent = snippets[name].lang;
      code.replaceChildren(...colorize(snippets[name].code, snippets[name].lang));
      copy.setAttribute('aria-label', `Copy the ${snippets[name].label} example`);
    };
    const tabs = F.segmented('Client example', Object.entries(snippets).map(([value, s]) => ({ value, label: s.label })), st.snippet, show);
    tabs.classList.add('segmented-sm');
    show(st.snippet);
    const urlValue = h('span', { class: 'set-url' }, h('code', { class: 'mono-id', text: `${base}/v1` }), F.copyBtn(`${base}/v1`, 'Copy base URL'));
    st.els.conn.replaceChildren(
      h('div', { class: 'set-group' }, row('Base URL', 'OpenAI-style clients use /v1. Anthropic SDKs take the origin without /v1.', urlValue)),
      h('div', { class: 'codeblock set-code' },
        h('div', { class: 'code-head' }, tabs, h('span', { class: 'code-actions' }, lang, copy)),
        h('pre', { class: 'code-pre code-vs', tabindex: '0' }, code)),
      h('p', { class: 'settings-foot', text: 'Opening this dashboard or calling the proxy from a browser on another machine needs that page\'s origin in PROXY_CORS_ORIGINS, or the proxy answers 403 cors_error.' }));
  }

  async function loadHealth() {
    try {
      st.health = await F.api('GET', '/health');
      st.healthError = null;
    } catch (e) {
      st.healthError = e;
    }
    renderServer();
  }

  function renderServer() {
    const host = st.els.server;
    if (st.healthError) { host.replaceChildren(F.notice('crit', 'GET /health failed', F.errorText(st.healthError))); return; }
    const hl = st.health;
    if (!hl) { host.replaceChildren(h('div', { class: 'set-group' }, row('Status', null, h('span', { class: 'quiet', text: 'Loading…' }), null, 'live'))); return; }
    if (!hl.models) {
      host.replaceChildren(h('div', { class: 'set-group' }, row('Status', `The proxy answered "${hl.status}". Details need the access key.`, hl.status, null, 'live')));
      return;
    }
    const pool = F.store.accounts && F.store.accounts.pool;
    const sr = hl.session_reuse || {};
    const withLamp = (state, text) => h('span', { class: 'set-lamp' }, F.lamp(state), text);
    const canServe = pool ? pool.can_serve : null;
    host.replaceChildren(
      h('div', { class: 'set-group' }, ...[
        row('Status', null, withLamp(hl.status === 'ok' ? 'ready' : 'error', hl.status), null, 'live'),
        row('Accounts', null, pool ? withLamp(canServe > 0 ? 'ready' : 'error', `${pool.total} loaded, ${canServe} can serve`) : `${(hl.accounts || []).length} loaded`, null, 'accounts'),
        row('Requests in flight', null, fmt.int(hl.in_flight), null, 'stream'),
        row('Client sessions', null, fmt.int(hl.agents), null, 'chat'),
        row('Session lifetime', null, sr.ttl_minutes != null ? `${sr.ttl_minutes} min, at most ${sr.max_messages} messages` : '—', null, 'latency'),
        hl.config_ready === false ? row('Auth config', null, h('span', { class: 'is-crit-text', text: 'not ready' }), null, 'alert') : null,
      ].filter(Boolean)),
      modelTable(hl.models || []));
  }

  // Models the proxy serves. DeepThink and Search come from the -thinking / -search suffixes.
  function modelTable(models) {
    const tag = (icon, text) => h('span', { class: 'model-tag' }, F.icon(icon), text);
    return h('div', { class: 'set-group model-table' },
      h('div', { class: 'model-head' },
        h('span', { class: 'set-label', text: 'Models' }),
        h('span', { class: 'set-hint', text: `${models.length} available` })),
      h('ul', { class: 'model-rows', role: 'list' }, models.map(m => h('li', { class: 'model-row' },
        h('img', { class: 'model-logo', src: '/dashboard/logo.png', alt: '', width: '20', height: '20' }),
        h('code', { class: 'model-id mono-id', text: m }),
        h('span', { class: 'model-tags' },
          /-thinking(?:-|$)/.test(m) ? tag('think', 'DeepThink') : null,
          /-search(?:-|$)/.test(m) ? tag('search-web', 'Search') : null),
        F.copyBtn(m, `Copy ${m}`)))));
  }

  function renderAppearance() {
    const pref = (label, hint, name, options) => row(label, hint, F.segmented(label, options, F.prefs.get(name), (v) => F.prefs.set(name, v)));
    st.els.appearance.replaceChildren(
      pref('Material', 'System follows the reduced-transparency setting of your OS.', 'material', [{ value: 'system', label: 'System' }, { value: 'glass', label: 'Glass', icon: 'material' }, { value: 'solid', label: 'Solid' }]),
      pref('Density', null, 'density', [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]));
  }

  async function renderChat() {
    const host = st.els.chat;
    const info = F.chatStore ? await F.chatStore.stats() : null;
    let est = null;
    try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { est = null; }
    const exportBtn = F.btn('Export', { icon: 'download', onclick: async () => {
      try { F.download(`fdsa-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await F.chatStore.exportAll(), null, 2)); }
      catch (e) { F.toast(`Export failed: ${e.message}`, { tone: 'error' }); }
    } });
    const delBtn = F.btn('Delete all…', { kind: 'danger-text', icon: 'trash' });
    delBtn.addEventListener('click', () => F.confirm(delBtn, {
      text: `Delete ${info ? `all ${fmt.int(info.conversations)}` : 'all'} conversations stored in this browser for ${location.origin}? This can't be undone.`,
      confirmLabel: 'Delete all',
      pendingLabel: 'Deleting…',
      async run() { await F.chatStore.deleteAll(); F.toast('Deleted all conversations.', { tone: 'success' }); renderChat(); },
    }));
    host.replaceChildren(
      h('div', { class: 'set-group' },
        row('Conversations', null, info ? fmt.int(info.conversations) : '—'),
        row('Messages', null, info ? fmt.int(info.messages) : '—'),
        row('Storage', info && info.mode === 'memory' ? 'Not saved: IndexedDB is unavailable in this browser mode.' : null,
          info && info.mode === 'memory' ? null : est ? `${fmt.compact(est.usage / 1024)} KB of about ${fmt.compact(est.quota / 1048576)} MB` : 'IndexedDB')),
      h('div', { class: 'set-group' },
        row('Export all conversations', 'Downloads every conversation in this browser as one JSON file.', exportBtn),
        row('Delete all conversations', 'Removes them from this browser. This can\'t be undone.', delBtn)));
  }

  function render() {
    renderKey();
    renderConn();
    renderServer();
    renderAppearance();
    renderChat();
  }

  F.views.settings = {
    title: 'Settings',
    live: false,
    mount,
    show() { st.visible = true; render(); loadHealth(); },
    hide() { st.visible = false; },
  };
})();
