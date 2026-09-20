# Агенты одним нажатием

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-pro
```

Скрипт пишет файлы, которые реально читают инструменты, и кладёт бэкап в `~/.freedeepseek-api/backups/`.

| Цель | Куда пишет |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` + профиль `freedeepseek`; Responses API и изображения |
| OpenCode | `~/.config/opencode/opencode.json`; вложения и image modality включены |
| Hermes | `~/.hermes/config.yaml` |
| OpenClaw | `~/.openclaw/openclaw.json`; вход `text` + `image` |
| Cursor | сниппет + launcher; ключ всё равно в GUI |

Изображения можно вставлять или прикреплять в Claude Code и OpenCode; в Codex используйте `codex -i screenshot.png`. API принимает OpenAI `image_url` / `input_image` и Anthropic `image` с base64 или публичным HTTPS URL. `file_id` не поддерживается. Форматы и лимиты: [HTTP API](../api.md#image-input).

Шаблоны: [`integrations/`](../../integrations/). Подробности: [English](../agents.md).
