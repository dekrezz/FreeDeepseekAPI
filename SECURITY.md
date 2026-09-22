# Security policy

FreeDeepseekAPI is a local proxy. It keeps a DeepSeek Web login on your machine and exposes OpenAI and Anthropic endpoints on localhost. The default address is `http://127.0.0.1:9655`.

## Supported versions

Report problems against the latest commit on `main`. There is no separate long-term support line.

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

https://github.com/dekrezz/FreeDeepseekAPI/security/advisories/new

Do not open a public issue, pull request, or chat that contains any of these:

- `deepseek-auth.json`, or any file from `accounts/`
- a token, cookie, or `PROXY_API_KEY`
- a live DeepSeek session id

Include the commit (`git rev-parse --short HEAD`), the command you ran, and what you expected instead. A short request with the secrets removed is enough.

A valid report is answered on the advisory. The fix lands as a normal commit on `main`. The advisory is published after that fix is on `main`.

## What we want to hear about

- Auth files created or read with permissions looser than mode `600`
- A client off this machine reaching the API while the server is bound only to loopback
- `PROXY_API_KEY` ignored after it is set, or `REQUIRE_PROXY_API_KEY` failing open
- A token, cookie, or proxy key copied into logs, error JSON, or a response body
- One local client reading or continuing another account's DeepSeek session
- Path or header handling that escapes the account files you configured

## What this policy does not cover

- DeepSeek rate-limiting, closing, or banning a web account. This project talks to [chat.deepseek.com](https://chat.deepseek.com). That site can change or refuse a login.
- Binding `HOST` to `0.0.0.0` or any public address without `PROXY_API_KEY`. The server prints a warning. That is the configuration you chose.
- Putting an auth file into an issue, a chat, or a coding agent.
- The model following a prompt, or a coding agent using the local tools you enabled.

## Running it safely

- Leave the bind at `127.0.0.1` unless you mean to share the port.
- Keep `deepseek-auth.json` and `accounts/*.json` out of git. `npm run auth` writes them mode `600`.
- Set `PROXY_API_KEY` before the port is reachable past your own user.
- One DeepSeek login serves one chat at a time. A second client on that same login waits.
