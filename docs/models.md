# Models

Checked 2026-09-20 against [DeepSeek API docs](https://api-docs.deepseek.com/), [pricing](https://api-docs.deepseek.com/quick_start/pricing), [V4.1-Flash](https://api-docs.deepseek.com/news/news260910), and a logged-in [chat.deepseek.com](https://chat.deepseek.com) session.

This proxy talks to **DeepSeek Web**, not the paid `api.deepseek.com` key.

**Web (2026-09-20):** Instant, Expert, Vision, and Pro are gone. The site runs **one** model: DeepSeek-V4.1-Flash. The composer is DeepThink + Search only. Remote `model_configs` still lists `default` / `expert` / `vision`, but only `default` is `enabled` and `switchable`.

The proxy exposes only the current Web model. `deepseek-flash` remains a short alias for `deepseek-v4-flash`.

Thinking and search are Web flags, encoded as suffixes:

| ID | thinking | search |
|---|---|---|
| `deepseek-v4-flash` | no | no |
| `deepseek-v4-flash-thinking` | yes | no |
| `deepseek-v4-flash-search` | no | yes |
| `deepseek-v4-flash-thinking-search` | yes | yes |

Legacy names (`deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert`, vision) are **not** registered. Unknown IDs return `400 invalid_model`.

Claude Code still sends `claude-sonnet-*` / `claude-opus-*` unless its env is rewritten. The proxy maps those onto Flash / Flash-thinking so leftover Claude IDs still work.

List: `GET /v1/models`. Full map: `GET /v1/model-capabilities`.
