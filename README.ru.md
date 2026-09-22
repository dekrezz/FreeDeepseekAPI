# FreeDeepseekAPI

<p align="center">
  <strong>Локальный OpenAI-compatible API proxy для DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/blob/main/LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
  <img alt="DeepSeek V4.1 Flash" src="https://img.shields.io/badge/DeepSeek-V4.1--Flash-4d6bfe.svg" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>Русский</strong> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#быстрый-старт">Быстрый старт</a> •
  <a href="#что-это-даёт">Что это даёт</a> •
  <a href="#примеры-запросов">Примеры</a> •
  <a href="#модели">Модели</a> •
  <a href="#endpoints">Endpoints</a> •
  <a href="#open-webui">Open WebUI</a> •
  <a href="#агенты">Агенты</a>
</p>

FreeDeepseekAPI поднимает локальный API-сервер перед **DeepSeek Web Chat** ([chat.deepseek.com](https://chat.deepseek.com)). К нему подключаются Open WebUI, LiteLLM, Hermes, Claude Code, Codex, OpenCode, OpenClaw, Cursor и любой OpenAI-compatible клиент.

Проект работает через ваш обычный залогиненный аккаунт DeepSeek. Локальный сервер принимает API-запросы и продолжает сохранённую Web-сессию. Платный ключ `api.deepseek.com` не нужен.

На сайте сейчас одна модель: **DeepSeek-V4.1-Flash**. `-thinking` включает DeepThink. `-search` включает родной поиск chat.deepseek.com, и именно им отвечают на вопросы про живой интернет.

> Это экспериментальный web-chat proxy. DeepSeek может поменять внутренний Web API без предупреждения. Для production надёжнее официальный платный API DeepSeek.

---

## Навигация

- [Что это даёт](#что-это-даёт)
- [Возможности](#возможности)
- [Быстрый старт](#быстрый-старт)
- [Windows](#windows)
- [Linux / Chromium](#linux--chromium)
- [VPS / headless](#vps--headless)
- [Rootless Podman](#rootless-podman)
- [Diagnostics / doctor](#diagnostics--doctor)
- [Session reuse](#session-reuse)
- [Пул аккаунтов](#пул-аккаунтов)
- [Вход](#вход)
- [Агенты](#агенты)
- [Проверка работы](#проверка-работы)
- [Примеры запросов](#примеры-запросов)
  - [Chat Completions](#chat-completions)
  - [DeepThink](#deepthink)
  - [Родной веб-поиск](#родной-веб-поиск)
  - [Streaming](#streaming)
  - [Anthropic Messages](#anthropic-messages)
  - [OpenAI Responses](#openai-responses)
  - [Tool calling](#tool-calling)
  - [Картинки](#картинки)
- [Модели](#модели)
- [Endpoints](#endpoints)
- [Переменные окружения](#переменные-окружения)
- [Ошибки](#ошибки)
- [Open WebUI](#open-webui)
- [Обновить логин](#обновить-логин)
- [Тесты](#тесты)
- [Статус проекта](#статус-проекта)

---

## Что это даёт

- Использовать DeepSeek Web как локальный API endpoint.
- Подключать DeepSeek к Open WebUI и другим OpenAI-compatible клиентам.
- Получать обычный JSON или streaming SSE.
- Включать DeepThink суффиксом `-thinking` и читать `reasoning_content`.
- Говорить с Claude Code через Anthropic Messages.
- Говорить с Codex через OpenAI Responses.
- Держать отдельный Web-чат на каждого агента или `user`.
- Отдавать несколько локальных инструментов за один ответ, до восьми.
- Искать в интернете родным поиском DeepSeek, а не через bash и не через websearch харнесса.

## Возможности

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE и обычный JSON без стрима
- **DeepThink:** `reasoning_content`, когда включён `-thinking`
- **Родной поиск:** Web Search chat.deepseek.com при `-search`, и ещё всегда, когда кодирующий агент прислал локальные инструменты
- **Tool calling:** инструменты OpenAI, Anthropic и Responses, пачкой
- **Возможности моделей:** `GET /v1/model-capabilities`
- **Сессии агентов:** один чат DeepSeek на `x-agent-session` или `user`
- **Восстановление сессии:** пустой ответ, сломанный tool call и таймаут оставляют тот же чат
- **Без зависимостей:** Node.js 18+, ни одного npm-пакета
- **Лицензия:** Apache-2.0

---

## Быстрый старт

```bash
git clone https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` открывает меню входа. Выберите вход через Chrome, залогиньтесь на chat.deepseek.com в открывшемся профиле, отправьте короткое сообщение вроде `ok` и вернитесь в терминал. Файл сохранится как `deepseek-auth.json` с правами `0600`.

`npm start` открывает меню запуска:

- запустить proxy
- войти через Chrome
- импортировать auth-файл или экспорт cookies
- показать id моделей DeepSeek-V4.1-Flash
- выйти

Без меню, для headless и CI:

```bash
NON_INTERACTIVE=1 npm start
# или
SKIP_ACCOUNT_MENU=1 npm start
```

Сервер слушает:

```text
http://127.0.0.1:9655
```

По умолчанию он доступен только с этого компьютера. Чтобы открыть его в сеть, задайте адрес и отдельный ключ proxy:

```bash
HOST=0.0.0.0 PROXY_API_KEY='replace-with-a-long-random-value' npm start
```

Ключ передаётся как `Authorization: Bearer <key>`. Без `PROXY_API_KEY` у API нет своей авторизации. Такой экземпляр в сеть не выставляйте.

Запросы из браузера разрешены с loopback-origin. Если UI открыт на другом адресе, перечислите точные origin через запятую:

```bash
PROXY_CORS_ORIGINS='https://ui.example.com,http://192.168.1.20:3000'
```

---

## Windows

```powershell
git clone https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

Если Chrome стоит не в обычном месте:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

Если Chrome не найден, `npm run auth` печатает, куда его ставить на Windows, macOS и Linux, а не сырой stack trace.

---

## Linux / Chromium

```bash
git clone https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

Если бинарник называется иначе:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# или
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## VPS / headless

Надёжный путь не запускает Chrome на сервере.

1. На машине, где есть GUI и Chrome:

```bash
npm run auth
```

2. Скопируйте `deepseek-auth.json` на VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. Импортируйте файл и проверьте его:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Запустите proxy без меню:

```bash
NON_INTERACTIVE=1 npm start
```

Подойдёт и экспорт cookies браузера, если вместе с ним есть token:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

`deepseek-auth.json` — это доступ к вашему логину DeepSeek Web. Не коммитьте его, не вставляйте в чат и храните с правами `0600`.

Команды входа по паролю нет. Прокси не спрашивает пароль DeepSeek и не пишет его на диск. Вход — это Chrome, готовый auth-файл или экспорт cookies плюс token.

---

## Rootless Podman

Контейнер только запускает proxy. Вход делайте на хосте командой `npm run auth`. Скрипты авторизации и `deepseek-auth.json` в образ не копируются.

Запускайте Podman своим пользователем, без root.

1. Соберите образ:

```bash
podman build --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. Положите auth-файл DeepSeek и отдельный ключ proxy в secrets:

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

Ключ должен быть длинным и случайным. Значение останется в этом shell, чтобы вы могли вызвать API. В образ и в командную строку Podman оно не попадает.

3. Запустите контейнер с урезанными привилегиями:

```bash
podman run --detach \
  --name free-deepseek-api \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,type=mount,target=/run/secrets/deepseek-auth.json,mode=0400 \
  --secret free-deepseek-proxy-key,type=mount,target=/run/secrets/proxy-api-key,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  localhost/free-deepseek-api:local
```

В образе уже стоят `NON_INTERACTIVE=1`, `HOST=0.0.0.0` и `REQUIRE_PROXY_API_KEY=1`. Без secret с ключом контейнер не начнёт обслуживать запросы. На хосте порт публикуется только на `127.0.0.1`. Не убирайте этот адрес, если перед ним нет firewall.

4. Проверьте, что процесс жив, что логин готов и что список моделей закрыт ключом:

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

Встроенный healthcheck бьёт в локальный `/health` и говорит только то, что процесс поднят. `/readyz` вернёт `503`, если ни один логин DeepSeek сейчас не может взять чат.

```bash
podman logs free-deepseek-api
podman inspect --format '{{.State.Health.Status}}' free-deepseek-api
```

Остановите контейнер и удалите secrets:

```bash
podman stop free-deepseek-api
podman rm free-deepseek-api
podman secret rm free-deepseek-auth free-deepseek-proxy-key
unset PROXY_API_KEY
```

Когда меняете логин или ключ proxy, замените secret и пересоздайте контейнер.

---

## Diagnostics / doctor

```bash
npm run doctor
# без запроса в сеть к DeepSeek:
npm run doctor -- --offline
```

`doctor` проверяет:

- есть ли `deepseek-auth.json` или `DEEPSEEK_AUTH_DIR`;
- парсится ли JSON;
- заданы ли `token`, `cookie` и `wasmUrl`;
- стоят ли права `0600` на macOS и Linux;
- при обычном запуске — отвечает ли endpoint PoW у DeepSeek.

Если видите `data.biz_data is null`, `fetch failed`, `401`, `403`, `429` или агент не видит модели, сначала запустите `npm run doctor`.

---

## Session reuse

FreeDeepseekAPI не открывает новый чат DeepSeek на каждый HTTP-запрос.

- Одно значение `x-agent-session`, `session` или `user` — один чат DeepSeek.
- Если чат уже есть, прокси продолжает его через `parent_message_id`.
- Постоянный system prompt и список инструментов уходят наверх **один раз**. Дальше OpenCode, Claude Code и Codex шлют только новый ход пользователя или результат инструмента.
- Изменившийся system prompt отправляется снова.
- Пустой ответ, сломанный tool call и таймаут **оставляют** живой чат. Раньше из-за этого открывался новый чат и заново уезжал весь промпт. Теперь нет.
- Новый чат начинается, если сессии нет, цепочка дошла до 100 сообщений, чату больше 2 часов, DeepSeek сказал, что промпт слишком длинный, или вы вызвали `/reset-session`.
- Длинный промпт перед отправкой режется до `DEEPSEEK_MAX_PROMPT_CHARS` (по умолчанию 80 000 символов). Начало задачи, свежие результаты инструментов и напоминание про инструменты сохраняются.
- Если клиент уже прислал многоходовую историю, прокси не подклеивает свою recovery-историю второй раз.
- Пустой ответ повторяется до `DEEPSEEK_MAX_RETRIES` раз (по умолчанию 2). Каждый retry берёт меньший кусок контекста и, если чат жив, остаётся в нём.

Явно задать агента:

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Привет"}]}'
```

Активные сессии:

```bash
curl http://127.0.0.1:9655/v1/sessions
```

Сбросить одну:

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=my-agent"
```

Сбросить все:

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=all"
```

Чаты на сайте DeepSeek всё равно будут видны. Прокси ходит во Web Chat API, а сами чаты хранит DeepSeek. Session reuse только не плодит новый чат, пока текущая цепочка ещё годится.

Сообщение, текст которого ровно `/new`, сбрасывает удалённый чат этого агента и не уходит в модель.

---

## Пул аккаунтов

DeepSeek может забанить логин на несколько дней, если два чата отправят запрос с одного и того же логина одновременно. Правило пула: один чат в полёте на логин. Второй запрос на занятый логин ждёт и не накладывается.

Sticky значит, что прокси не прыгает между аккаунтами посреди живого чата. Если логин получил `401`, `403` или `429` и ушёл в cooldown, следующий запрос может перейти на другой готовый логин, а старая удалённая сессия перед этим сбрасывается.

Каталог auth-файлов:

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
chmod 600 accounts/*.json deepseek-auth.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Или список через запятую:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

Как ведёт себя пул:

- новый агент получает свободный логин по кругу;
- этот логин остаётся приклеен к сессии;
- `401`, `403` и `429` отправляют логин в cooldown (`DEEPSEEK_ACCOUNT_COOLDOWN_MS`, по умолчанию 10 минут);
- два запроса и два свободных логина уходят на разные аккаунты;
- тот же `x-agent-session` внахлёст ждёт свой логин (`DEEPSEEK_ACCOUNT_LOCK_WAIT_MS`, по умолчанию 120 секунд);
- когда заняты все логины, запрос ждёт sticky или тот, которым давно не пользовались;
- запрос заголовка сессии OpenCode отвечается локально и логин не занимает;
- `/health` показывает статус аккаунтов без путей к auth-файлам и без имён файлов;
- auth-файлы должны быть с правами `0600`.

Привязать клиента к выбранному файлу нельзя. Прокси сам берёт свободный логин.

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## Вход

| Команда | Что делает |
|---|---|
| `npm run auth` | Меню: Chrome, импорт, статус, удалить локальный файл |
| `npm run deepseek:auth` | Снять token и cookies через Chrome |
| `npm run auth:import` | Импорт `deepseek-auth.json` или экспорта cookies |
| `npm run doctor` | Проверить файлы. Без `--offline` ещё и PoW |

Расширение Chrome: загрузите `chrome-extension/` на открытую вкладку chat.deepseek.com. Собирайте, пока **Token** не станет Ready, потом сохраните файл. Этот JSON в чат не вставляйте.

Поля: `token`, `cookie`, `wasmUrl`. Необязательные: `hif_dliq`, `hif_leim`, `name` и `enabled` (`false` ставит логин на паузу). Пример: [`auth.example.json`](auth.example.json).

Пароль аккаунта DeepSeek сюда не входит. Команды `auth:console` нет, и пароль на диск писать не нужно.

---

## Агенты

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
npm run setup:agents -- --target codex --model deepseek-v4-flash
```

Прокси уже должен слушать порт. Адрес по умолчанию: `http://127.0.0.1:9655`. Другой задаётся через `--base-url`. Если задан `PROXY_API_KEY`, он копируется в конфиг агента.

Setup добавляет FreeDeepseekAPI как отдельный профиль. Claude, GPT и то, чем вы пользуетесь сейчас, он не подменяет.

| Агент | Что записывается | Как выбрать |
|---|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json` | `claude --settings ~/.claude/freedeepseek.settings.json` |
| Codex | `~/.codex/freedeepseek.config.toml` и каталог моделей | `codex --profile freedeepseek` |
| OpenCode | провайдер `freedeepseek` и правила автономности в `AGENTS.md` | выбрать `freedeepseek/<id>` |
| Hermes | `~/.hermes/freedeepseek.yaml` | этот файл профиля |
| OpenClaw | провайдер `freedeepseek` | выбрать явно |
| Cursor | сниппет и launcher в `integrations/cursor/` | настройки редактора не меняются |

`--model` всегда DeepSeek-V4.1-Flash. `-thinking` включает DeepThink. `-search` включает родной поиск chat.deepseek.com. Если в запросе есть локальные инструменты, этот поиск включается и без суффикса `-search`. DeepThink остаётся таким, какой выбран в id.

Setup Codex **не** пишет `forced_login_method = api`. На Codex CLI эта строка разлогинивает ChatGPT. Обычный `codex` остаётся на ChatGPT. Профиль FreeDeepseek говорит с этим прокси.

Картинки:

- Claude Code: вставьте или прикрепите. Блок Anthropic `image` уходит в DeepSeek Web.
- Codex: `codex -i screenshot.png`. Повторите `-i` для нескольких файлов. `/v1/responses` принимает `input_image`.
- OpenCode: вставьте или перетащите картинку. Сгенерированный конфиг её не выкидывает.
- Остальные OpenAI-клиенты: `image_url` как base64 data URL или публичный HTTPS URL.

Вернуть прошлый setup из бэкапа:

```bash
node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/<stamp>
```

Два агента сразу — два Web-логина в `accounts/`. Подробности: [docs/ru/agents.md](docs/ru/agents.md).

---

## Проверка работы

```bash
curl http://127.0.0.1:9655/health
curl http://127.0.0.1:9655/readyz
curl http://127.0.0.1:9655/v1/models
curl http://127.0.0.1:9655/v1/model-capabilities
```

`/health` говорит, что процесс жив. `/readyz` равен `200`, только если хотя бы один логин может обслужить запрос. `/v1/models` отдаёт четыре id DeepSeek-V4.1-Flash.

---

## Примеры запросов

### Chat Completions

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Ответь одним предложением."}],
    "stream": false
  }'
```

### DeepThink

`-thinking` — это переключатель DeepThink из композера чата. Модель всё та же, DeepSeek-V4.1-Flash. Она рассуждает перед ответом.

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking",
    "messages": [{"role": "user", "content": "Почему небо голубое? Коротко."}],
    "stream": false
  }'
```

Где лежит рассуждение:

- без стрима: `choices[0].message.reasoning_content`
- стрим: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` — оценка по извлечённому тексту DeepThink. Web-стрим официальный расход reasoning-токенов не отдаёт.

Ход с вызовом инструмента не приклеивает рассуждение к сообщению. Часть агентов считает любой текст рядом с tool call окончательным ответом и останавливается.

### Родной веб-поиск

`-search` включает родной Web Search chat.deepseek.com. Вопросы про интернет идут через этот поиск. Не просите модель пользоваться bash, curl или инструментом харнесса `websearch` / `webfetch`.

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-search",
    "messages": [{"role": "user", "content": "Найди свежий факт про DeepSeek и ответь коротко."}],
    "stream": false
  }'
```

Оба переключателя вместе:

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking-search",
    "messages": [{"role": "user", "content": "Что изменилось на сайте DeepSeek за эту неделю?"}],
    "stream": false
  }'
```

Если в запросе есть локальные инструменты, родной поиск включается даже на обычном `deepseek-v4-flash`. DeepThink остаётся выключенным, пока в id нет `-thinking`.

### Streaming

```bash
curl -N -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Расскажи короткий анекдот."}],
    "stream": true
  }'
```

Последний SSE-чанк несёт `usage`, затем `data: [DONE]`.

### Anthropic Messages

```bash
curl -X POST http://127.0.0.1:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Ответь ровно OK"}],
    "stream": false
  }'
```

Claude Code после `npm run setup:agents -- --target claude-code`:

```bash
claude --settings ~/.claude/freedeepseek.settings.json
```

Имена вроде `claude-sonnet-*` и `claude-opus-*` отображаются на DeepSeek-V4.1-Flash и DeepSeek-V4.1-Flash с DeepThink, поэтому старый Claude id всё ещё выполняется.

### OpenAI Responses

```bash
curl -X POST http://127.0.0.1:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "input": "Ответь ровно OK",
    "stream": false
  }'
```

Codex ходит этим маршрутом. После setup:

```bash
codex --profile freedeepseek
```

### Tool calling

Прокси принимает OpenAI `tools`, Anthropic `tools` и function tools из Responses.

У DeepSeek Web нет настоящего массива tool calls. Прокси вписывает список инструментов в промпт и разбирает ответ обратно в OpenAI `tool_calls`. Принимаются такие формы:

- `{"tool_call":{"name":"...","arguments":{...}}}`
- `{"tool_calls":[{"name":"...","arguments":{...}}]}` — несколько независимых вызовов, до 8
- `TOOL_CALL:` и следом JSON-объект
- JSON в ограде с конвертом `tool_call`, `tool_calls` или `function_call`
- `<tool_call>...</tool_call>`
- DeepSeek DSML, включая Web-вариант с удвоенными чертами

`execute_code` и `web_search` — собственные инструменты DeepSeek. На вашем компьютере они не запускаются. Если они стоят рядом с настоящим локальным инструментом вроде `read_file`, они отбрасываются, а локальные вызовы остаются. Недописанный блок инструмента не выполняется. Один повтор просит строгий JSON. Если и он сломан, ход возвращает `502 malformed_tool_call`, а чат остаётся открытым.

Инструменты харнесса `websearch`, `webfetch` и `WebFetch` вырезаются. Живой интернет — это родной поиск chat.deepseek.com.

### Картинки

PNG, JPEG, WebP и GIF. До 10 картинок, по 20 МиБ в раскодированном виде. Тело JSON по умолчанию до 30 МиБ.

Прокси загружает картинку в DeepSeek Web, ждёт конца разбора и потом шлёт id файла. Чужой `file_id` отклоняется. URL должен быть публичным HTTPS. Редиректы на локальные, частные и link-local адреса отклоняются.

OpenAI Chat Completions использует `image_url`. Responses использует `input_image`. Anthropic использует блок `image` с base64. См. [docs/api.md](docs/api.md).

---

## Модели

`GET /v1/models` отдаёт только DeepSeek-V4.1-Flash.

| ID | DeepThink | Родной веб-поиск | Что делает |
|---|---|---|---|
| `deepseek-v4-flash` | выкл | выкл | DeepSeek-V4.1-Flash. `deepseek-flash` — тот же id |
| `deepseek-v4-flash-thinking` | вкл | выкл | Сначала DeepThink, потом ответ |
| `deepseek-v4-flash-search` | выкл | вкл | Родной поиск chat.deepseek.com для живого интернета |
| `deepseek-v4-flash-thinking-search` | вкл | вкл | DeepThink и родной поиск |

Эти суффиксы — два переключателя в чате DeepSeek. Другую модель они не выбирают.

Старые id не зарегистрированы и отвечают `400 invalid_model`:

`deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-v3`, `deepseek-instant`, `deepseek-expert`, `deepseek-v4-pro`, `deepseek-chat-search` и vision.

```bash
curl http://127.0.0.1:9655/v1/model-capabilities
```

Полная таблица: [docs/ru/models.md](docs/ru/models.md).

---

## Endpoints

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | Процесс жив. Статус аккаунтов, если ключа proxy нет или bearer совпал |
| `GET` | `/readyz` | `200`, только если логин может обслужить запрос |
| `GET` | `/v1/models` | Четыре id DeepSeek-V4.1-Flash |
| `GET` | `/v1/model-capabilities` | Id, DeepThink и родной поиск |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/responses` | OpenAI Responses |
| `GET` | `/v1/sessions` | Локальные сессии агентов |
| `POST` | `/reset-session?agent=<id>` | Закрыть один Web-чат |
| `POST` | `/reset-session?agent=all` | Закрыть все Web-чаты |

---

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `HOST` | `127.0.0.1` | Адрес. Привязка не к loopback без ключа proxy печатает предупреждение |
| `PORT` | `9655` | Порт |
| `PROXY_API_KEY` | выкл | Bearer обязателен на `/v1/*`, если задан |
| `REQUIRE_PROXY_API_KEY` | выкл | Не стартовать без ключа. В контейнере это включено |
| `PROXY_CORS_ORIGINS` | loopback | Дополнительные точные origin браузера |
| `DEEPSEEK_AUTH_PATH` | `./deepseek-auth.json` | Один файл или список через запятую |
| `DEEPSEEK_AUTH_DIR` | `./accounts`, если каталог есть | Все `*.json` в нём |
| `DEEPSEEK_MAX_PROMPT_CHARS` | `80000` | Потолок того, что уходит наверх. Минимум 16000 |
| `DEEPSEEK_MAX_RETRIES` | `2` | Повторы пустого ответа в том же чате |
| `DEEPSEEK_REQUEST_DEADLINE_MS` | `120000` | Лимит времени на запрос |
| `DEEPSEEK_MAX_CONCURRENT` | `24` | Потолок процесса. Настоящий параллелизм — число свободных логинов |
| `DEEPSEEK_ACCOUNT_LOCK_WAIT_MS` | `120000` | Сколько второй чат ждёт занятый логин |
| `DEEPSEEK_ACCOUNT_COOLDOWN_MS` | `600000` | После 401, 403 или 429 |
| `TRUST_PROXY` | выкл | Если `1`, IP клиента берётся из `X-Forwarded-For` |
| `MAX_REQUEST_BODY_BYTES` | `31457280` | Максимум тела JSON, вместе с base64-картинками |
| `NON_INTERACTIVE` / `SKIP_ACCOUNT_MENU` | выкл | Пропустить меню запуска |

---

## Ошибки

| Статус | `error.type` | Что делать |
|---|---|---|
| 400 | `invalid_model` | Возьмите id из `GET /v1/models` |
| 400 | `context_length_exceeded` | Промпт остался слишком длинным после уплотнения |
| 401 | `authentication_error` | Ключ proxy не совпал |
| 429 | `concurrent_chat_blocked` | Ожидание занятого логина истекло. Добавьте логин или повторите |
| 429 | `rate_limit` | Все логины в cooldown. Уважайте `Retry-After` |
| 502 | `malformed_tool_call` | Разметка инструмента осталась сломанной после одной починки. Чат сохранён |
| 502 | `empty_response` | DeepSeek ничего не вернул после повторов |
| 503 | `overloaded` / `no_auth` | Слишком много запросов в полёте или нет auth-файла |
| 504 | `request_timeout` | Вышел срок из `DEEPSEEK_REQUEST_DEADLINE_MS` |

---

## Open WebUI

Base URL, если Open WebUI в Docker на той же машине:

```text
http://host.docker.internal:9655/v1
```

Локально, без Docker:

```text
http://127.0.0.1:9655/v1
```

Если `PROXY_API_KEY` не задан, в поле API key можно поставить что угодно. Если ключ задан, клиент должен прислать именно его. Прокси проверяет bearer до моделей, сессий и completions.

Берите `deepseek-v4-flash` для обычного ответа, `deepseek-v4-flash-thinking` для DeepThink и `deepseek-v4-flash-search`, когда вопрос требует живого интернета через родной поиск chat.deepseek.com.

---

## Обновить логин

```bash
npm run auth
npm start
```

Если DeepSeek отвечает `401` или `403`, или падает PoW, войдите снова и замените `deepseek-auth.json`.

В git не попадают:

- `deepseek-auth.json`
- `accounts/*.json`
- каталоги профиля Chrome, которыми пользуется скрипт входа
- `.env`

---

## Тесты

Синтаксис и модульные тесты, без сети:

```bash
npm test
```

Живые smoke-тесты против уже запущенного proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-v4-flash npm run test:live
```

`npm test` гоняет `node --check` по точкам входа и `node --test tests/unit.test.js`. В DeepSeek он не ходит.

---

## Статус проекта

FreeDeepseekAPI — локальный web-chat proxy. Он зависит от текущего контракта chat.deepseek.com. Когда контракт меняется, может понадобиться поправить auth или тело запроса.

Если вызов перестал работать:

1. Обновите логин через `npm run auth`.
2. Запустите `npm run doctor`.
3. Прочитайте `GET /v1/model-capabilities` и возьмите id DeepSeek-V4.1-Flash.
4. Если тот же чат продолжает падать, вызовите `POST /reset-session?agent=<id>` и попробуйте ещё раз.
5. Если и это не помогло, DeepSeek, скорее всего, изменил внутренний Web API.

Сообщения об уязвимостях идут в закрытый GitHub advisory, не в публичный issue. См. [SECURITY.md](SECURITY.md). Список мейнтейнеров: [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Документация

- [Авторизация](docs/ru/auth.md)
- [Агенты](docs/ru/agents.md)
- [Модели](docs/ru/models.md)
- [HTTP API](docs/api.md)

## Звёзды

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.svg" alt="История звёзд" width="800" />
</a>

## Лицензия

Apache-2.0. Copyright 2026 dekrezz.
