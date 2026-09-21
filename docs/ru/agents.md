# Агенты одним нажатием

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
```

Скрипт добавляет FreeDeepseekAPI как отдельный opt-in профиль/provider. Текущие Opus, Sonnet, GPT и выбранная модель не заменяются.

| Цель | Что добавляется |
|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json`; запуск через `claude --settings …` |
| Codex | профиль `freedeepseek`; запуск через `codex --profile freedeepseek` |
| OpenCode | provider `freedeepseek` и правило автономности в `~/.config/opencode/AGENTS.md`; текущий `model` сохраняется |
| Hermes | отдельный `~/.hermes/freedeepseek.yaml` |
| OpenClaw | provider `freedeepseek`; текущий primary сохраняется |
| Cursor | сниппет + launcher; настройки редактора не меняются |

Два агента сразу — два Web-логина в `accounts/`. Конкретный аккаунт к клиенту не привязывается. Как добавить файлы: [Авторизация](auth.md).

Изображения можно вставлять или прикреплять в Claude Code и OpenCode; в Codex используйте `codex -i screenshot.png`. API принимает OpenAI `image_url` / `input_image` и Anthropic `image` с base64 или публичным HTTPS URL. `file_id` не поддерживается. Форматы и лимиты: [HTTP API](../api.md#image-input).

Шаблоны: [`integrations/`](../../integrations/). Подробности: [English](../agents.md).
