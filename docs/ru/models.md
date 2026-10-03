# Модели

Одна модель: **DeepSeek-V4.1-Flash**. Прокси ходит в [chat.deepseek.com](https://chat.deepseek.com), не в платный ключ `api.deepseek.com`.

`deepseek-flash` — короткий алиас `deepseek-v4-flash`. Суффиксы — это два переключателя из чата DeepSeek. Другую модель они не выбирают.

| ID | DeepThink | Родной веб-поиск |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | выкл | вкл |
| `deepseek-v4-flash-thinking` | вкл | вкл |
| `deepseek-v4-flash-nosearch` | выкл | выкл |
| `deepseek-v4-flash-thinking-nosearch` | вкл | выкл |

**`-thinking` включает DeepThink.** V4.1-Flash рассуждает перед ответом. Сама модель остаётся DeepSeek-V4.1-Flash.

**Родной Web Search chat.deepseek.com включён по умолчанию.** Запросы в интернет идут через этот поиск. Инструменты харнесса `websearch`, `webfetch` и `WebFetch` его не заменяют; пока поиск включён, прокси их отбрасывает.

**`-nosearch` выключает поиск.** То же делает `"web_search": false` в теле запроса, на любом ID. `"web_search": true` снова включает его для ID с `-nosearch`. Любое другое значение возвращает `400 invalid_request_error`. При выключенном поиске у кодирующего агента остаются его собственные веб-инструменты.

**Бывшие ID с `-search`.** `deepseek-v4-flash-search` и `deepseek-v4-flash-thinking-search` по-прежнему работают и означают `deepseek-v4-flash` и `deepseek-v4-flash-thinking`. В `/v1/models` они не перечислены.

Старые ID не зарегистрированы: `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert` и vision. Они отвечают `400 invalid_model`.

Имена Claude Code вроде `claude-sonnet-*` и `claude-opus-*` отображаются на DeepSeek-V4.1-Flash и DeepSeek-V4.1-Flash с DeepThink.

Список: `GET /v1/models`. Полная карта: `GET /v1/model-capabilities`.
