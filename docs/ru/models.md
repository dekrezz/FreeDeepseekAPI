# Модели

Сверка 2026-09-20: [документация DeepSeek API](https://api-docs.deepseek.com/), [цены](https://api-docs.deepseek.com/quick_start/pricing), [V4.1-Flash](https://api-docs.deepseek.com/news/news260910), залогиненный [chat.deepseek.com](https://chat.deepseek.com).

Прокси ходит в **DeepSeek Web**, не в платный `api.deepseek.com`.

**Web:** Instant, Expert, Vision и Pro убраны. На сайте одна модель: **DeepSeek-V4.1-Flash**. В чате только DeepThink и Search. В `model_configs` ещё есть `default` / `expert` / `vision`, но живой только `default`.

Прокси показывает только актуальную Web-модель. `deepseek-flash` остаётся коротким алиасом `deepseek-v4-flash`.

| ID прокси | DeepThink | Search |
|---|---:|---:|
| `deepseek-v4-flash` / `deepseek-flash` | нет | нет |
| `deepseek-v4-flash-thinking` | да | нет |
| `deepseek-v4-flash-search` | нет | да |
| `deepseek-v4-flash-thinking-search` | да | да |

Старые имена (`deepseek-v4-pro`, `deepseek-chat`, `deepseek-r1`, `deepseek-expert`, vision) не зарегистрированы — неизвестный ID даёт `400`.

Список: `GET /v1/models`.
