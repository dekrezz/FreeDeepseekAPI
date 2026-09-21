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
  <a href="docs/zh/auth.md">鉴权</a>
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

## 多个账号

一个 DeepSeek Web 登录不能同时跑两个聊天。两个 Agent 或两个 OpenCode 会话，把 2–3 个文件放进 `accounts/`，并给每个客户端不同的 `x-agent-session`：

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
```

代理自己选用空闲登录。不能把某个账号绑到某个客户端。同一登录上的第二个聊天会排队等待。详见[鉴权](docs/zh/auth.md)。

## 文档

| 指南 | |
|---|---|
| [模型](docs/zh/models.md) | V4.1-Flash |
| [Agent](docs/zh/agents.md) | 一键配置 |
| [鉴权](docs/zh/auth.md) | 多个 Web 登录 |
| [HTTP API](docs/api.md) | 账号池、排队、环境变量 |

## Star 趋势

<p>
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers"><img src="https://img.shields.io/github/stars/dekrezz/FreeDeepseekAPI?style=for-the-badge&logo=github&color=3ee0c8&label=stars" alt="GitHub stars" /></a>
</p>

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.png" alt="Star history" width="800" />
</a>
