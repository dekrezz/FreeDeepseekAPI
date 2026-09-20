<div align="center">

# FreeDeepseekAPI

Local OpenAI / Anthropic / Responses proxy for [chat.deepseek.com](https://chat.deepseek.com).  
Web login, no paid API key. **2–3 accounts** for concurrent clients.

**English** · [Русский](README.ru.md) · [简体中文](README.zh.md)

<p>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers"><img src="https://img.shields.io/github/stars/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=3ee0c8&label=stars" alt="GitHub stars" /></a>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/network/members"><img src="https://img.shields.io/github/forks/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=7c6bff" alt="forks" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-3ee0c8?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/models-V4.1--Flash-7c6bff?style=for-the-badge" alt="models" />
  <img src="https://img.shields.io/badge/license-MIT-1b1638?style=for-the-badge" alt="license" />
</p>

<p>
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/models.md">Models</a> ·
  <a href="docs/agents.md">One-click agents</a> ·
  <a href="docs/auth.md">Auth</a> ·
  <a href="docs/api.md">API</a> ·
  <a href="https://t.me/forgetmeai">Telegram</a>
</p>

</div>

## Start

```bash
npm run auth
npm start
```

```bash
curl http://127.0.0.1:9655/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-agent-session: worker-a' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}'
```

Two clients at once: two Web logins in `accounts/`, each with its own `x-agent-session`. One login cannot send two chats in parallel.

## Models

Web is **DeepSeek-V4.1-Flash** only (Instant / Expert / Pro removed). [Table →](docs/models.md)

| ID | Web |
|---|---|
| [`deepseek-v4-flash`](docs/models.md) / `deepseek-flash` | V4.1-Flash |
| `deepseek-v4-pro` | same model (legacy alias) |
| `…-thinking` / `…-search` | DeepThink / Search |

## One-click agents

[How it works →](docs/agents.md)

```bash
npm run setup:agents
```

<table>
<tr>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>Claude Code</b><br/>Anthropic Messages</a></td>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>Codex</b><br/>Responses + images</a></td>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>OpenCode</b><br/>image attachments</a></td>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>Hermes</b><br/>custom provider</a></td>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>OpenClaw</b><br/>Chat Completions</a></td>
<td align="center"><a href="docs/agents.md#one-click-agent-setup"><b>Cursor</b><br/>OpenAI Base URL</a></td>
</tr>
</table>

Templates: [`integrations/`](integrations/).

## Docs

| Guide | |
|---|---|
| [Models](docs/models.md) | V4.1-Flash IDs |
| [Agents](docs/agents.md) | one-click wiring |
| [HTTP API](docs/api.md) | completions, pool, `429`, env |
| [Auth](docs/auth.md) | 1–3 Web logins |

## Docker

```bash
podman build -t free-deepseek-api -f Containerfile .
podman run --rm \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,type=mount,target=/run/secrets/deepseek-auth.json,mode=0400 \
  --secret free-deepseek-proxy-key,type=mount,target=/run/secrets/proxy-api-key,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  free-deepseek-api
```

## Stars

<p>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers"><img src="https://img.shields.io/github/stars/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=3ee0c8&label=stars" alt="GitHub stars" /></a>
</p>

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.png" alt="Star history" width="800" />
</a>
