# 模型

对照 2026-09-20：[DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/)、[定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[V4.1-Flash](https://api-docs.deepseek.com/news/news260910)、已登录的 [chat.deepseek.com](https://chat.deepseek.com)。

本代理走 **DeepSeek Web**，不是付费 `api.deepseek.com`。

**Web：** Instant、Expert、Vision、Pro 均已移除。站点只剩 **DeepSeek-V4.1-Flash**。聊天界面只有 DeepThink 和 Search。`model_configs` 仍有 `default` / `expert` / `vision`，但只有 `default` 可用。

**付费 API：** `deepseek-flash` → V4.1-Flash。旧名 `deepseek-v4-flash` 仍会路由过去。DeepSeek 决定在 2026-09-14 后继续提供独立的付费 `deepseek-v4-pro`；这不会让 Pro 回到 Web，也不改变本代理的协议（`model_type: default`）。

| 代理 ID | Web `model_type` | 权重 |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | `default` | DeepSeek-V4.1-Flash |
| `deepseek-v4-pro`（旧别名） | `default` | DeepSeek-V4.1-Flash |

后缀：`-thinking`、`-search`、`-thinking-search`。旧名未注册，未知 ID 返回 `400`。

列表：`GET /v1/models`。
