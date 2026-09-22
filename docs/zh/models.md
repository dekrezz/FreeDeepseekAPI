# 模型

只有一个模型：**DeepSeek-V4.1-Flash**。代理连接的是 [chat.deepseek.com](https://chat.deepseek.com)，不是付费的 `api.deepseek.com` 密钥。

`deepseek-flash` 是 `deepseek-v4-flash` 的短别名。后缀是 DeepSeek 聊天里的两个开关，不会换成另一个模型。

| ID | DeepThink | 原生网页搜索 |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | 关 | 关 |
| `deepseek-v4-flash-thinking` | 开 | 关 |
| `deepseek-v4-flash-search` | 关 | 开 |
| `deepseek-v4-flash-thinking-search` | 开 | 开 |

**`-thinking` 打开 DeepThink。** V4.1-Flash 先推理再回答。底层模型仍是 DeepSeek-V4.1-Flash。

**`-search` 打开 chat.deepseek.com 的原生网页搜索。** 联网查询走这个搜索。Harness 的 `websearch`、`webfetch`、`WebFetch` 不能代替它。编码代理带上本地工具时，即使用的是普通 `deepseek-v4-flash`，代理也会为这次请求打开原生搜索。DeepThink 仍由你选的模型 ID 决定。

旧 ID 未注册：`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`、`deepseek-r1`、`deepseek-instant`、`deepseek-expert` 和 vision。它们返回 `400 invalid_model`。

Claude Code 的 `claude-sonnet-*`、`claude-opus-*` 会映射到 DeepSeek-V4.1-Flash，以及带 DeepThink 的 DeepSeek-V4.1-Flash。

列表：`GET /v1/models`。完整映射：`GET /v1/model-capabilities`。
