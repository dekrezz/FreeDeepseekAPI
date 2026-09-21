# Авторизация

`deepseek-auth.json` — живая сессия chat.deepseek.com. Права `600`. В git не коммитить.

| Команда | Что делает |
|---|---|
| `npm run auth` | Меню: вход / импорт / статус |
| `npm run deepseek:auth` | Снять token и cookies через Chrome |
| `npm run auth:import` | Импорт `deepseek-auth.json` или cookies из браузера |
| `npm run doctor` | Проверить файлы; без `--offline` ещё и PoW |

Расширение: `chrome-extension/` на открытой вкладке `chat.deepseek.com`. Ждите **Token: Ready**, затем Save File. JSON в чат не вставляйте.

Поля: `token`, `cookie`, `wasmUrl`. По желанию `hif_dliq`, `hif_leim`. `enabled: false` в файле временно выключает этот логин. Пример: [`auth.example.json`](../../auth.example.json).

## Несколько аккаунтов

Один Web-логин = один чат в полёте. Два агента или две сессии OpenCode сразу — это два (или три) файла:

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
```

Прокси поднимает `./deepseek-auth.json` и все `./accounts/*.json`. Можно задать каталог (`DEEPSEEK_AUTH_DIR`) или список файлов через запятую в `DEEPSEEK_AUTH_PATH`. После добавления файла перезапустите сервер.

Каждому клиенту дайте свой `x-agent-session`. Привязать конкретный логин к клиенту нельзя: прокси сам берёт свободный. Второй запрос на тот же логин ждёт, а не идёт параллельно (иначе DeepSeek банит на несколько дней).

Подробности протокола: [HTTP API](../api.md).
