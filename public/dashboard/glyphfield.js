'use strict';
// Glyph field: a mark set in random letters and digits that keep re-rolling, on the plain
// dark ground. Behind the empty chat the mark is the project logo; on a settings page it is
// that page's icon. A click on the ground drops a ripple that runs out like a ring on water:
// glyphs on its crest are pushed out, lit and re-rolled. Only the press counts; holding the
// button or dragging does nothing.
(function () {
  const F = window.FDSA;

  const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  // Distances in CSS px, times in ms, speed in px per ms. `still*` is the reduced-motion press.
  const RIPPLE = Object.freeze({ speed: 0.5, wavelength: 44, band: 80, lead: 6, life: 1600, push: 7, glow: 0.7, still: 420, stillRadius: 90 });
  const MAX_RIPPLES = 8;
  const FONT_PX = 11;
  const LINE_PX = 14;
  const MONO = '"Geist Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';
  const INK = '#a9b6c6';     // cool grey of the field
  const CREST = '#5aa9ff';   // --signal: the lit crest of a ripple
  const INTERACTIVE = 'button, a, input, textarea, select, label, form, [role="menu"], [role="dialog"], .composer-meta, .composer-note, .chat-banners';
  const IDLE_MS = 120;       // re-roll tick while nothing moves
  const IDLE_SHARE = 0.012;  // share of glyphs re-rolled per tick

  // One ripple at distance d from its centre, `age` ms after the press.
  // push: radial displacement in px (positive = outward); glow: added brightness.
  function rippleSample(d, age, reduced) {
    if (!(age >= 0) || age > (reduced ? RIPPLE.still : RIPPLE.life)) return { push: 0, glow: 0 };
    if (reduced) {
      // No travelling ring and no movement: the pressed spot brightens and fades.
      const glow = RIPPLE.glow * (1 - age / RIPPLE.still) * Math.exp(-((d / RIPPLE.stillRadius) ** 2));
      return { push: 0, glow: glow > 1e-4 ? glow : 0 };
    }
    const behind = RIPPLE.speed * age - d;   // how far the wavefront has passed this point
    if (behind < -RIPPLE.lead) return { push: 0, glow: 0 };
    const band = Math.exp(-((behind / RIPPLE.band) ** 2));
    const decay = (1 - age / RIPPLE.life) ** 2;
    const wave = Math.sin((2 * Math.PI * behind) / RIPPLE.wavelength);
    const centre = Math.min(1, d / 24);       // the drop point itself does not jump
    const glow = RIPPLE.glow * band * decay * (0.6 + 0.4 * wave);
    return { push: RIPPLE.push * wave * band * decay * centre, glow: glow > 1e-4 ? glow : 0 };
  }

  function createRipples({ reducedMotion = false } = {}) {
    const list = [];
    const life = reducedMotion ? RIPPLE.still : RIPPLE.life;
    return {
      press(x, y, now) {
        list.push({ x, y, t: now });
        if (list.length > MAX_RIPPLES) list.shift();
      },
      // Drops finished ripples; true while any is still running.
      active(now) {
        for (let i = list.length - 1; i >= 0; i--) if (now - list[i].t > life) list.splice(i, 1);
        return list.length > 0;
      },
      // Every running ripple at (x, y): displacement vector and brightness, summed.
      sample(x, y, now) {
        let sx = 0;
        let sy = 0;
        let glow = 0;
        for (const r of list) {
          const dx = x - r.x;
          const dy = y - r.y;
          const d = Math.hypot(dx, dy);
          const s = rippleSample(d, now - r.t, reducedMotion);
          glow += s.glow;
          if (s.push && d > 0) { sx += (dx / d) * s.push; sy += (dy / d) * s.push; }
        }
        return { x: sx, y: sy, glow };
      },
    };
  }

  // Where the mark sits, in the field's own pixels. 'center': the empty chat, a little above
  // the middle. 'right': a page hero, cut by the right edge and clear of the headline on the
  // left. 'top': a tall panel whose text sits at the bottom.
  function maskRect(W, H, place) {
    if (place === 'right') {
      const size = H * 1.55;
      return { size, left: Math.max(W * 0.5, W - size * 0.62), top: H * 0.5 - size / 2 };
    }
    if (place === 'top') {
      const size = Math.min(W * 0.92, H * 0.6);
      return { size, left: (W - size) / 2, top: H * 0.06 };
    }
    const size = Math.min(H * 1.02, W * 0.86);
    return { size, left: W / 2 - size / 2, top: H * 0.45 - size / 2 };
  }

  // A sprite icon as a white stroke drawing the canvas can read back (currentColor is white).
  function iconImageUrl(id) {
    const symbol = document.getElementById(`i-${id}`);
    if (!symbol) throw new Error(`glyph field: no icon #i-${id} in the sprite`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol.getAttribute('viewBox') || '0 0 24 24'}" width="256" height="256" color="#fff" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${symbol.innerHTML}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function isBackgroundPress(e) {
    if (e.button !== 0 || e.isPrimary === false) return false;
    const t = e.target;
    return !(t && typeof t.closest === 'function' && t.closest(INTERACTIVE));
  }
  // The press is the whole gesture: no move, up or drag handlers, so holding does nothing.
  function bindPress(target, onPress) {
    target.addEventListener('pointerdown', (e) => { if (isBackgroundPress(e)) onPress(e); });
  }

  // Smooth value noise for the resting brightness, so the field has soft clusters.
  function hash(x, y) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
    const v = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // opts.mask: { image: url } or { icon: sprite id } or null; opts.place: see maskRect;
  // opts.fade: 'composer' (calm under the chat composer), 'headline' (calm where a hero's
  // headline sits, bottom left), 'caption' (calm under a panel's text, bottom) or none;
  // opts.when(host): extra condition for running, checked when the host's class changes.
  function create(host, opts = {}) {
    const place = opts.place || 'center';
    const fadeKind = opts.fade || null;
    const when = opts.when || (() => true);
    const canvas = document.createElement('canvas');
    canvas.className = 'glyph-field';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('glyph field: this browser gives no 2D canvas context');

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let ripples = createRipples({ reducedMotion: motion.matches });

    // Grid in device pixels; gw x gh is one glyph cell.
    let W = 0;
    let H = 0;
    let dpr = 1;
    let gw = 0;
    let gh = 0;
    let cols = 0;
    let rows = 0;
    let glyph = new Uint8Array(0);
    let base = new Float32Array(0);   // resting brightness per cell, 0 = empty
    let lit = [];                     // cells with a resting glyph
    let atlasInk = null;
    let atlasCrest = null;
    let dirty = true;
    let running = false;
    let rippling = false;
    let visible = false;
    let raf = 0;
    let idleTimer = 0;

    // The atlas is drawn in Geist Mono: lay out again once the font is in.
    document.fonts.load(`${FONT_PX}px "Geist Mono"`).then(() => { dirty = true; if (running) relayout(); },
      (err) => console.error(`glyph field: Geist Mono did not load (${err && err.message}); glyphs use the system monospace.`));

    let mark = null;
    let markReady = false;
    if (opts.mask) {
      mark = new Image();
      const what = opts.mask.image || `icon #i-${opts.mask.icon}`;
      mark.src = opts.mask.image || iconImageUrl(opts.mask.icon);
      mark.decode().then(() => { markReady = true; dirty = true; if (running) relayout(); },
        (err) => console.error(`glyph field: ${what} did not load (${err && err.message}); the field is drawn without the mark.`));
    }

    function atlas(color) {
      const a = document.createElement('canvas');
      a.width = gw * GLYPHS.length;
      a.height = gh;
      const c = a.getContext('2d');
      c.font = `${FONT_PX * dpr}px ${MONO}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = color;
      for (let i = 0; i < GLYPHS.length; i++) c.fillText(GLYPHS[i], i * gw + gw / 2, gh / 2);
      return a;
    }

    // Alpha of the mark per cell: the mark drawn into a cols x rows bitmap, one pixel per cell.
    function markAlpha() {
      if (!markReady) return null;
      const { size, left, top } = maskRect(W, H, place);
      const off = document.createElement('canvas');
      off.width = cols;
      off.height = rows;
      const o = off.getContext('2d', { willReadFrequently: true });
      o.imageSmoothingQuality = 'high';
      o.drawImage(mark, left / gw, top / gh, size / gw, size / gh);
      let data;
      try {
        data = o.getImageData(0, 0, cols, rows).data;
      } catch (err) {
        console.error(`glyph field: the browser will not read the mark back (${err && err.message}); the field is drawn without it.`);
        return null;
      }
      const out = new Float32Array(cols * rows);
      for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
      return out;
    }

    // Calm zones keep text on top of the field readable.
    function fadeAt(c, r) {
      const x = (c * gw) / W;
      const y = (r * gh) / H;
      if (fadeKind === 'composer') return Math.min(1, Math.max(0.35, (1 - y) / 0.22));
      if (fadeKind === 'headline') return Math.min(1, Math.max(0.15, x / 0.5, (1 - y) / 0.6));
      if (fadeKind === 'caption') return Math.min(1, Math.max(0.12, (0.62 - y) / 0.2));
      return 1;
    }

    function restLevel(a, c, r) {
      const n = noise(c * 0.09, r * 0.16) * 0.65 + noise(c * 0.31 + 17, r * 0.55) * 0.35;
      const spark = a > 0.5 && hash(c, r + 9973) > 0.97 ? 0.25 : 0;
      const inside = a * (0.14 + 0.42 * n) + spark;
      const outside = (1 - a) * (n > 0.74 ? 0.035 + 0.16 * (n - 0.74) : 0);
      const v = (inside + outside) * fadeAt(c, r);
      return v > 0.02 ? Math.min(1, v) : 0;
    }

    function relayout() {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.round(rect.width * dpr);
      H = Math.round(rect.height * dpr);
      canvas.width = W;
      canvas.height = H;
      ctx.font = `${FONT_PX}px ${MONO}`;
      gw = Math.round((Math.ceil(ctx.measureText('M').width) + 1) * dpr);
      gh = Math.round(LINE_PX * dpr);
      cols = Math.ceil(W / gw);
      rows = Math.ceil(H / gh);
      atlasInk = atlas(INK);
      atlasCrest = atlas(CREST);
      const alpha = markAlpha();
      glyph = new Uint8Array(cols * rows);
      base = new Float32Array(cols * rows);
      lit = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          glyph[i] = (Math.random() * GLYPHS.length) | 0;
          base[i] = restLevel(alpha ? alpha[i] : 0, c, r);
          if (base[i]) lit.push(i);
        }
      }
      dirty = false;
      paint(performance.now());
      return true;
    }

    function drawCell(i, x, y, alpha, atlasImg) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(atlasImg, glyph[i] * gw, 0, gw, gh, x, y, gw, gh);
    }

    // At rest only the lit cells are drawn; while a ripple runs every cell is sampled,
    // because the ring also lights empty ground as it passes.
    function paint(now) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      if (!rippling) {
        for (const i of lit) drawCell(i, (i % cols) * gw, ((i / cols) | 0) * gh, base[i], atlasInk);
        ctx.globalAlpha = 1;
        return;
      }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const s = ripples.sample((c * gw + gw / 2) / dpr, (r * gh + gh / 2) / dpr, now);
          const level = base[i] + s.glow * 0.45;
          if (level < 0.02) continue;
          if (s.glow > 0.3 && Math.random() < 0.25) glyph[i] = (Math.random() * GLYPHS.length) | 0;
          const x = c * gw + s.x * dpr;
          const y = r * gh + s.y * dpr;
          drawCell(i, x, y, Math.min(1, level), atlasInk);
          if (s.glow > 0.04) drawCell(i, x, y, Math.min(1, s.glow), atlasCrest);
        }
      }
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      raf = 0;
      if (!running) return;
      rippling = ripples.active(now);
      paint(now);
      if (rippling) raf = requestAnimationFrame(frame);
    }

    function idleTick() {
      if (rippling || motion.matches || !lit.length) return;
      const count = Math.max(1, Math.round(lit.length * IDLE_SHARE));
      for (let k = 0; k < count; k++) {
        const i = lit[(Math.random() * lit.length) | 0];
        glyph[i] = (Math.random() * GLYPHS.length) | 0;
        const x = (i % cols) * gw;
        const y = ((i / cols) | 0) * gh;
        ctx.clearRect(x, y, gw, gh);
        drawCell(i, x, y, base[i], atlasInk);
      }
      ctx.globalAlpha = 1;
    }

    // Runs only while the empty chat is on screen and the tab is visible.
    function update() {
      const should = visible && when(host) && !document.hidden;
      if (should === running) return;
      running = should;
      if (running) {
        if (dirty && !relayout()) { running = false; return; }
        idleTimer = setInterval(idleTick, IDLE_MS);
      } else {
        clearInterval(idleTimer);
        idleTimer = 0;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        rippling = false;
        ripples = createRipples({ reducedMotion: motion.matches });
      }
    }

    new MutationObserver(update).observe(host, { attributes: true, attributeFilter: ['class'] });
    new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; update(); }).observe(host);
    document.addEventListener('visibilitychange', update);
    let resizeFrame = 0;
    new ResizeObserver(() => {
      dirty = true;
      // A field that could not lay out at zero size starts once the view has a size.
      if (!running) { update(); return; }
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (running) relayout(); });
    }).observe(host);
    motion.addEventListener('change', () => {
      ripples = createRipples({ reducedMotion: motion.matches });
      rippling = false;
      if (running) paint(performance.now());
    });

    return {
      press(clientX, clientY) {
        if (!running) return;
        const rect = canvas.getBoundingClientRect();
        ripples.press(clientX - rect.left, clientY - rect.top, performance.now());
        rippling = true;
        if (!raf) raf = requestAnimationFrame(frame);
      },
    };
  }

  // A field on `host` that answers clicks on it: the one call a view needs.
  function attach(host, opts) {
    const field = create(host, opts);
    bindPress(host, (e) => field.press(e.clientX, e.clientY));
    return field;
  }

  F.glyphField = { GLYPHS, RIPPLE, rippleSample, createRipples, bindPress, maskRect, create, attach };
})();
