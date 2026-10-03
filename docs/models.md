# Models

One model: **DeepSeek-V4.1-Flash**. The proxy talks to [chat.deepseek.com](https://chat.deepseek.com), not the paid `api.deepseek.com` key.

`deepseek-flash` is a short alias of `deepseek-v4-flash`. The suffixes are the two switches from the DeepSeek chat composer. They do not select a different model.

| ID | DeepThink | Native web search |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | off | on |
| `deepseek-v4-flash-thinking` | on | on |
| `deepseek-v4-flash-nosearch` | off | off |
| `deepseek-v4-flash-thinking-nosearch` | on | off |

**`-thinking` turns DeepThink on.** V4.1-Flash reasons before it answers. The underlying model stays DeepSeek-V4.1-Flash.

**Native Web Search of chat.deepseek.com is on by default.** Internet lookups go through that search. A harness `websearch`, `webfetch`, or `WebFetch` tool is not a substitute; the proxy drops those tools while search is on.

**`-nosearch` turns search off.** So does `"web_search": false` in the request body, on any id. `"web_search": true` turns it back on for a `-nosearch` id. Any other value returns `400 invalid_request_error`. With search off, a coding agent keeps its own web tools.

**Former `-search` IDs.** `deepseek-v4-flash-search` and `deepseek-v4-flash-thinking-search` still work and mean `deepseek-v4-flash` and `deepseek-v4-flash-thinking`. They are not listed in `/v1/models`.

Older IDs are not registered: `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert`, and vision. They return `400 invalid_model`.

Claude Code names such as `claude-sonnet-*` and `claude-opus-*` map onto DeepSeek-V4.1-Flash and DeepSeek-V4.1-Flash with DeepThink.

List: `GET /v1/models`. Full map: `GET /v1/model-capabilities`.
