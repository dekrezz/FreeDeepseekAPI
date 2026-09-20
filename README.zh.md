<div align="center">

# FreeDeepseekAPI

面向 [chat.deepseek.com](https://chat.deepseek.com) 的本地 OpenAI / Anthropic / Responses 代理。  
使用 Web 登录，无需付费 API Key。**2–3 个账号**并发。

[English](README.md) · [Русский](README.ru.md) · **简体中文**

<p>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers"><img src="https://img.shields.io/github/stars/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=3ee0c8&label=stars" alt="GitHub stars" /></a>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/network/members"><img src="https://img.shields.io/github/forks/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=7c6bff" alt="forks" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-3ee0c8?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/models-V4.1--Flash-7c6bff?style=for-the-badge" alt="models" />
</p>

<p>
  <a href="docs/zh/README.md">文档</a> ·
  <a href="docs/zh/models.md">模型</a> ·
  <a href="docs/zh/agents.md">Agent</a> ·
  <a href="docs/auth.md">鉴权</a> ·
  <a href="https://t.me/forgetmeai">Telegram</a>
</p>

</div>

## 开始

```bash
npm run auth
npm start
```

```bash
curl http://127.0.0.1:9655/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}'
```

## 模型

Web 仅 **DeepSeek-V4.1-Flash**（Instant / Expert / Pro 已移除）。[完整表 →](docs/zh/models.md)

| ID | Web |
|---|---|
| [`deepseek-v4-flash`](docs/zh/models.md) / `deepseek-flash` | V4.1-Flash |
| `deepseek-v4-pro` | 同一模型（旧别名） |
| `…-thinking` / `…-search` | DeepThink / Search |

## 一键接入 Agent

[原理 →](docs/zh/agents.md)

```bash
npm run setup:agents
```

<table>
<tr>
<td align="center"><a href="docs/zh/agents.md"><b>Claude Code</b></a></td>
<td align="center"><a href="docs/zh/agents.md"><b>Codex</b></a></td>
<td align="center"><a href="docs/zh/agents.md"><b>OpenCode</b></a></td>
<td align="center"><a href="docs/zh/agents.md"><b>Hermes</b></a></td>
<td align="center"><a href="docs/zh/agents.md"><b>OpenClaw</b></a></td>
<td align="center"><a href="docs/zh/agents.md"><b>Cursor</b></a></td>
</tr>
</table>

模板：[`integrations/`](integrations/)。

## 文档

| 指南 | |
|---|---|
| [模型](docs/zh/models.md) | V4.1-Flash |
| [Agent](docs/zh/agents.md) | 一键配置 |
| [鉴权](docs/auth.md) | `deepseek-auth.json` |
| [HTTP API](docs/api.md) | 接口 |

## Star 趋势

<p>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers"><img src="https://img.shields.io/github/stars/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=3ee0c8&label=stars" alt="GitHub stars" /></a>
</p>

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.png" alt="Star history" width="800" />
</a>
