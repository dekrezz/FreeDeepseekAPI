# Models

One model: **DeepSeek-V4.1-Flash**. The proxy talks to [chat.deepseek.com](https://chat.deepseek.com), not the paid `api.deepseek.com` key.

`deepseek-flash` is a short alias of `deepseek-v4-flash`. The suffixes are the two switches from the DeepSeek chat composer. They do not select a different model.

| ID | DeepThink | Native web search |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | off | off |
| `deepseek-v4-flash-thinking` | on | off |
| `deepseek-v4-flash-search` | off | on |
| `deepseek-v4-flash-thinking-search` | on | on |

**`-thinking` turns DeepThink on.** V4.1-Flash reasons before it answers. The underlying model stays DeepSeek-V4.1-Flash.

**`-search` turns on the native Web Search of chat.deepseek.com.** Internet lookups go through that search. A harness `websearch`, `webfetch`, or `WebFetch` tool is not a substitute. When a coding agent sends local tools, the proxy also enables this native search for that request, including on plain `deepseek-v4-flash`. DeepThink still follows the model you picked.

Older IDs are not registered: `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert`, and vision. They return `400 invalid_model`.

Claude Code names such as `claude-sonnet-*` and `claude-opus-*` map onto DeepSeek-V4.1-Flash and DeepSeek-V4.1-Flash with DeepThink.

List: `GET /v1/models`. Full map: `GET /v1/model-capabilities`.
