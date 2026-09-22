# Модели

Одна модель: **DeepSeek-V4.1-Flash**. Прокси ходит в [chat.deepseek.com](https://chat.deepseek.com), не в платный ключ `api.deepseek.com`.

`deepseek-flash` — короткий алиас `deepseek-v4-flash`. Суффиксы — это два переключателя из чата DeepSeek. Другую модель они не выбирают.

| ID | DeepThink | Родной веб-поиск |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | выкл | выкл |
| `deepseek-v4-flash-thinking` | вкл | выкл |
| `deepseek-v4-flash-search` | выкл | вкл |
| `deepseek-v4-flash-thinking-search` | вкл | вкл |

**`-thinking` включает DeepThink.** V4.1-Flash рассуждает перед ответом. Сама модель остаётся DeepSeek-V4.1-Flash.

**`-search` включает родной поиск chat.deepseek.com.** Запросы в интернет идут через этот поиск. Инструменты харнесса `websearch`, `webfetch` и `WebFetch` его не заменяют. Если кодирующий агент прислал локальные инструменты, прокси включает этот родной поиск и на обычном `deepseek-v4-flash`. DeepThink при этом остаётся таким, какой выбран в ID модели.

Старые ID не зарегистрированы: `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert` и vision. Они отвечают `400 invalid_model`.

Имена Claude Code вроде `claude-sonnet-*` и `claude-opus-*` отображаются на DeepSeek-V4.1-Flash и DeepSeek-V4.1-Flash с DeepThink.

Список: `GET /v1/models`. Полная карта: `GET /v1/model-capabilities`.
