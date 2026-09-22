# HTTP API

Local OpenAI / Anthropic / Responses proxy. Default: `http://127.0.0.1:9655`.

This is a **Web-session** API, not `api.deepseek.com`. One DeepSeek login can serve **one in-flight chat**. Put 2–3 logins in the pool so concurrent clients fan out.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | Liveness. Account list if no `PROXY_API_KEY` or Bearer matches |
| GET | `/readyz` | public | `200` only if at least one account can serve now |
| GET | `/v1/models` | proxy key if set | OpenAI model list |
| GET | `/v1/model-capabilities` | proxy key if set | DeepSeek-V4.1-Flash IDs. `-thinking` is DeepThink. `-search` is native chat.deepseek.com search |
| GET | `/v1/sessions` | proxy key if set | Sticky agent sessions |
| POST | `/v1/chat/completions` | proxy key if set | OpenAI Chat Completions (`stream` true\|false) |
| POST | `/v1/messages` | proxy key if set | Anthropic Messages |
| POST | `/v1/responses` | proxy key if set | OpenAI Responses |
| POST | `/reset-session?agent=<id\|all>` | proxy key if set | Drop a sticky Web chat |

## Completions

```bash
curl -sS http://127.0.0.1:9655/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-agent-session: worker-a' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}'
```

| Header / field | Effect |
|---|---|
| `x-agent-session` or `user` | Sticky DeepSeek chat. **Give each concurrent client a different value** |
| `Authorization: Bearer` | Required when `PROXY_API_KEY` / `REQUIRE_PROXY_API_KEY` is set |
| `model` | `deepseek-v4-flash` / `deepseek-flash` (DeepSeek-V4.1-Flash). `-thinking` enables DeepThink. `-search` enables native chat.deepseek.com web search. `-thinking-search` enables both |
| `stream` | SSE chunks; last chunk includes `usage` |
| `x-account-id` (response) | Which Web login served the request |

Loopback clients without `x-agent-session` share `dev-agent`. Overlapping real chats on one login wait in a per-account queue (`DEEPSEEK_ACCOUNT_LOCK_WAIT_MS`, default matches the request deadline). OpenCode session-title completions are answered locally and do not occupy the login.

On a live sticky Web chat the proxy sends the system prompt and tool list **once**. Later OpenCode / Claude Code / Codex turns omit that system blob and replayed history; only the new user/tool turn goes upstream. A changed system prompt is sent again. Remote session reset (TTL, `/new`, empty-response retry) sends the full prompt.

OpenCode's bundled prompt is kept, but token-economy / "ask first" lines are rewritten for DeepSeek Web: finish the task autonomously and do not ask clarifying questions. `npm run setup:agents -- --target opencode` writes the same rule to `~/.config/opencode/AGENTS.md`.

## Image input

The proxy uploads images to DeepSeek Web first, waits for parsing to finish, then sends the returned IDs in `ref_file_ids`. Supported formats are PNG, JPEG, WebP, and GIF. Up to 10 images and 20 MiB decoded bytes per image are accepted; the JSON request body defaults to 30 MiB (`MAX_REQUEST_BODY_BYTES`).

OpenAI Chat Completions:

```json
{
  "model": "deepseek-v4-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBOR..." } }
    ]
  }]
}
```

OpenAI Responses (used by Codex):

```json
{
  "model": "deepseek-v4-flash",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Describe this image" },
      { "type": "input_image", "image_url": "data:image/png;base64,iVBOR..." }
    ]
  }]
}
```

Anthropic Messages (used by Claude Code):

```json
{
  "model": "deepseek-v4-flash",
  "max_tokens": 1024,
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR..." } },
      { "type": "text", "text": "Describe this image" }
    ]
  }]
}
```

Base64 data URLs and public HTTPS URLs are supported. Provider `file_id` references are rejected because this proxy does not implement OpenAI/Anthropic Files APIs. URL fetching rejects redirects to local, private, link-local, and documentation-only IP ranges.

## Concurrency and account pool

DeepSeek issues a multi-day ban if two chats send on the **same** Web login at once.

| Situation | Behavior |
|---|---|
| Two requests, two free accounts | Routed to different logins |
| Same `x-agent-session` overlapping | Queued on that login until the in-flight chat finishes |
| All logins busy | Queued on the sticky/LRU login |
| OpenCode session-title request | Local short title; DeepSeek is not called |
| Account 401/403/429 | Cooldown, next request uses another ready login |
| Global flood | `503 overloaded` when `in_flight` ≥ `DEEPSEEK_MAX_CONCURRENT` (default 24) |

Pool files (mode `600`, never commit):

```text
deepseek-auth.json          # first login (npm run auth / auth:import)
accounts/worker-2.json     # second `npm run auth:import`
accounts/worker-3.json
```

Or:

```bash
export DEEPSEEK_AUTH_DIR=./accounts
# or
export DEEPSEEK_AUTH_PATH="$PWD/a.json,$PWD/b.json,$PWD/c.json"
NON_INTERACTIVE=1 npm start
```

Import a second file without replacing the first:

```bash
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
```

Then restart so the pool reloads.

## Errors

| Status | `error.type` | What to do |
|---|---|---|
| 400 | `invalid_model` | Use an id from `GET /v1/models` |
| 401 | `authentication_error` | Proxy key |
| 429 | `concurrent_chat_blocked` | Wait exceeded `DEEPSEEK_ACCOUNT_LOCK_WAIT_MS`; add another login or retry |
| 429 | `rate_limit` | All logins in cooldown; honor `Retry-After` |
| 503 | `overloaded` / `no_auth` | Backpressure, or no `deepseek-auth.json` |
| 504 | `request_timeout` | `DEEPSEEK_REQUEST_DEADLINE_MS` (default 120000) |

## Env

| Env | Default | |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `9655` | Bind. Non-loopback without a proxy key prints a warning |
| `PROXY_API_KEY` / `REQUIRE_PROXY_API_KEY` | off | Protects `/v1/*` |
| `DEEPSEEK_AUTH_PATH` | `./deepseek-auth.json` | One file, or comma-separated list |
| `DEEPSEEK_AUTH_DIR` | `./accounts` if present | All `*.json` in that directory |
| `DEEPSEEK_MAX_CONCURRENT` | `24` | Process-wide cap. Real parallelism is **number of idle logins** |
| `DEEPSEEK_ACCOUNT_LOCK_WAIT_MS` | `120000` | How long a second chat waits for a busy login |
| `DEEPSEEK_ACCOUNT_COOLDOWN_MS` | `600000` | After 401/403/429 |
| `TRUST_PROXY` | off | If `1`, client IP uses `X-Forwarded-For` |
| `MAX_REQUEST_BODY_BYTES` | `31457280` | Maximum JSON body size, including base64 images |

Docker: [`Containerfile`](../Containerfile). Auth: [`auth.md`](auth.md). Models: [`models.md`](models.md).
