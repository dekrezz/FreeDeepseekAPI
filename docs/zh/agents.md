# 一键接入 Agent

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-pro
```

脚本写入各工具真正读取的配置，并备份到 `~/.freedeepseek-api/backups/`。

| 目标 | 写入 |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` + `freedeepseek` profile；Responses API 与图片输入 |
| OpenCode | `~/.config/opencode/opencode.json`；启用附件和 image modality |
| Hermes | `~/.hermes/config.yaml` |
| OpenClaw | `~/.openclaw/openclaw.json`；输入为 `text` + `image` |
| Cursor | 片段 + 启动脚本；API Key 仍在 GUI |

Claude Code 和 OpenCode 可直接粘贴或附加图片；Codex 使用 `codex -i screenshot.png`。API 支持 OpenAI `image_url` / `input_image` 与 Anthropic `image`，来源可为 base64 或公共 HTTPS URL；不支持 `file_id`。格式与限制见 [HTTP API](../api.md#image-input)。

模板：[`integrations/`](../../integrations/)。详情：[English](../agents.md)。
