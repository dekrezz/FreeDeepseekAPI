# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who self-host FreeDeepseekAPI on their own machine, VPS or container and point coding agents (Claude Code, Codex, OpenCode, Cursor), Open WebUI, LiteLLM or any OpenAI-compatible client at it. They open the dashboard to see whether the account pool can serve, to add or pause DeepSeek accounts, to inspect failed requests, to check token usage, and to chat with the model directly.

## Product Purpose

A local OpenAI-, Anthropic- and Responses-compatible API proxy in front of DeepSeek Web Chat (chat.deepseek.com). It reuses a logged-in DeepSeek Web session instead of a paid api.deepseek.com key. Success: the user's tools keep working, and when they do not, the dashboard says exactly why within seconds.

## Positioning

A multi-account pool with failover: a rate-limited request moves to another account. The dashboard shows that routing as it happens — which account served which request, which one is cooling down and for how long.

## Operating Context

- Runs locally (`npm run dashboard`, `/dashboard`) or on a VPS behind `PROXY_API_KEY`.
- Often open in a background tab next to a terminal and an agent session; checked at a glance, then used for short tasks.
- Admin API is gated by Host/Origin checks and optional `PROXY_API_KEY`.

## Capabilities and Constraints

- Views: Chat, Status, Accounts, Usage, Requests, Settings; ⌘K command palette; inspector panel; mobile tab bar.
- Model today: DeepSeek-V4.1-Flash, with `-thinking` (DeepThink) and `-search` (native Web Search) variants.
- Zero npm dependencies, no build step, vanilla HTML/CSS/JS.
- Strict CSP: no CDNs, no web fonts, no inline styles or scripts; system fonts only (confirmed by the user).
- Request stats are metadata only, never prompt or answer text.
- Experimental: DeepSeek can change the private Web API without notice.

## Brand Commitments

- Name: FreeDeepseekAPI. Logo: `docs/assets/logo.png`.
- The user pinned the dashboard's visual direction (dark only, no light theme):
  - Interface (buttons, sidebar, menus, composer, settings): ChatGPT / Claude app grammar. The sidebar (logo + collapse, New chat, Search ⌘K, Chats with a filter toggle, Settings at the foot), the composer and its model menu follow the Claude app; no status captions or Live switch in the chrome; Settings is a Claude-style modal window with a left nav (search, grouped items) and label-left / control-right rows.
  - Imagery and video: SpaceX grammar. Every full surface carries real space photography or video (NASA public domain, provenance in `public/dashboard/MEDIA.md`): Status = launch video hero, empty chat = Earth horizon, open chat = Milky Way over Earth (dimmed for reading), key screen = night launch. New surfaces get imagery too.
  - Labels and copy stay the product's own; only the style is borrowed.
  - Logo: `docs/assets/logo.png` (white whale), served as `public/dashboard/logo.png`.
- Ships English, Russian and Chinese READMEs; UI text must survive Cyrillic and CJK.

## Evidence on Hand

- Real data comes only from the running proxy's admin API. No customers, benchmarks or testimonials exist; never invent them. Never show fake data.

## Product Principles

1. Fail loudly: every error states its cause and the fix.
2. Truth at a glance: pool readiness is legible in one look.
3. Metadata, never content: the dashboard never stores prompts or answers server-side.
4. Zero dependencies stays zero.

## Accessibility & Inclusion

State is never carried by colour alone (lamp shapes, table twins for charts). Respect reduced motion. Keyboard-complete (⌘K, shortcuts).
