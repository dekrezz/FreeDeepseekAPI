# Switchyard: dashboard design spec (FreeDeepseekAPI)

Status: final and ready to implement. This file supersedes Proposal A ("Switchyard") and Proposal B ("Relay Glass"). The winner is A, with grafts from B (§0).
Surface mode: **Operate**. Brief constraints that cannot be overridden:
- no npm, no build step, vanilla HTML/CSS/JS;
- CSP stays as written in `server.js` (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:`), so there are no CDNs, no web fonts, no inline style attributes and no inline scripts. Dynamic values go through the CSSOM (`el.style.setProperty`), which CSP allows;
- the security model is unchanged: Host/Origin checks, `PROXY_API_KEY`, admin gating;
- fail loudly. Never show fake data or a silent fallback.

Skills this spec was checked against:
- `~/.claude/skills/impeccable/SKILL.md`, plus `reference/operate.md`, `craft-floor.md`, `new-work.md` and `visualize.md`;
- `~/.claude/skills/frontend-design/SKILL.md`;
- `~/.claude/skills/apple-design/SKILL.md`;
- `~/.claude/skills/emil-design-eng/SKILL.md`.

No dataviz `SKILL.md` exists under `~/.claude` on this machine. The chart rules in §7 restate the dataviz method both proposals used: validated palette, form before colour, no dual axis, a table twin. Implementers should re-read `craft-floor.md` immediately before writing CSS.

---

## 0. Decision record

| Criterion (1–5) | A: Switchyard | B: Relay Glass |
|---|---|---|
| Originality without gimmick | 5. A track diagram is literally what the proxy does; DIN readouts | 4. "The Wire" and the route receipt; the serif chat voice |
| Restraint | 4. Cobalt does a little too much, including the primary fill | 5. Ink-black primaries, accent never a fill |
| Fit for dev-tool dashboard + chat | 5. Strongest Status view and state tables | 4. Strongest chat moments and cross-links |
| Accessibility | 5. Shape lamps, table twins, contrast computed | 5. Equivalent |
| Feasibility under CSP / vanilla | 4. `local()` DIN needs a one-time check | 4. Serif prose falls back unevenly in Chrome and lacks Cyrillic |
| **Total** | **23** | **22** |

**Winner: A, Switchyard.** Its signature, the per-account track diagram, is product truth and not decoration. Its state system is the most complete.

**Grafted from B:**
1. **Ink-black primary buttons.** Cobalt `--signal` is limited to selection, focus, links, the "live" and "busy" states, and data. It is never a button fill. That is what keeps the restraint at the ChatGPT/SpaceX level.
2. **Route receipt** under every assistant reply. It uses icon + value pairs, links the account to its account page, and links the whole receipt to the matching Requests row.
3. **Composer docking**, a FLIP from the centred empty state to the docked position. It happens once per conversation and is the product's single authored motion moment.
4. **Block-staggered reveal** of the burst reply, replacing A's per-character typewriter. B correctly calls a typewriter fake streaming.
5. **Three glass thicknesses** (thin, regular, thick), with blur capped at 40px.
6. **Status headline as a live sentence**: "4 of 5 accounts can serve. alt-3 cools down for 1:12 more."
7. **Single sidebar with a chat list**, ChatGPT-style, instead of A's second conversation column. That column would leave only about 600px for the transcript at 1100px.
8. **Cross-links everywhere.**
   - Account → Requests filtered by account and Usage filtered by account.
   - Request row → conversation.
   - Track segment → request.
9. **Undoable removal.** The account file moves to `accounts/.removed/`, and a toast offers Undo.
10. **Settings → Connection**: copyable OpenAI, Anthropic and curl snippets.

**Declined from B:**
- Serif assistant prose. It would be a fourth type voice. In Chrome, `ui-serif` does not resolve and falls to Iowan Old Style, which has no Cyrillic, and the project ships `README.ru.md`.
- The warm limestone ground. It drifts toward the cream tell; cool porcelain reads more precise.
- B's four-slot chart palette. Only two series exist.

**Declined from A:**
- The second conversation column.
- The cobalt Send/primary fill.
- The per-character reveal.

**Not done, and still to do with the user:** impeccable `init` (PRODUCT.md) and the concept roll were skipped, because the orchestrator fixed the direction. After the build, run `impeccable detect --json` and the finish reviewer.

---

## 1. Concept

The proxy is a rail **switchyard**:
- requests arrive and get switched onto a **track**, which is a DeepSeek account;
- a request occupies the track for a while, then leaves;
- a track can be **signalled** (cooldown) or **out of service** (disabled).

The UI borrows the *working grammar* of a signal-box track diagram:
- one horizontal lane per account;
- occupancy drawn as solid segments;
- signal lamps that carry shape as well as colour;
- time running left to right up to a hard **now** line.

The visual language:
- **Ground:** cool porcelain in light mode, graphite slate in dark mode.
- **Ink:** black ink carries all text and primary actions.
- **Hairlines and rules:** used throughout.
- **Signal colour:** one colour only, cobalt.
- **Readout numerals:** DIN.
- **Liquid glass:** only where content actually scrolls beneath it.

**The one bold thing:** the track diagram on Status, plus its echo in the account inspector. Everything else is quiet.

---

## 2. Information architecture and routing

Routing uses hash routes, so the server needs no route changes; only new static files are whitelisted.

| Route | View | Data |
|---|---|---|
| `#/status` | Status (track diagram, pool sentence, recent errors) | `GET /admin/accounts` every 5s; `GET /admin/requests?since=` every 5s |
| `#/chat` · `#/chat/<convId>` | Chat | `/v1/models`, `/v1/model-capabilities`, `/v1/chat/completions`, `/reset-session`, `/v1/sessions` |
| `#/accounts` · `#/accounts/<id>` | Accounts (table + inspector) | `/admin/accounts*` |
| `#/usage?w=1h\|24h\|all&account=&model=` | Usage | `GET /admin/usage` |
| `#/requests?status=error&account=&model=&endpoint=&client=&id=` | Requests (`id` opens that row's inspector) | `GET /admin/requests` |
| `#/settings` | Settings | local + `/health` |

**Landing:** `#/status` on the first visit. After that, the last route is stored in `localStorage` key `fdsa.lastRoute`. An unknown route goes to `#/status` with the toast "Unknown page `#/x`".

**Sidebar order:**
1. **New chat** button (ink-filled; ⌘/Ctrl+Shift+O)
2. Chat
3. Status
4. Accounts
5. Usage
6. Requests
7. Chats section: search field, then the list grouped Today / Yesterday / Previous 7 days / Older
8. Footer: pool signal ("4 of 5 ready", or "None ready · next in 0:42"; clicking goes to Accounts) and Settings

**Command palette** (⌘K / Ctrl+K): a `<dialog>`, opened and closed with **no animation**.
- Navigates to any view.
- Actions: New chat, Reload accounts, Pause account…, Clear cooldown…
- Jumps to any account or conversation.
- Matching is fuzzy on label.

**Keyboard:**

| Keys | Action |
|---|---|
| `g` then `c`/`s`/`a`/`u`/`r` | Go to Chat / Status / Accounts / Usage / Requests (within 800ms) |
| `/` | Focus the view filter |
| `j` / `k` | Move the table row cursor |
| `Enter` | Open the inspector |
| `Esc` | Close the topmost layer (popover > sheet > palette), or stop chat generation |
| `⌘\` | Toggle the sidebar |

**Pool signal states** (sidebar footer, also the tab bar badge on mobile):

| Pool state | Lamp | Text | Colour |
|---|---|---|---|
| ≥1 can serve | ready lamp | "N of M ready" | `--ok` lamp, `--ink-2` text |
| 0 can serve, cooldown pending | cooldown lamp | "None ready · next in m:ss" | `--warn` |
| 0 accounts or none with credentials | no-creds lamp | "No accounts" | `--crit` |

---

## 3. Files and backend contract

### 3.1 Static files

All files live in `public/dashboard/`. Each one gets a `DASHBOARD_FILES` entry in `server.js` and a `node --check` line in `test:syntax`. The whitelist test must keep asserting that `/dashboard/x` returns 404.

| File | Contents |
|---|---|
| `index.html` | Shell, SVG `<symbol>` sprite, `<template>`s, plain `<script defer>` tags in this order |
| `app.css` | All styles; tokens at the top |
| `core.js` | `api()` fetch wrapper (key header, error normalisation), auth gates, router, tiny store, toasts, sheet/popover/dialog helpers, formatters, poller |
| `charts.js` | SVG primitives: axis, columns, stacked columns, hbar, track lanes, tooltip, table twin |
| `markdown.js` | Safe DOM markdown renderer (no `innerHTML`, ever) |
| `status.js`, `accounts.js`, `usage.js`, `requests.js`, `settings.js` | Views |
| `chat.js` | Chat view + IndexedDB store |

There are no ES modules. Every file attaches to the `window.FDSA` namespace. Delete the old `app.js` and its whitelist entry, and update `test:syntax`. The `Containerfile` must `COPY public/ ./public/`.

### 3.2 Backend additions

These are required. The UI must also handle each one being absent: a 404 renders the specific "endpoint missing" panel (§10).

**Extend `logRow`:**
- `id`: monotonically increasing integer as a string.
- `api`: `"openai"`, `"anthropic"` or `"responses"`.
- `stream`: boolean.
- `error_type`: string or null.
- `error_message`: string or null, clipped to 500 characters.
- `local`: true for requests answered without upstream (e.g. `/new`).
- `agent`: unchanged; the UI shows it as **Client**.

**`GET /admin/requests?limit=200&since=<id>&account=&model=&status=ok|error&path=`**

Response:
```
{ now, capacity: 400, oldest_ts, rows: [logRow…newest first] }
```
`since` returns only rows with `id > since`.

**`GET /admin/usage?window=1h|24h|all`**

Response:
```
{ now, window, bucket_ms, coverage: { from_ts, rows, capacity },
  totals: { requests, errors, prompt_tokens, completion_tokens, usd },
  series: [{ t, prompt_tokens, completion_tokens, requests, errors }],
  by_account: [{ key, requests, errors, prompt_tokens, completion_tokens, usd, p50_ms, p95_ms }],
  by_model, by_client, by_endpoint,
  lifetime_by_account: [ … from usageByAccount ] }
```
Bucket sizes: `1h` → 5 min, `24h` → 1 h, `all` → auto, giving 24–48 buckets.

**`POST /admin/accounts/import`**
- Body: `{ name, auth: <deepseek-auth.json object> }`.
- Validates the fields `token`, `cookie`, `hif_dliq`, `hif_leim`.
- Writes `accounts/<sanitised-name>.json` with mode `0600`, then reloads.
- Errors: 409 `account_exists`, 422 `invalid_auth` with `{ missing: [...] }`.

**`DELETE /admin/accounts/:id`**
- Moves the file to `accounts/.removed/<name>-<ts>.json` and reloads.
- Returns `{ removed: id, trash: "<file>" }`.

**`POST /admin/accounts/restore`**
- Body: `{ trash }`.
- Moves the file back and reloads.
- 409 if the name is taken.

The account loader must ignore dot-directories.

All new admin routes go through `adminAccessDecision`, the same as today.

---

## 4. Layout

### 4.1 Shell

```
≥1100px
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ [✎ New chat] │ ░ toolbar: glass-thin, sticky, 52px, content scrolls under ░ │
│              │ <view title>                  Updated 14:02:31  ● Live  [⋯] │
│ ◫ Chat       ├──────────────────────────────────────────────────────────────┤
│ ▸ Status     │                                                              │
│   Accounts   │      view content, padding 32px 40px, max-width 1320px       │
│   Usage      │      (Chat: transcript column max 720px, centred)            │
│   Requests   │                                                              │
│ Chats ⌕ ____ │                                                              │
│  Today       │                                                              │
│   Debug fai… │                                                              │
│  Yesterday   │                                                              │
│   SQL index… │                                                              │
│ ──────────── │                                                              │
│ ● 4 of 5 rdy │                                                              │
│ ⚙ Settings   │                                                              │
└──────────────┴──────────────────────────────────────────────────────────────┘
 240px, solid --rail (heavy structural material, never glass)
```

**720–1099px:**
- The sidebar becomes a 64px icon rail: New chat, the five views, and Settings, with tooltips.
- The chat list moves into a left **sheet** (thick glass, scrim) opened from the toolbar sidebar-toggle in Chat.

**<720px:**
- A bottom tab bar (glass-regular, 56px + `env(safe-area-inset-bottom)`) holds Chat, Status, Accounts, Usage and Requests. Status carries the pool lamp badge.
- Settings and New chat move to the toolbar.
- Tables reflow to two-line rows (§6.2).
- Inspectors become bottom sheets with drag-to-dismiss (§8).

**Alignment and spacing:**
- Everything is left-aligned, except the chat empty state, which is centred.
- There is no container card around tables. They sit on the ground with hairline row rules.
- Sections are separated by 40px plus a 1px `--rule`. They are not boxed.

### 4.2 Toolbar (every view)

- **Left:** the view title (`title` step). In Chat this is the conversation title, which can be edited by double-click or from the ⋯ menu.
- **Right:**
  - "Updated hh:mm:ss" (meta, `--ink-3`, tabular);
  - a Live toggle on data views (on means polling is active; it is a switch, not a button);
  - the view's primary actions;
  - an ⋯ overflow menu.
- **Scroll-edge effect:** the scroll container gets `mask-image: linear-gradient(to bottom, transparent 0, #000 12px)`, offset under the toolbar. There is no border under the toolbar.

---

## 5. Tokens

### 5.1 Colour (oklch is the source of truth)

Contrast is measured against `--bg`. The theme follows the system; Settings can force a theme with `:root[data-theme=light|dark]`. Use `color-scheme: light dark`. Define both palettes with `@media (prefers-color-scheme: dark)` on `:root:not([data-theme=light])`, plus `:root[data-theme=dark]`.

| Token | Light | Dark | Role / contrast |
|---|---|---|---|
| `--bg` | `oklch(0.975 0.004 255)` | `oklch(0.23 0.012 260)` | page ground (graphite slate, not tinted black) |
| `--surface` | `oklch(0.995 0.002 255)` | `oklch(0.265 0.012 260)` | sheets, popovers, solid glass fallback, chart plot |
| `--sunken` | `oklch(0.95 0.006 255)` | `oklch(0.205 0.012 260)` | inputs, code blocks, user bubble, skeleton bars |
| `--rail` | `oklch(0.955 0.006 258)` | `oklch(0.205 0.012 260)` | sidebar |
| `--ink` | `oklch(0.23 0.015 262)` | `oklch(0.96 0.004 260)` | text, **primary button fill**, 15.7 / 15.0 |
| `--on-ink` | `= --bg` | `= --bg` | text on primary button |
| `--ink-2` | `oklch(0.43 0.016 262)` | `oklch(0.80 0.010 260)` | secondary, 7.6 / 9.0 |
| `--ink-3` | `oklch(0.53 0.014 262)` | `oklch(0.68 0.012 260)` | tertiary / meta, 4.9 / 5.9 (≥4.5 on `--sunken`) |
| `--rule` | `oklch(0.905 0.006 258)` | `oklch(0.32 0.012 260)` | hairlines |
| `--rule-strong` | `oklch(0.64 0.010 258)` | `oklch(0.55 0.012 260)` | control borders, chart baseline, ≥3:1 |
| `--signal` | `oklch(0.52 0.20 264)` | `oklch(0.72 0.14 264)` | focus, selection, links, live, busy, 5.4 / 6.7 |
| `--signal-wash` | `oklch(0.52 0.20 264 / 0.10)` | `oklch(0.72 0.14 264 / 0.16)` | selected row, new-row flash, `::selection` |
| `--ok` | `oklch(0.52 0.12 155)` | `oklch(0.76 0.13 155)` | ready, 4.9 / 8.3 |
| `--warn` | `oklch(0.54 0.11 75)` | `oklch(0.80 0.12 80)` | cooldown / stale, 4.8 / 9.0 |
| `--crit` | `oklch(0.53 0.19 27)` | `oklch(0.71 0.16 27)` | error / destructive, 5.4 / 6.1 |
| `--ok-wash` / `--warn-wash` / `--crit-wash` | status at α 0.10 | status at α 0.16 | row tint, cooldown band, inline error block |
| `--data-1` (completion) | `#2c5fdd` | `#628eed` | chart series |
| `--data-2` (prompt) | `#c5772c` | `#c77f3e` | chart series. Copper is data only and never a status colour |

**Rules:**
- **Primary buttons** use `--ink` fill and `--on-ink` text. **Secondary buttons** are transparent with a 1px `--rule-strong` border and `--ink` text. **Destructive buttons** use a `--crit` fill and white text (light) or `--bg` text (dark), and appear only inside a confirmation.
- `--signal` is never a fill larger than a 2px stroke or a 10px lamp. The exceptions are `--signal-wash` backgrounds, data marks and focus rings.
- **Status is never shown by colour alone.** It is always lamp shape + word (§9).

**Browser surfaces:**
```css
::selection { background: var(--signal-wash); color: var(--ink); }
:root { caret-color: var(--signal); accent-color: var(--signal); }
* { scrollbar-width: thin; scrollbar-color: var(--rule-strong) transparent; }
a { color: var(--signal); text-decoration-thickness: 1px; text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
```
Tables, axes and timers use `font-variant-numeric: tabular-nums`.

### 5.2 Typography

```css
@font-face {
  font-family: "Readout";
  src: local("DIN Alternate Bold"), local("DINAlternate-Bold"), local("Bahnschrift SemiBold"), local("Bahnschrift");
  font-weight: 700;
  unicode-range: U+0030-0039, U+0024, U+0025, U+002B-002E, U+003A, U+00B7, U+2212, U+2248;
}
:root {
  --font-ui:   -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif;
  --font-read: "Readout", var(--font-ui);
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
html { font: 100%/1.5 var(--font-ui); -webkit-font-smoothing: antialiased; font-optical-sizing: auto; }
```

- **The DIN check.** `local()` is not a network fetch. Verify once in Safari and Chrome that DevTools shows no CSP `font-src` violation and that digits render in DIN. If either browser blocks it, delete the `@font-face`; `--font-read` then falls back to SF with tabular numerals. **Do not loosen the CSP for this.**
- **Why digits only:** macOS ships DIN Alternate in Bold only and without Cyrillic, so letters always fall through to SF.

| Step | rem (px) / line-height | Weight | Tracking | Family | Use |
|---|---|---|---|---|---|
| `title` | 1.625 (26) / 32px | 650 | −0.022em | ui | one per view; Status sentence; chat empty heading |
| `readout-xl` | 1.875 (30) / 34px | 700 | −0.01em | read | KPI figures (proportional numerals) |
| `heading` | 1.0625 (17) / 24px | 600 | −0.012em | ui | section headings, sheet titles |
| `prose` | 1 (16) / 26px | 400 | −0.006em | ui | assistant + user messages, max 68ch |
| `body` | 0.875 (14) / 20px | 400 | −0.003em | ui | UI, table cells |
| `label` | 0.8125 (13) / 18px | 500 | 0 | ui | buttons, controls, column headers (sentence case) |
| `meta` | 0.75 (12) / 16px | 400 | +0.006em | ui | timestamps, captions, axis ticks |
| `readout` | inherit size | 700 | 0 | read | inline countdowns and durations in tables (tabular) |
| `code` | 0.8125 (13) / 20px | 400 | 0 | mono | code blocks |
| `mono-id` | 0.78125 (12.5) / 18px | 400 | 0 | mono | model ids, account ids, header values, `error.type` |

**Rules:**
- Text on glass gets +50 weight and +0.005em tracking (vibrancy).
- No ALL-CAPS, no eyebrows above headings.
- Space above a heading is 32px; space below is 12px.
- Assistant headings h1–h4 map to `heading` (h1, h2) and `prose` 600 (h3, h4).

### 5.3 Spacing, radii, elevation, sizing

- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32, 40, 56, 72, written in rem (÷16). Layout scales with the user's font size.
- **Row height:** 40px comfortable, 32px compact. The density toggle is in Settings, attribute `[data-density]`.
- **Hit targets:** at least 32px on a fine pointer, 44px under `(pointer: coarse)`.
- **Radii:**

| Element | Radius |
|---|---|
| Buttons, segmented controls | 8 |
| Inputs | 10 |
| Code blocks | 10 |
| Popovers | 12 |
| Sheets and inspector | 16 |
| User bubble | 18 |
| Composer | 22 |
| Pills, switches, chips | 999 |
| Lane segments | 3 |
| Chart column top | 4 |

- **Elevation is declared once:** a border *or* a shadow, never both. The glass specular rim is not a border.
  - `--shadow-pop: 0 2px 6px -2px oklch(0.25 0.03 262 / 0.12), 0 12px 32px -12px oklch(0.25 0.03 262 / 0.28)`
  - `--shadow-sheet: 0 2px 4px oklch(0.2 0.03 262 / 0.06), 0 24px 64px -16px oklch(0.2 0.03 262 / 0.32)`
  - In dark mode, multiply alpha by 1.8.
- **z-index scale:** toolbar 10, tab bar 20, inspector 30, scrim 40, sheet/dialog 50, popover 60, toast 70, palette 80.

### 5.4 Liquid glass material

```css
.glass {
  --g-tint: 68%; --g-blur: 24px;
  background: color-mix(in oklch, var(--surface) var(--g-tint), transparent);
  -webkit-backdrop-filter: blur(var(--g-blur)) saturate(1.7);
          backdrop-filter: blur(var(--g-blur)) saturate(1.7);
  box-shadow:
    inset 0 1px 0 0 oklch(1 0 0 / 0.55),          /* specular top edge */
    inset 0 0 0 1px oklch(1 0 0 / 0.10),          /* rim */
    inset 0 -1px 0 0 oklch(0.2 0.02 262 / 0.06),  /* seat */
    var(--shadow-pop);
}
.glass-thin    { --g-tint: 72%; --g-blur: 18px; box-shadow: inset 0 -0.5px 0 0 oklch(0.2 0.02 262 / 0.06); } /* toolbar */
.glass-regular { --g-tint: 70%; --g-blur: 24px; }   /* composer, toasts, tab bar, "N new" pill */
.glass-thick   { --g-tint: 80%; --g-blur: 36px; box-shadow: inset 0 1px 0 0 oklch(1 0 0 / 0.55), inset 0 0 0 1px oklch(1 0 0 / 0.10), var(--shadow-sheet); } /* inspector, sheets, palette, auth gate */
```

**Dark mode:**
- `--g-tint` is 10 points lower.
- The specular edge is `oklch(1 0 0 / 0.14)`.
- The rim is `oklch(1 0 0 / 0.06)`.

**Fallbacks, in this order of specificity:**
1. `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))`: background `var(--surface)` and `box-shadow: 0 0 0 1px var(--rule), var(--shadow-pop)`.
2. `@media (prefers-reduced-transparency: reduce)`, or `:root[data-material=solid]`: the same solid treatment as 1.
3. `@media (prefers-contrast: more)`: solid `--surface`, a 1px `--rule-strong` border, no inset highlight, and `--ink-3` promoted to `--ink-2`.
4. `@media (forced-colors: active)`: `Canvas`/`CanvasText`, 1px `CanvasText` borders, and focus via `Highlight`.

Settings → Material offers System, Glass and Solid, which sets `data-material` on `:root`.

**Glass rules:**
- **Allowed only on:** toolbar, composer, inspector, sheets, toasts, palette, mobile tab bar, the "N new" pill, and popovers that open over scrolling content.
- **Never on glass.** A popover opened from the composer is solid `--surface` with `--shadow-pop`.
- **Never on a flat area with nothing beneath it.**
- **No colour on the glass layer.** Coloured children (lamps, the ink Send button) are solid.
- **Blur is at most 40px.**

---

## 6. Views

### 6.1 Status (landing): the track diagram

```
4 of 5 accounts can serve. alt-3 cools down for 1:12 more.        ← h1, `title`, live
Updated 14:02:31 · polling every 5s                                  ← meta (only this one middle-dot)

Traffic                                          [15m|1h|6h]  [Diagram|Table]
                 −15m           −10m           −5m             now│ +2m
 ● main          ━━  ━━━━━   ━ ━━━━━━━   ━━━         ━━━━━━      │
 ◐ alt-2         ━━━━   ━━━━━━━━   ━━ ━━━━━━━━━━━━━━━━━━━━━━━━━━━▶│ Busy 0:38 · dashboard:k3f
 ◇ alt-3         ━━ ━━━━ ━━━✕ ━✕                                  │▒▒▒▒▒▒ Cooldown 1:12 (rate limit)
 ○ backup        · · · · · · · · · · · · · · · · · Paused by admin│
 ⊘ old           · · · · · · · · · · · No credentials: token missing│
────────────────────────────────────────────────────────────────────────────────
 212 requests     1.84M tokens ≈     3 errors     6.2 s p50              ← readouts, last window
────────────────────────────────────────────────────────────────────────────────
Recent errors (3)                                             Open Requests
 14:01:12  alt-3  deepseek-v4-flash-thinking  429  rate_limit_error  "…"   (row → inspector)
```

**Headline sentence**, built from `pool`:

| Pool state | Sentence | Colour |
|---|---|---|
| All accounts can serve | "All 5 accounts can serve." | ink |
| Some can serve | "4 of 5 accounts can serve." plus the soonest cooldown, as "alt-3 cools down for 1:12 more." | ink |
| None can serve | "No account can serve. The next one is ready in 0:42." | `--crit`, with alert icon |
| Pool empty | "No accounts are loaded." | ink, followed by the empty state (§10) |

**Lane geometry (SVG, `charts.js`):**
- Lanes are 32px tall with a 1px `--rule` track line at the vertical centre.
- The label column is 168px: lamp (10px) + 8px gap + account name (`body`, truncated with a `title` attribute).
- The plot spans from the window start to now, plus a 12% future zone on the right for cooldown and busy projection.
- The **now** line is 1px `--ink` running the full height, with the label "now" in `meta` at the top.
- **Request segment:** a rect 6px tall, centred, from `x(ts − ms)` to `x(ts)`, minimum width 2px, rx 3.
  - OK: `--ink` at opacity 0.85.
  - Error: `--crit`, followed by a 7px ✕ glyph (SVG path, 1.5 stroke) at the end.
  - Adjacent segments keep a 2px gap of the ground colour (an inset stroke in the `--bg` colour).
- **Busy:** an open segment from `busy_since` to the now line, in `--signal`, with an arrowhead 4px past now. Its label sits right of the now line: "Busy m:ss · <client>". `busy_since` comes from the lock's `since`; add it to `adminAccountView` if it is missing.
- **Cooldown:** a band from now to `cooldown_until`, full lane height − 8px, filled `--warn-wash`. Its label is "Cooldown m:ss (reason)" in `--warn` text. If the band is wider than the future zone, it clips with a hard edge and the label still shows the full time.
- **Paused / no-credentials:** the track line becomes `stroke-dasharray: 1 5` in `--ink-3`, with the reason text in `meta` inside the lane. The dashes mean "out of service". They are not decoration.
- **Time axis:** ticks at clean minute marks. For 15m the steps are 5m; for 1h, 15m; for 6h, 1h. Labels are `meta`, `--ink-3`, tabular, using `−` (U+2212). No vertical gridlines.

**Interaction:**
- Hovering a segment, or focusing it with ←/→ and ↑/↓ between lanes, shows a tooltip:
  - leading line: status + latency;
  - then model (mono), client, tokens in→out ≈, and time.
  - The tooltip is solid `--surface` + `--shadow-pop`, built with `textContent` only.
- Clicking or pressing Enter on a segment goes to `#/requests?id=<id>`.
- A lane label links to `#/accounts/<id>`.
- **Accessibility:** the SVG is `role="img"` with an `aria-label` summary, for example "5 lanes, 212 requests in the last 15 minutes, 3 errors, alt-3 in cooldown". The table toggle shows the same rows as an HTML `<table>`.
- **Re-render on every poll.** It steps; there is no tweening or drift.
- **Busy animation:** the busy segment's opacity "breathes" 0.55↔1 over 2s with ease-in-out, infinite. This is the only ambient animation in the product. Under reduced motion it is static at 1.
- **Without `/admin/requests` (404):** draw lanes with state only (busy, cooldown, paused) and one inline notice: "Traffic history needs GET /admin/requests. This server build doesn't expose it."

**Readout strip:**
- One row of 4 figures, each `readout-xl` with a `meta` label underneath (e.g. "requests").
- Separated by 1px vertical `--rule` hairlines, 32px apart.
- No cards, deltas or sparklines.
- Estimates carry a "≈" suffix on the figure.

### 6.2 Accounts

```
Accounts                                     [Reload from disk]  [+ Add account]  ← toolbar actions (Add = primary ink)
⌕ Filter accounts ____   [All | Ready | Busy | Cooldown | Paused | Problems]        5 accounts
────────────────────────────────────────────────────────────────────────────────────
 State                    Account   Failures  Last error         Last ok   Requests  Tokens ≈   
 ● Ready                  main      0 / 2     —                  12s ago     184     1.21M     ⋯
 ◐ Busy 0:38 · dash:k3f   alt-2     0 / 0     —                  1m ago      122     0.84M     ⋯
 ◇ Cooldown 1:12 ▕▓▓▓░▏   alt-3     3 / 9     429 rate limit     14m ago      61     0.30M  [Clear] ⋯
 ○ Paused by admin        backup    0 / 1     —                  2h ago        9     0.04M [Resume] ⋯
 ⊘ No credentials         old       —         token missing      —             0     0          ⋯
```

**Table:**
- A real `<table>` with `<th scope="col">`.
- Numeric columns are right-aligned and tabular.
- The account id is in `mono-id`.
- **Failures:** "consecutive / lifetime".
- **Cooldown meter:** 40×4px. The track is `--rule`, the fill is `--warn`, and the fill shrinks via `transform: scaleX()` every second with linear timing.
- **Inline actions** appear only when they are the obvious next step:
  - **Clear** on cooldown;
  - **Resume** on admin-paused.
  - Both are secondary buttons, 28px tall.
- **⋯ popover:**
  - Pause routing / Resume routing
  - Clear cooldown
  - View requests: `#/requests?account=<id>`
  - View usage: `#/usage?account=<id>`
  - Remove account… (`--crit` text)
- **Row interaction:**
  - Clicking a row, or `Enter` on the row cursor, opens the **inspector** and sets `#/accounts/<id>`.
  - The selected row gets a `--signal-wash` background.
- **Filter chips** use the segmented control style.
- **Mobile (<720px):** each row is two lines.
  - Line 1: lamp + name (600) + state text, with ⋯ on the right.
  - Line 2 (`meta`): failures · last ok · tokens.

**Inspector:** a non-modal side panel.
- glass-thick, 440px wide, 16px radius on the inner corners, flush to the right edge below the toolbar;
- **no scrim**, so the table stays usable;
- Esc or the × closes it.

Sections, top to bottom:
1. **Header:** lamp + state word, the name (`heading`) and the id (`mono-id`, with a copy button).
2. **Credentials:** "Token ✓ · 7 cookie parts · file accounts/alt-3.json". Credential values are never shown.
3. **Lane trace (1h):** the same lane component on a single lane, 40px tall.
4. **State actions:**
   - a full-width "Route requests to this account" switch (`role="switch"`);
   - "Clear cooldown" if the account is cooling down.
   - A 409 `disabled_in_file` response renders inline under the switch, verbatim, in `--crit`, and the switch reverts.
5. **Last error:** full text, `mono-id`, wrapped, selectable, on `--sunken` with radius 10 and 12px padding.
6. **Usage by model (this account):** hbar mini-chart, top 5.
7. **Links:** "Requests from this account", "Usage for this account".
8. **Footer:** "Remove account…" as a `--crit` text button.

**Add account:** a modal, which is justified because it handles credentials.
- `<dialog>`, glass-thick, 520px, centred, scrim `oklch(0.2 0.02 262 / 0.32)`, focus trapped.

Contents, top to bottom:
1. **Title:** "Add a DeepSeek account".
2. **Drop zone:** 120px tall, 1px dashed `--rule-strong`, radius 12. Text: "Drop deepseek-auth.json (exported by the DeepSeek Auth Exporter extension) or paste it below." Drag-over turns it `--signal-wash` with a solid `--signal` border.
3. **Paste field:** `<textarea>`, `code` font, 8 rows.
4. **Live validation list**, re-run on input. Each line is a lamp + a sentence:
   - "Token found" / "Token missing: the file has no `token` field"
   - cookie with its part count
   - `hif_dliq`
   - `hif_leim`
   - JSON parse errors show the parser's message and position.
5. **Name field:** prefilled from the file name, sanitised to `[a-z0-9-_]`. A helper line underneath reads "Saved as accounts/alt-4.json".
6. **Disclosure sentence (meta):** "Credentials are sent once to this server and written to disk readable only by your user. They are never shown again."
7. **Buttons:**
   - **Add account** (primary ink), disabled until validation passes;
   - Cancel (secondary).
   - On success: toast "Added alt-4. Ready to serve." and the dialog closes.
   - 409 or 422: the server message renders verbatim above the buttons.
8. **If `POST /admin/accounts/import` returns 404:** the dialog body is replaced by "This server build can't import accounts from the dashboard. Run `npm run auth:import -- --output ./accounts/<name>.json`, then Reload from disk." The command gets a copy button.

**Remove:**
- A confirm popover anchored to the trigger, solid `--surface`, 320px.
- Text: "Remove alt-3? Its file moves to accounts/.removed/ and it stops receiving requests."
- Buttons: **Remove account** (`--crit` fill) and Cancel.
- On success, a toast reads "Removed alt-3" with **Undo** (10s), which calls `POST /admin/accounts/restore`.
- If the server reports a hard delete (no `trash` field in the response), the copy says "Deletes accounts/alt-3.json" and the toast has no Undo.

**Reload from disk:**
- The button shows "Reloading…" with a 12px spinner.
- On success, a toast reads "Reloaded: 1 added, 0 removed, 4 kept". Per-file errors are expandable inside the toast.
- A 422 opens an inline banner listing the errors and stating that the pool is unchanged.

### 6.3 Usage

```
Usage                                      [1h | 24h | All since start]   Account [All ▾]
Tokens are estimates (≈ characters ÷ 4). Cost uses a flat $0.22 / $0.66 per 1M tokens.
Charts cover the last 400 requests (since 13:12). Per-account lifetime totals cover everything since the server started.
────────────────────────────────────────────────────────────────────────────────
 1,284         2.13M ≈        1.71M / 0.42M ≈         $0.65 ≈          1.9%
 requests      tokens         prompt / completion     at API prices    errors
────────────────────────────────────────────────────────────────────────────────
Tokens over time                                             ■ Prompt  ■ Completion
 (stacked columns, height 220px)
Requests and errors                                          (separate chart, 96px, same x)
────────────────────────────────────────────────────────────────────────────────
By account            By model              By client             By endpoint
 hbar lists, 4 columns at ≥1280px, 2 at ≥720px, 1 below.          [Bars | Table]
────────────────────────────────────────────────────────────────────────────────
Lifetime by account (since server start)   table: Account · Requests · Prompt ≈ · Completion ≈ · Cost ≈
```

- The caveat text is `meta` `--ink-2`, always visible, and its numbers come from `coverage`.
- **Filtering:** one filter row scopes the whole view. Filters are written to the hash, so cross-links work.
- **Refetch:** the previous render stays at 0.6 opacity until the new data lands. There is no skeleton flash after the first load.

### 6.4 Requests

```
Requests     ● Live   [All | Errors]  Account [All▾]  Model [All▾]  Endpoint [All▾]  ⌕ Client… /
                                                                     ( 12 new · Show )  ← glass-regular pill
 Time      Status   Endpoint            Model                  Account  Client          In ≈   Out ≈   Latency
 14:02:31  ✓ 200    OpenAI chat         flash-thinking         main     dashboard:k3f   1.2K   640     8.4 s
 14:02:18  ✓ 200    Anthropic messages  flash                  alt-2    claude-code     22K    1.1K    4.1 s
 14:01:12  ✕ 429    OpenAI chat         flash-thinking         alt-3    opencode        880    —       2.0 s
           rate_limit_error · Account alt-3 rate-limited; cooling down for 60s     ← 2nd line, `body` --ink-2
 14:00:55  ✓ 200    OpenAI chat  ⌂      —                      —        dashboard:k3f   —      —       3 ms
────────────────────────────────────────────────────────────────────────────────
Showing 212 of 400 kept in memory (oldest 13:12)
```

**Columns:**
- **Endpoint** shows a friendly label: `/v1/chat/completions` → "OpenAI chat", `/v1/messages` → "Anthropic messages", `/v1/responses` → "Responses". A stream glyph follows when `stream` is true, and a local (house) glyph when `local` is true.
- **Status** is a lamp glyph + code, in `--ok` or `--crit`.
- **Model ids** drop the `deepseek-v4-` prefix in the table only; the full id is in the `title` and the inspector.

**Live updates:**
- Poll with `since=<lastId>`.
- New rows insert at the top. Each new row's background starts at `--signal-wash` and fades to transparent over 1200ms `ease`.
- If the user has scrolled more than 80px down, new rows queue behind the pill "N new · Show". Clicking it scrolls to the top and inserts them.
- The Live switch pauses polling.

**Row inspector:**
- Same component as the account inspector, 440px.
- Shows every field with copy buttons. `ip` appears only here.
- The error appears in full.
- Actions:
  - "Open conversation" when the client starts with `dashboard:`;
  - "Open account".

### 6.5 Settings

Sections:
- **Access key:**
  - the stored state ("Stored for this tab only", via sessionStorage);
  - a password field + Save;
  - "Forget key".
- **Connection:**
  - base URL = `location.origin`;
  - three copyable snippets on `--sunken`: OpenAI SDK, Anthropic SDK, curl. The key is written as `$PROXY_API_KEY`.
  - A note on `PROXY_CORS_ORIGINS` for LAN use.
- **Server:** facts from `/health`: version, uptime, session TTL, max messages, accounts.
- **Appearance:**
  - Theme: System, Light, Dark;
  - Material: System, Glass, Solid;
  - Density: Comfortable, Compact.
- **Chat data:**
  - conversation count and approximate size, from `navigator.storage.estimate()`;
  - "Export all (JSON)";
  - "Delete all conversations…" (confirm popover).
  - The note "Stored in this browser only, for <origin>."

---

## 7. Charts

Rules for every chart:
- **Plot area:** `--surface` is not drawn. Charts sit on the ground.
- **Gridlines:** horizontal only, 1px solid `--rule`.
- **Baseline:** `--rule-strong`.
- **Ticks:** clean values (0 / 500K / 1M). Labels are `meta` `--ink-3`, tabular, formatted with `Intl.NumberFormat(undefined,{notation:'compact'})`.
- **Text colour:** data text is never in a series colour. Value labels are `--ink`.
- **Not allowed:** dual axes, value ramps on nominal categories, recolouring on filter.
- **Tooltip:** a crosshair (1px `--ink-3` vertical line) plus a tooltip. The hit target is the full column band, at least 24px wide.
  - Keyboard: the chart is `tabindex=0`; ←/→ move bucket by bucket and show the same tooltip.
- **Table twin:** every chart has a Table toggle that renders the same data as an HTML table.
- **forced-colors and print:** add 45° texture (an SVG `<pattern>`) to the prompt series only.

| Chart | Form | Spec |
|---|---|---|
| Tokens over time | Stacked columns | prompt (`--data-2`) bottom, completion (`--data-1`) top. Column width `min(24px, band × 0.7)`, a 2px gap between segments in `--bg`. The top segment has a 4px top radius; the baseline is square. Legend uses 10×10 rect keys at the top right. The last bucket gets direct labels. |
| Requests and errors | Columns + marks | Request columns in `--ink-3`. Error count as a ✕ mark above each column in `--crit`, plus its count in the tooltip. Same x as above, its own y. |
| By account / model / client / endpoint | Horizontal bars | A single `--data-1` series, sorted descending, row height 28px, bar height 10px with rx 3, label left (`body`, truncated), value at the bar tip (`body` tabular `--ink`). Top 7, then "Other (n)". Rows link to the filtered view. |
| Latency (Requests, optional) | Histogram | 20 bins, `--ink-3`, p50/p95 tick labels on the axis. |
| KPIs | Readouts | §6.1 strip. No sparklines. |

**Palette validation** (cobalt + copper), as run by proposal A with `validate_palette.js`:
- **Light, on `#fcfdff`:** CVD ΔE 29.8, normal-vision ΔE 34.3, both colours ≥3:1. Pass.
- **Dark, on `#22252b`:** CVD ΔE 25.0, normal-vision ΔE 26.4. Pass.

---

## 8. Chat

### 8.1 Layout

```
Empty conversation (#/chat)
                                    What should we work on?                    ← `title`, centred
                         flash-thinking · goes to the next ready account · 4 of 5 ready   ← meta ink-2
                  ╭──────────────────────────────────────────────────────────╮
                  │ Message DeepSeek through this proxy…                      │  glass-regular,
                  │ ⊕   [◐ Think] [⌕ Search]                deepseek-v4-…  ■↑ │  radius 22, 680px max
                  ╰──────────────────────────────────────────────────────────╯
                        Saved in this browser only (127.0.0.1:8787).            ← meta ink-3

Active conversation
 ░ Debug failover                                     ⋯ ░   ← glass-thin toolbar
                                 ╭───────────────────────╮
                                 │ Why does this 401 when │  user: --sunken, radius 18, right, max 80%
                                 ╰───────────────────────╯
 ▸ Reasoned for 14 s                                         ← disclosure, label --ink-3
 The 401 comes from the bearer check running before…        ← prose, no bubble, max 68ch
 ┌ JavaScript ─────────────────────── Wrap  Copy ┐
 │ if (!isProxyAuthorized(req)) { … }            │          ← --sunken, radius 10
 └───────────────────────────────────────────────┘
 ⇄ alt-2   ◇ flash-thinking   ◷ 8.4 s   ≈ 1.2K → 640        ⧉  ↻     ← route receipt + actions
 ╭───────────────────────────────────────────────────────╮
 │ Message…                                       ■ Stop │  docked composer, bottom 16px + safe area
 ╰───────────────────────────────────────────────────────╯
```

**Layout rules:**
- The transcript column is at most 720px wide, centred in the content area, with 24px side padding.
- Turns are 32px apart.
- The transcript scrolls under the composer. A scroll-edge mask covers the bottom 48px: `mask-image: linear-gradient(to top, transparent 0, #000 48px)`, applied to the scroll container above the composer.
- **Empty heading:** "What should we work on?" is the chosen copy. Do not use suggestion chips, a logo or a greeting carousel.
- **Empty-state status line**, built from the pool:
  - If the pool cannot serve: "No account can serve for 0:42. Open Accounts" (link), in `--warn`.
  - If `/v1/models` failed: "Models couldn't load: <error>. Send is disabled."

### 8.2 Composer

**Text area:**
- Auto-grows to `40vh`, then scrolls.
- Placeholder text is `--ink-3`.
- Focus puts a 2px `--signal` ring on the composer container (`:focus-within`), not on the textarea.

**Bottom row, left:**
- **⊕ Attach:** opens the file picker. Images are png, jpeg, webp or gif; at most 10 images, each up to 20MB. Read them with `FileReader` as `data:` URLs, because the CSP has no `blob:`.
  - Thumbnails show as 48px chips with a remove ×.
  - A violation shows inline under the composer naming the limit, e.g. "photo.heic isn't supported. Use PNG, JPEG, WebP or GIF."
  - Paste and drop also work.
- **Think** and **Search** toggles: pills, `aria-pressed`, 28px tall.
  - Pressed state: `--ink` 1px border + `--sunken` fill.
  - Not pressed: transparent, `--ink-2`.

**Bottom row, right:**
- The resolved model id in `mono-id`, `--ink-3`.
- The **Send** button: 32×32px, radius 10 (a rounded square, deliberately not a circle), `--ink` fill, arrow-up icon in `--on-ink`. Disabled when the input is empty: opacity 0.35, `aria-disabled`.
- While a request is running, Send morphs to **Stop**: the same button with a stop icon. The icons cross-fade with a 2px blur bridge over 180ms.

**Model mapping:**
- Build the mapping from `/v1/models`; never hard-code it. Think × Search map to the four ids:
  - none = `deepseek-v4-flash`
  - Think = `…-thinking`
  - Search = `…-search`
  - both = `…-thinking-search`
- Any id missing from the server list disables its toggle, with the reason from `/v1/model-capabilities` in a tooltip.
- The model is remembered per conversation. Switching mid-conversation is allowed.

**Keys:**

| Key | Action |
|---|---|
| Enter | Send |
| Shift+Enter | Newline |
| Esc | Stop (while running) |
| ↑ in an empty composer | Edit the last user message |
| ⌘/Ctrl+Shift+O | New chat |

- A message that is exactly `/new` is blocked with the inline hint "Use New chat to start fresh."

### 8.3 Request lifecycle

**Request:**
- `POST /v1/chat/completions` with `stream: true`.
- Headers: `x-agent-session: dashboard:<convId>` and the key header.
- **Body:** the full transcript, user and assistant `content` only:
  - never `reasoning_content`;
  - images only on the turn that attached them;
  - no `tools`.
- **Title:** the first user line, trimmed to 48 characters at a word boundary.
- There is no client timeout. The only abort is the user's Stop.

**Pending state:**
- The assistant slot shows "Working" plus an elapsed timer `0:14` (readout, tabular, updated every 1s).
- A 1px `--signal` hairline 64px long sweeps across the top of the slot: `translateX` over 1.2s, linear, infinite. Under reduced motion it is static at full width, 0.4 opacity.
- For `-thinking` models the label reads "Thinking" instead of "Working".
- At 20s a `meta` line appears: "The proxy returns the answer when DeepSeek finishes, so long answers and account failover can take a few minutes. It arrives in one piece."

**Parsing:**
- Use one `TextDecoder` with `{stream:true}`. Split on `\n\n` and parse `data:` lines.
- Accumulate `reasoning_content` and `content` separately.
- Take `usage` from the chunk with `choices: []`.
- Read the response headers `x-account-id` and `X-FreeDeepseek-Context-Compacted`.
- If the stream ends without `[DONE]`, show the error "Response truncated: the stream ended early (no [DONE])", with Retry.
- Render progressively as chunks arrive. If they arrive in one burst (the current server behaviour), the reveal below applies.

**Reveal:** the reply is split into top-level markdown blocks.
- Blocks fade in with opacity 0→1 and `filter: blur(2px)`→0 over 180ms `--ease-out`.
- Each block starts 30ms after the previous one. The first 8 blocks are staggered; the rest appear together.
- There is no typewriter effect.
- Under reduced motion everything appears instantly.
- A polite live region announces "Answer ready".

**Reasoning:**
- A `<details>`-like disclosure, collapsed by default once content exists: "Reasoned for 14 s". The elapsed time is measured on the client up to the first content.
- Expanded: `body` 14/22, `--ink-2`, with a 1px `--rule` left hairline and 12px left padding.
- It expands with `grid-template-rows: 0fr→1fr` + opacity over 200ms `--ease-out`, and the chevron rotates 90°.

**Route receipt** sits under each assistant turn, as icon + value pairs 16px apart, in `meta` `--ink-2`:
- route icon + account (links to `#/accounts/<id>`);
- model icon + short model id;
- latency icon + seconds;
- token icon + "≈ in → out".
- A "Context compacted" pill (`--sunken`, `meta`) appears when the header is present.
- Clicking the receipt's empty area goes to `#/requests?client=dashboard:<id>&id=<nearest>`.
- Actions on the right: Copy and Regenerate, as 28px icon buttons with tooltips.

**User turn actions** (shown on hover or focus-within): Edit and Copy.
- **Edit** turns the bubble into a textarea in place. Enter saves and resends; Esc cancels.

**Stop / regenerate / edit:**
- **Stop** (`AbortController`):
  - keeps the user turn;
  - marks the assistant slot "Stopped. The next message starts a fresh upstream thread.";
  - sets `conv.needsReset = true`.
- **Before any send where `needsReset` is set, and before Regenerate or Edit:** call `POST /reset-session?agent=dashboard:<id>`.
  - A 404 means nothing to reset; continue.
  - Any other failure aborts the send and shows the error inline.
- Never expose `agent=all`.
- **Concurrency:**
  - Send is disabled per conversation while that conversation is in flight.
  - Other conversations may run in parallel.
  - The sidebar shows a busy lamp (◐, `--signal`) next to running chats.

**Errors** render inline in the assistant slot, never as a toast:
- **Block:** `--crit-wash` background, radius 12, padding 12/16, with the error-x icon.
- **Title by type:**

| Type / condition | Title |
|---|---|
| 429 | Rate limited |
| 503 | No account available |
| 401 | Access key required |
| 403 `cors_error` | Not allowed from this address |
| 400 `context_length_exceeded` | Context too long |
| network | Can't reach the proxy |

- **Body:**
  - `error.message` verbatim;
  - `error.type` in `mono-id`.
- **One recovery action:**

| Condition | Action |
|---|---|
| 429 / 503 | "Retry in 0:12", honouring Retry-After; becomes plain "Retry" at 0 |
| 401 | "Enter access key", which opens the gate |
| 403 | "Open Settings", plus a `PROXY_CORS_ORIGINS` hint |
| Context too long | "Start a new chat" |
| Otherwise | "Retry" |

- A secondary link "View in Requests" is also shown.

**⋯ conversation menu:**
- Rename
- Session details: a popover with `/v1/sessions` data for this agent (account pin, message count, age)
- Reset server session
- Export JSON
- Delete…, which removes the conversation with an Undo toast (10s)

### 8.4 Markdown and code

**Markdown** (`markdown.js`):
- Builds the DOM with `createElement` + `textContent` only.
- **Supported:**
  - paragraphs;
  - h1–h4;
  - nested ul/ol;
  - task lists (read-only checkboxes);
  - blockquote: 1px `--rule` left hairline, `--ink-2`;
  - hr;
  - tables: wrapped in a horizontal scroller, header `label`, hairline rows;
  - fenced code;
  - inline code: `mono-id` on `--sunken`, radius 4, padding 1px 4px;
  - bold, italic, strikethrough;
  - links: `http`, `https` and `mailto` only, with `rel="noopener noreferrer" target="_blank"` and an external icon after the text.
- Anything else renders as literal text.

**Code block:**
- Header row, 32px:
  - language label in sentence case (`meta`, `--ink-3`);
  - on the right: a Wrap toggle and Copy. Copy's icon morphs to a check with the label "Copied" for 1.5s.
- Body: `code` font, `--sunken`, padding 12/16, `tab-size: 2`, horizontal scroll, `white-space: pre`. The Wrap toggle switches it to `pre-wrap`.
- **No syntax highlighting.** Monochrome is the house style, not a gap.

### 8.5 Storage

**IndexedDB database `fdsa-chat`, version 1:**

| Store | keyPath | Fields | Index |
|---|---|---|---|
| `conversations` | `id` | `title, model, createdAt, updatedAt, needsReset` | `updatedAt` |
| `messages` | `id` | `convId, role, content, reasoning, images[], meta{account, ms, usage, compacted, error}` | `convId` |

- A `QuotaExceededError` shows a persistent banner: "Browser storage is full. Export or delete older conversations." The banner offers Export and Delete older than 30 days. History is never dropped silently.
- If IndexedDB is unavailable (private mode, for example), show a banner saying conversations won't be saved, and keep them in memory for the session.
- The key stays in `sessionStorage` (unchanged).

---

## 9. Icons

**Format:**
- One inline `<svg>` sprite in `index.html` with `<symbol>`s. It replaces the existing 1.8-stroke set.
- `viewBox="0 0 24 24"`, drawn on a 20×20 live area (2px padding).
- Rendered at 16px (tables, receipt), 18px (buttons) or 20px (nav).
- `stroke="currentColor"`, `stroke-width="1.5"`, `vector-effect="non-scaling-stroke"` on every path, so the stroke is 1.5px at every size.
- `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"`.

**Geometry:**
- Rectangles have rx 2.
- Circles are drawn 0.5 units larger than squares so they look the same size.
- Arrowheads are 45° and 4.5 units long.
- No detail is smaller than 2 units.
- Filled shapes appear only in lamps and the stop square.

**Lamps** (10px, filled with `currentColor`, colour set by the state class):

| State | Lamp shape |
|---|---|
| ready | ● filled circle |
| busy | ◐ half-filled circle with a 1.5px outline |
| cooldown | ◇ outlined diamond |
| paused | ○ outlined circle |
| no credentials | ⊘ circle with slash |
| error | ✕ (used in tables and lanes) |

**Symbol list** (`i-` prefix):

| Group | Symbols |
|---|---|
| Nav | `chat` (speech shape, straight tail), `status` (three track lines + vertical now tick), `accounts` (three stacked rounded tokens), `usage` (three columns on a baseline), `requests` (list lines + inbound arrow), `settings` (two horizontal sliders with knobs; not a gear) |
| Chat | `new-chat` (pencil over square), `sidebar` (rect with left pane), `attach` (plus in circle), `image`, `think` (circle with half filled by a vertical stroke pattern, contrast glyph), `search-web` (globe with one meridian + equator), `send` (arrow up), `stop` (rounded square, filled), `regenerate` (open arc + arrowhead), `edit` (pencil), `copy` (two offset rects), `check`, `chevron-right`, `chevron-down`, `more` (three dots, filled r=1.25) |
| Receipt | `route` (arrow passing through a node), `model` (diamond outline), `latency` (stopwatch), `token` (two stacked discs) |
| Actions | `plus`, `reload`, `pause`, `play`, `clear-cooldown` (hourglass + slash), `trash`, `undo`, `close`, `external`, `filter`, `search`, `sort-asc`, `sort-desc`, `download`, `upload`, `key`, `lock`, `alert` (triangle), `info` (circle i), `error-x` (circle x), `success` (circle check) |
| Misc | `stream` (three short horizontal dashes, staggered), `local` (house), `live` (dot in ring), `sun`, `moon`, `display` (system), `material` (two overlapping panes), `table-view`, `chart-view`, `keyboard`, `copy-snippet` (=`copy`) |

**Usage rules:**
- Never use emoji or Unicode characters as icons. The glyphs in this document are notation only.
- An icon-only button must have an `aria-label` and a tooltip that shows after 500ms. Once one tooltip is open, adjacent tooltips open instantly with no animation.

---

## 10. States

| State | Treatment |
|---|---|
| First load | Skeletons in the real geometry: table rows as `--sunken` bars 10px tall at 40/60/30% widths; lanes drawn empty with "Loading traffic…" in `meta`. No shimmer. |
| Refetch | Content stays. The toolbar's "Updated" time ticks. No spinner. |
| Stale (poll failing) | Toolbar text: "Stale since 14:02:31 · retrying in 8s" in `--warn` with the cooldown lamp. A banner below the toolbar names the endpoint, the HTTP status and `error.message`, with a Retry button. Data stays visible at 0.7 opacity. Backoff is 5 → 10 → 20 → 30s max. |
| Auth required (401) | A full-view gate on glass-thick over a dimmed shell. Contents: lock icon, "Enter the proxy access key", password field, **Unlock** (primary). If a stored key was rejected: "The saved key was refused by the server." Polling stops while the gate is up. |
| Forbidden (403 `admin_forbidden`) | The same gate. It explains `PROXY_API_KEY`, `PROXY_ADMIN_ALLOW_REMOTE` and `PROXY_CORS_ORIGINS`, each on a copyable `mono-id` line, plus the server message verbatim. |
| Endpoint missing (404) | An in-panel notice: info icon + "This server build doesn't expose GET /admin/usage. Update server.js to the version that ships with this dashboard." Nothing is drawn. |
| Empty pool | Status and Accounts show "No accounts are loaded." with an **Add account** button and the `npm run auth:import` command (with Copy). |
| Empty requests / usage | "No requests since the server started at 13:12." with the action "Send one from Chat" and a curl snippet. |
| Action pending | The button keeps its width. The label is replaced by a 12px spinner (a 1.5 stroke arc rotating 600ms linear) plus a verb label such as "Reloading…". The row gets `aria-busy="true"`. Repeat clicks are ignored. |
| Action error | An inline message under the control: `--crit`, `body`, the server message verbatim. A toast also appears for actions started from a popover. |
| Offline | Banner: "Can't reach the proxy at 127.0.0.1:8787 (<error name>)." Chat Send is disabled, with that reason as its tooltip. |
| Partial (models failed) | Chat opens with the toggles disabled and an inline error. Other views are unaffected. |

**Every interactive component has these states:**
- default;
- hover (gated by `(hover:hover) and (pointer:fine)`, wash `oklch(from var(--ink) l c h / 0.05)`);
- focus-visible;
- active (`scale(0.97)`);
- disabled (0.4 opacity, `cursor: not-allowed`, plus a tooltip giving the reason);
- loading;
- error.

**Toasts:**
- Bottom-right, glass-regular, 360px max, stacked with 8px gaps, at most 3 visible.
- Auto-dismiss after 5s; 10s when the toast has Undo.
- The timer pauses on hover, focus or a hidden tab.
- Announced in a `role="status"` region.
- Errors go in `role="alert"` and do not auto-dismiss.

**Accessibility:**
- Landmarks: `nav`, `main`, `aside` (inspector), `header` (toolbar).
- `aria-current="page"` on the active nav item.
- Real tables with `scope`.
- Lanes and charts are `role="img"` with text summaries, plus their table twins.
- Visible focus rings.
- Dialogs use `<dialog>` with a focus trap and return focus to the trigger on close.
- The inspector moves focus to its heading on open and back to the row on close.
- WCAG AA contrast is met by every token in §5.1.

---

## 11. Motion

**Easing tokens:**
```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
/* critically damped spring, damping 1.0 / response 0.35s, run over 500ms */
--spring-settle: linear(0, .075, .227, .390, .536, .656, .750, .821, .873, .911, .938, .957, .971, .980, .986, .991, .994, .996, .997, .998, 1);
/* damping 0.8 / response 0.32s, 520ms. ONLY after a drag release (mobile sheets) */
--spring-flick: linear(0, .072, .228, .407, .575, .714, .822, .900, .952, .984, 1.003, 1.012, 1.015, 1.015, 1.013, 1.010, 1.007, 1.005, 1.003, 1.002, 1.001, 1);
```

| What | Spec |
|---|---|
| Press | `:active { transform: scale(0.97) }`, 100ms `--ease-out` |
| Hover wash / colour | 120ms `ease`, fine pointer only |
| Popover / menu | Enter: scale 0.96→1 + opacity + `filter: blur(4px)`→0, 180ms `--ease-out`, `transform-origin` at the trigger edge. Exit: 120ms, same path |
| Tooltip | 125ms opacity + scale 0.97; instant for subsequent tooltips |
| Inspector (side) | Enter: `translateX(24px)`→0 + opacity, with `--g-blur` 0→36px as it materialises, 500ms `--spring-settle`. Exit: 200ms `--ease-drawer` back to the right. Interruptible (CSS transitions, not keyframes) |
| Dialog (Add account) | Centred, scale 0.98→1 + opacity, 220ms `--ease-out`. Scrim 0→0.32 over 200ms |
| Mobile bottom sheet | 1:1 drag with `setPointerCapture`, respecting the grab offset. Rubber-band above the top: `(o·d·0.55)/(d+0.55·|o|)`. On release, project with `v/1000·0.998/(1−0.998)` and snap open or closed by projection and velocity sign, using `--spring-flick` |
| Toast | Enter from below with `translateY(100%)`→0, 400ms `--spring-settle`. Exit the same way, 180ms. Transitions, not keyframes |
| Composer docking (signature) | On the first send of a conversation: the empty heading and status line fade out over 150ms, then the composer FLIPs from centre to dock, 500ms `--spring-settle`. Once per conversation |
| Send ↔ Stop | Icon cross-fade + 2px blur bridge, 180ms `--ease-out` |
| Reply reveal | §8.3: 180ms per block, 30ms stagger, at most 8 blocks |
| Reasoning disclosure | `grid-template-rows` 0fr→1fr + opacity, 200ms `--ease-out`; chevron rotate 90° |
| Working sweep | 1.2s linear infinite `translateX` |
| Busy lane breath | Opacity 0.55↔1, 2s `ease-in-out`, infinite (only ambient motion) |
| New request row | Background `--signal-wash`→transparent, 1200ms `ease` |
| Cooldown meter | `scaleX` updated each second, 1000ms linear |
| Theme change | Colours and background cross-fade over 200ms (class on `:root` for one frame window) |
| **Not animated** | Palette open/close, view switches, keyboard navigation, row selection, poll re-renders, number changes (no count-ups), page load (no staggered entrances) |

**`prefers-reduced-motion: reduce`:**
- Every transform becomes an opacity cross-fade of 150ms or less.
- The composer docking is instant.
- No blur-in, no stagger.
- The busy breath and the working sweep are static.
- Bottom sheets still track the finger but snap without overshoot.
- Timers keep updating, because they are information.

**Never use:**
- `transition: all`;
- `ease-in`;
- `scale(0)` entrances.

---

## 12. Copy rules

- Sentence case everywhere.
- Buttons name the action, and the result keeps the same verb: "Add account" → "Added alt-4". "Remove account" → "Removed alt-3". "Reload from disk" → "Reloaded".
- Errors state what happened and how to fix it. They never apologise.
- Estimated numbers always carry "≈" or "est.", with the method explained once per view.
- Use the product's own words: account, pool, cooldown, client, endpoint, model. Never "workspace", "project" or "agent fleet".
- No "→" appended to link or button text. A link reads "Open Requests", not "Open Requests →".

---

## 13. Anti-patterns refused (checklist for review)

- [ ] **No gradients as paint:** no gradient text, glows, auroras or washes. The only gradients are `mask-image` scroll-edge masks.
- [ ] **No purple or violet, no neon.** Dark mode is graphite L 0.23, not tinted near-black. Cobalt is never a button fill.
- [ ] **No SaaS card grid,** no nested cards, no hero-metric template, no sparklines as filler, no deltas.
- [ ] **No ALL-CAPS labels or eyebrows,** no 01/02/03 numbering, no "→" in buttons, no middle-dot chains beyond the single "Updated · polling" meta line and the 2-part mobile row meta.
- [ ] **Monospace only for code, ids, model names, header values and error types.**
- [ ] **No glass as decoration,** no glass on glass, blur at most 40px, all fallbacks present.
- [ ] **Elevation:** no hard offset shadows, no ghost cards (border + wide shadow), no coloured `border-left` thicker than 1px.
- [ ] **No emoji or Unicode icons.** All icons come from the sprite.
- [ ] **Charts:** no dual axes, no rainbow, no colour-only status, no recolour on filter, no series-coloured text.
- [ ] **No fake streaming or fake data,** no silent endpoint fallbacks, no swallowed quota errors.
- [ ] **CSP-safe output:** no `innerHTML` with server or model text, no inline `style=""` attributes or `<script>`.
- [ ] **No copied looks:** no ChatGPT circle send button, greeting chips or bubble-everywhere layout; no SpaceX all-black with ultra-tracked caps.

**Main risk:** the signature depends on `GET /admin/requests`. It must ship in the same change as the UI, or Status degrades to lane states only.
