<p align="center">
  <img src="docs/assets/logo.png" alt="FreeDeepseekAPI" width="160" />
</p>

<h1 align="center">FreeDeepseekAPI</h1>

<p align="center">
  <strong>Local OpenAI-compatible API proxy for DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/blob/main/LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
  <img alt="DeepSeek V4.1 Flash" src="https://img.shields.io/badge/DeepSeek-V4.1--Flash-4d6bfe.svg" />
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> •
  <a href="#what-you-get">What you get</a> •
  <a href="#request-examples">Examples</a> •
  <a href="#models">Models</a> •
  <a href="#endpoints">Endpoints</a> •
  <a href="#open-webui">Open WebUI</a> •
  <a href="#coding-agents">Coding agents</a>
</p>

<p align="center">
  <a href="#dashboard"><img src="docs/assets/dashboard.png" alt="FreeDeepseekAPI dashboard: built-in chat on top of DeepSeek Web" width="880" /></a>
</p>

FreeDeepseekAPI runs a local API server in front of **DeepSeek Web Chat** ([chat.deepseek.com](https://chat.deepseek.com)). Point Open WebUI, LiteLLM, Hermes, Claude Code, Codex, OpenCode, OpenClaw, Cursor, or any OpenAI-compatible client at it.

The project uses your normal logged-in DeepSeek account. The local server accepts API requests, then continues that saved Web session. There is no paid `api.deepseek.com` key.

One model is on the site today: **DeepSeek-V4.1-Flash**. The native Web Search built into chat.deepseek.com is **on by default**, and that search is what answers live internet questions. `-thinking` turns DeepThink on. `-nosearch` or `"web_search": false` turns search off.

> This is an experimental Web-chat proxy. DeepSeek can change its private Web API at any time. When it does, the project is updated to follow, and this guide may change with it. Keep your copy on the newest version: Settings → Updates in the dashboard, or see [Updates](#updates).

---

## Contents

- [What you get](#what-you-get)
- [Features](#features)
- [Quick start](#quick-start)
- [Windows](#windows)
- [Linux / Chromium](#linux--chromium)
- [VPS / headless](#vps--headless)
- [Rootless Podman](#rootless-podman)
- [Diagnostics / doctor](#diagnostics--doctor)
- [Session reuse](#session-reuse)
- [Multi-account pool](#multi-account-pool)
- [Dashboard](#dashboard)
- [Updates](#updates)
- [Sign-in](#sign-in)
- [Coding agents](#coding-agents)
- [Check that it works](#check-that-it-works)
- [Request examples](#request-examples)
  - [Chat Completions](#chat-completions)
  - [DeepThink](#deepthink)
  - [Native web search](#native-web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages](#anthropic-messages)
  - [OpenAI Responses](#openai-responses)
  - [Tool calling](#tool-calling)
  - [Images](#images)
- [Models](#models)
- [Endpoints](#endpoints)
- [Environment](#environment)
- [Errors](#errors)
- [Open WebUI](#open-webui)
- [Refresh the login](#refresh-the-login)
- [Tests](#tests)
- [Project status](#project-status)

---

## What you get

- Use DeepSeek Web as a local API endpoint.
- Connect DeepSeek to Open WebUI and other OpenAI-compatible clients.
- Get a normal JSON body or a streaming SSE response.
- Turn DeepThink on with `-thinking` and read `reasoning_content`.
- Talk to Claude Code through the Anthropic Messages shim.
- Talk to Codex through the OpenAI Responses shim.
- Keep a separate Web chat for each agent or `user` id.
- Let several local tools run in one reply, up to eight.
- Search the live web with DeepSeek's own search, not with bash or a harness websearch tool.

## Features

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks, and a normal non-stream JSON body
- **DeepThink:** `reasoning_content` when `-thinking` is on
- **Native search:** chat.deepseek.com Web Search, on by default. Off with `-nosearch` or `"web_search": false`
- **Tool calling:** OpenAI tools, Anthropic tools, and Responses function tools, returned as a batch
- **Model capabilities:** `GET /v1/model-capabilities`
- **Agent sessions:** one DeepSeek chat per `x-agent-session` or `user`
- **Session recovery:** an empty reply, a broken tool call, or a timeout keeps the same chat
- **Zero dependencies:** Node.js 18+, no npm packages
- **License:** Apache-2.0

---

## Quick start

```bash
git clone --branch stable https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` opens the sign-in menu. Choose Chrome sign-in, log in at chat.deepseek.com in the profile it opens, send a short message such as `ok`, then return to the terminal and continue. The saved file is `deepseek-auth.json`, mode `0600`.

`npm start` opens the launch menu:

- Start proxy
- Start proxy + open dashboard (also `npm run dashboard`)
- Sign in with Chrome
- Import an auth file or a browser cookie export
- Show the DeepSeek-V4.1-Flash model ids
- Quit

Headless or CI, with no menu:

```bash
NON_INTERACTIVE=1 npm start
# or
SKIP_ACCOUNT_MENU=1 npm start
```

The server listens on:

```text
http://127.0.0.1:9655
```

By default only this computer can reach it. To publish it on a network, set an address and a proxy key:

```bash
HOST=0.0.0.0 PROXY_API_KEY='replace-with-a-long-random-value' npm start
```

Send that key as `Authorization: Bearer <key>`. Without `PROXY_API_KEY`, the API has no authentication of its own. Do not put that instance on a network.

Browser calls are allowed from loopback origins. If the UI is on another origin, list the exact origins, comma-separated:

```bash
PROXY_CORS_ORIGINS='https://ui.example.com,http://192.168.1.20:3000'
```

---

## Windows

```powershell
git clone --branch stable https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

If Chrome is not in the usual place:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

When Chrome is missing, `npm run auth` prints the install path for Windows, macOS, or Linux instead of a raw stack trace.

---

## Linux / Chromium

```bash
git clone --branch stable https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

If the binary has another name:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# or
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## VPS / headless

The reliable path does not run Chrome on the server.

1. On a machine that has a GUI and Chrome:

```bash
npm run auth
```

2. Copy `deepseek-auth.json` to the VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. Import it and check the file:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Start the proxy with no menu:

```bash
NON_INTERACTIVE=1 npm start
```

A browser cookie export works too, if you also have the token:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

`deepseek-auth.json` is access to your DeepSeek Web login. Do not commit it, do not paste it into a chat, and keep it mode `0600`.

There is no password login command. The proxy never asks for your DeepSeek password and never stores one. Sign-in is Chrome, a saved auth file, or a cookie export plus token.

---

## Rootless Podman

The container only runs the proxy. Sign in on the host with `npm run auth`. Auth scripts and `deepseek-auth.json` are not copied into the image.

Run Podman as your user, not as root.

1. Build the image:

```bash
podman build --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. Store the DeepSeek auth file and a separate proxy key as secrets:

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

Use a long random key. The value stays in this shell so you can call the API. It is not baked into the image or the Podman command line.

3. Start the container with the privileges dropped:

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

Inside the image, `NON_INTERACTIVE=1`, `HOST=0.0.0.0`, and `REQUIRE_PROXY_API_KEY=1` are already set. The container refuses to serve if the proxy-key secret is missing or empty. On the host the port is published only on `127.0.0.1`. Do not drop that address unless you have a firewall in front of it.

4. Check liveness, account readiness, and the protected model list:

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

The built-in healthcheck hits local `/health` and only tells you the process is up. `/readyz` returns `503` when no DeepSeek login can serve a chat right now.

```bash
podman logs free-deepseek-api
podman inspect --format '{{.State.Health.Status}}' free-deepseek-api
```

Stop the container and remove the secrets:

```bash
podman stop free-deepseek-api
podman rm free-deepseek-api
podman secret rm free-deepseek-auth free-deepseek-proxy-key
unset PROXY_API_KEY
```

When you rotate the login or the proxy key, replace the secret and recreate the container.

---

## Diagnostics / doctor

```bash
npm run doctor
# no network call to DeepSeek:
npm run doctor -- --offline
```

`doctor` checks:

- whether `deepseek-auth.json` or `DEEPSEEK_AUTH_DIR` is present;
- whether the JSON parses;
- whether `token`, `cookie`, and `wasmUrl` are set;
- whether the file mode is `0600` on macOS and Linux;
- on a normal run, whether the DeepSeek PoW endpoint answers.

If you see `data.biz_data is null`, `fetch failed`, `401`, `403`, `429`, or a coding agent that cannot list models, run `npm run doctor` first.

---

## Session reuse

FreeDeepseekAPI does not open a new DeepSeek chat on every HTTP request.

- One `x-agent-session`, `session`, or `user` value is one DeepSeek chat.
- When that chat already exists, the proxy continues it with `parent_message_id`.
- The standing system prompt and the tool list go upstream **once**. Later turns from OpenCode, Claude Code, and Codex send only the new user or tool turn.
- A changed system prompt is sent again.
- An empty reply, a broken tool-call, or a timeout **keeps** the live chat. Those failures used to open a new chat and resend the whole prompt. They do not anymore.
- A new chat starts when the session is missing, the chain hits 100 messages, the chat is older than 2 hours, DeepSeek says the prompt is too long, or you call `/reset-session`.
- Long prompts are cut to `DEEPSEEK_MAX_PROMPT_CHARS` (default 80,000 characters) before they are sent. The start of the task, the latest tool results, and the tool reminder stay.
- If the client already sent a multi-turn history, the proxy does not paste its own recovery history a second time.
- An empty reply is retried up to `DEEPSEEK_MAX_RETRIES` times (default 2). Each retry uses a smaller slice of context, still on the same chat when that chat is alive.

Set the agent explicitly:

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello"}]}'
```

List active sessions:

```bash
curl http://127.0.0.1:9655/v1/sessions
```

Reset one session:

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=my-agent"
```

Reset every session:

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=all"
```

A reset keeps the proxy's copy of the conversation and replays it into the next chat when the client sends only one message. Add `&history=drop` when the client will send its own full transcript, for example after editing an earlier message, so the replaced turns do not come back.

You will still see chats in the DeepSeek website. The proxy uses the Web Chat API, and DeepSeek stores the real chats. Session reuse only stops the proxy from opening a new one when the current chain is still good.

A message whose text is exactly `/new` resets that agent's remote chat instead of sending the text to the model.

---

## Multi-account pool

DeepSeek can ban a login for days if two chats send on that same login at the same time. The pool rule is: one in-flight chat per login. A second request for a busy login waits. It does not overlap.

Sticky means the proxy does not hop accounts in the middle of a live chat, except when that login is rate-limited or loses auth. If the login gets `401` or `403`, or DeepSeek rate-limits it, the login goes into cooldown and the old remote session is dropped. A rate-limited request does not fail: it moves right away to another ready login, on a new chat that gets the full transcript. After `401`/`403`, the next request moves.

Directory of auth files:

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
chmod 600 accounts/*.json deepseek-auth.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Or a comma-separated list:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

How the pool behaves:

- a new agent gets a free login, round-robin;
- that login stays stuck to the session;
- `401`, `403`, and rate limits put the login in cooldown (`DEEPSEEK_ACCOUNT_COOLDOWN_MS`, default 10 minutes). A rate limit is HTTP `429`, a "too frequent" message in an HTTP `400` or JSON body (for example `Слишком частые сообщения`), or a DeepSeek stream hint with `finish_reason: rate_limit_reached`. `Retry-After` is honored when DeepSeek sends it;
- the rate-limited request moves to another ready login on a new chat. Only when every login is cooling down does the client get `429 rate_limit`;
- other `400` errors do not cause a cooldown. The chat is recreated on the same login;
- two requests and two free logins go to different accounts;
- the same `x-agent-session` overlapping waits on its login (`DEEPSEEK_ACCOUNT_LOCK_WAIT_MS`, default 120 seconds);
- when every login is busy, the request waits on the sticky or least-recently-used login;
- OpenCode's session-title request is answered locally and does not occupy a login;
- `/health` shows account status without auth-file paths or file names;
- `/dashboard` shows every login and lets you pause, resume, clear a cooldown, and reload auth files without a restart (see [Dashboard](#dashboard));
- auth files must be mode `0600`.

You cannot pin a client to a chosen file. The proxy picks a free login.

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## Dashboard

Open `http://127.0.0.1:9655/dashboard`. It lists every login with its state (`ready`, `busy`, `cooldown`, `disabled`, `no_credentials`), the cooldown countdown and reason, consecutive and total failures, the last upstream error, and usage. From there you can:

- **Disable / Enable** a login. This is a runtime pause: in-flight work finishes, and a restart forgets it. `"enabled": false` in the auth file is the persistent switch; a login disabled in its file cannot be enabled from the dashboard.
- **Clear cooldown** to put a cooling login back in rotation now.
- **Reload accounts** to re-read the auth files. New files are added and deleted files are removed. A kept login keeps its cooldown and counters. A login whose token or cookie changed starts fresh.

To add a login, import it and press Reload:

```bash
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-3.json
```

The page is static and holds no data. It reads the admin API:

| Method | Path | Result |
|---|---|---|
| `GET` | `/admin/accounts` | `{ now, pool, accounts }` |
| `POST` | `/admin/accounts/<id>/disable` | `{ account, pool }` |
| `POST` | `/admin/accounts/<id>/enable` | `{ account, pool }`. `409 disabled_in_file` if the file says `"enabled": false` |
| `POST` | `/admin/accounts/<id>/clear-cooldown` | `{ account, pool }` |
| `POST` | `/admin/accounts/reload` | `{ added, removed, kept, errors, accounts, pool }`. `422 no_accounts_found` leaves the pool unchanged |
| `POST` | `/admin/accounts/restore` | Body `{ archived_as }` from a `DELETE`. Renames the file back and reloads: `{ restored, errors, accounts, pool }`. `404 archive_not_found`, `409 restore_target_exists` |

Access rules:

- With `PROXY_API_KEY` set, `/admin/*` needs the same bearer as `/v1/*`. The page asks for the key and keeps it in the tab's session storage only.
- Without a key, `/admin/*` answers only direct loopback clients. A request that carries `X-Forwarded-For`, `Forwarded`, or `X-Real-IP` is refused with `403 admin_forbidden`, even from `127.0.0.1`. So is a non-localhost `Host`, or a browser `Origin` other than the proxy's own (another local web app cannot pause logins). `PROXY_ADMIN_ALLOW_REMOTE=1` lifts only the client address rule. The `Host` must still be loopback, an IP address, or a host listed in `PROXY_CORS_ORIGINS`, and a browser `Origin` must still be the proxy's own. Anyone who can reach the port can still pause logins, so prefer a key on a network bind.
- Browser POSTs still pass the origin guard. To use the dashboard from a non-loopback address, add that origin to `PROXY_CORS_ORIGINS`.
- Admin responses never contain tokens, cookies, `hif_*` values, or auth-file names.

The container image ships the dashboard. With `--read-only`, actions that write auth files (add, rename, remove, restore) fail with `500 auth_file_write_failed`; pause, resume, and clear cooldown work.

---

## Updates

DeepSeek changes its Web chat from time to time, and FreeDeepseekAPI follows. Keep your copy current.

Two channels, both branches on GitHub:

| Channel | What it gets |
|---|---|
| `stable` | A release once it has been checked. The default, and what Quick start clones. |
| `latest` | Every release as soon as it is out. |

**From the dashboard:** Settings → Updates. Pick a channel, **Check for updates** shows what is new, **Install** moves your copy to it, **Restart now** loads it. The restart is automatic when the proxy runs with `npm start` or `npm run dashboard`; otherwise stop it and start it again.

The dashboard only moves your copy forward. It stops and shows the command to run by hand when the folder has uncommitted changes to tracked files or your channel branch has commits of its own. A container image or a downloaded archive has no git history: pull a new image or download the new release.

**By hand:**

```bash
git fetch origin && git switch stable && git merge --ff-only origin/stable
```

Then restart the proxy.

---

## Sign-in

| Command | What it does |
|---|---|
| `npm run auth` | Menu: Chrome sign-in, import, status, delete the local file |
| `npm run deepseek:auth` | Chrome capture of token and cookies |
| `npm run auth:import` | Import `deepseek-auth.json` or a browser cookie export |
| `npm run doctor` | Check the files. Drop `--offline` to also hit PoW |

Chrome extension: load `chrome-extension/` on an open chat.deepseek.com tab. Collect until **Token** is Ready, then save the file. Do not paste that JSON into a chat.

Fields: `token`, `cookie`, `wasmUrl`. Optional: `hif_dliq`, `hif_leim`, `name`, and `enabled` (`false` pauses that login). See [`auth.example.json`](auth.example.json).

The password of the DeepSeek account is not an input. There is no `auth:console` command, and none should store a password on disk.

---

## Coding agents

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
npm run setup:agents -- --target codex --model deepseek-v4-flash
```

The proxy must already be listening. The default origin is `http://127.0.0.1:9655`. Override it with `--base-url`. If `PROXY_API_KEY` is set, it is copied into the agent config.

Setup adds FreeDeepseekAPI as an opt-in profile. It does not replace Claude, GPT, or whatever you already use.

| Agent | What is written | How you select it |
|---|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json` | `claude --settings ~/.claude/freedeepseek.settings.json` |
| Codex | `~/.codex/freedeepseek.config.toml` and a model catalog | `codex --profile freedeepseek` |
| OpenCode | a `freedeepseek` provider, plus autonomy rules in `AGENTS.md` | pick `freedeepseek/<id>` |
| Hermes | `~/.hermes/freedeepseek.yaml` | that profile file |
| OpenClaw | a `freedeepseek` provider | pick it explicitly |
| Cursor | a snippet and launcher under `integrations/cursor/` | editor settings stay as they are |

`--model` is always DeepSeek-V4.1-Flash, with native chat.deepseek.com search on. `-thinking` turns DeepThink on. `-nosearch` turns search off; the agent then keeps its own web tools. An old `-search` id maps to the same id without the suffix.

Codex setup does **not** set `forced_login_method = api`. On Codex CLI that line logs you out of ChatGPT. Normal `codex` stays on ChatGPT. The FreeDeepseek profile talks to this proxy.

Images:

- Claude Code: paste or attach. The Anthropic `image` block is uploaded to DeepSeek Web.
- Codex: `codex -i screenshot.png`. Repeat `-i` for more files. `/v1/responses` accepts `input_image`.
- OpenCode: paste or drop an image. The generated config keeps attachments.
- Other OpenAI clients: send `image_url` as a base64 data URL or a public HTTPS URL.

Restore a previous setup from its backup:

```bash
node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/<stamp>
```

Two agents at once need two Web logins in `accounts/`. Details: [docs/agents.md](docs/agents.md).

---

## Check that it works

```bash
curl http://127.0.0.1:9655/health
curl http://127.0.0.1:9655/readyz
curl http://127.0.0.1:9655/v1/models
curl http://127.0.0.1:9655/v1/model-capabilities
```

`/health` is liveness. `/readyz` is `200` only when at least one login can serve. `/v1/models` lists the four DeepSeek-V4.1-Flash ids.

---

## Request examples

### Chat Completions

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Answer in one sentence."}],
    "stream": false
  }'
```

### DeepThink

`-thinking` is the DeepThink switch from the chat composer. The model is still DeepSeek-V4.1-Flash. It reasons before the answer.

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking",
    "messages": [{"role": "user", "content": "Why is the sky blue? Keep it short."}],
    "stream": false
  }'
```

Where the reasoning shows up:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` is an estimate from the extracted DeepThink text. The Web stream does not report official reasoning-token usage.

A tool-call turn does not attach reasoning to the message. Some agents treat any text next to a tool call as the final answer and stop.

### Native web search

The native Web Search of chat.deepseek.com is on by default, for every model id. Internet questions go through that search. Do not ask the model to use bash, curl, or a harness `websearch` / `webfetch` tool for the live web.

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Find a current fact about DeepSeek and answer briefly."}],
    "stream": false
  }'
```

To answer without search, send `"web_search": false`, or use an id ending in `-nosearch`:

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking",
    "web_search": false,
    "messages": [{"role": "user", "content": "Explain how a B-tree splits a node."}],
    "stream": false
  }'
```

`web_search` must be `true` or `false`; any other value returns `400 invalid_request_error`. It overrides the id: `"web_search": true` on a `-nosearch` id turns search back on. The field works on `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`.

With search off, a coding agent keeps its own `websearch` / `webfetch` tools and is not told that native search is on.

### Streaming

```bash
curl -N -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Tell a short joke."}],
    "stream": true
  }'
```

The last SSE chunk carries `usage`, then `data: [DONE]`.

### Anthropic Messages

```bash
curl -X POST http://127.0.0.1:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Reply with exactly OK"}],
    "stream": false
  }'
```

Claude Code, after `npm run setup:agents -- --target claude-code`:

```bash
claude --settings ~/.claude/freedeepseek.settings.json
```

Names such as `claude-sonnet-*` and `claude-opus-*` are mapped onto DeepSeek-V4.1-Flash and DeepSeek-V4.1-Flash with DeepThink, so a leftover Claude id still runs.

### OpenAI Responses

```bash
curl -X POST http://127.0.0.1:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "input": "Reply with exactly OK",
    "stream": false
  }'
```

Codex uses this route. After setup:

```bash
codex --profile freedeepseek
```

### Tool calling

The proxy accepts OpenAI `tools`, Anthropic `tools`, and Responses function tools.

DeepSeek Web has no native tool-call array. The proxy writes the tool list into the prompt and parses the reply back into OpenAI `tool_calls`. Accepted shapes:

- `{"tool_call":{"name":"...","arguments":{...}}}`
- `{"tool_calls":[{"name":"...","arguments":{...}}]}` — several independent calls, up to 8
- `TOOL_CALL:` plus a JSON object
- a fenced JSON envelope with `tool_call`, `tool_calls`, or `function_call`
- `<tool_call>...</tool_call>`
- DeepSeek DSML, including the doubled-bar Web variant

`execute_code` and `web_search` are DeepSeek's own tools. They are not run on your computer. If they appear next to a real local tool such as `read_file`, they are dropped and the local calls are kept. A half-written tool block is not executed. One repair retry asks for strict JSON. If that is still broken, the turn returns `502 malformed_tool_call` and the chat stays open.

While native search is on, harness `websearch`, `webfetch`, and `WebFetch` tools are stripped and the live web is the native chat.deepseek.com search. With search off they reach the agent unchanged.

### Images

PNG, JPEG, WebP, and GIF. Up to 10 images, 20 MiB decoded each. The JSON body defaults to 30 MiB.

The proxy uploads the image to DeepSeek Web, waits until parsing finishes, then sends the file id. A provider `file_id` is rejected. A URL must be public HTTPS. Redirects into local, private, or link-local addresses are rejected.

OpenAI Chat Completions uses `image_url`. Responses uses `input_image`. Anthropic uses an `image` block with base64. See [docs/api.md](docs/api.md).

---

## Models

`GET /v1/models` lists only DeepSeek-V4.1-Flash.

| ID | DeepThink | Native web search | What it does |
|---|---|---|---|
| `deepseek-v4-flash` | off | on | DeepSeek-V4.1-Flash. `deepseek-flash` is the same id |
| `deepseek-v4-flash-thinking` | on | on | DeepThink, then the answer |
| `deepseek-v4-flash-nosearch` | off | off | No native search |
| `deepseek-v4-flash-thinking-nosearch` | on | off | DeepThink without native search |

These suffixes are the two switches in the DeepSeek chat composer. They do not select another model. `"web_search": true|false` in the request body overrides the search switch of any id.

The old `deepseek-v4-flash-search` and `deepseek-v4-flash-thinking-search` ids still work. They mean `deepseek-v4-flash` and `deepseek-v4-flash-thinking` and are no longer listed in `/v1/models`.

Older ids are not registered and return `400 invalid_model`:

`deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-v3`, `deepseek-instant`, `deepseek-expert`, `deepseek-v4-pro`, `deepseek-chat-search`, and vision.

```bash
curl http://127.0.0.1:9655/v1/model-capabilities
```

Full table: [docs/models.md](docs/models.md).

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Process is up. Account status if no proxy key, or the bearer matches |
| `GET` | `/readyz` | `200` only if a login can serve now |
| `GET` | `/dashboard` | Account dashboard (static page) |
| `GET` | `/admin/accounts` | Pool and per-login status. See [Dashboard](#dashboard) |
| `POST` | `/admin/accounts/<id>/{disable,enable,clear-cooldown}` | Pause, resume, or un-cool one login |
| `POST` | `/admin/accounts/reload` | Re-read auth files without a restart |
| `GET` | `/v1/models` | The four DeepSeek-V4.1-Flash ids |
| `GET` | `/v1/model-capabilities` | Ids, DeepThink, and native search |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/responses` | OpenAI Responses |
| `GET` | `/v1/sessions` | Local agent sessions |
| `POST` | `/reset-session?agent=<id>` | Drop one Web chat |
| `POST` | `/reset-session?agent=all` | Drop every Web chat |

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. A non-loopback bind without a proxy key prints a warning |
| `PORT` | `9655` | Listen port |
| `PROXY_API_KEY` | off | Bearer required on `/v1/*` and `/admin/*` when set |
| `REQUIRE_PROXY_API_KEY` | off | Refuse to start if the key is missing. The container sets this |
| `PROXY_CORS_ORIGINS` | loopback | Extra exact browser origins |
| `PROXY_ADMIN_ALLOW_REMOTE` | off | If `1`, `/admin/*` answers non-loopback clients even without `PROXY_API_KEY` |
| `DEEPSEEK_AUTH_PATH` | `./deepseek-auth.json` | One file, or a comma-separated list |
| `DEEPSEEK_AUTH_DIR` | `./accounts` when that directory exists | Every `*.json` in it |
| `DEEPSEEK_MAX_PROMPT_CHARS` | `80000` | Cap on what is sent upstream. Minimum 16000 |
| `DEEPSEEK_MAX_RETRIES` | `2` | Empty-reply retries on the same chat |
| `DEEPSEEK_REQUEST_DEADLINE_MS` | `120000` | Per-request deadline |
| `DEEPSEEK_MAX_CONCURRENT` | `24` | Process-wide cap. Real parallelism is the number of idle logins |
| `DEEPSEEK_ACCOUNT_LOCK_WAIT_MS` | `120000` | How long a second chat waits for a busy login |
| `DEEPSEEK_ACCOUNT_COOLDOWN_MS` | `600000` | Cooldown after 401, 403, or a rate limit without `Retry-After` |
| `TRUST_PROXY` | off | If `1`, the client IP is taken from `X-Forwarded-For` |
| `MAX_REQUEST_BODY_BYTES` | `31457280` | Maximum JSON body, including base64 images |
| `NON_INTERACTIVE` / `SKIP_ACCOUNT_MENU` | off | Skip the launch menu |

---

## Errors

| Status | `error.type` | What to do |
|---|---|---|
| 400 | `invalid_model` | Use an id from `GET /v1/models` |
| 400 | `context_length_exceeded` | The prompt was still too long after compaction |
| 401 | `authentication_error` | The proxy key does not match |
| 403 | `admin_forbidden` | `/admin/*` without a key from a non-loopback or proxied client. See [Dashboard](#dashboard) |
| 429 | `concurrent_chat_blocked` | The wait for a busy login ran out. Add another login or retry |
| 429 | `rate_limit` | Every login is in cooldown (rate-limited or auth failure). Honor `Retry-After` |
| 429 | `rate_limit_error` | DeepSeek rate-limited the login and the request ran out of time or the client left before a failover finished. Honor `Retry-After` |
| 502 | `malformed_tool_call` | Tool markup was still broken after one repair. The chat was kept |
| 502 | `empty_response` | DeepSeek returned nothing after the retries |
| 503 | `overloaded` / `no_auth` | Too many in-flight requests, or no auth file |
| 504 | `request_timeout` | The deadline in `DEEPSEEK_REQUEST_DEADLINE_MS` was hit |

---

## Open WebUI

Base URL when Open WebUI runs in Docker on the same machine:

```text
http://host.docker.internal:9655/v1
```

Local, no Docker:

```text
http://127.0.0.1:9655/v1
```

If `PROXY_API_KEY` is unset, the API key field can be anything. If the key is set, the client must send that exact bearer. The proxy checks it before models, sessions, and completions.

Pick `deepseek-v4-flash` for a normal answer with native chat.deepseek.com search, `deepseek-v4-flash-thinking` for DeepThink, and a `-nosearch` id when you want an answer without search.

---

## Refresh the login

```bash
npm run auth
npm start
```

If DeepSeek answers `401` or `403`, or the PoW challenge fails, sign in again and replace `deepseek-auth.json`.

These paths stay out of git:

- `deepseek-auth.json`
- `accounts/*.json`
- Chrome profile directories used by the auth script
- `.env`

---

## Tests

Syntax and unit tests, no network:

```bash
npm test
```

Live smoke tests against a proxy that is already running:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-v4-flash npm run test:live
```

`npm test` runs `node --check` on the entry points and `node --test` on `tests/unit.test.js` and `tests/account-failover.test.js`. It does not call DeepSeek: the failover tests serve every upstream call from an in-process mock.

---

## Project status

FreeDeepseekAPI is a local Web-chat proxy. It depends on the current chat.deepseek.com contract. When that contract changes, auth or the request body may need an update.

If a call stops working:

1. Update to the newest version ([Updates](#updates)).
2. Refresh the login with `npm run auth`.
3. Run `npm run doctor`.
4. Read `GET /v1/model-capabilities` and use a DeepSeek-V4.1-Flash id.
5. If the same chat keeps failing, `POST /reset-session?agent=<id>` and try once more.
6. If it still fails, DeepSeek has likely changed the private Web API.

Security reports go to a private GitHub advisory, not a public issue. See [SECURITY.md](SECURITY.md). The maintainer list is [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Documentation

- [Authentication](docs/auth.md)
- [Agent setup](docs/agents.md)
- [Models](docs/models.md)
- [HTTP API](docs/api.md)

## Stars

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.svg" alt="Star history" width="800" />
</a>

## License

Apache-2.0. Copyright 2026 dekrezz.
