# 模型

只有一个模型：**DeepSeek-V4.1-Flash**。代理连接的是 [chat.deepseek.com](https://chat.deepseek.com)，不是付费的 `api.deepseek.com` 密钥。

`deepseek-flash` 是 `deepseek-v4-flash` 的短别名。后缀是 DeepSeek 聊天里的两个开关，不会换成另一个模型。

| ID | DeepThink | 原生网页搜索 |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | 关 | 开 |
| `deepseek-v4-flash-thinking` | 开 | 开 |
| `deepseek-v4-flash-nosearch` | 关 | 关 |
| `deepseek-v4-flash-thinking-nosearch` | 开 | 关 |

**`-thinking` 打开 DeepThink。** V4.1-Flash 先推理再回答。底层模型仍是 DeepSeek-V4.1-Flash。

**chat.deepseek.com 的原生网页搜索默认打开。** 联网查询走这个搜索。Harness 的 `websearch`、`webfetch`、`WebFetch` 不能代替它；搜索打开时，代理服务器会去掉这些工具。

**`-nosearch` 关闭搜索。** 在任何 ID 上，请求体里的 `"web_search": false` 也会关闭搜索。对 `-nosearch` ID 发送 `"web_search": true` 会重新打开搜索。其他值都会返回 `400 invalid_request_error`。搜索关闭时，编码代理保留自己的联网工具。

**原 `-search` ID。** `deepseek-v4-flash-search` 和 `deepseek-v4-flash-thinking-search` 仍然可用，等同于 `deepseek-v4-flash` 和 `deepseek-v4-flash-thinking`。它们不会列在 `/v1/models` 里。

旧 ID 未注册：`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`、`deepseek-r1`、`deepseek-instant`、`deepseek-expert` 和 vision。它们返回 `400 invalid_model`。

Claude Code 的 `claude-sonnet-*`、`claude-opus-*` 会映射到 DeepSeek-V4.1-Flash，以及带 DeepThink 的 DeepSeek-V4.1-Flash。

列表：`GET /v1/models`。完整映射：`GET /v1/model-capabilities`。
