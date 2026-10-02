// FreeDeepseekAPI dashboard: chart primitives (inline SVG, no libraries).
// Stacked columns, columns with error marks, horizontal bars, the account track
// lanes, a shared tooltip and table twins. Labels are untrusted: textContent only.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h, s, fmt } = F;
  const C = F.charts = {};

  // ---------------------------------------------------------------- tooltip
  const tipEl = () => document.getElementById('chart-tip');
  // rows: [{value, label, key: 'data-1'|'data-2'|'crit'|'ink'|null}]
  C.showTip = (clientX, clientY, title, rows) => {
    const el = tipEl();
    el.replaceChildren();
    if (title) el.append(h('p', { class: 'tip-title', text: title }));
    for (const r of rows) {
      el.append(h('p', { class: 'tip-row' },
        r.key ? h('span', { class: `tip-key tip-key-${r.key}`, 'aria-hidden': 'true' }) : null,
        h('strong', { class: 'tip-value', text: r.value }),
        r.label ? h('span', { class: 'tip-label', text: r.label }) : null));
    }
    el.hidden = false;
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    let x = clientX + 14;
    if (x + w > innerWidth - 8) x = clientX - w - 14;
    let y = clientY - ht - 12;
    if (y < 8) y = clientY + 16;
    el.style.setProperty('left', `${Math.max(8, x)}px`);
    el.style.setProperty('top', `${y}px`);
  };
  C.hideTip = () => { tipEl().hidden = true; };
  document.addEventListener('scroll', () => C.hideTip(), true);

  // ---------------------------------------------------------------- scales
  C.niceTicks = (max, count = 4, integer = false) => {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) || 10 * mag;
    if (integer) step = Math.max(1, Math.ceil(step));
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
    if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
    return ticks;
  };
  const tickFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

  // Observes a host's width and calls draw(width) on change.
  // Content width: a host may carry padding (the chart cards in the settings window).
  const innerWidth$ = (host) => {
    const cs = getComputedStyle(host);
    return Math.floor(host.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
  };
  C.responsive = (host, draw) => {
    let last = 0;
    const ro = new ResizeObserver(() => {
      const w = innerWidth$(host);
      if (w && w !== last) { last = w; draw(w); }
    });
    ro.observe(host);
    host._ro && host._ro.disconnect();
    host._ro = ro;
    const w = innerWidth$(host);
    if (w) { last = w; draw(w); }
  };

  // ---------------------------------------------------------------- table twin
  // columns: [{label, num, get(row)}]
  C.table = (caption, columns, rows) => {
    const table = h('table', { class: 'data-table twin' });
    table.append(h('caption', { class: 'sr-only', text: caption }));
    const head = h('tr');
    for (const c of columns) head.append(h('th', { scope: 'col', class: c.num ? 'num' : null, text: c.label }));
    table.append(h('thead', null, head));
    const body = h('tbody');
    for (const r of rows) {
      const tr = h('tr');
      columns.forEach((c, i) => {
        const v = c.get(r);
        tr.append(h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: c.num ? 'num' : null }, v instanceof Node ? v : String(v)));
      });
      body.append(tr);
    }
    table.append(body);
    return h('div', { class: 'table-scroll' }, table);
  };

  // ---------------------------------------------------------------- column charts
  // Shared frame: y gridlines + ticks, x labels, keyboard + pointer crosshair.
  // opts: { buckets, height, label, yMax, xLabel(t), draw(g, ctx), tip(i) -> {title, rows} , onPick(i) }
  function columnFrame(host, opts) {
    const draw = (width) => {
      const H = opts.height;
      const padL = 44;
      const padR = 8;
      const padT = 8;
      const padB = 24;
      const plotW = Math.max(40, width - padL - padR);
      const plotH = H - padT - padB;
      const n = opts.buckets.length || 1;
      const band = plotW / n;
      const ticks = C.niceTicks(opts.yMax, opts.ticks || 4, opts.integer);
      const top = ticks[ticks.length - 1] || 1;
      const y = (v) => padT + plotH - (v / top) * plotH;
      const x = (i) => padL + i * band;
      const svg = s('svg', { class: 'chart', width, height: H, viewBox: `0 0 ${width} ${H}`, role: 'img', 'aria-label': opts.label, tabindex: '0' });
      const grid = s('g', { class: 'chart-grid', 'aria-hidden': 'true' });
      for (const t of ticks) {
        grid.append(s('line', { x1: padL, x2: width - padR, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'gridline' }));
        grid.append(s('text', { x: padL - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end', text: opts.yFmt ? opts.yFmt(t) : tickFmt.format(t) }));
      }
      // x labels: about 6 evenly spaced
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
      for (let i = 0; i < n; i += every) {
        grid.append(s('text', { x: x(i) + band / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle', text: opts.xLabel(opts.buckets[i].t) }));
      }
      svg.append(grid);
      // soft wash over the hovered bucket, under the marks
      const wash = s('rect', { class: 'col-hover', x: 0, y: padT, width: band, height: plotH, rx: 6, visibility: 'hidden', 'aria-hidden': 'true' });
      svg.append(wash);
      const marks = s('g', { class: 'chart-marks', 'aria-hidden': 'true' });
      svg.append(marks);
      const cross = s('line', { class: 'crosshair', y1: padT, y2: padT + plotH, x1: 0, x2: 0, visibility: 'hidden' });
      svg.append(cross);
      opts.draw(marks, { x, y, band, colW: Math.min(24, band * 0.7), plotH, padT, top, n });

      let cursor = -1;
      const point = (i, clientX, clientY) => {
        if (i < 0 || i >= n) return;
        cursor = i;
        const cx = x(i) + band / 2;
        cross.setAttribute('x1', cx);
        cross.setAttribute('x2', cx);
        cross.setAttribute('visibility', 'visible');
        wash.setAttribute('x', x(i) + Math.max(0, (band - Math.max(16, Math.min(40, band))) / 2));
        wash.setAttribute('width', Math.min(band, Math.max(16, Math.min(40, band))));
        wash.setAttribute('visibility', 'visible');
        const t = opts.tip(i);
        if (clientX == null) {
          const r = svg.getBoundingClientRect();
          clientX = r.left + cx;
          clientY = r.top + padT + 12;
        }
        C.showTip(clientX, clientY, t.title, t.rows);
      };
      const clear = () => { cross.setAttribute('visibility', 'hidden'); wash.setAttribute('visibility', 'hidden'); C.hideTip(); };
      svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const i = Math.floor((e.clientX - r.left - padL) / band);
        if (i < 0 || i >= n) { clear(); return; }
        point(i, e.clientX, e.clientY);
      });
      svg.addEventListener('pointerleave', clear);
      svg.addEventListener('blur', clear);
      svg.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = cursor < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cursor + (e.key === 'ArrowRight' ? 1 : -1)));
          point(next);
        } else if (e.key === 'Escape') clear();
      });
      host.replaceChildren(svg);
    };
    C.responsive(host, draw);
  }

  // Stacked columns: prompt (data-2) bottom, completion (data-1) top.
  // buckets: [{t, prompt, completion}]
  C.stackedTokens = (host, buckets, { label, xLabel, height = 220 }) => {
    const totals = buckets.map(b => b.prompt + b.completion);
    columnFrame(host, {
      buckets, height, label, xLabel,
      yMax: Math.max(1, ...totals),
      draw(g, { x, y, band, colW }) {
        buckets.forEach((b, i) => {
          if (!(b.prompt + b.completion)) return;
          const cx = x(i) + (band - colW) / 2;
          const y0 = y(0);
          const yp = y(b.prompt);
          const yt = y(b.prompt + b.completion);
          if (b.completion) {
            // Prompt square at the base, then a 2px ground gap, completion carries the 4px top radius.
            if (b.prompt) g.append(s('rect', { x: cx, y: yp, width: colW, height: Math.max(1, y0 - yp), class: 'mark-data-2' }));
            const bottom = b.prompt ? yp - 2 : y0;
            const hgt = Math.max(1, bottom - yt);
            g.append(s('path', { d: topRounded(cx, Math.min(yt, bottom - 1), colW, hgt, Math.min(4, hgt, colW / 2)), class: 'mark-data-1' }));
          } else {
            const hgt = Math.max(1, y0 - yp);
            g.append(s('path', { d: topRounded(cx, yp, colW, hgt, Math.min(4, hgt, colW / 2)), class: 'mark-data-2' }));
          }
        });
      },
      tip(i) {
        const b = buckets[i];
        return {
          title: xLabel(b.t, true),
          rows: [
            { value: `${fmt.compact(b.prompt + b.completion)} ≈`, label: 'tokens' },
            { value: fmt.compact(b.completion), label: 'completion', key: 'data-1' },
            { value: fmt.compact(b.prompt), label: 'prompt', key: 'data-2' },
          ],
        };
      },
    });
  };

  // Request columns: successful requests in light ink at the base, errors stacked on top in
  // red after a 2px surface gap, and an x above any bucket with errors (state is never colour alone).
  // buckets: [{t, requests, errors}]
  C.requestColumns = (host, buckets, { label, xLabel, height = 160 }) => {
    columnFrame(host, {
      buckets, height, label, xLabel, ticks: 2, integer: true,
      yMax: Math.max(1, ...buckets.map(b => b.requests)),
      draw(g, { x, y, band, colW }) {
        buckets.forEach((b, i) => {
          if (!b.requests) return;
          const cx = x(i) + (band - colW) / 2;
          const y0 = y(0);
          const okN = Math.max(0, b.requests - (b.errors || 0));
          const yOk = y(okN);
          const yTop = y(b.requests);
          if (b.errors) {
            if (okN) g.append(s('rect', { x: cx, y: yOk, width: colW, height: Math.max(1, y0 - yOk), class: 'mark-requests' }));
            const bottom = okN ? yOk - 2 : y0;
            const hgt = Math.max(2, bottom - yTop);
            g.append(s('path', { d: topRounded(cx, bottom - hgt, colW, hgt, Math.min(4, hgt, colW / 2)), class: 'mark-errors' }));
            const mx = x(i) + band / 2;
            const my = bottom - hgt - 9;
            g.append(s('path', { d: `M${mx - 3} ${my - 3}l6 6M${mx + 3} ${my - 3}l-6 6`, class: 'mark-error' }));
          } else {
            const hgt = Math.max(1, y0 - yTop);
            g.append(s('path', { d: topRounded(cx, yTop, colW, hgt, Math.min(4, hgt, colW / 2)), class: 'mark-requests' }));
          }
        });
      },
      tip(i) {
        const b = buckets[i];
        return {
          title: xLabel(b.t, true),
          rows: [
            { value: fmt.int(b.requests), label: 'requests', key: 'ink' },
            { value: fmt.int(b.errors), label: 'errors', key: 'crit' },
          ],
        };
      },
    });
  };

  function topRounded(x, y, w, hgt, r) {
    r = Math.max(0, r);
    return `M${x} ${y + hgt}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + hgt}Z`;
  }

  // ---------------------------------------------------------------- horizontal bars
  // rows: [{key, label, value, valueText, title, href, highlight}] sorted desc
  C.hbars = (host, rows, { label, top = 7, otherLabel = 'Other' } = {}) => {
    const list = h('ol', { class: 'hbars', 'aria-label': label });
    let shown = rows.slice(0, top);
    if (rows.length > top) {
      const rest = rows.slice(top);
      const sum = rest.reduce((a, r) => a + r.value, 0);
      shown = shown.concat([{ key: '(rest)', label: `${otherLabel} (${rest.length})`, value: sum, valueText: rows[0].fmtValue ? rows[0].fmtValue(sum) : fmt.compact(sum), muted: true }]);
    }
    const max = Math.max(1, ...shown.map(r => r.value));
    for (const r of shown) {
      const inner = [
        h('span', { class: 'hbar-label', title: r.title || r.label }, r.labelNode || r.label),
        h('span', { class: 'hbar-track', 'aria-hidden': 'true' }, h('span', { class: ['hbar-fill', r.muted && 'is-muted', !(r.value > 0) && 'is-zero'], style: { '--w': String(r.value / max) } })),
        h('span', { class: 'hbar-value', text: r.valueText }),
      ];
      const row = r.href
        ? h('a', { class: ['hbar', r.highlight && 'is-highlight'], href: r.href, 'data-tip': r.tip || null }, inner)
        : h('div', { class: ['hbar', r.highlight && 'is-highlight'], 'data-tip': r.tip || null }, inner);
      list.append(h('li', null, row));
    }
    host.replaceChildren(list);
  };

  // ---------------------------------------------------------------- share list
  // Apple-storage style breakdown: a total, one segmented share bar (2px surface gaps)
  // and a ranked list with a colour key, share and value per row.
  // rows: [{key, label, value, valueText, title, href, highlight, tip, slot}] sorted desc.
  // slot (0..3) comes from the caller and follows the entity, not its rank in this metric;
  // anything without a slot folds into one grey "Other".
  C.SHARE_SLOTS = 4;
  C.shareList = (host, rows, { label, total, totalText, unit, fmtValue = fmt.compact } = {}) => {
    const named = rows.filter(r => r.slot != null);
    const rest = rows.filter(r => r.slot == null);
    const items = named.slice();
    if (rest.length) {
      const sum = rest.reduce((a, r) => a + r.value, 0);
      items.push({ key: '(rest)', label: `Other (${rest.length})`, value: sum, valueText: fmtValue(sum), slot: 'other', tip: rest.map(r => r.label).join(', ') });
    }
    const pct = (v) => (total > 0 ? `${Math.round((v / total) * 100)}%` : '—');
    const bar = h('div', { class: ['share-bar', !(total > 0) && 'is-empty'], role: 'img', 'aria-label': `${label}: ${items.map(r => `${r.label} ${pct(r.value)}`).join(', ')}` });
    const segs = new Map();
    for (const r of items) {
      if (!(r.value > 0)) continue;
      const seg = h('span', { class: `share-seg share-${r.slot}` });
      seg.style.setProperty('flex-grow', String(r.value));
      segs.set(r.key, seg);
      bar.append(seg);
    }
    const list = h('ol', { class: 'share-list', 'aria-label': label });
    for (const r of items) {
      const inner = [
        h('span', { class: `share-key share-${r.slot}`, 'aria-hidden': 'true' }),
        h('span', { class: 'share-label', title: r.title || r.label, text: r.label }),
        h('span', { class: 'share-pct', text: pct(r.value) }),
        h('span', { class: 'share-value', text: r.valueText }),
      ];
      const row = r.href
        ? h('a', { class: ['share-row', r.highlight && 'is-highlight'], href: r.href, 'data-tip': r.tip || null }, inner)
        : h('div', { class: ['share-row', r.highlight && 'is-highlight'], 'data-tip': r.tip || null }, inner);
      const seg = segs.get(r.key);
      if (seg) {
        row.addEventListener('pointerenter', () => { bar.classList.add('is-focusing'); seg.classList.add('is-on'); });
        row.addEventListener('pointerleave', () => { bar.classList.remove('is-focusing'); seg.classList.remove('is-on'); });
      }
      list.append(h('li', null, row));
    }
    host.replaceChildren(
      h('p', { class: 'share-total' }, h('span', { class: 'share-total-value', text: totalText }), unit ? h('span', { class: 'share-total-unit', text: unit }) : null),
      bar, list);
  };

  // ---------------------------------------------------------------- lanes
  // The account track diagram. HTML label column + one SVG plot.
  // opts: { accounts, rows, windowMs, now, height:32, compact, onPick(row), labelHref(acc) }
  C.lanes = (host, opts) => {
    host._lanesOpts = opts;
    C.responsive(host, (w) => C._drawLanes(host, host._lanesOpts, w));
  };
  C.redrawLanes = (host, opts) => {
    host._lanesOpts = opts;
    const w = Math.floor(host.clientWidth);
    if (w) C._drawLanes(host, opts, w);
  };

  const AXIS_STEPS = { 900000: 300000, 3600000: 900000, 21600000: 3600000 };

  C._drawLanes = (host, opts, width) => {
    const { accounts, rows, windowMs, now } = opts;
    const laneH = opts.laneH || 32;
    const labelW = opts.labelW != null ? opts.labelW : (width < 560 ? 112 : 168);
    const axisH = opts.noAxis ? 0 : 22;
    const plotW = Math.max(80, width - labelW);
    const futureW = Math.max(plotW * 0.12, Math.min(176, plotW * 0.34));
    const nowX = plotW - futureW;
    const t0 = now - windowMs;
    const x = (t) => ((t - t0) / windowMs) * nowX;
    const H = axisH + accounts.length * laneH;

    const wrap = h('div', { class: ['lanes', opts.compact && 'lanes-compact'] });
    wrap.style.setProperty('--label-w', `${labelW}px`);
    // label column
    const labels = h('div', { class: 'lane-labels' });
    if (axisH) labels.append(h('div', { class: 'lane-axis-spacer' }));
    for (const a of accounts) {
      const name = a.name || a.id;
      const lab = opts.labelHref
        ? h('a', { class: 'lane-label', href: opts.labelHref(a), title: `${name} (${stateWord(a)})` }, F.lamp(a.status), h('span', { class: 'lane-name', text: name }))
        : h('div', { class: 'lane-label', title: name }, F.lamp(a.status), h('span', { class: 'lane-name', text: name }));
      labels.append(lab);
    }

    const byAccount = new Map(accounts.map(a => [a.id, []]));
    for (const r of rows) {
      if (!r.account || !byAccount.has(r.account)) continue;
      if (r.ts + (r.ms || 0) < t0) continue;
      byAccount.get(r.account).push(r);
    }
    for (const list of byAccount.values()) list.sort((a, b) => a.ts - b.ts);

    const svg = s('svg', { class: 'lane-plot', width: plotW, height: H, viewBox: `0 0 ${plotW} ${H}`, tabindex: opts.interactive === false ? null : '0', role: 'img', 'aria-label': opts.label || 'Account lanes' });
    const defs = s('defs');
    const clipId = `lane-clip-${Math.random().toString(36).slice(2, 8)}`;
    defs.append(s('clipPath', { id: clipId }, s('rect', { x: 0, y: 0, width: plotW, height: H })));
    svg.append(defs);
    const root = s('g', { 'clip-path': `url(#${clipId})` });
    svg.append(root);

    // axis
    if (axisH) {
      const step = AXIS_STEPS[windowMs] || Math.round(windowMs / 4);
      const ax = s('g', { class: 'lane-axis', 'aria-hidden': 'true' });
      for (let k = step; k < windowMs; k += step) {
        const tx = x(now - k);
        if (tx < 18) continue;
        ax.append(s('text', { x: tx, y: 14, 'text-anchor': 'middle', class: 'tick', text: `−${minutesLabel(k)}` }));
      }
      ax.append(s('text', { x: nowX, y: 14, 'text-anchor': 'middle', class: 'tick tick-now', text: 'now' }));
      root.append(ax);
      // hairline time grid under the lanes, and a faint wash over the future side of now
      const grid = s('g', { class: 'lane-grid', 'aria-hidden': 'true' });
      for (let k = step; k < windowMs; k += step) {
        const tx = x(now - k);
        if (tx < 18) continue;
        grid.append(s('line', { x1: tx, x2: tx, y1: axisH, y2: H, class: 'grid-v' }));
      }
      root.append(grid);
    }
    root.append(s('rect', { x: nowX, y: axisH, width: Math.max(0, plotW - nowX), height: H - axisH, class: 'future-zone', 'aria-hidden': 'true' }));

    const segs = []; // focusable request segments: {row, lane, x1, x2, cy}
    accounts.forEach((a, li) => {
      const cy = axisH + li * laneH + laneH / 2;
      const g = s('g', { class: 'lane' });
      const out = a.status === 'disabled' || a.status === 'no_credentials';
      g.append(s('line', { x1: 0, x2: plotW, y1: cy, y2: cy, class: out ? 'track track-out' : 'track' }));
      if (out) {
        const reason = a.status === 'no_credentials'
          ? `No credentials: ${!a.credentials || !a.credentials.token ? 'token missing' : 'cookie missing'}`
          : a.disabled_by === 'file' ? 'Disabled in file' : 'Paused by admin';
        const tw = reason.length * 6.6 + 12;
        g.append(s('rect', { x: 8, y: cy - 9, width: tw, height: 18, class: 'lane-label-bg' }));
        g.append(s('text', { x: 14, y: cy + 4, class: 'lane-note', text: reason }));
      }
      // cooldown band
      if (a.cooldown_until && a.cooldown_until > now) {
        const x2 = Math.min(plotW, x(a.cooldown_until));
        g.append(s('rect', { x: nowX, y: cy - (laneH - 8) / 2, width: Math.max(2, x2 - nowX), height: laneH - 8, class: 'band-cooldown' }));
        if (!opts.compact) g.append(s('text', { x: nowX + 6, y: cy + 4, class: 'lane-note lane-note-warn', text: `Cooldown ${fmt.clock((a.cooldown_until - now) / 1000)} (${fmt.cooldownReason(a.cooldown_reason)})` }));
      }
      // requests
      // A request is a dot (r 4) or, when it lasted long enough to show, a capsule 8px tall.
      // Errors are red and carry a white x in their end cap, so state is never colour alone.
      for (const r of byAccount.get(a.id) || []) {
        const xs = Math.max(0, x(r.ts));
        const xe = Math.min(nowX, x(r.ts + (r.ms || 0)));
        const cap = r.ok ? 4 : 5.5;
        let x1;
        let x2;
        let el;
        if (xe - xs <= cap * 2) {
          const cx = Math.min(nowX - cap, Math.max(cap, (xs + xe) / 2));
          x1 = cx - cap; x2 = cx + cap;
          el = s('circle', { cx, cy, r: cap, class: r.ok ? 'seg-ok' : 'seg-err' });
        } else {
          x1 = xs; x2 = xe;
          el = s('rect', { x: x1, y: cy - cap, width: x2 - x1, height: cap * 2, rx: cap, class: r.ok ? 'seg-ok' : 'seg-err' });
        }
        g.append(el);
        if (!r.ok) { const ex = x2 - cap; g.append(s('path', { d: `M${ex - 2.25} ${cy - 2.25}l4.5 4.5M${ex + 2.25} ${cy - 2.25}l-4.5 4.5`, class: 'seg-x' })); }
        segs.push({ row: r, lane: li, x1, x2, cy, el });
      }
      // busy: open segment to now, arrowhead past now, label in the future zone
      if (a.busy && a.busy_since) {
        const bx = Math.max(0, x(a.busy_since));
        const busy = s('g', { class: 'busy' });
        busy.style.setProperty('animation-delay', `-${Date.now() % 2000}ms`);
        busy.append(s('rect', { x: bx, y: cy - 3, width: Math.max(2, nowX - bx), height: 6, rx: 3, class: 'seg-busy' }));
        busy.append(s('path', { d: `M${nowX} ${cy - 4}l4 4-4 4`, class: 'seg-busy-head' }));
        g.append(busy);
        const label = `Busy ${fmt.clock((now - a.busy_since) / 1000)}${a.busy_agent ? ` · ${a.busy_agent}` : ''}`;
        if (!opts.compact && !(a.cooldown_until && a.cooldown_until > now)) g.append(s('text', { x: nowX + 8, y: cy + 4, class: 'lane-note lane-note-signal', text: label }));
      }
      root.append(g);
    });
    // now line
    root.append(s('line', { x1: nowX, x2: nowX, y1: axisH ? 18 : 0, y2: H, class: 'now-line' }));

    // focus ring for keyboard cursor
    const ring = s('rect', { class: 'seg-ring', rx: 4, visibility: 'hidden' });
    root.append(ring);

    let cursor = null;
    const tipFor = (sg, cx, cyClient) => {
      const r = sg.row;
      C.showTip(cx, cyClient, `${r.ok ? 'OK' : 'Error'} ${r.status} · ${fmt.ms(r.ms)}`, [
        { value: r.model || '—', label: 'model' },
        { value: r.agent || '—', label: 'client' },
        { value: `${fmt.compact(r.prompt_tokens)} → ${fmt.compact(r.completion_tokens)} ≈`, label: 'tokens' },
        { value: fmt.time(r.ts), label: r.error_type || 'started' },
      ]);
    };
    const focusSeg = (sg) => {
      cursor = sg;
      ring.setAttribute('x', sg.x1 - 3);
      ring.setAttribute('y', sg.cy - 8.5);
      ring.setAttribute('width', Math.max(14, sg.x2 - sg.x1 + 6));
      ring.setAttribute('height', 17);
      ring.setAttribute('rx', 8.5);
      ring.setAttribute('visibility', 'visible');
      const b = svg.getBoundingClientRect();
      tipFor(sg, b.left + sg.x2, b.top + sg.cy - 4);
    };
    const hit = (e) => {
      const b = svg.getBoundingClientRect();
      const px = e.clientX - b.left;
      const py = e.clientY - b.top;
      let best = null;
      let bestD = 14;
      for (const sg of segs) {
        if (Math.abs(py - sg.cy) > 12) continue;
        const d = px < sg.x1 ? sg.x1 - px : px > sg.x2 ? px - sg.x2 : 0;
        if (d < bestD) { bestD = d; best = sg; }
      }
      return best;
    };
    if (opts.interactive !== false) {
      svg.addEventListener('pointermove', (e) => {
        const sg = hit(e);
        svg.classList.toggle('is-pointing', Boolean(sg));
        if (sg) tipFor(sg, e.clientX, e.clientY); else C.hideTip();
      });
      svg.addEventListener('pointerleave', () => C.hideTip());
      svg.addEventListener('click', (e) => { const sg = hit(e); if (sg && opts.onPick) opts.onPick(sg.row); });
      svg.addEventListener('blur', () => { ring.setAttribute('visibility', 'hidden'); C.hideTip(); });
      svg.addEventListener('keydown', (e) => {
        if (!segs.length) return;
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        if (e.key === 'Enter') { if (cursor && opts.onPick) opts.onPick(cursor.row); return; }
        if (!cursor) { focusSeg(segs[segs.length - 1]); return; }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const same = segs.filter(sg => sg.lane === cursor.lane);
          const i = same.indexOf(cursor);
          const n = same[i + (e.key === 'ArrowRight' ? 1 : -1)];
          if (n) focusSeg(n);
        } else {
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          for (let lane = cursor.lane + dir; lane >= 0 && lane < accounts.length; lane += dir) {
            const same = segs.filter(sg => sg.lane === lane);
            if (!same.length) continue;
            const near = same.reduce((a, b) => (Math.abs(b.x1 - cursor.x1) < Math.abs(a.x1 - cursor.x1) ? b : a));
            focusSeg(near);
            break;
          }
        }
      });
    }
    if (labelW) wrap.append(labels);
    else wrap.classList.add('lanes-bare');
    wrap.append(h('div', { class: 'lane-plot-wrap' }, svg));
    host.replaceChildren(wrap);
  };

  function minutesLabel(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  }

  function stateWord(a) {
    return { ready: 'ready', busy: 'busy', cooldown: 'cooling down', disabled: a.disabled_by === 'file' ? 'disabled in file' : 'paused', no_credentials: 'no credentials' }[a.status] || a.status;
  }
  C.stateWord = stateWord;
  // Sentence-start form for headers and list details; stateWord stays lower case for mid-sentence use.
  C.stateLabel = (a) => { const w = stateWord(a); return w.charAt(0).toUpperCase() + w.slice(1); };
})();
