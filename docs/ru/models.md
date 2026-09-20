# Модели

Сверка 2026-09-20: [документация DeepSeek API](https://api-docs.deepseek.com/), [цены](https://api-docs.deepseek.com/quick_start/pricing), [V4.1-Flash](https://api-docs.deepseek.com/news/news260910), залогиненный [chat.deepseek.com](https://chat.deepseek.com).

Прокси ходит в **DeepSeek Web**, не в платный `api.deepseek.com`.

**Web:** Instant, Expert, Vision и Pro убраны. На сайте одна модель: **DeepSeek-V4.1-Flash**. В чате только DeepThink и Search. В `model_configs` ещё есть `default` / `expert` / `vision`, но живой только `default`.

**Платный API:** `deepseek-flash` → V4.1-Flash. Старый `deepseek-v4-flash` туда же. Отдельный платный `deepseek-v4-pro` DeepSeek решил сохранить и после 2026-09-14. В Web это Pro не возвращает и протокол прокси не меняет (`model_type: default`).

| ID прокси | Web `model_type` | Вес |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | `default` | DeepSeek-V4.1-Flash |
| `deepseek-v4-pro` (старый алиас) | `default` | DeepSeek-V4.1-Flash |

Суффиксы: `-thinking`, `-search`, `-thinking-search`. Старые имена (`deepseek-chat`, `deepseek-r1`, `deepseek-expert`, vision) не зарегистрированы — неизвестный ID даёт `400`.

Список: `GET /v1/models`.
