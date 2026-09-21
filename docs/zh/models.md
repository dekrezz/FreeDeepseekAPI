# 模型

对照 2026-09-20：[DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/)、[定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[V4.1-Flash](https://api-docs.deepseek.com/news/news260910)、已登录的 [chat.deepseek.com](https://chat.deepseek.com)。

本代理走 **DeepSeek Web**，不是付费 `api.deepseek.com`。

**Web：** Instant、Expert、Vision、Pro 均已移除。站点只剩 **DeepSeek-V4.1-Flash**。聊天界面只有 DeepThink 和 Search。`model_configs` 仍有 `default` / `expert` / `vision`，但只有 `default` 可用。

代理只显示当前 Web 模型。`deepseek-flash` 仍是 `deepseek-v4-flash` 的短别名。

| 代理 ID | DeepThink | Search |
|---|---:|---:|
| `deepseek-v4-flash` / `deepseek-flash` | 否 | 否 |
| `deepseek-v4-flash-thinking` | 是 | 否 |
| `deepseek-v4-flash-search` | 否 | 是 |
| `deepseek-v4-flash-thinking-search` | 是 | 是 |

旧名（`deepseek-v4-pro`、`deepseek-chat`、`deepseek-r1`、`deepseek-expert`、vision）未注册，未知 ID 返回 `400`。

列表：`GET /v1/models`。
