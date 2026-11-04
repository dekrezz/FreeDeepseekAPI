<p align="center">
  <img src="docs/assets/logo.png" alt="FreeDeepseekAPI" width="160" />
</p>

<h1 align="center">FreeDeepseekAPI</h1>

<p align="center">
  <strong>Use your free DeepSeek account as an API</strong>
</p>

<p align="center">
  <a href="https://github.com/dekrezz/FreeDeepseekAPI/blob/main/LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

FreeDeepseekAPI runs on your computer and turns your free [chat.deepseek.com](https://chat.deepseek.com) account into a local API. Any app that works with OpenAI or Anthropic can talk to DeepSeek through it: Open WebUI, Claude Code, Codex, Cursor and others. You don't need a paid API key.

## Get started

You need [Node.js](https://nodejs.org) 18 or newer, Git, Google Chrome and a DeepSeek account.

```bash
git clone --branch stable https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm run dashboard
```

1. `npm run auth` opens Chrome. Pick **Sign in with Chrome**, log in to DeepSeek, send a short message like `ok`, then go back to the terminal.
2. `npm run dashboard` starts the proxy and opens the dashboard. You can chat right there.

## Connect an app

Put this in your app's settings:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:9655/v1` |
| API key | any text |
| Model | `deepseek-v4-flash` |

Open WebUI in Docker needs `http://host.docker.internal:9655/v1` instead.

## Set up coding agents

Keep the proxy running and run:

```bash
npm run setup:agents
```

It adds DeepSeek to Claude Code, Codex, OpenCode, Hermes, OpenClaw and Cursor as an extra option. Your current setup stays as it is, and you can skip this step in the wizard. The same thing is in the dashboard: Settings → Agents.

## FAQ

<details>
<summary><strong>Is it really free?</strong></summary>

Yes. It uses the same free account you use on the DeepSeek site.

</details>

<details>
<summary><strong>Is this an official DeepSeek project?</strong></summary>

No. It talks to DeepSeek's private web chat, which can change at any time. When that happens, the project gets updated to follow.

</details>

<details>
<summary><strong>Can my account get banned?</strong></summary>

It can happen. DeepSeek can block a login for days if two chats send on it at the same time, so the proxy runs one chat per login and makes the next one wait. That lowers the risk but can't remove it. DeepSeek decides what it allows.

</details>

<details>
<summary><strong>Where do my login and messages go?</strong></summary>

Your login stays on your computer in `deepseek-auth.json`. Your messages go to DeepSeek, the same as in the normal chat.

</details>

<details>
<summary><strong>Which model should I pick?</strong></summary>

There is one model with two switches:

| Model | What it does |
|---|---|
| `deepseek-v4-flash` | Answers with web search |
| `deepseek-v4-flash-thinking` | Thinks first, then answers |

Add `-nosearch` to either one to turn web search off.

</details>

<details>
<summary><strong>Can I use several accounts?</strong></summary>

Yes. Add them in the dashboard under Settings → Accounts. Running two agents at once needs two logins.

</details>

<details>
<summary><strong>It stopped working. What do I do?</strong></summary>

Try these in order:
1. Update: Settings → Updates in the dashboard.
2. Log in again: `npm run auth`.
3. Check your setup: `npm run doctor`.

If that doesn't help, DeepSeek has probably changed something. [Open an issue](https://github.com/dekrezz/FreeDeepseekAPI/issues).

</details>

<details>
<summary><strong>How do I update?</strong></summary>

Open Settings → Updates in the dashboard and press **Check for updates**. `stable` gets a release once it has been checked. `latest` gets every release first.

</details>

<details>
<summary><strong>Can other devices use it?</strong></summary>

By default only your computer can reach it. To share it, set `PROXY_API_KEY` and read [Running it safely](SECURITY.md#running-it-safely) first.

</details>

<details>
<summary><strong>Does it work on Windows, a server or in a container?</strong></summary>

Yes: [Windows](docs/guide.md#windows), [VPS](docs/guide.md#vps--headless), [Podman](docs/guide.md#rootless-podman).

</details>

## More

- [Full guide](docs/guide.md): everything in detail, with request examples
- [HTTP API](docs/api.md): endpoints, errors and settings
- [Models](docs/models.md) · [Accounts and login](docs/auth.md) · [Coding agents](docs/agents.md)
- [Security](SECURITY.md): how to report a vulnerability

## License

Apache-2.0. Copyright 2026 dekrezz.
