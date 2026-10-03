// FreeDeepseekAPI dashboard: Chat view + IndexedDB conversation store.
//
// Server facts this file is built around (see API.md):
// - The reply is generated in full before the SSE stream starts, so the stream
//   arrives as one burst. The UI shows a pending state with elapsed time.
// - The server keeps a sticky remote thread per x-agent-session and only forwards
//   turns after the last assistant message. Regenerate, edit, retry and the first
//   send after a Stop reset that session first (POST /reset-session).
// - The client keeps the full transcript and always sends it.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;

  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_IMAGES = 10;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_BODY_CHARS = 29 * 1024 * 1024;
  const SLOW_HINT_MS = 20000;
  const BURST_MS = 400;

  // ================================================================ storage
  const DB_NAME = 'fdsa-chat';
  const DB_VERSION = 1;

  const store = {
    mode: 'idb',
    db: null,
    unavailableReason: null,
    mem: { convs: new Map(), msgs: new Map() },

    async open() {
      if (!('indexedDB' in window)) { this.toMemory('IndexedDB is not available in this browser'); return; }
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' }).createIndex('convId', 'convId');
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('open failed'));
          req.onblocked = () => reject(new Error('Another tab is upgrading the chat database. Close other dashboard tabs and reload.'));
        });
        this.db.onversionchange = () => { this.db.close(); this.toMemory('The chat database was changed by another tab. Reload this tab.'); };
      } catch (e) {
        this.toMemory(`IndexedDB could not open (${e.name || 'Error'}: ${e.message})`);
      }
    },
    toMemory(reason) {
      this.mode = 'memory';
      this.db = null;
      this.unavailableReason = reason;
      renderBanners();
    },
    tx(names, mode, fn) {
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(names, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new DOMException('Transaction aborted', 'AbortError'));
        result = fn(t);
      });
    },
    req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); },

    async allConversations() {
      if (this.mode === 'memory') return Array.from(this.mem.convs.values());
      return this.req(this.db.transaction('conversations').objectStore('conversations').getAll());
    },
    async messages(convId) {
      if (this.mode === 'memory') return (this.mem.msgs.get(convId) || []).slice();
      const rows = await this.req(this.db.transaction('messages').objectStore('messages').index('convId').getAll(convId));
      return rows.sort((a, b) => a.seq - b.seq);
    },
    async putConversation(conv) {
      if (this.mode === 'memory') { this.mem.convs.set(conv.id, conv); return; }
      await this.tx(['conversations'], 'readwrite', t => t.objectStore('conversations').put(conv));
    },
    async putMessage(msg) {
      if (this.mode === 'memory') {
        const list = this.mem.msgs.get(msg.convId) || [];
        const i = list.findIndex(m => m.id === msg.id);
        if (i >= 0) list[i] = msg; else list.push(msg);
        this.mem.msgs.set(msg.convId, list);
        return;
      }
      await this.tx(['messages'], 'readwrite', t => t.objectStore('messages').put(msg));
    },
    async deleteMessages(convId, ids) {
      if (this.mode === 'memory') {
        this.mem.msgs.set(convId, (this.mem.msgs.get(convId) || []).filter(m => !ids.includes(m.id)));
        return;
      }
      await this.tx(['messages'], 'readwrite', t => { const os = t.objectStore('messages'); for (const id of ids) os.delete(id); });
    },
    async deleteConversation(id) {
      if (this.mode === 'memory') { this.mem.convs.delete(id); this.mem.msgs.delete(id); return; }
      await this.tx(['conversations', 'messages'], 'readwrite', t => {
        t.objectStore('conversations').delete(id);
        const idx = t.objectStore('messages').index('convId');
        idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
          const c = e.target.result;
          if (c) { t.objectStore('messages').delete(c.primaryKey); c.continue(); }
        };
      });
    },
    async deleteAll() {
      await ready;
      if (this.mode === 'memory') { this.mem.convs.clear(); this.mem.msgs.clear(); }
      else await this.tx(['conversations', 'messages'], 'readwrite', t => { t.objectStore('conversations').clear(); t.objectStore('messages').clear(); });
      for (const run of S.runs.values()) run.controller.abort();
      S.convs.clear();
      S.msgs.clear();
      S.quota = false;
      if (S.visible) F.navigate('chat');
      renderList();
      renderBanners();
    },
    // Settings can render before IndexedDB has opened; wait for it rather than report zeros.
    async stats() {
      await ready;
      if (this.mode === 'memory') {
        let n = 0;
        for (const l of this.mem.msgs.values()) n += l.length;
        return { mode: 'memory', conversations: this.mem.convs.size, messages: n };
      }
      const [c, m] = await Promise.all([
        this.req(this.db.transaction('conversations').objectStore('conversations').count()),
        this.req(this.db.transaction('messages').objectStore('messages').count()),
      ]);
      return { mode: 'idb', conversations: c, messages: m };
    },
    async exportAll() {
      await ready;
      const convs = await this.allConversations();
      const out = [];
      for (const c of convs) out.push({ conversation: c, messages: await this.messages(c.id) });
      return { exported_at: new Date().toISOString(), origin: location.origin, conversations: out };
    },
  };
  F.chatStore = store;

  // Persist with loud failures. History in memory is never dropped.
  async function persist(fn) {
    try {
      await fn();
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') { S.quota = true; renderBanners(); }
      else F.toast(`Couldn't save the conversation: ${e && e.name ? `${e.name}: ` : ''}${e && e.message}`, { tone: 'error' });
    }
  }
  const saveConv = (conv) => persist(() => store.putConversation(conv));
  const saveMsg = (msg) => persist(() => store.putMessage(msg));

  // ================================================================ state
  const S = {
    root: null, els: {}, visible: false,
    convs: new Map(),
    msgs: new Map(),           // convId -> messages (loaded)
    activeId: null,
    runs: new Map(),           // convId -> { controller, startedAt, msgId }
    models: { loaded: false, error: null, ids: new Set(), base: null, caps: {}, capsError: null, list: [] },
    think: false, search: true,
    attachments: [],
    pendingDeletes: new Map(),
    quota: false,
    search_q: '',
    turnEls: new Map(),        // msgId -> li
    unknownId: null,
    loadingConv: null,
  };

  const active = () => (S.activeId ? S.convs.get(S.activeId) : null);
  const msgsOf = (id) => S.msgs.get(id) || [];
  const agentFor = (conv) => `dashboard:${conv.id}`;

  // ================================================================ models
  function parseModel(id) {
    // Search is on unless the id says -nosearch (old -search ids also mean on).
    return { think: /-thinking(-|$)/.test(id), search: !/-nosearch$/.test(id) };
  }
  function modelFor(think, search) {
    const base = S.models.base;
    if (!base) return null;
    return `${base}${think ? '-thinking' : ''}${search ? '' : '-nosearch'}`;
  }
  function modelAvailable(id) { return Boolean(id) && S.models.ids.has(id); }
  function unavailableReason(id) {
    if (!S.models.loaded) return 'Models are loading';
    if (S.models.error) return `Models couldn't load: ${S.models.error.message}`;
    const cap = S.models.caps[id];
    if (cap && cap.unavailable_reason) return `${id}: ${cap.unavailable_reason}`;
    if (S.models.capsError) return `${id} is not offered by this server (capabilities failed: ${S.models.capsError.message})`;
    return `${id} is not offered by this server`;
  }
  function currentModel() { return modelFor(S.think, S.search); }

  async function loadModels() {
    try {
      const body = await F.api('GET', '/v1/models');
      const list = (body.data || []).map(m => m.id);
      if (!list.length) throw new F.ApiError('GET /v1/models returned no models.', { type: 'no_models' });
      S.models.list = body.data;
      S.models.ids = new Set(list);
      // base = an id whose -thinking or -nosearch variant exists; else the shortest id
      S.models.base = list.find(id => !/-thinking|-nosearch/.test(id) && (S.models.ids.has(`${id}-thinking`) || S.models.ids.has(`${id}-nosearch`)))
        || list.slice().sort((a, b) => a.length - b.length)[0];
      S.models.error = null;
    } catch (e) {
      if (F.handleGate(e)) {
        // Retry after the key gate is unlocked (the shell re-shows the view).
        S.modelsLoading = false;
        renderComposer();
        return;
      }
      S.models.error = e;
    }
    try {
      const caps = await F.api('GET', '/v1/model-capabilities');
      S.models.caps = caps.data || {};
      S.models.capsError = null;
    } catch (e) {
      S.models.capsError = e;
    }
    S.models.loaded = true;
    // keep toggles valid
    if (!modelAvailable(currentModel())) { S.think = false; S.search = true; }
    renderComposer();
    renderEmpty();
  }

  // ================================================================ view
  function mount(root) {
    S.root = root;
    const banners = h('div', { class: 'chat-banners' });
    const emptyTitle = h('h2', { class: 'chat-empty-title' },
      h('img', { class: 'chat-empty-mark', src: '/dashboard/logo.png', alt: '', width: '40', height: '40' }),
      h('span', { text: 'What should we work on?' }));
    const emptyLine = h('p', { class: 'chat-empty-line' });
    const empty = h('div', { class: 'chat-empty' }, emptyTitle, emptyLine);
    const unknown = h('div', { class: 'chat-unknown', hidden: true });
    const transcript = h('ol', { class: 'transcript', 'aria-label': 'Conversation' });
    const scroll = h('div', { class: 'chat-scroll', id: 'chat-scroll', tabindex: '-1' }, h('div', { class: 'chat-inner' }, banners, unknown, transcript));

    const textarea = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Message DeepSeek through this proxy…', 'aria-label': 'Message', spellcheck: 'true' });
    const thumbs = h('div', { class: 'attach-row', hidden: true });
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    const attachBtn = F.iconBtn('plus', 'Attach images', { onclick: () => fileInput.click() });
    // Under the box, Claude-style: model and mode on the right (the account is in its menu).
    const modelName = h('span', { class: 'meta-btn-label' });
    const modelMode = h('span', { class: 'meta-btn-detail' });
    const modelBtn = h('button', { type: 'button', class: 'meta-btn meta-btn-model', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, modelName, modelMode);
    const meta = h('div', { class: 'composer-meta' }, h('div', { class: 'composer-meta-left' }), h('div', { class: 'composer-meta-right' }, modelBtn));
    const sendBtn = h('button', { type: 'submit', class: 'send-btn', 'aria-label': 'Send' },
      h('span', { class: 'send-icon send-icon-send' }, F.icon('send')),
      h('span', { class: 'send-icon send-icon-stop' }, F.icon('stop')));
    const form = h('form', { class: 'composer glass glass-regular', 'aria-label': 'Message composer' },
      thumbs, textarea,
      h('div', { class: 'composer-row' },
        h('div', { class: 'composer-left' }, attachBtn),
        h('div', { class: 'composer-right' }, sendBtn)));
    const note = h('p', { class: 'composer-note', role: 'status' });
    const dock = h('div', { class: 'composer-dock' }, empty, form, meta, note, fileInput);
    root.append(scroll, dock);
    Object.assign(S.els, { banners, empty, emptyTitle, emptyLine, unknown, transcript, scroll, textarea, thumbs, fileInput, attachBtn, modelBtn, modelName, modelMode, sendBtn, form, note, dock });

    // composer behaviour
    const grow = () => {
      textarea.style.setProperty('height', 'auto');
      textarea.style.setProperty('height', `${Math.min(textarea.scrollHeight, Math.round(innerHeight * 0.4))}px`);
    };
    textarea.addEventListener('input', () => { grow(); setNote(''); renderComposer(); });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
      else if (e.key === 'ArrowUp' && !textarea.value && !S.attachments.length) {
        const conv = active();
        const lastUser = conv && msgsOf(conv.id).filter(m => m.role === 'user').pop();
        if (lastUser && !S.runs.has(conv.id)) { e.preventDefault(); startEdit(lastUser); }
      }
    });
    textarea.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData ? e.clipboardData.files : []).filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); const conv = active(); if (conv && S.runs.has(conv.id)) stop(conv); else submit(); });
    form.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); form.classList.add('is-over'); } });
    form.addEventListener('dragleave', () => form.classList.remove('is-over'));
    form.addEventListener('drop', (e) => { e.preventDefault(); form.classList.remove('is-over'); addFiles(Array.from(e.dataTransfer.files)); });
    fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
    modelBtn.addEventListener('click', () => openModelMenu(modelBtn));
    F.on('chat-account', () => renderComposer());
    F.on('accounts', () => renderComposer());
    S.grow = grow;

    // title rename by double-click
    document.getElementById('view-title').addEventListener('dblclick', () => { if (S.visible && active()) renameInline(); });

    // sidebar list
    const search = document.getElementById('chat-search');
    search.addEventListener('input', () => { S.search_q = search.value.trim().toLowerCase(); renderList(); });

    F.on('accounts', () => { if (S.visible) renderEmpty(); });
    F.on('chat-account', () => { if (S.visible) renderEmpty(); });
    F.on('poll', () => { if (S.visible) renderComposer(); });
    F.on('tick', tick);
    S.ro = new ResizeObserver(() => syncDockSpace());
    S.ro.observe(dock);
  }

  // Bottom padding of the transcript follows the composer height.
  function syncDockSpace() {
    if (!S.els.dock) return;
    const hgt = S.els.form.getBoundingClientRect().height + 48;
    // The open-chat backdrop (.view-chat::before) keeps the Earth limb above the composer.
    // Layout offsets, not rects: the composer may be mid-FLIP (transformed) when this runs.
    S.els.dock.parentElement.style.setProperty('--dock-top', `${S.els.dock.offsetHeight - S.els.form.offsetTop}px`);
    S.els.scroll.style.setProperty('--dock-h', `${Math.round(hgt)}px`);
  }

  function setNote(text, tone, fromReason = false) {
    S.noteFromReason = fromReason && Boolean(text);
    S.els.note.textContent = text || '';
    S.els.note.className = `composer-note${tone ? ` is-${tone}` : ''}`;
  }

  // Modes are model variants on this server: base, -thinking, and their -nosearch twins.
  // Web search is on by default; the menu has a separate switch to turn it off.
  const MODES = [
    { think: false, title: 'Instant', desc: 'Direct answers, fastest' },
    { think: true, title: 'DeepThink', desc: 'Reasons step by step before answering' },
  ];
  const modeLabel = (think, search) => `${MODES.find(m => m.think === think).title}${search ? '' : ' · No search'}`;
  // "deepseek-v4-flash" → "V4 Flash": the id, made readable, nothing invented.
  const baseName = () => String(S.models.base || '').replace(/^deepseek-/i, '').split('-').filter(Boolean)
    .map(w => (/^v\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');

  function setMode(think, search) {
    const id = modelFor(think, search);
    if (!modelAvailable(id)) { setNote(unavailableReason(id), 'crit'); return; }
    S.think = think;
    S.search = search;
    const conv = active();
    if (conv) { conv.model = id; saveConv(conv); }
    try { localStorage.setItem('fdsa.chat.model', id); } catch (e) { /* preference only */ }
    renderComposer();
    renderEmpty();
  }

  function openModelMenu(trigger) {
    const list = h('div', { class: 'menu model-menu', role: 'menu', 'aria-label': 'Model' });
    const blocked = sendBlockReason();
    if (!S.models.loaded || S.models.error) {
      list.append(h('p', { class: 'meta model-menu-note', text: blocked || 'Loading models…' }));
    } else {
      for (const mode of MODES) {
        const id = modelFor(mode.think, S.search);
        const ok = modelAvailable(id);
        const checked = S.think === mode.think;
        const b = h('button', {
          type: 'button', role: 'menuitemradio', class: 'menu-item model-item', 'aria-checked': String(checked),
          'aria-disabled': ok ? null : 'true', 'data-tip': ok ? id : unavailableReason(id),
        },
          h('span', { class: 'model-text' }, h('span', { class: 'model-title', text: mode.title }), h('span', { class: 'model-desc', text: mode.desc })),
          checked ? F.icon('check', 'model-check') : null);
        b.addEventListener('click', () => { if (!ok) return; F.closePopover(); setMode(mode.think, S.search); });
        list.append(b);
      }
      list.append(h('div', { class: 'menu-sep', role: 'separator' }));
      const searchId = modelFor(S.think, !S.search);
      const searchOk = modelAvailable(searchId);
      const sw = h('button', {
        type: 'button', role: 'menuitemcheckbox', class: 'menu-item model-item', 'aria-checked': String(S.search),
        'aria-disabled': searchOk ? null : 'true', 'data-tip': searchOk ? searchId : unavailableReason(searchId),
      },
        h('span', { class: 'model-text' }, h('span', { class: 'model-title', text: 'Web search' }), h('span', { class: 'model-desc', text: 'Answers with live results from the web' })),
        S.search ? F.icon('check', 'model-check') : null);
      sw.addEventListener('click', () => { if (!searchOk) return; F.closePopover(); setMode(S.think, !S.search); });
      list.append(sw);
    }
    list.append(h('div', { class: 'menu-sep', role: 'separator' }));
    const acct = h('button', { type: 'button', role: 'menuitem', class: 'menu-item model-row' },
      h('span', { class: 'model-row-label', text: 'Account' }),
      h('span', { class: 'model-row-value', text: chatAccountLabel() }),
      F.icon('chevron-right', 'model-row-chev'));
    acct.addEventListener('click', () => {
      F.closePopover(false);
      if (!F.openAccountMenu) throw new Error('The account switcher (app.js) did not load.');
      F.openAccountMenu(trigger);
    });
    list.append(acct);
    list.addEventListener('keydown', (e) => {
      const btns = Array.from(list.querySelectorAll('.menu-item'));
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
    F.popover(trigger, list, { width: 300, align: 'start', role: 'presentation', label: 'Model' });
  }

  function chatAccountLabel() {
    const pinned = F.chatAccount ? F.chatAccount.get() : '';
    if (!pinned) return 'Automatic';
    const a = F.store.accounts && F.store.accounts.accounts.find(x => x.id === pinned);
    return a ? (a.name || a.id) : pinned;
  }


  function sendBlockReason() {
    if (!S.models.loaded) return 'Loading models…';
    if (S.models.error) return `Models couldn't load: ${S.models.error.message}. Send is disabled.`;
    const err = F.store.error;
    if (err && err.type === 'network') return err.message;
    if (F.gate.mode) return 'Unlock the dashboard first.';
    return null;
  }

  function renderComposer() {
    if (!S.els.form) return;
    const { modelBtn, modelName, modelMode, sendBtn, textarea, attachBtn } = S.els;
    const conv = active();
    const running = conv && S.runs.has(conv.id);
    const id = currentModel();
    if (!S.models.loaded) { modelName.textContent = 'Loading models…'; modelMode.textContent = ''; }
    else if (S.models.error) { modelName.textContent = 'Models unavailable'; modelMode.textContent = ''; }
    else { modelName.textContent = baseName(); modelMode.textContent = modeLabel(S.think, S.search); }
    modelBtn.setAttribute('aria-label', `Model: ${modelName.textContent} ${modelMode.textContent}`.trim());
    modelBtn.setAttribute('data-tip', id ? `Requests use ${id}` : (sendBlockReason() || ''));
    const caps = S.models.list.find(m => m.id === id);
    const vision = !caps || !caps.capabilities || caps.capabilities.vision !== false;
    setDisabled(attachBtn, !vision || S.attachments.length >= MAX_IMAGES, !vision ? `${id} doesn't accept images` : `At most ${MAX_IMAGES} images per message`, 'Attach images (PNG, JPEG, WebP, GIF)');
    const reason = sendBlockReason();
    const emptyInput = !textarea.value.trim() && !S.attachments.length;
    S.els.form.classList.toggle('is-running', Boolean(running));
    sendBtn.setAttribute('aria-label', running ? 'Stop' : 'Send');
    sendBtn.setAttribute('data-tip', running ? 'Stop (Esc)' : reason || (emptyInput ? 'Type a message' : 'Send (Enter)'));
    sendBtn.setAttribute('aria-disabled', String(!running && (Boolean(reason) || emptyInput)));
    if (reason && !running && (S.els.note.textContent === '' || S.noteFromReason)) setNote(reason, S.models.error ? 'crit' : null, true);
    else if (!reason && S.noteFromReason) setNote('');
  }
  function setDisabled(btn, disabled, reason, tip) {
    btn.setAttribute('aria-disabled', String(Boolean(disabled)));
    btn.setAttribute('data-tip', disabled ? reason : (tip || btn.getAttribute('aria-label') || ''));
  }

  function renderEmpty() {
    if (!S.els.emptyLine) return;
    const line = S.els.emptyLine;
    line.className = 'chat-empty-line';
    line.replaceChildren();
    if (S.models.error) {
      line.classList.add('is-crit');
      line.append(`Models couldn't load: ${F.errorText(S.models.error)}. Send is disabled.`);
      return;
    }
    const sig = F.poolSignal();
    const data = F.store.accounts;
    if (data && data.pool.total && data.pool.can_serve === 0) {
      line.classList.add('is-warn');
      line.append(sig.nextSec != null ? `No account can serve for ${fmt.clock(sig.nextSec)}. ` : 'No account can serve right now. ', h('a', { href: '#/accounts', text: 'Open Accounts' }));
      return;
    }
    // Otherwise (including no accounts: the sidebar row offers "Add account") the greeting
    // stays clean; model and account live on the row under the composer.
  }

  // ================================================================ attachments
  function addFiles(files) {
    const errs = [];
    for (const file of files) {
      if (S.attachments.length >= MAX_IMAGES) { errs.push(`At most ${MAX_IMAGES} images per message.`); break; }
      if (!IMAGE_TYPES.has(file.type)) { errs.push(`${file.name} isn't supported. Use PNG, JPEG, WebP or GIF.`); continue; }
      if (file.size > MAX_IMAGE_BYTES) { errs.push(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB. The limit is 20 MB per image.`); continue; }
      const item = { id: F.uid(8), name: file.name, type: file.type, size: file.size, dataUrl: null };
      S.attachments.push(item);
      const reader = new FileReader();
      reader.onload = () => { item.dataUrl = String(reader.result); renderThumbs(); renderComposer(); };
      reader.onerror = () => { S.attachments = S.attachments.filter(a => a !== item); setNote(`Could not read ${file.name}: ${reader.error ? reader.error.name : 'error'}`, 'crit'); renderThumbs(); };
      reader.readAsDataURL(file);
    }
    setNote(errs.join(' '), errs.length ? 'crit' : null);
    renderThumbs();
    renderComposer();
  }
  function renderThumbs() {
    const { thumbs } = S.els;
    thumbs.hidden = !S.attachments.length;
    thumbs.replaceChildren(...S.attachments.map(a => h('div', { class: 'thumb' },
      a.dataUrl ? h('img', { src: a.dataUrl, alt: a.name }) : h('span', { class: 'spinner', 'aria-label': `Reading ${a.name}` }),
      h('button', { type: 'button', class: 'thumb-remove', 'aria-label': `Remove ${a.name}`, onclick: () => { S.attachments = S.attachments.filter(x => x !== a); renderThumbs(); renderComposer(); S.els.textarea.focus(); } }, F.icon('close')))));
    if (S.attachments.length) thumbs.append(h('p', { class: 'meta thumbs-note', text: 'Images go with this message only.' }));
    syncDockSpace();
  }

  // ================================================================ conversations
  function titleFrom(text) {
    const line = (text || '').split('\n').map(s => s.trim()).find(Boolean) || 'Image';
    if (line.length <= 48) return line;
    const cut = line.slice(0, 48);
    const sp = cut.lastIndexOf(' ');
    return `${(sp > 24 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
  }

  async function openConversation(id) {
    if (S.activeId === id && S.msgs.has(id)) { renderTranscript(); return; }
    S.activeId = id;
    const conv = S.convs.get(id);
    S.unknownId = conv ? null : id;
    if (conv) {
      const p = parseModel(conv.model || '');
      if (modelAvailable(conv.model)) { S.think = p.think; S.search = p.search; }
      if (!S.msgs.has(id)) {
        S.loadingConv = id;
        try { S.msgs.set(id, await store.messages(id)); }
        catch (e) { F.toast(`Couldn't load this conversation: ${e.name}: ${e.message}`, { tone: 'error' }); S.msgs.set(id, []); }
        S.loadingConv = null;
      }
    }
    if (S.activeId !== id) return;
    renderAll();
  }

  function newChat({ focus = true } = {}) {
    S.activeId = null;
    S.unknownId = null;
    S.attachments = [];
    if (location.hash !== '#/chat') F.navigate('chat');
    renderAll();
    if (focus) requestAnimationFrame(() => S.els.textarea && S.els.textarea.focus());
  }

  function renderAll() {
    if (!S.root) return;
    const conv = active();
    const hasMsgs = conv && msgsOf(conv.id).length > 0;
    S.root.classList.toggle('is-empty', !hasMsgs && !S.unknownId);
    S.els.unknown.hidden = !S.unknownId;
    if (S.unknownId) {
      S.els.unknown.replaceChildren(F.notice('info', 'This conversation isn\'t stored in this browser.',
        `Chats are kept per browser and per origin (${location.origin}). It may live in another browser, or under 127.0.0.1 instead of localhost.`,
        [F.btn('New chat', { kind: 'primary', icon: 'new-chat', onclick: () => newChat() })]));
    }
    renderTranscript();
    renderThumbs();
    renderComposer();
    renderEmpty();
    renderList();
    renderBanners();
    F.emit('chat-title');
  }

  // ================================================================ transcript
  function renderTranscript() {
    const conv = active();
    const list = conv ? msgsOf(conv.id) : [];
    S.turnEls.clear();
    S.els.transcript.replaceChildren(...list.map(m => turnEl(m, false)));
    requestAnimationFrame(() => scrollToBottom(false));
  }

  function nearBottom() {
    const sc = S.els.scroll;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  }
  function scrollToBottom(smooth) {
    const sc = S.els.scroll;
    sc.scrollTo({ top: sc.scrollHeight, behavior: smooth && !F.reducedMotion() ? 'smooth' : 'auto' });
  }

  function updateTurn(m, reveal) {
    const old = S.turnEls.get(m.id);
    const stick = nearBottom();
    const el = turnEl(m, reveal);
    if (old && old.parentNode) old.replaceWith(el);
    else S.els.transcript.append(el);
    if (stick) scrollToBottom(false);
  }

  function turnEl(m, reveal) {
    const li = m.role === 'user' ? userTurn(m) : assistantTurn(m, reveal);
    S.turnEls.set(m.id, li);
    return li;
  }

  function userTurn(m) {
    const bubble = h('div', { class: 'bubble' });
    if (m.images && m.images.length) bubble.append(h('div', { class: 'bubble-images' }, m.images.map((src, i) => h('img', { src, alt: `Attached image ${i + 1}` }))));
    if (m.content) bubble.append(h('p', { class: 'bubble-text', text: m.content }));
    const conv = active();
    const running = conv && S.runs.has(conv.id);
    const actions = h('div', { class: 'turn-actions' },
      running ? null : F.iconBtn('edit', 'Edit message', { onclick: () => startEdit(m) }),
      F.iconBtn('copy', 'Copy message', { onclick: (e) => F.copy(m.content || '', e.currentTarget) }));
    return h('li', { class: 'turn turn-user', 'data-id': m.id }, h('h3', { class: 'sr-only', text: 'You said' }), bubble, actions);
  }

  function startEdit(m) {
    const li = S.turnEls.get(m.id);
    if (!li) return;
    const ta = h('textarea', { class: 'edit-input', 'aria-label': 'Edit message', rows: '3' });
    ta.value = m.content || '';
    const save = F.btn('Save and send', { kind: 'primary', size: 'sm' });
    const cancel = F.btn('Cancel', { size: 'sm' });
    const box = h('div', { class: 'edit-box' }, ta,
      m.images && m.images.length ? h('p', { class: 'meta', text: `The ${m.images.length} attached image${m.images.length === 1 ? '' : 's'} will be sent again.` }) : null,
      h('div', { class: 'edit-actions' }, cancel, save));
    const bubble = li.querySelector('.bubble');
    bubble.replaceWith(box);
    li.classList.add('is-editing');
    const done = () => updateTurn(m, false);
    cancel.addEventListener('click', done);
    save.addEventListener('click', () => commitEdit(m, ta.value));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitEdit(m, ta.value); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    });
    const fit = () => { ta.style.setProperty('height', 'auto'); ta.style.setProperty('height', `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`); };
    ta.addEventListener('input', fit);
    requestAnimationFrame(() => { fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  }

  async function commitEdit(m, text) {
    const conv = active();
    if (!conv || S.runs.has(conv.id)) return;
    if (text.trim() === '/new') { setNote('Use New chat to start fresh.'); return; }
    if (!text.trim() && !(m.images && m.images.length)) return;
    m.content = text;
    const list = msgsOf(conv.id);
    const drop = list.filter(x => x.seq > m.seq);
    S.msgs.set(conv.id, list.filter(x => x.seq <= m.seq));
    await saveMsg(m);
    if (drop.length) await persist(() => store.deleteMessages(conv.id, drop.map(x => x.id)));
    conv.needsReset = true;
    const a = newAssistant(conv);
    renderTranscript();
    run(conv, a);
  }

  function assistantTurn(m, reveal) {
    const li = h('li', { class: 'turn turn-assistant', 'data-id': m.id }, h('h3', { class: 'sr-only', text: 'DeepSeek said' }));
    const meta = m.meta || {};
    const conv = active();
    const runInfo = conv && S.runs.get(conv.id);
    const pending = runInfo && runInfo.msgId === m.id;

    if (pending) {
      const thinking = parseModel(meta.model || '').think;
      const elapsed = Date.now() - runInfo.startedAt;
      li.append(h('div', { class: 'working', 'aria-live': 'off' },
        h('span', { class: 'sweep', 'aria-hidden': 'true' }),
        h('p', { class: 'working-label' }, h('span', { text: thinking ? 'Thinking' : 'Working' }), ' ', h('span', { class: 'readout-inline', 'data-run-timer': String(runInfo.startedAt), text: fmt.clock(elapsed / 1000) })),
        h('p', { class: 'meta working-hint', 'data-slow-hint': String(runInfo.startedAt), hidden: elapsed < SLOW_HINT_MS, text: 'The proxy returns the answer when DeepSeek finishes, so long answers and account failover can take a few minutes. It arrives in one piece.' })));
      if (m.reasoning || m.content) li.append(...answerParts(m, false));
      return li;
    }

    li.append(...answerParts(m, reveal));

    if (meta.stopped) li.append(h('p', { class: 'stopped-note', text: 'Stopped. The next message starts a fresh upstream thread.' }));
    if (meta.error) li.append(errorBlock(m));
    if (!meta.error && !meta.stopped) li.append(receipt(m));
    else if (meta.stopped && m.content) li.append(receipt(m));
    return li;
  }

  function answerParts(m, reveal) {
    const parts = [];
    if (m.reasoning) {
      const open = Boolean(m._reasoningOpen);
      const secs = m.meta && m.meta.reasoningMs ? Math.max(1, Math.round(m.meta.reasoningMs / 1000)) : null;
      const btn = h('button', { type: 'button', class: 'reasoning-toggle', 'aria-expanded': String(open) },
        F.icon('chevron-right', 'chev'), h('span', { text: secs ? `Reasoned for ${secs} s` : 'Reasoning' }));
      const body = h('div', { class: 'reasoning-body' }, h('div', { class: 'reasoning-inner' }, h('div', { class: 'reasoning-text' }, F.md.render(m.reasoning))));
      const wrap = h('div', { class: ['reasoning', open && 'is-open'] }, btn, body);
      btn.addEventListener('click', () => {
        m._reasoningOpen = !m._reasoningOpen;
        wrap.classList.toggle('is-open', m._reasoningOpen);
        btn.setAttribute('aria-expanded', String(m._reasoningOpen));
      });
      parts.push(wrap);
    }
    if (m.content) {
      const answer = h('div', { class: 'answer prose' });
      const blocks = F.md.blocks(m.content);
      const animate = reveal && !F.reducedMotion();
      blocks.forEach((b, i) => {
        if (animate) {
          b.classList.add('reveal');
          b.style.setProperty('--d', `${Math.min(i, 8) * 30}ms`);
        }
        answer.append(b);
      });
      if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { for (const b of answer.children) b.classList.add('is-in'); }));
      parts.push(answer);
    }
    return parts;
  }

  function errorBlock(m) {
    const e = m.meta.error;
    const title = errorTitle(e);
    const actions = h('div', { class: 'error-actions' });
    const conv = active();
    const retry = () => regenerate(m);
    if (e.status === 401) actions.append(F.btn('Enter access key', { kind: 'primary', size: 'sm', icon: 'key', onclick: () => F.openKeyGate() }));
    else if (e.status === 403) actions.append(h('a', { class: 'btn btn-secondary btn-sm', href: '#/settings' }, h('span', { class: 'btn-label', text: 'Open Settings' })));
    else if (e.type === 'context_length_exceeded') actions.append(F.btn('Start a new chat', { kind: 'primary', size: 'sm', icon: 'new-chat', onclick: () => newChat() }));
    else if ((e.status === 429 || e.status === 503) && e.retryAt) {
      const left = Math.max(0, (e.retryAt - Date.now()) / 1000);
      const b = F.btn(left > 0 ? `Retry in ${fmt.clock(left)}` : 'Retry', { kind: 'secondary', size: 'sm', icon: 'regenerate', onclick: () => { if (Date.now() >= e.retryAt) retry(); } });
      b.setAttribute('data-retry-at', String(e.retryAt));
      if (left > 0) b.setAttribute('aria-disabled', 'true');
      actions.append(b);
    } else actions.append(F.btn('Retry', { size: 'sm', icon: 'regenerate', onclick: retry }));
    if (conv) actions.append(h('a', { class: 'link', href: F.hashFor('requests', '', { client: agentFor(conv), status: 'error' }), text: 'View in Requests' }));
    return h('div', { class: 'chat-error', role: 'alert' },
      F.icon('error-x', 'chat-error-icon'),
      h('div', { class: 'chat-error-body' },
        h('p', { class: 'chat-error-title', text: title }),
        h('p', { class: 'chat-error-text selectable', text: e.message }),
        e.type ? h('p', { class: 'mono-id chat-error-type', text: `${e.type}${e.status ? ` · HTTP ${e.status}` : ''}` }) : null,
        e.status === 403 && e.type === 'cors_error' ? h('p', { class: 'meta', text: `Add ${location.origin} to PROXY_CORS_ORIGINS where the proxy runs, then restart it.` }) : null,
        actions));
  }

  function errorTitle(e) {
    if (e.type === 'network') return 'Can\'t reach the proxy';
    if (e.type === 'stream_truncated') return 'Response truncated';
    if (e.type === 'reset_failed') return 'Couldn\'t reset the server session';
    if (e.status === 429) return 'Rate limited';
    if (e.status === 503) return 'No account available';
    if (e.status === 401) return 'Access key required';
    if (e.status === 403 && e.type === 'cors_error') return 'Not allowed from this address';
    if (e.type === 'context_length_exceeded') return 'Context too long';
    if (e.status === 504) return 'The proxy timed out';
    if (e.status >= 500) return 'The proxy failed to answer';
    if (e.status === 400) return 'The proxy rejected the request';
    return 'The request failed';
  }

  function receipt(m) {
    const meta = m.meta || {};
    const conv = active();
    const usage = meta.usage || {};
    const pair = (icon, label, value, href) => {
      const inner = [F.icon(icon, 'icon-sm'), h('span', { class: 'receipt-value', text: value })];
      return href
        ? h('a', { class: 'receipt-item', href, 'data-tip': label, 'aria-label': `${label}: ${value}` }, inner)
        : h('span', { class: 'receipt-item', 'data-tip': label, 'aria-label': `${label}: ${value}` }, inner);
    };
    const items = h('div', { class: 'receipt-items' });
    if (meta.account) items.append(pair('route', 'Served by account', (F.accountById(meta.account) && F.accountById(meta.account).name) || meta.account, `#/accounts/${encodeURIComponent(meta.account)}`));
    if (meta.model) items.append(pair('model', 'Model', fmt.shortModel(meta.model)));
    if (meta.ms != null) items.append(pair('latency', 'Time to answer', fmt.ms(meta.ms)));
    if (usage.prompt_tokens != null) items.append(pair('token', 'Estimated tokens in and out', `≈ ${fmt.compact(usage.prompt_tokens)} → ${fmt.compact(usage.completion_tokens)}`));
    if (meta.compacted) items.append(h('span', { class: 'chip', 'data-tip': 'The proxy shortened older turns to fit the context window', text: 'Context compacted' }));
    const list = conv ? msgsOf(conv.id) : [];
    const lastAssistant = list.filter(x => x.role === 'assistant').pop();
    const running = conv && S.runs.has(conv.id);
    const actions = h('div', { class: 'receipt-actions' },
      m.content ? F.iconBtn('copy', 'Copy answer', { onclick: (e) => F.copy(m.content, e.currentTarget) }) : null,
      lastAssistant === m && !running ? F.iconBtn('regenerate', 'Regenerate', { onclick: () => regenerate(m) }) : null);
    const el = h('div', { class: 'receipt' }, items, actions);
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button') || !conv) return;
      const near = nearestRequest(conv, meta.requestTs);
      F.navigate('requests', '', { client: agentFor(conv), id: near ? near.id : null });
    });
    el.setAttribute('data-tip', 'Open in Requests');
    return el;
  }

  function nearestRequest(conv, ts) {
    const agent = agentFor(conv);
    let best = null;
    for (const r of F.store.requests) {
      if (r.agent !== agent) continue;
      if (!best || Math.abs(r.ts - ts) < Math.abs(best.ts - ts)) best = r;
    }
    return best;
  }

  // ================================================================ sending
  function newAssistant(conv) {
    const list = msgsOf(conv.id);
    const a = { id: F.uid(14), convId: conv.id, seq: (list.length ? list[list.length - 1].seq : 0) + 1, role: 'assistant', content: '', reasoning: '', images: [], meta: {}, createdAt: Date.now() };
    list.push(a);
    S.msgs.set(conv.id, list);
    return a;
  }

  async function submit() {
    const { textarea } = S.els;
    const text = textarea.value;
    const reason = sendBlockReason();
    if (reason) { setNote(reason, 'crit'); return; }
    if (!text.trim() && !S.attachments.length) return;
    if (S.attachments.some(a => !a.dataUrl)) { setNote('Images are still loading.'); return; }
    if (text.trim() === '/new') { setNote('Use New chat to start fresh.'); return; }
    const images = S.attachments.map(a => a.dataUrl);
    if (images.reduce((n, u) => n + u.length, 0) + text.length > MAX_BODY_CHARS) { setNote('These images are too large together. The proxy accepts about 30 MB per request.', 'crit'); return; }
    let conv = active();
    if (conv && S.runs.has(conv.id)) return;
    const first = !conv || !msgsOf(conv.id).length;
    if (!conv) {
      const now = Date.now();
      conv = { id: F.uid(12), title: titleFrom(text), model: currentModel(), createdAt: now, updatedAt: now, needsReset: false };
      S.convs.set(conv.id, conv);
      S.msgs.set(conv.id, []);
      S.activeId = conv.id;
      F.replaceHash('chat', conv.id, {});
    }
    conv.model = currentModel();
    const list = msgsOf(conv.id);
    const u = { id: F.uid(14), convId: conv.id, seq: (list.length ? list[list.length - 1].seq : 0) + 1, role: 'user', content: text, reasoning: '', images, meta: {}, createdAt: Date.now() };
    list.push(u);
    textarea.value = '';
    S.grow();
    S.attachments = [];
    renderThumbs();
    setNote('');
    const a = newAssistant(conv);
    conv.updatedAt = Date.now();
    saveConv(conv);
    saveMsg(u);
    if (first) dock();
    S.els.transcript.append(turnEl(u, false));
    run(conv, a);
    renderList();
    F.emit('chat-title');
    requestAnimationFrame(() => scrollToBottom(true));
  }

  // Signature motion: the composer docks from the centre once per conversation.
  function dock() {
    const root = S.root;
    if (!root.classList.contains('is-empty')) return;
    const { form } = S.els;
    if (F.reducedMotion()) { root.classList.remove('is-empty'); return; }
    const first = form.getBoundingClientRect();
    root.classList.add('is-leaving');
    setTimeout(() => {
      const before = form.getBoundingClientRect();
      root.classList.remove('is-empty', 'is-leaving');
      const last = form.getBoundingClientRect();
      // measured twice: the heading fade does not move the form, but be exact
      const from = before.top ? before : first;
      form.style.setProperty('transform', `translate(${from.left - last.left}px, ${from.top - last.top}px)`);
      form.getBoundingClientRect();
      form.classList.add('is-docking');
      form.style.removeProperty('transform');
      const end = () => { form.classList.remove('is-docking'); form.removeEventListener('transitionend', end); };
      form.addEventListener('transitionend', end);
      setTimeout(end, 700);
    }, 150);
  }

  function buildMessages(conv, a) {
    const list = msgsOf(conv.id).filter(m => m.seq < a.seq);
    const lastUser = list.filter(m => m.role === 'user').pop();
    const out = [];
    for (const m of list) {
      if (m.role === 'assistant') {
        if (m.content) out.push({ role: 'assistant', content: m.content });
        continue;
      }
      if (m === lastUser && m.images && m.images.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: m.content || '' }, ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))] });
      } else {
        out.push({ role: 'user', content: m.content || '' });
      }
    }
    return out;
  }

  async function resetSession(conv) {
    try {
      await F.api('POST', `/reset-session?agent=${encodeURIComponent(agentFor(conv))}`, { timeout: 15000 });
    } catch (e) {
      if (e.status === 404) return; // the server has no session for this chat: nothing to reset
      throw Object.assign(new F.ApiError(`POST /reset-session failed before sending: ${e.message}`, { status: e.status, type: 'reset_failed' }), { cause: e });
    }
  }

  async function run(conv, a) {
    const controller = new AbortController();
    const runInfo = { controller, startedAt: Date.now(), msgId: a.id };
    S.runs.set(conv.id, runInfo);
    a.meta = { model: conv.model, requestTs: F.now() };
    a.content = '';
    a.reasoning = '';
    if (active() === conv) { updateTurn(a, false); renderComposer(); }
    renderList();
    let firstByteAt = null;
    let firstContentAt = null;
    let lastPaint = 0;
    try {
      if (conv.needsReset) {
        await resetSession(conv);
        conv.needsReset = false;
        saveConv(conv);
      }
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        headers: F.authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-agent-session': agentFor(conv), ...(F.chatAccount && F.chatAccount.get() ? { 'x-account-id': F.chatAccount.get() } : {}) }),
        body: JSON.stringify({ model: conv.model, stream: true, messages: buildMessages(conv, a) }),
      }).catch((e) => { if (controller.signal.aborted) throw e; throw F.networkError(e, 'POST /v1/chat/completions'); });
      if (!res.ok) throw await F.errorFromResponse(res, 'POST /v1/chat/completions');
      a.meta.account = res.headers.get('x-account-id') || null;
      a.meta.compacted = /^(1|true)$/i.test(res.headers.get('x-freedeepseek-context-compacted') || '');
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        const body = await res.json().catch(() => { throw new F.ApiError('The proxy answered with neither an event stream nor JSON.', { type: 'invalid_response', status: res.status }); });
        const msg = body.choices && body.choices[0] && body.choices[0].message;
        if (!msg) throw new F.ApiError('The proxy answered without a message.', { type: 'invalid_response', status: res.status });
        a.content = msg.content || '';
        a.reasoning = msg.reasoning_content || '';
        a.meta.usage = body.usage || null;
        firstByteAt = Date.now();
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let done = false;
        const handle = (data) => {
          if (data === '[DONE]') { done = true; return; }
          let chunk;
          try { chunk = JSON.parse(data); } catch (e) { throw new F.ApiError(`The stream sent a chunk that is not JSON: ${data.slice(0, 120)}`, { type: 'invalid_stream' }); }
          if (chunk.error) throw new F.ApiError(chunk.error.message || 'The stream reported an error.', { type: chunk.error.type || 'stream_error' });
          if (Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage) { a.meta.usage = chunk.usage; return; }
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (!delta) return;
          if (delta.reasoning_content) a.reasoning += delta.reasoning_content;
          if (delta.content) {
            if (!firstContentAt) firstContentAt = Date.now();
            a.content += delta.content;
          }
          if (chunk.usage) a.meta.usage = chunk.usage;
        };
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (!firstByteAt) firstByteAt = Date.now();
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const evt = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of evt.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
          }
          // Progressive paint when chunks really trickle in (not the usual burst).
          if (!done && Date.now() - firstByteAt > BURST_MS && Date.now() - lastPaint > 120 && active() === conv) {
            lastPaint = Date.now();
            updateTurn(a, false);
          }
        }
        buf += decoder.decode();
        for (const evt of buf.split('\n\n')) for (const line of evt.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
        if (!done) throw new F.ApiError('Response truncated: the stream ended early (no [DONE]).', { type: 'stream_truncated' });
      }
      a.meta.ms = Date.now() - runInfo.startedAt;
      a.meta.reasoningMs = a.reasoning ? (firstContentAt || Date.now()) - runInfo.startedAt : null;
      if (!a.content && !a.reasoning) throw new F.ApiError('The proxy finished without any answer text.', { type: 'empty_response' });
    } catch (e) {
      if (controller.signal.aborted) {
        a.meta.stopped = true;
        conv.needsReset = true;
      } else {
        const err = e instanceof F.ApiError ? e : new F.ApiError(`${e.name || 'Error'}: ${e.message}`, { type: 'client_error' });
        F.handleGate(err); // a 401 also opens the key gate; the inline block still explains
        a.meta.error = {
          status: err.status || 0, type: err.type || null, message: err.message,
          retryAt: err.retryAfter ? Date.now() + err.retryAfter * 1000 : ((err.status === 429 || err.status === 503) ? Date.now() + 2000 : null),
        };
        conv.needsReset = true;
      }
    } finally {
      S.runs.delete(conv.id);
      conv.updatedAt = Date.now();
      saveConv(conv);
      saveMsg(a);
      const burst = firstByteAt && (Date.now() - firstByteAt) <= BURST_MS;
      if (active() === conv) {
        updateTurn(a, Boolean(burst) && !a.meta.error && !a.meta.stopped);
        // user turn actions (Edit) come back once the run ends
        for (const m of msgsOf(conv.id)) if (m.role === 'user') updateTurn(m, false);
        const prev = msgsOf(conv.id).filter(x => x.role === 'assistant' && x !== a);
        for (const p of prev) updateTurn(p, false);
        renderComposer();
      }
      renderList();
      if (!a.meta.error && !a.meta.stopped) F.announce('Answer ready');
      else if (a.meta.error) F.announce(`Error: ${errorTitle(a.meta.error)}`);
    }
  }

  function stop(conv) {
    const r = S.runs.get(conv.id);
    if (r) r.controller.abort();
  }

  async function regenerate(m) {
    const conv = active();
    if (!conv || S.runs.has(conv.id)) return;
    const list = msgsOf(conv.id);
    const drop = list.filter(x => x.seq >= m.seq);
    S.msgs.set(conv.id, list.filter(x => x.seq < m.seq));
    await persist(() => store.deleteMessages(conv.id, drop.map(x => x.id)));
    conv.needsReset = true;
    const a = newAssistant(conv);
    renderTranscript();
    run(conv, a);
  }

  // ================================================================ timers
  function tick() {
    if (!S.visible || !S.root) return;
    const now = Date.now();
    for (const el of S.root.querySelectorAll('[data-run-timer]')) el.textContent = fmt.clock((now - Number(el.dataset.runTimer)) / 1000);
    for (const el of S.root.querySelectorAll('[data-slow-hint]')) el.hidden = now - Number(el.dataset.slowHint) < SLOW_HINT_MS;
    for (const el of S.root.querySelectorAll('[data-retry-at]')) {
      const left = (Number(el.dataset.retryAt) - now) / 1000;
      const label = el.querySelector('.btn-label');
      if (left > 0) { label.textContent = `Retry in ${fmt.clock(left)}`; el.setAttribute('aria-disabled', 'true'); }
      else { label.textContent = 'Retry'; el.removeAttribute('aria-disabled'); el.removeAttribute('data-retry-at'); }
    }
    if (S.root.classList.contains('is-empty')) renderEmpty();
  }

  // ================================================================ sidebar list
  function renderList() {
    const host = document.getElementById('chat-list');
    if (!host) return;
    const q = S.search_q;
    const convs = Array.from(S.convs.values())
      .filter(c => !S.pendingDeletes.has(c.id))
      .filter(c => !q || (c.title || '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!convs.length) {
      host.replaceChildren(h('div', { class: 'chat-list-empty' },
        h('p', { class: 'chat-list-empty-title', text: q ? 'No chat title matches' : 'No chats yet' }),
        h('p', { class: 'chat-list-empty-text', text: q ? 'Try another word.' : store.mode === 'memory' ? 'Chats are kept in memory only in this browser mode.' : 'Start one with New chat above.' })));
      return;
    }
    // One flat list, newest first; each row carries its own date on the right.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const t0 = startOfDay.getTime();
    const thisYear = startOfDay.getFullYear();
    const when = (ts) => {
      const d = new Date(ts);
      if (ts >= t0) return fmt.hm(ts);
      if (ts >= t0 - 86400000) return 'Yesterday';
      if (ts >= t0 - 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
      return d.toLocaleDateString(undefined, d.getFullYear() === thisYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
    };
    host.replaceChildren(h('ul', { class: 'chat-items', role: 'list' }, convs.map(c => h('li', null,
      h('a', { class: 'chat-item', href: `#/chat/${encodeURIComponent(c.id)}`, 'aria-current': c.id === S.activeId && S.visible ? 'page' : null, title: c.title },
        S.runs.has(c.id) ? F.lamp('busy', 'chat-busy') : null,
        h('span', { class: 'chat-item-title', text: c.title || 'Untitled' }),
        h('time', { class: 'chat-item-date', datetime: new Date(c.updatedAt).toISOString(), text: when(c.updatedAt) }))))));
  }

  // ================================================================ banners
  function renderBanners() {
    const host = S.els.banners;
    if (!host) return;
    host.replaceChildren();
    if (store.mode === 'memory') {
      host.append(F.notice('warn', 'Conversations won\'t be saved', `${store.unavailableReason}. They stay in memory until you close this tab.`));
    }
    if (S.quota) {
      host.append(F.notice('crit', 'Browser storage is full. Export or delete older conversations.', 'New messages show here but are not saved until there is room.', [
        F.btn('Export', { size: 'sm', icon: 'download', onclick: async () => F.download(`fdsa-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.exportAll(), null, 2)) }),
        F.btn('Delete older than 30 days', { size: 'sm', kind: 'danger-text', onclick: deleteOld }),
      ]));
    }
  }
  async function deleteOld() {
    const cutoff = Date.now() - 30 * 86400000;
    const old = Array.from(S.convs.values()).filter(c => c.updatedAt < cutoff && !S.runs.has(c.id));
    for (const c of old) {
      await persist(() => store.deleteConversation(c.id));
      S.convs.delete(c.id);
      S.msgs.delete(c.id);
    }
    S.quota = false;
    F.toast(old.length ? `Deleted ${old.length} conversation${old.length === 1 ? '' : 's'} older than 30 days.` : 'No conversation is older than 30 days.', { tone: old.length ? 'success' : 'warn' });
    renderList();
    renderBanners();
  }

  // ================================================================ conversation menu
  function renameInline() {
    const conv = active();
    const title = document.getElementById('view-title');
    if (!conv || title.querySelector('input')) return;
    const input = h('input', { type: 'text', class: 'title-input', value: conv.title, 'aria-label': 'Conversation title', maxlength: '120' });
    title.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v && v !== conv.title) { conv.title = v; saveConv(conv); renderList(); }
      F.emit('chat-title');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function sessionDetails(trigger) {
    const conv = active();
    const box = h('div', { class: 'session-pop' }, h('p', { class: 'meta', text: 'Loading…' }));
    F.popover(trigger, box, { width: 320, label: 'Server session' });
    try {
      const body = await F.api('GET', '/v1/sessions');
      const s = (body.agents || []).find(x => x.agent === agentFor(conv));
      if (!s) {
        box.replaceChildren(h('p', { class: 'session-title', text: 'No server session' }), h('p', { class: 'meta', text: 'The proxy holds no session for this chat (none yet, it was reset, or the server restarted). The next message sends the full transcript.' }));
        return;
      }
      box.replaceChildren(h('p', { class: 'session-title', text: 'Server session' }), h('ul', { class: 'facts' },
        h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: 'Pinned account' }), h('span', { class: 'fact-value mono-id', text: s.account || '—' })),
        h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: 'Messages' }), h('span', { class: 'fact-value', text: fmt.int(s.message_count) })),
        h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: 'History kept' }), h('span', { class: 'fact-value', text: fmt.int(s.history_size) })),
        h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: 'Age' }), h('span', { class: 'fact-value', text: `${s.age_min} min` })),
        h('li', { class: 'fact' }, h('span', { class: 'fact-label', text: 'Client id' }), h('span', { class: 'fact-value mono-id', text: s.agent }))));
    } catch (e) {
      if (!F.handleGate(e)) box.replaceChildren(F.notice('crit', 'GET /v1/sessions failed', F.errorText(e)));
    }
  }

  function convMenu(trigger) {
    const conv = active();
    if (!conv) return;
    const running = S.runs.has(conv.id);
    F.menu(trigger, [
      { label: 'Rename', icon: 'edit', run: () => renameInline(), movesFocus: true },
      { label: 'Session details', icon: 'info', movesFocus: true, run: () => setTimeout(() => sessionDetails(trigger), 0) },
      { label: 'Reset server session', icon: 'regenerate', disabled: running, reason: 'Wait for the answer or stop it first', run: async () => {
        try { await resetSession(conv); conv.needsReset = false; saveConv(conv); F.toast('Reset the server session. The next message sends the full transcript.', { tone: 'success' }); }
        catch (e) { if (!F.handleGate(e)) F.toastError('Reset failed', e); }
      } },
      { label: 'Export JSON', icon: 'download', run: async () => {
        F.download(`chat-${conv.id}.json`, JSON.stringify({ conversation: conv, messages: msgsOf(conv.id) }, null, 2));
      } },
      'sep',
      { label: 'Delete…', icon: 'trash', danger: true, disabled: running, reason: 'Stop the answer first', run: () => deleteConv(conv) },
    ], { label: 'Conversation actions' });
  }

  function deleteConv(conv) {
    const timer = setTimeout(async () => {
      S.pendingDeletes.delete(conv.id);
      await persist(() => store.deleteConversation(conv.id));
      S.convs.delete(conv.id);
      S.msgs.delete(conv.id);
      renderList();
    }, 10000);
    S.pendingDeletes.set(conv.id, timer);
    if (S.activeId === conv.id) newChat({ focus: false });
    renderList();
    F.toast(`Deleted "${conv.title}".`, { action: { label: 'Undo', run: () => { clearTimeout(timer); S.pendingDeletes.delete(conv.id); renderList(); F.navigate('chat', conv.id); } } });
  }

  // ================================================================ init
  async function init() {
    await store.open();
    try {
      const convs = await store.allConversations();
      for (const c of convs) S.convs.set(c.id, c);
    } catch (e) {
      F.toast(`Couldn't read saved chats: ${e.name}: ${e.message}`, { tone: 'error' });
    }
    renderList();
    try {
      const pref = localStorage.getItem('fdsa.chat.model');
      if (pref) { const p = parseModel(pref); S.think = p.think; S.search = p.search; }
    } catch (e) { /* preference only */ }
  }
  const ready = init();

  F.views.chat = {
    get title() { const c = active(); return c ? c.title : 'New chat'; },
    live: false,
    mount,
    async show(route) {
      S.visible = true;
      if (!S.models.loaded && !S.modelsLoading) { S.modelsLoading = true; loadModels(); }
      await ready;
      if (route.sub) await openConversation(route.sub);
      else { S.activeId = null; S.unknownId = null; renderAll(); }
      document.getElementById('toggle-chats').hidden = false;
      if (!S.activeId) requestAnimationFrame(() => S.els.textarea.focus({ preventScroll: true }));
      syncDockSpace();
    },
    hide() {
      S.visible = false;
      document.getElementById('toggle-chats').hidden = true;
      renderList();
    },
    actions() {
      const conv = active();
      if (!conv) return [];
      const more = F.iconBtn('more', 'Conversation actions', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
      more.addEventListener('click', () => convMenu(more));
      return [more];
    },
    // Esc: stop the running answer in the open conversation.
    onEscape() {
      const conv = active();
      if (conv && S.runs.has(conv.id)) { stop(conv); return true; }
      return false;
    },
    newChat,
    conversations: () => Array.from(S.convs.values()).filter(c => !S.pendingDeletes.has(c.id)).sort((a, b) => b.updatedAt - a.updatedAt),
    renderList,
    get filterInput() { return document.getElementById('chat-search'); },
  };
})();
