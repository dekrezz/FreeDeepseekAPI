// FreeDeepseekAPI dashboard: shell. Router, toolbar, sidebar, command palette,
// keyboard shortcuts and boot. Loaded last; every view is registered by now.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, fmt } = F;
  const VIEWS = ['chat', 'status', 'accounts', 'usage', 'requests', 'settings'];
  const $ = (id) => document.getElementById(id);

  const app = { view: null, route: null };

  // ---------------------------------------------------------------- mount views
  for (const name of VIEWS) {
    const v = F.views[name];
    if (!v) throw new Error(`Dashboard view "${name}" did not load. Check that public/dashboard/${name}.js is served.`);
    v.mount($(`view-${name}`));
  }

  // ---------------------------------------------------------------- router
  function route() {
    if (F._suppressRoute) return;
    const r = F.parseHash();
    if (!r.view) {
      let last = null;
      try { last = localStorage.getItem('fdsa.lastRoute'); } catch (e) { /* preference only */ }
      const lastView = last && F.parseHash(last).view;
      history.replaceState(null, '', VIEWS.includes(lastView) ? last : '#/chat');
      return route();
    }
    if (!VIEWS.includes(r.view)) {
      F.toast(`Unknown page #/${r.view}`, { tone: 'warn' });
      history.replaceState(null, '', '#/chat');
      return route();
    }
    try { localStorage.setItem('fdsa.lastRoute', location.hash); } catch (e) { /* preference only */ }
    if (r.view === 'chat') app.lastChatHash = location.hash;
    F.closePopover(false);
    F.hideTooltip();
    F.charts.hideTip();
    closeChatsSheet();
    const changed = app.view !== r.view;
    if (changed && app.view) {
      F.views[app.view].hide();
      // The chat stays on screen behind the settings window.
      if (app.view !== 'chat') $(`view-${app.view}`).hidden = true;
    }
    const wasSettings = Boolean(app.view) && app.view !== 'chat';
    app.view = r.view;
    app.route = r;
    const el = $(`view-${r.view}`);
    el.hidden = false;
    document.getElementById('app').dataset.view = r.view;
    // Everything except the chat lives in the settings window; the shared toolbar
    // (title, Live, view actions) moves with the view.
    const inSettings = r.view !== 'chat';
    $('settings-layer').hidden = !inSettings;
    document.body.classList.toggle('settings-open', inSettings);
    if (inSettings) $('settings-pane').prepend($('toolbar'));
    else $('main').prepend($('toolbar'));
    if (inSettings && !wasSettings) requestAnimationFrame(() => $('settings-modal').focus({ preventScroll: true }));
    if (changed) $('scroll').scrollTop = 0;
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === r.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    F.views[r.view].show(r);
    renderToolbar();
    document.title = `${titleFor(r.view)} · FreeDeepseekAPI`;
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- settings window
  function closeSettings() {
    if (app.view === 'chat') return false;
    location.hash = app.lastChatHash || '#/chat';
    return true;
  }
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', closeSettings);
  $('settings-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let any = false;
    for (const list of document.querySelectorAll('.settings-nav .nav-list')) {
      let shown = 0;
      for (const li of list.children) {
        const hit = !q || li.textContent.toLowerCase().includes(q);
        li.hidden = !hit;
        if (hit) shown++;
      }
      list.hidden = !shown;
      list.previousElementSibling.hidden = !shown;
      if (shown) any = true;
    }
    $('settings-nav-empty').hidden = any;
  });

  function titleFor(view) {
    const t = F.views[view].title;
    return typeof t === 'function' ? t() : t;
  }

  // ---------------------------------------------------------------- toolbar
  function renderToolbar() {
    const v = F.views[app.view];
    const title = $('view-title');
    if (!title.querySelector('input')) title.textContent = titleFor(app.view);
    const actions = v.actions ? v.actions() : [];
    $('toolbar-actions').replaceChildren(...actions);
  }
  F.on('chat-title', () => {
    if (app.view !== 'chat') return;
    renderToolbar();
    document.title = `${titleFor('chat')} · FreeDeepseekAPI`;
  });





  // ---------------------------------------------------------------- stale banner + pool signal
  function renderBanner() {
    const slot = $('banner-slot');
    const s = F.store;
    const v = F.views[app.view];
    slot.replaceChildren();
    if (!s.error || !v || !v.live) return;
    const retry = F.btn('Retry', { size: 'sm', icon: 'reload', onclick: () => F.refresh() });
    if (s.error.type === 'network') {
      slot.append(F.notice('crit', `Can't reach the proxy at ${location.host}.`, `${s.error.message} Data below is from ${s.lastOkAt ? fmt.time(s.lastOkAt) : 'nowhere yet'}.`, [retry]));
    } else {
      slot.append(F.notice('warn', `${s.error.endpoint || 'GET /admin/accounts'} failed${s.error.status ? ` with HTTP ${s.error.status}` : ''}`, F.errorText(s.error), [retry]));
    }
    if (s.error.status === 403 && s.error.type === 'cors_error') {
      slot.lastChild.append(h('p', { class: 'meta', text: `Add ${location.origin} to PROXY_CORS_ORIGINS where the proxy runs.` }));
    }
  }

  // ---------------------------------------------------------------- account switcher
  // ChatGPT-style account row at the foot of the sidebar. The chosen account serves the
  // dashboard chat (x-account-id); "Automatic" lets the pool pick. Agents and API clients
  // are never affected.
  const ACCOUNT_KEY = 'fdsa.chatAccount';
  F.chatAccount = {
    get() { try { return localStorage.getItem(ACCOUNT_KEY) || ''; } catch (e) { return ''; } },
    set(id) {
      try { if (id) localStorage.setItem(ACCOUNT_KEY, id); else localStorage.removeItem(ACCOUNT_KEY); }
      catch (e) { F.toast(`Could not save the chat account: ${e.name}`, { tone: 'error' }); }
      renderPool();
      F.emit('chat-account', id);
    },
  };
  const initials = (name) => {
    const words = String(name || '?').replace(/[_.-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : String(words[0] || '?').slice(0, 2);
    return letters.toUpperCase();
  };
  // Stable hue per account id, so an account keeps its colour across reloads.
  const hueOf = (id) => { let x = 0; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
  F.avatar = (account, cls = '') => {
    const el = h('span', { class: ['avatar', cls], 'aria-hidden': 'true' });
    paintAvatar(el, account);
    return el;
  };
  function paintAvatar(el, account) {
    el.classList.remove('is-add', 'is-auto');
    el.replaceChildren();
    if (account === 'add') { el.classList.add('is-add'); el.append(F.icon('plus')); return; }
    if (account === 'auto') { el.classList.add('is-auto'); el.append(F.icon('auto')); return; }
    el.style.setProperty('--avatar-h', String(hueOf(account.id)));
    el.textContent = initials(account.name || account.id);
  }
  const accountStateText = (a) => {
    if (a.status === 'cooldown') return `Cooling down · ${fmt.clock(F.cooldownLeft(a))}`;
    return { ready: 'Ready', busy: 'Busy', disabled: 'Paused', no_credentials: 'No credentials' }[a.status] || a.status;
  };

  function renderPool() {
    const sig = F.poolSignal();
    const data = F.store.accounts;
    const btn = $('account-switch');
    const avatar = $('account-avatar');
    const name = $('account-name');
    const sub = $('account-sub');
    const pinned = F.chatAccount.get();
    btn.className = 'account-switch';
    if (!data) {
      paintAvatar(avatar, 'auto');
      name.textContent = sig.text;
      sub.textContent = '';
    } else if (!data.accounts.length) {
      paintAvatar(avatar, 'add');
      name.textContent = 'Add account';
      sub.textContent = 'No DeepSeek login yet';
      btn.classList.add('is-empty');
    } else if (pinned) {
      const a = data.accounts.find(x => x.id === pinned);
      if (a) {
        paintAvatar(avatar, a);
        name.textContent = a.name || a.id;
        sub.textContent = a.email || accountStateText(a);
        if (a.status === 'cooldown') btn.classList.add('is-warn');
        if (a.status === 'disabled' || a.status === 'no_credentials') btn.classList.add('is-crit');
      } else {
        paintAvatar(avatar, { id: pinned, name: pinned });
        name.textContent = pinned;
        sub.textContent = 'Not loaded · chat will fail';
        btn.classList.add('is-crit');
      }
    } else {
      paintAvatar(avatar, 'auto');
      name.textContent = 'Automatic';
      sub.textContent = sig.text;
      if (sig.tone) btn.classList.add(`is-${sig.tone}`);
    }
    const label = `Chat account: ${name.textContent}${sub.textContent ? `, ${sub.textContent}` : ''}`;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-tip', label);
    F.setLamp($('tab-pool-lamp'), sig.state);
    $('tab-pool-lamp').classList.toggle(`is-${sig.tone}`, Boolean(sig.tone));
  }

  function openAddAccount(trigger) {
    if (!F.views.accounts.openAdd) throw new Error('The Accounts view did not register openAdd().');
    F.views.accounts.openAdd(trigger);
  }

  function openAccountMenu(trigger) {
    const data = F.store.accounts;
    if (data && !data.accounts.length) { openAddAccount(trigger); return; }
    const pinned = F.chatAccount.get();
    const list = h('div', { class: 'menu account-menu', role: 'menu', 'aria-label': 'Chat account' });
    const item = (avatarFor, title, detail, checked, run, extra = {}) => {
      const b = h('button', { type: 'button', role: extra.radio === false ? 'menuitem' : 'menuitemradio', class: ['menu-item', 'account-item', extra.cls], 'aria-checked': extra.radio === false ? null : String(checked) },
        F.avatar(avatarFor, 'avatar-sm'),
        h('span', { class: 'account-text' }, h('span', { class: 'account-name', text: title }), detail ? h('span', { class: 'account-sub', text: detail }) : null),
        checked ? F.icon('check', 'account-check') : null);
      b.addEventListener('click', () => { F.closePopover(); run(); });
      return b;
    };
    if (data) {
      list.append(item('auto', 'Automatic', `Pool picks · ${F.poolSignal().text}`, !pinned, () => F.chatAccount.set('')));
      for (const a of data.accounts) {
        const tone = a.status === 'cooldown' ? 'is-warn' : (a.status === 'disabled' || a.status === 'no_credentials') ? 'is-crit' : null;
        list.append(item(a, a.name || a.id, a.email ? `${a.email} · ${accountStateText(a)}` : accountStateText(a), pinned === a.id, () => F.chatAccount.set(a.id), { cls: tone }));
      }
    } else {
      list.append(h('p', { class: 'meta account-menu-note', text: F.store.error ? `Accounts unavailable: ${F.errorText(F.store.error)}` : 'Loading accounts…' }));
    }
    list.append(h('div', { class: 'menu-sep', role: 'separator' }));
    // Plain rows like "Manage accounts", so both labels start on the same line.
    const add = h('button', { type: 'button', role: 'menuitem', class: 'menu-item' }, F.icon('plus'), h('span', { text: 'Add account' }));
    add.addEventListener('click', () => { F.closePopover(); openAddAccount(trigger); });
    list.append(add);
    const manage = h('button', { type: 'button', role: 'menuitem', class: 'menu-item' }, F.icon('accounts'), h('span', { text: 'Manage accounts' }));
    manage.addEventListener('click', () => { F.closePopover(); F.navigate('accounts'); });
    list.append(manage);
    list.addEventListener('keydown', (e) => {
      const btns = Array.from(list.querySelectorAll('.menu-item'));
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
    F.popover(trigger, list, { width: Math.max(244, trigger.getBoundingClientRect().width), align: 'start', role: 'presentation', label: 'Chat account' });
  }
  $('account-switch').addEventListener('click', (e) => openAccountMenu(e.currentTarget));
  F.openAccountMenu = openAccountMenu;


  F.on('poll', () => {
    document.getElementById('app').classList.toggle('is-stale', Boolean(F.store.error && F.store.lastOkAt));
    renderBanner();
    renderPool();
  });
  F.on('accounts', renderPool);
  F.on('tick', () => { if (F.store.accounts && (F.store.accounts.pool.can_serve === 0 || F.chatAccount.get())) renderPool(); });

  // ---------------------------------------------------------------- sidebar
  $('new-chat').addEventListener('click', () => F.views.chat.newChat());
  $('toolbar-new-chat').addEventListener('click', () => F.views.chat.newChat());

  // Chat list as a sheet below 1100px.
  function openChatsSheet() {
    const app$ = $('app');
    app$.classList.add('chats-open');
    $('scrim').hidden = false;
    $('toggle-chats').setAttribute('aria-expanded', 'true');
  }
  function closeChatsSheet() {
    const app$ = $('app');
    if (!app$.classList.contains('chats-open')) return false;
    app$.classList.remove('chats-open');
    $('scrim').hidden = true;
    $('toggle-chats').setAttribute('aria-expanded', 'false');
    return true;
  }
  $('toggle-chats').addEventListener('click', () => {
    if ($('app').classList.contains('rail-collapsed') && innerWidth >= 720) { setRailCollapsed(false); return; }
    if (innerWidth >= 1100) { showChatFilter(); return; }
    if ($('app').classList.contains('chats-open')) closeChatsSheet(); else openChatsSheet();
  });
  $('chats-close').addEventListener('click', () => { closeChatsSheet(); $('toggle-chats').focus(); });

  // Sidebar head and actions, as in the Claude app: collapse, search (the ⌘K palette),
  // and a filter that appears under "Chats" only when asked for.
  // Collapse slides the whole sidebar away (width animates, contents fade) and is remembered.
  // Only a user toggle slides the rail; crossing a breakpoint on resize just snaps.
  let railAnimTimer = null;
  function setRailCollapsed(collapsed, animate = true) {
    const app$ = $('app');
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      app$.classList.add('rail-animates');
      clearTimeout(railAnimTimer);
      railAnimTimer = setTimeout(() => app$.classList.remove('rail-animates'), 400);
    }
    app$.classList.toggle('rail-collapsed', collapsed);
    $('rail-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('toggle-chats').setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Show chats');
    try { localStorage.setItem('fdsa.railCollapsed', collapsed ? '1' : '0'); } catch (e) { /* preference only */ }
  }
  F.toggleRail = () => setRailCollapsed(!$('app').classList.contains('rail-collapsed'));
  $('rail-toggle').addEventListener('click', () => { F.toggleRail(); $('toggle-chats').focus({ preventScroll: true }); });
  try { if (localStorage.getItem('fdsa.railCollapsed') === '1') setRailCollapsed(true, false); } catch (e) { /* preference only */ }
  $('open-search').addEventListener('click', () => openPalette());
  function showChatFilter() {
    $('chats-filter-field').hidden = false;
    $('chats-filter').setAttribute('aria-expanded', 'true');
    $('chat-search').focus();
  }
  function hideChatFilter() {
    const input = $('chat-search');
    $('chats-filter-field').hidden = true;
    $('chats-filter').setAttribute('aria-expanded', 'false');
    if (input.value) { input.value = ''; input.dispatchEvent(new Event('input')); }
  }
  $('chats-filter').addEventListener('click', () => { if ($('chats-filter-field').hidden) showChatFilter(); else hideChatFilter(); });
  $('chat-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); hideChatFilter(); $('chats-filter').focus(); } });
  $('scrim').addEventListener('click', closeChatsSheet);

  // ---------------------------------------------------------------- gate
  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('gate-input').value.trim();
    if (!v) return;
    try { F.key.set(v); } catch (err) { F.toast(`Could not store the key: ${err.name}`, { tone: 'error' }); return; }
    $('gate-input').value = '';
    F.hideGate();
    F.refresh();
    if (app.view && F.views[app.view].show) F.views[app.view].show(app.route);
  });
  $('gate-retry').addEventListener('click', () => { F.hideGate(); F.refresh(); });

  // ---------------------------------------------------------------- command palette
  const palette = { items: [], index: 0 };
  function paletteItems() {
    const items = [
      { label: 'New chat', hint: '⇧⌘O', icon: 'new-chat', run: () => F.views.chat.newChat() },
      { label: 'Go to Chat', hint: 'g c', icon: 'chat', run: () => F.navigate('chat') },
      { label: 'Go to Status', hint: 'g s', icon: 'status', run: () => F.navigate('status') },
      { label: 'Go to Accounts', hint: 'g a', icon: 'accounts', run: () => F.navigate('accounts') },
      { label: 'Go to Usage', hint: 'g u', icon: 'usage', run: () => F.navigate('usage') },
      { label: 'Go to Requests', hint: 'g r', icon: 'requests', run: () => F.navigate('requests') },
      { label: 'Go to Settings', icon: 'settings', run: () => F.navigate('settings') },
      { label: 'Show errors in Requests', icon: 'error-x', run: () => F.navigate('requests', '', { status: 'error' }) },
      { label: 'Reload accounts from disk', icon: 'reload', run: () => { F.navigate('accounts'); setTimeout(() => { const b = Array.from(document.querySelectorAll('#toolbar-actions .btn')).find(x => x.textContent.includes('Reload')); F.views.accounts.reload(b); }, 0); } },
      { label: 'Add account', icon: 'plus', run: () => { F.navigate('accounts'); setTimeout(() => F.views.accounts.openAdd(document.querySelector('#toolbar-actions .btn-primary')), 0); } },
    ];
    for (const a of (F.store.accounts && F.store.accounts.accounts) || []) {
      const name = a.name || a.id;
      items.push({ label: `Account: ${name}`, detail: F.charts.stateLabel(a), icon: 'accounts', run: () => F.navigate('accounts', a.id) });
      if (a.status === 'ready' || a.status === 'busy' || a.status === 'cooldown') items.push({ label: `Pause account: ${name}`, icon: 'pause', run: () => F.views.accounts.action(a, 'disable') });
      if (a.status === 'disabled' && a.disabled_by === 'admin') items.push({ label: `Resume account: ${name}`, icon: 'play', run: () => F.views.accounts.action(a, 'enable') });
      if (a.status === 'cooldown') items.push({ label: `Clear cooldown: ${name}`, icon: 'clear-cooldown', run: () => F.views.accounts.action(a, 'clear-cooldown') });
    }
    for (const c of F.views.chat.conversations().slice(0, 50)) {
      items.push({ label: `Chat: ${c.title}`, detail: fmt.ago(c.updatedAt, Date.now()), icon: 'chat', run: () => F.navigate('chat', c.id) });
    }
    return items;
  }
  function renderPalette() {
    const q = $('palette-input').value;
    const scored = palette.all.map(it => ({ it, s: F.fuzzy(q, it.label) })).filter(x => x.s >= 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    palette.items = scored.slice(0, 40).map(x => x.it);
    palette.index = Math.min(palette.index, Math.max(0, palette.items.length - 1));
    const list = $('palette-list');
    list.replaceChildren(...palette.items.map((it, i) => {
      const li = h('li', { role: 'option', id: `pal-${i}`, class: 'palette-item', 'aria-selected': String(i === palette.index) },
        F.icon(it.icon), h('span', { class: 'palette-label', text: it.label }),
        it.detail ? h('span', { class: 'palette-detail', text: it.detail }) : null,
        it.hint ? h('kbd', { class: 'kbd', text: it.hint }) : null);
      li.addEventListener('pointermove', () => { if (palette.index !== i) { palette.index = i; mark(); } });
      li.addEventListener('click', () => choose(i));
      return li;
    }));
    if (!palette.items.length) list.append(h('li', { class: 'palette-empty', role: 'presentation', text: 'Nothing matches.' }));
    mark();
  }
  function mark() {
    for (const li of $('palette-list').querySelectorAll('.palette-item')) li.setAttribute('aria-selected', String(li.id === `pal-${palette.index}`));
    $('palette-input').setAttribute('aria-activedescendant', palette.items.length ? `pal-${palette.index}` : '');
    const cur = $(`pal-${palette.index}`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    const it = palette.items[i];
    if (!it) return;
    $('palette').close();
    it.run();
  }
  function openPalette() {
    const dlg = $('palette');
    if (dlg.open) { dlg.close(); return; }
    F.closePopover(false);
    palette.all = paletteItems();
    palette.index = 0;
    $('palette-input').value = '';
    renderPalette();
    dlg.showModal();
    $('palette-input').focus();
  }
  $('palette-input').addEventListener('input', () => { palette.index = 0; renderPalette(); });
  $('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.index = Math.min(palette.items.length - 1, palette.index + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palette.index = Math.max(0, palette.index - 1); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(palette.index); }
  });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) $('palette').close(); });
  $('add-account').addEventListener('click', (e) => { if (e.target === $('add-account')) $('add-account').close(); });

  // ---------------------------------------------------------------- keyboard
  let gPending = 0;
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); F.views.chat.newChat(); return; }
    if (mod && e.key === '\\') {
      e.preventDefault();
      F.toggleRail();
      return;
    }
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return; // native dialog handles it
      if (F.closePopover()) { e.preventDefault(); return; }
      if (closeChatsSheet()) { e.preventDefault(); $('toggle-chats').focus(); return; }
      if (F.inspector.isOpen) { e.preventDefault(); F.inspector.close(); return; }
      if (closeSettings()) { e.preventDefault(); return; }
      if (app.view === 'chat' && F.views.chat.onEscape()) { e.preventDefault(); return; }
      return;
    }
    if (mod || e.altKey || isTyping(e.target) || F.gate.mode || document.querySelector('dialog[open]')) return;
    if (gPending && Date.now() - gPending < 800) {
      const map = { c: 'chat', s: 'status', a: 'accounts', u: 'usage', r: 'requests' };
      gPending = 0;
      if (map[e.key]) { e.preventDefault(); F.navigate(map[e.key]); }
      return;
    }
    if (e.key === 'g') { gPending = Date.now(); return; }
    if (e.key === '/') {
      const input = F.views[app.view].filterInput;
      if (input && input.offsetParent !== null) { e.preventDefault(); input.focus(); input.select && input.select(); }
      else if (app.view === 'chat') { e.preventDefault(); openChatsSheetIfNeeded(); }
      return;
    }
    const v = F.views[app.view];
    if (v.onKey && v.onKey(e)) e.preventDefault();
  });
  function openChatsSheetIfNeeded() {
    if ($('app').classList.contains('rail-collapsed') && innerWidth >= 720) setRailCollapsed(false);
    else if (innerWidth < 1100) openChatsSheet();
    showChatFilter();
  }

  document.getElementById('inspector-close').addEventListener('click', () => F.inspector.close());

  // ---------------------------------------------------------------- boot
  // Polling is always on; the old Live switch is gone, so a stored pause must not strand the dashboard.
  try { localStorage.removeItem('fdsa.live'); } catch (e) { /* preference only */ }
  route();
  renderPool();
  F.refresh();
})();
