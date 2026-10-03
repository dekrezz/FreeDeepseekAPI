# Dashboard API contract

This contract covers everything the dashboard at `/dashboard` calls. It is not served over HTTP; only `.js`, `.css` and `.svg` assets are.

## Common rules

- **Auth.** Send `Authorization: Bearer <PROXY_API_KEY>` when a key is set. The key lives in `sessionStorage['freedeepseek.proxyKey']`.
  - Without a key, `/admin/*` answers only direct loopback clients with a loopback `Host`. A browser `Origin` must equal `Host`.
  - A denied request gets `403 {error:{type:'admin_forbidden'}}`.
  - A missing or wrong key gets `401 {error:{type:'authentication_error'}}`.
  - A foreign browser origin gets `403 {error:{type:'cors_error'}}`. This happens when the page is opened over a LAN host and `PROXY_CORS_ORIGINS` is not set.
- **Fetch options.** Use `cache:'no-store'` and `credentials:'omit'`. The page is same-origin, so `PATCH`, `DELETE` and custom headers need no preflight.
- **Errors.** Every `/admin` error has the shape `{error:{message, type, ...extra}}`.
  - Show both `message` and `type`.
  - A wrong method returns `405 method_not_allowed` with an `Allow` header.
  - An unknown path returns `404 not_found`.
  - A bad query parameter returns `400 invalid_query`.
  - All responses send `Cache-Control: no-store`.
- **Estimates.** Token counts are estimates (characters / 4). USD uses one flat rate for every model, given in `pricing`. Label both "est." in the UI.
- **Memory only.** Stats live in memory and reset when the server restarts.
- **No content in logs.** No prompt or answer text is ever logged or returned by these routes. Error text is scrubbed of credentials and clipped to 300 characters.

## Static assets

- `/dashboard` and `/dashboard/` serve `index.html`.
- `/dashboard/<name>.(js|css|svg)` serves `public/dashboard/<name>.<ext>`.
  - `<name>` must match `[a-z0-9][a-z0-9-]*`: lowercase, with no dots, slashes or subfolders.
  - Anything else returns 404.
  - To add `chat.js`, `icons.svg` or similar, you do not need to edit `server.js`.
- CSP is unchanged: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:`.
  - Inline `<script>`, `<style>` and `style=""` are blocked. Setting styles through the CSSOM (`el.style.setProperty`) is allowed.
  - There is no `font-src`, so use system font stacks.
  - `blob:` images are blocked. Use `FileReader.readAsDataURL`.
- Add every new JS file to `test:syntax` in `package.json` (`node --check public/dashboard/<file>.js`).

---

## GET /admin/accounts

The response is unchanged:

```
{ now, pool:{ total, ready, busy, cooldown, disabled, no_credentials, can_serve, next_ready_at, next_ready_in_sec },
  accounts:[AccountView] }
```

`AccountView` has these fields:

```
{ id, name, email:string|null, status:'ready'|'busy'|'cooldown'|'disabled'|'no_credentials', enabled, disabled_by:'file'|'admin'|null,
  credentials:{ token:bool, cookie_count }, cooldown_until, cooldown_remaining_sec, cooldown_reason:'rate_limit'|'auth'|null,
  busy, busy_agent, busy_since, failures, total_failures,
  last_error:{ kind, status, message, at }|null, last_success_at, last_used_at,
  usage:{ requests, prompt_tokens, completion_tokens, usd } }   // usage = lifetime since server start
```

It never contains a token, cookie, `hif_*` value or file path. `email` is the optional `"email"` string from the auth file, or `null`.

## POST /admin/accounts/:id/disable | enable | clear-cooldown

These are unchanged. They are runtime only, and the effect is lost on restart. The response is `200 {account, pool}`.

Errors:
- `404 account_not_found`
- `409 disabled_in_file`: returned by `enable` when the file says `"enabled": false`. Use `PATCH` with `{enabled:true}` instead.

## POST /admin/accounts/reload

This is unchanged. It re-reads the auth files from disk.

- `200 {added[], removed[], kept[], errors:[{file, message}], accounts, pool}`
- `422 no_accounts_found {errors}`: the pool is left unchanged.

## POST /admin/accounts/import (new)

Adds a login. It writes `<accounts dir>/<id>.json` with mode 0600, then reloads the pool.

The request body is JSON and at most 64 KB:

```json
{ "name": "Work main",
  "auth": { "token": "…", "cookie": "ds_session_id=…; …", "hif_dliq": "…", "hif_leim": "…", "wasmUrl": "…" } }
```

- **`name`** (required): 1-64 characters after trimming.
  - The `id` is derived from it as lowercase `[a-z0-9._-]`, with other characters replaced by `-`. For example, `"Work main"` becomes `work-main`.
  - If a name has no Latin letters or digits, for example a Cyrillic name, the id becomes `account-N`.
- **`auth`** (required): the exact JSON produced by the Chrome extension ("DeepSeek Auth Exporter") or by `deepseek-auth.json`.
  - These aliases are also accepted: `access_token`/`accessToken`/`auth_token`, a `Bearer ` prefix on the token, and a `cookies` array export.
  - `wasmUrl` defaults to the DeepSeek value when missing.
  - The server never fills the token from its own environment.

`201` response:

```json
{ "account": AccountView, "added": ["work-main"], "removed": [], "errors": [], "accounts": [AccountView], "pool": {...} }
```

Errors:

| status | type | when |
|---|---|---|
| 400 | `invalid_json` | the body is not JSON |
| 413 | `payload_too_large` | the body is larger than 64 KB |
| 422 | `invalid_request` | `name` is missing, blank or longer than 64 characters, `auth` is not an object, or the body is not an object |
| 422 | `invalid_auth` | `error.errors`, for example `["cookie missing"]` or `["token missing"]` |
| 409 | `account_exists` | the id or file already exists (`error.account`) |
| 409 | `duplicate_account` | the same token is already loaded (`error.account` = existing id) |
| 409 | `import_unsupported` | the server uses an explicit `DEEPSEEK_AUTH_PATH=a,b` list, so there is no writable accounts directory |
| 500 | `auth_file_write_failed` / `import_not_loaded` | a filesystem problem. The message includes the errno code but no path. |

Notes:
- The reload also picks up any other changes made to the auth files.
- The credentials travel in the request body. Over a non-loopback, non-HTTPS origin they are exposed on the network, so show a warning in that case (`location.hostname` is not loopback and the protocol is `http:`).

## PATCH /admin/accounts/:id (new)

Renames an account and/or persists the enabled flag in its auth file. The file is written atomically, keeps mode 0600, and the pool is reloaded.

The body contains only these keys, and at least one of them:

```json
{ "name": "Personal", "enabled": false }
```

- `enabled:false` writes `"enabled": false`. The account becomes `status:'disabled'` with `disabled_by:'file'`, and this survives restarts.
- `enabled:true` removes the flag from the file and also lifts a runtime admin pause.
- The `id` does not change, because it comes from the file name.

The response is `200 {account, pool}`.

Errors:
- `404 account_not_found`
- `422 invalid_request`: an unknown field, an empty body, `enabled` that is not a boolean, or a bad name
- `400 invalid_json`
- `409 auth_file_unreadable`
- `500 auth_file_write_failed` / `reload_failed`

## DELETE /admin/accounts/:id (new)

Removes an account from the pool. The auth file is **archived, not destroyed**: it is renamed to `<id>.json.removed-<epoch ms>` in the same folder. The file keeps the credentials and stays at mode 0600. The pool is then reloaded.

The response is `200 {removed:[id], archived_as:'<id>.json.removed-1759…', errors, accounts, pool}`.

Errors:
- `404 account_not_found`
- `409 account_file_protected`: the file is not directly inside the managed accounts directory. For example, the root `deepseek-auth.json` or an explicit path list. The user must remove it by hand.
- `409 last_account`: it is the only loaded account.
- `422 no_accounts_found`: nothing else loads. The rename is rolled back.
- `500 auth_file_write_failed`

In the UI, say the login was removed from the pool and its file was kept as `archived_as`. Delete that file by hand to erase it.

Sessions pinned to a removed account move to another account on their next request.

## POST /admin/accounts/restore (new)

Undoes a `DELETE`. Body: `{archived_as}` exactly as the `DELETE` returned it. The file is renamed back to `<id>.json` and the pool is reloaded.

The response is `200 {restored:[id], errors, accounts, pool}`.

Errors:
- `422 invalid_request`: `archived_as` is not a bare `<file>.json.removed-<digits>` name.
- `404 archive_not_found`: no such archived file (for example, it was already restored).
- `409 restore_target_exists`: `<id>.json` exists again; the archive is left in place.
- `409 accounts_dir_unmanaged`: auth files come from an explicit path list.
- `422 restore_failed`: the file did not load as an account; it is archived again.
- `500 auth_file_write_failed`

The dashboard offers this as **Undo** on the removal toast.

---

## GET /admin/requests (new)

Returns recent requests to `/v1/chat/completions`, `/v1/messages` and `/v1/responses`, newest first. The buffer is in memory and holds at most 400 rows.

Query parameters (all optional):

| param | values |
|---|---|
| `limit` | 1-400, default 100 |
| `before_id` | integer; returns rows with `id < before_id` (paging) |
| `status` | `ok`, `error`, or a 3-digit HTTP code |
| `api` | `openai`, `anthropic` or `responses` |
| `account`, `model`, `agent` | exact match |

Response:

```json
{
  "now": 1759400000000,
  "capacity": 400,
  "total": 37,            // rows currently in the buffer
  "oldest_ts": 1759390000000,
  "matched": 12,          // rows matching the filters (before limit)
  "requests": [RequestView]
}
```

`RequestView`:

```json
{
  "id": 42,                          // increasing per server process; use it as the key and for before_id
  "ts": 1759399990000,               // request start, epoch ms
  "path": "/v1/chat/completions",
  "api": "openai",                   // openai | anthropic | responses
  "model": "deepseek-v4-flash-thinking",  // requested model (canonical), null if the body did not parse
  "account": "work-main",            // serving account; null when rejected before routing or answered locally
  "agent": "dashboard:9f2c…",        // x-agent-session | session | user | 'dev-agent' (loopback) | remote IP
  "ip": "127.0.0.1",
  "status": 200,                     // 499 = client disconnected
  "ok": true,
  "stream": true,                    // null when the body could not be parsed
  "local": false,                    // true: answered locally ("/new" reset or session-title request), no DeepSeek call
  "ms": 8123,
  "prompt_tokens": 120, "completion_tokens": 300, "reasoning_tokens": 180,  // est.; reasoning is included in completion
  "usd": 0.000224,                   // est.
  "error_type": null,                // e.g. rate_limit, rate_limit_error, no_auth, overloaded, request_timeout,
                                     // context_length_exceeded, invalid_model, unsupported_model,
                                     // malformed_tool_call, client_disconnected, server_error
  "error_message": null              // scrubbed, ≤300 chars
}
```

Errors: `400 invalid_query` (the message names the bad parameter), `405`.

Requests that are not logged:
- `503 overloaded` rejections
- `413` oversized bodies
- 404s
- `/v1/models`, `/health` and `/admin`

## GET /admin/usage (new)

Returns aggregates for a time window from per-minute buckets kept for 24 hours, plus lifetime totals since the server started.

Query parameters:

| param | values | default |
|---|---|---|
| `window` | `15m`, `1h`, `6h`, `24h` | `24h` |
| `bucket` | `1m`, `5m`, `15m`, `1h` (must not be larger than the window) | `15m`→`1m`, `1h`→`1m`, `6h`→`5m`, `24h`→`15m` |

Buckets are aligned to epoch multiples of the bucket size (UTC). The series is dense: empty buckets are zero. `totals` equals the sum of `series`.

Response:

```json
{
  "now": 1759400000000,
  "estimated": true,
  "pricing": { "input_per_m": 0.22, "output_per_m": 0.66, "currency": "USD" },
  "window": { "key": "24h", "ms": 86400000, "from": 1759314600000, "to": 1759400000000 },
  "bucket": { "key": "15m", "ms": 900000 },
  "retention_ms": 86400000,
  "totals": Counters,
  "by_account":  [ { "key": "work-main" | null, ...Counters } ],   // null = no account (rejected / local)
  "by_model":    [ { "key": "deepseek-v4-flash", ...Counters } ],
  "by_endpoint": [ { "key": "/v1/chat/completions", ...Counters } ],
  "by_agent":    [ { "key": "dashboard:…", ...Counters } ],          // per client / session id
  "series":      [ { "t": 1759314600000, ...Counters } ],            // length = window / bucket
  "lifetime": {
    "since": 1759300000000, ...Counters,
    "by_account": [ { "key": "work-main", "requests", "prompt_tokens", "completion_tokens", "usd" } ]
  }
}
```

```
Counters = { requests, ok, errors, prompt_tokens, completion_tokens, reasoning_tokens, usd, avg_ms }
```

- Breakdowns are sorted by `requests`, descending.
- Each dimension keeps at most 50 distinct keys per minute. Extra keys are folded into `"(other)"`.

Errors: `400 invalid_query`, `405`.

---

## Chat: existing routes, no change

All of these need the bearer key when one is set.

- **`GET /v1/models`** returns `{data:[{id, real_model, capabilities:{reasoning, web_search, files, vision}}]}`.
  - The ids are `deepseek-v4-flash`, `-thinking`, `-nosearch` and `-thinking-nosearch`. Search is on unless the id ends in `-nosearch`.
  - Build the Think and Search toggles from this list.
- **`POST /v1/chat/completions`** with `{model, stream:true, messages}` and the header `x-agent-session: dashboard:<conversationId>`. That session id is unique per conversation and shows up as `agent` in the logs and usage.
  - The client sends the full transcript every time. Send only user and assistant `content`; do not send reasoning back.
  - Do not send `tools`.
  - Never send a user message that is exactly `/new`.
  - The response streams SSE chunks as `delta.reasoning_content`, then `delta.content`, then `finish_reason:'stop'`, then a usage-only chunk (`choices:[]`), then `[DONE]`.
  - **The stream is not live.** The whole answer arrives in one burst after generation finishes, so show a pending state with elapsed time and a Stop button.
  - Request header `x-account-id: <id>` (optional) serves the request with that account only: `404 account_not_found`, `409 account_unavailable` (paused or no credentials) or `429 rate_limit` with `Retry-After` (cooling down) instead of failing over to another account.
  - Response headers: `x-account-id` names the serving account, and `X-FreeDeepseek-Context-Compacted: true` means the prompt was compacted.
  - Error JSON: `{error:{message, type}}`. For 429, honor `Retry-After`.
- **`POST /reset-session?agent=dashboard:<id>&history=drop`** must be called before you regenerate, edit, change the system prompt, or send the next message after a Stop. `history=drop` clears the server's copy so turns an edit replaced are not replayed.
  - The server keeps a sticky remote thread and sends only the turns after the last assistant message.
  - `404 {error:'No session for agent: …'}` means there was nothing to reset. That error is a bare string.
  - Never call `agent=all`.
- **`GET /v1/sessions`** returns `{agents:[{agent, session_id, message_count, account, history_size, age_min}], total}`.
- **`GET /health`** is public but returns more detail with the key. It includes `in_flight`, `chat_locks` and `models`.

Images: send `content:[{type:'text',text},{type:'image_url',image_url:{url:'data:image/png;base64,…'}}]`.
- Allowed types: png, jpeg, webp and gif.
- Limits: at most 10 images per request, 20 MB per image, and a 30 MB body.
