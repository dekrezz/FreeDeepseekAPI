# 一键接入 Agent

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
```

脚本将 FreeDeepseekAPI 添加为可选 profile/provider，不会替换现有的 Opus、Sonnet、GPT 或默认模型。

`--model` 始终是 DeepSeek-V4.1-Flash。`-thinking` 打开 DeepThink。`-search` 打开 chat.deepseek.com 的原生搜索，用来查互联网。请求里带了本地工具时，即使 ID 没有 `-search`，也会打开这个搜索。

| 目标 | 添加内容 |
|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json`；使用 `claude --settings …` |
| Codex | `freedeepseek` profile；使用 `codex --profile freedeepseek` |
| OpenCode | `freedeepseek` provider 与 `~/.config/opencode/AGENTS.md` 自主完成规则；保留现有 `model` |
| Hermes | 独立的 `~/.hermes/freedeepseek.yaml` |
| OpenClaw | `freedeepseek` provider；保留现有 primary |
| Cursor | 配置片段与启动器；不修改编辑器设置 |

同时跑两个 Agent 需要两个 Web 登录，文件放进 `accounts/`。不能把某个账号绑到某个客户端。添加方法见[鉴权](auth.md)。

Claude Code 和 OpenCode 可直接粘贴或附加图片；Codex 使用 `codex -i screenshot.png`。API 支持 OpenAI `image_url` / `input_image` 与 Anthropic `image`，来源可为 base64 或公共 HTTPS URL；不支持 `file_id`。格式与限制见 [HTTP API](../api.md#image-input)。

模板：[`integrations/`](../../integrations/)。详情：[English](../agents.md)。
