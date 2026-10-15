'use strict';

// Empty-chat backdrop: the project mark set in random letters and digits, and a water
// ripple from each click on the background. Only a press starts a ripple: holding the
// button or dragging does nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGlyphField() {
  const file = path.join(__dirname, '..', 'public', 'dashboard', 'glyphfield.js');
  const window = { FDSA: {} };
  vm.runInContext(fs.readFileSync(file, 'utf8'), vm.createContext({ window }), { filename: 'glyphfield.js' });
  const G = window.FDSA.glyphField;
  assert.ok(G, 'glyphfield.js must register window.FDSA.glyphField');
  return G;
}

test('glyph field: the field is drawn from letters and digits only', () => {
  const G = loadGlyphField();
  assert.match(G.GLYPHS, /^[A-Za-z0-9]+$/);
  assert.equal(new Set(G.GLYPHS).size, 62, 'every letter in both cases and every digit, once');
});

test('glyph field: a click ripple moves glyphs only on its wavefront and dies out', () => {
  const G = loadGlyphField();
  const { speed, life } = G.RIPPLE;
  const age = 400;
  const front = speed * age;

  const ahead = G.rippleSample(front + 60, age, false);
  assert.equal(ahead.push, 0, 'glyphs the wave has not reached yet stay put');
  assert.equal(ahead.glow, 0);

  let moved = 0;
  for (let d = Math.max(0, front - 120); d <= front; d += 2) {
    moved = Math.max(moved, Math.abs(G.rippleSample(d, age, false).push));
  }
  assert.ok(moved >= 2, `glyphs on the wavefront are pushed visibly, got ${moved}px`);
  assert.ok(G.rippleSample(front - 10, age, false).glow > 0, 'the wavefront lights its glyphs');

  for (const d of [0, 40, front, front + 200]) {
    const after = G.rippleSample(d, life + 1, false);
    assert.equal(after.push, 0, `nothing moves after the ripple ends (d=${d})`);
    assert.equal(after.glow, 0);
  }
});

test('glyph field: with reduced motion a click lights glyphs but moves none', () => {
  const G = loadGlyphField();
  for (let age = 0; age <= G.RIPPLE.life; age += 50) {
    for (let d = 0; d <= 600; d += 15) {
      assert.equal(G.rippleSample(d, age, true).push, 0, `no movement at d=${d}, age=${age}`);
    }
  }
  assert.ok(G.rippleSample(0, 50, true).glow > 0, 'the pressed spot still answers');
});

test('glyph field: ripples from several clicks add up and are dropped when they end', () => {
  const G = loadGlyphField();
  const age = 300;
  const r = G.RIPPLE.speed * age - 10;          // just behind the wavefront
  const ripples = G.createRipples({ reducedMotion: false });
  ripples.press(0, 0, 0);
  ripples.press(2 * r, 0, 0);
  assert.equal(ripples.active(10), true);

  const one = G.rippleSample(r, age, false);
  const both = ripples.sample(r, 0, age);       // exactly between the two clicks
  assert.ok(one.glow > 0);
  assert.ok(Math.abs(both.glow - 2 * one.glow) < 1e-9, 'two ripples meeting light the glyphs twice as much');
  assert.ok(Math.abs(both.x) < 1e-9 && Math.abs(both.y) < 1e-9, 'opposite pushes cancel out');

  assert.equal(ripples.active(G.RIPPLE.life + 1), false, 'finished ripples are dropped');
  const later = ripples.sample(r, 0, G.RIPPLE.life + 1);
  assert.deepEqual([later.x, later.y, later.glow], [0, 0, 0]);
});

test('glyph field: only a press starts a ripple; holding or dragging does nothing', () => {
  const G = loadGlyphField();
  const listeners = {};
  const target = { addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); } };
  const presses = [];
  G.bindPress(target, (e) => presses.push(e));

  assert.deepEqual(Object.keys(listeners), ['pointerdown'], 'no move, up or drag listeners at all');

  const background = { closest: () => null };
  const control = { closest: (sel) => (/button|textarea|form/.test(sel) ? {} : null) };
  const down = (extra) => listeners.pointerdown.forEach(fn => fn({ button: 0, isPrimary: true, target: background, ...extra }));

  down();
  assert.equal(presses.length, 1, 'a press on the background starts a ripple');
  down({ button: 2 });
  assert.equal(presses.length, 1, 'a right click does not');
  down({ isPrimary: false });
  assert.equal(presses.length, 1, 'a second finger does not');
  down({ target: control });
  assert.equal(presses.length, 1, 'a press on the composer or a button does not');
});

test('settings pages and the add-account dialog show no photos or video', () => {
  const dir = path.join(__dirname, '..', 'public', 'dashboard');
  for (const file of ['core.js', 'status.js', 'accounts.js', 'usage.js', 'requests.js', 'agents.js', 'settings.js']) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(code, /\/dashboard\/media-/, `${file} still shows a photo or video`);
    assert.doesNotMatch(code, /createElement\(['"]video['"]\)/, `${file} still plays a video`);
  }
});

test('glyph field: a page hero keeps its mark on the right, clear of the headline; the chat centres it', () => {
  const G = loadGlyphField();
  for (const [W, H] of [[1200, 320], [800, 300], [480, 260]]) {
    const r = G.maskRect(W, H, 'right');
    assert.ok(r.left >= W * 0.45, `hero mark starts at ${r.left}px of ${W}px, over the headline`);
    assert.ok(r.size >= H, 'the hero mark is at least as tall as the hero');
  }
  const c = G.maskRect(1200, 800, 'center');
  assert.ok(Math.abs(c.left + c.size / 2 - 600) < 1, 'the chat mark is centred');
});
