<p align="center">
  <img src="docs/assets/logo.svg" alt="FreeDeepseekAPI" width="128" />
</p>

<h1 align="center">FreeDeepseekAPI</h1>

<p align="center">
  <strong>面向 DeepSeek Web Chat 的本地 OpenAI 兼容 API 代理</strong>
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
  <a href="README.ru.md">Русский</a> ·
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#能做什么">能做什么</a> •
  <a href="#请求示例">示例</a> •
  <a href="#模型">模型</a> •
  <a href="#endpoints">Endpoints</a> •
  <a href="#open-webui">Open WebUI</a> •
  <a href="#编程代理">编程代理</a>
</p>

FreeDeepseekAPI 在本机启动一个 API 服务，后端是 **DeepSeek Web Chat**（[chat.deepseek.com](https://chat.deepseek.com)）。Open WebUI、LiteLLM、Hermes、Claude Code、Codex、OpenCode、OpenClaw、Cursor，以及任何 OpenAI 兼容客户端都可以连上来。

它使用你已经登录的 DeepSeek 账号。本地服务接收 API 请求，再沿着保存好的 Web 会话继续聊。不需要 `api.deepseek.com` 的付费密钥。

网站上现在只有一个模型：**DeepSeek-V4.1-Flash**。`-thinking` 打开 DeepThink。`-search` 打开 chat.deepseek.com 自带的网页搜索，上网查资料走的就是这个搜索。

> 这是实验性的网页聊天代理。DeepSeek 可能不打招呼就改掉内部 Web API。生产环境更稳妥的是官方付费 API。

---

## 目录

- [能做什么](#能做什么)
- [功能](#功能)
- [快速开始](#快速开始)
- [Windows](#windows)
- [Linux / Chromium](#linux--chromium)
- [VPS / 无界面](#vps--无界面)
- [Rootless Podman](#rootless-podman)
- [Diagnostics / doctor](#diagnostics--doctor)
- [会话复用](#会话复用)
- [多账号池](#多账号池)
- [登录](#登录)
- [编程代理](#编程代理)
- [检查是否正常](#检查是否正常)
- [请求示例](#请求示例)
  - [Chat Completions](#chat-completions)
  - [DeepThink](#deepthink)
  - [自带网页搜索](#自带网页搜索)
  - [Streaming](#streaming)
  - [Anthropic Messages](#anthropic-messages)
  - [OpenAI Responses](#openai-responses)
  - [工具调用](#工具调用)
  - [图片](#图片)
- [模型](#模型)
- [Endpoints](#endpoints)
- [环境变量](#环境变量)
- [错误](#错误)
- [Open WebUI](#open-webui)
- [重新登录](#重新登录)
- [测试](#测试)
- [项目状态](#项目状态)

---

## 能做什么

- 把 DeepSeek Web 当成一个本地 API。
- 接到 Open WebUI 和其他 OpenAI 兼容客户端。
- 返回普通 JSON，或者 SSE 流。
- 用 `-thinking` 打开 DeepThink，并从 `reasoning_content` 读出推理。
- 用 Anthropic Messages 接 Claude Code。
- 用 OpenAI Responses 接 Codex。
- 每个代理或 `user` 各用一个独立的 Web 会话。
- 一次回复里交出最多八个本地工具调用。
- 上网用 DeepSeek 自己的搜索，不用 bash，也不用 harness 的 websearch。

## 功能

- **OpenAI 兼容 API：** `POST /v1/chat/completions`
- **Anthropic 兼容垫片：** `POST /v1/messages`
- **OpenAI Responses 垫片：** `POST /v1/responses`
- **流式输出：** SSE，以及非流式 JSON
- **DeepThink：** 选了 `-thinking` 时返回 `reasoning_content`
- **自带搜索：** `-search` 打开 chat.deepseek.com 的 Web Search；编程代理带了本地工具时也会打开
- **工具调用：** OpenAI、Anthropic 和 Responses 的工具，可以一批一起返回
- **模型能力：** `GET /v1/model-capabilities`
- **代理会话：** 一个 `x-agent-session` 或 `user` 对应一个 DeepSeek 聊天
- **会话恢复：** 空回复、坏掉的工具调用和超时都留在原来的聊天里
- **零依赖：** Node.js 18+，没有 npm 包
- **许可证：** Apache-2.0

---

## 快速开始

```bash
git clone https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` 打开登录菜单。选 Chrome 登录，在弹出的独立配置里登录 chat.deepseek.com，发一条很短的消息，比如 `ok`，再回到终端。文件会写成 `deepseek-auth.json`，权限是 `0600`。

`npm start` 打开启动菜单：

- 启动代理
- 用 Chrome 登录
- 导入 auth 文件或浏览器 cookie 导出
- 列出 DeepSeek-V4.1-Flash 的模型 id
- 退出

无菜单，适合无界面和 CI：

```bash
NON_INTERACTIVE=1 npm start
# 或
SKIP_ACCOUNT_MENU=1 npm start
```

服务监听：

```text
http://127.0.0.1:9655
```

默认只接受本机连接。要暴露到网络，必须同时指定地址和单独的代理密钥：

```bash
HOST=0.0.0.0 PROXY_API_KEY='replace-with-a-long-random-value' npm start
```

密钥用 `Authorization: Bearer <key>` 传递。没有 `PROXY_API_KEY` 时，API 自己不鉴权。不要把这种实例放到网上。

浏览器请求默认允许来自 loopback origin。界面开在别的地址时，把精确 origin 用逗号列出来：

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

Chrome 不在默认路径时：

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

找不到 Chrome 时，`npm run auth` 会打印 Windows、macOS 和 Linux 上该装到哪里，而不是一长串原始堆栈。

---

## Linux / Chromium

```bash
git clone https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

二进制名字不一样时：

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# 或
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## VPS / 无界面

更稳的做法是不在服务器上开 Chrome。

1. 在有图形界面和 Chrome 的机器上：

```bash
npm run auth
```

2. 把 `deepseek-auth.json` 拷到 VPS：

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. 导入并检查：

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. 不带菜单启动代理：

```bash
NON_INTERACTIVE=1 npm start
```

浏览器导出的 cookie 也可以，但必须同时带上 token：

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

`deepseek-auth.json` 就是你的 DeepSeek Web 登录。不要提交，不要贴进聊天，权限保持 `0600`。

没有密码登录命令。代理不问 DeepSeek 密码，也不会把密码写到磁盘。登录方式只有 Chrome、现成的 auth 文件，或者 cookie 导出加上 token。

---

## Rootless Podman

容器只负责跑代理。登录在宿主机上用 `npm run auth` 完成。登录脚本和 `deepseek-auth.json` 不会打进镜像。

用普通用户跑 Podman，不要 root。

1. 构建镜像：

```bash
podman build --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. 把 DeepSeek 登录和单独的代理密钥放进 secrets：

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

密钥要长、要随机。这个 shell 里会留下变量，方便你随后调用 API。它不会进镜像，也不会出现在 Podman 命令行里。

3. 用最小权限启动容器：

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

镜像里已经设了 `NON_INTERACTIVE=1`、`HOST=0.0.0.0` 和 `REQUIRE_PROXY_API_KEY=1`。没有密钥 secret 时，容器不会开始对外服务。宿主机只把端口发布到 `127.0.0.1`。前面没有防火墙时，不要拿掉这个地址。

4. 检查进程、登录是否就绪，以及模型列表是否被密钥保护：

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

内置 healthcheck 只打本地 `/health`，只说明进程还在。`/readyz` 在没有任何 DeepSeek 登录能接聊天时返回 `503`。

```bash
podman logs free-deepseek-api
podman inspect --format '{{.State.Health.Status}}' free-deepseek-api
```

停掉容器并删掉 secrets：

```bash
podman stop free-deepseek-api
podman rm free-deepseek-api
podman secret rm free-deepseek-auth free-deepseek-proxy-key
unset PROXY_API_KEY
```

轮换登录或代理密钥时，换掉对应 secret，再重建容器。

---

## Diagnostics / doctor

```bash
npm run doctor
# 不向 DeepSeek 发网络请求：
npm run doctor -- --offline
```

`doctor` 检查：

- 是否存在 `deepseek-auth.json` 或 `DEEPSEEK_AUTH_DIR`；
- JSON 是否能解析；
- 是否有 `token`、`cookie` 和 `wasmUrl`；
- macOS 和 Linux 上权限是否为 `0600`；
- 普通运行时，DeepSeek 的 PoW 端点是否还能用。

看到 `data.biz_data is null`、`fetch failed`、`401`、`403`、`429`，或者代理看不到模型时，先跑 `npm run doctor`。

---

## 会话复用

FreeDeepseekAPI 不会为每一个 HTTP 请求新开一个 DeepSeek 聊天。

- 同一个 `x-agent-session`、`session` 或 `user` 对应同一个 DeepSeek 聊天。
- 已经有会话时，代理用 `parent_message_id` 接着往下写。
- 固定的 system prompt 和工具列表只向上游发 **一次**。之后 OpenCode、Claude Code 和 Codex 只发新的用户回合或工具结果。
- system prompt 变了会再发一次。
- 空回复、坏掉的工具调用和超时 **留在** 当前聊天。以前这种情况会新开一个聊天，再把整段提示重新发出去。现在不会。
- 只有这些情况才开新聊天：还没有会话、链到了 100 条消息、聊天超过 2 小时、DeepSeek 说提示太长，或者你调用了 `/reset-session`。
- 发出去之前，长提示会被裁到 `DEEPSEEK_MAX_PROMPT_CHARS`（默认 80 000 个字符）。任务开头、最新的工具结果和工具提醒会留下来。
- 客户端已经带了多轮历史时，代理不会再把自己的恢复历史贴一遍。
- 空回复最多重试 `DEEPSEEK_MAX_RETRIES` 次（默认 2）。每次重试都用更短的上下文；聊天还在的话，就继续留在里面。

显式指定代理：

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

查看当前会话：

```bash
curl http://127.0.0.1:9655/v1/sessions
```

重置一个：

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=my-agent"
```

全部重置：

```bash
curl -X POST "http://127.0.0.1:9655/reset-session?agent=all"
```

DeepSeek 网站上仍然能看到这些聊天。代理走的是 Web Chat API，聊天本身存在 DeepSeek 那边。会话复用只是在当前链还能用的时候，不再另开一个。

正文恰好是 `/new` 的消息会重置这个代理的远程聊天，并且不会发给模型。

---

## 多账号池

同一个登录上如果有两个聊天同时发出请求，DeepSeek 可能会把这个登录封几天。池的规则是：每个登录同一时刻只跑一个聊天。第二个请求会等，不会叠上去。

Sticky 的意思是：活着的聊天中间，代理不会换账号。登录收到 `401`、`403` 或 `429` 并进入冷却后，下一次请求可以换到另一个可用登录，旧的远程会话会先被清掉。

用一个目录放 auth 文件：

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
chmod 600 accounts/*.json deepseek-auth.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

或者用逗号分隔的文件列表：

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

池怎么工作：

- 新代理按轮转拿到一个空闲登录；
- 这个登录会粘在该会话上；
- `401`、`403` 和 `429` 让登录进入冷却（`DEEPSEEK_ACCOUNT_COOLDOWN_MS`，默认 10 分钟）；
- 两个请求、两个空闲登录时，会分到不同账号；
- 同一个 `x-agent-session` 重叠时，会等自己的登录（`DEEPSEEK_ACCOUNT_LOCK_WAIT_MS`，默认 120 秒）；
- 所有登录都忙时，请求等待 sticky 的那个，或者最久没用的那个；
- OpenCode 的会话头请求在本地回答，不占用登录；
- `/health` 展示账号状态，但不给出 auth 文件路径和文件名；
- auth 文件权限应为 `0600`。

不能把某个客户端钉死到某个文件。代理自己挑空闲登录。

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## 登录

| 命令 | 作用 |
|---|---|
| `npm run auth` | 菜单：Chrome、导入、状态、删除本地文件 |
| `npm run deepseek:auth` | 用 Chrome 抓取 token 和 cookies |
| `npm run auth:import` | 导入 `deepseek-auth.json` 或 cookie 导出 |
| `npm run doctor` | 检查文件。不加 `--offline` 还会探测 PoW |

Chrome 扩展：把 `chrome-extension/` 加载到已经打开的 chat.deepseek.com 标签页。等到 **Token** 变成 Ready 再保存。不要把这份 JSON 贴进聊天。

字段：`token`、`cookie`、`wasmUrl`。可选：`hif_dliq`、`hif_leim`、`name`，以及 `enabled`（`false` 会暂停这个登录）。示例见 [`auth.example.json`](auth.example.json)。

这里没有 DeepSeek 账号密码。没有 `auth:console`，也不需要把密码写到磁盘。

---

## 编程代理

```bash
npm run setup:agents
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
npm run setup:agents -- --target codex --model deepseek-v4-flash
```

代理需要已经在听端口。默认地址是 `http://127.0.0.1:9655`。换地址用 `--base-url`。如果设了 `PROXY_API_KEY`，它会被写进代理配置。

安装只是把 FreeDeepseekAPI 加成分开的配置。它不会替换你现在用的 Claude、GPT 或其他登录。

| 代理 | 写入位置 | 怎么选 |
|---|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json` | `claude --settings ~/.claude/freedeepseek.settings.json` |
| Codex | `~/.codex/freedeepseek.config.toml` 和模型目录 | `codex --profile freedeepseek` |
| OpenCode | `freedeepseek` 提供方，以及 `AGENTS.md` 里的自主规则 | 选 `freedeepseek/<id>` |
| Hermes | `~/.hermes/freedeepseek.yaml` | 使用这个配置文件 |
| OpenClaw | `freedeepseek` 提供方 | 显式选择 |
| Cursor | `integrations/cursor/` 里的片段和启动脚本 | 不改编辑器设置 |

`--model` 始终是 DeepSeek-V4.1-Flash。`-thinking` 打开 DeepThink。`-search` 打开 chat.deepseek.com 的自带搜索。请求里带了本地工具时，即使没有 `-search` 后缀也会打开这个搜索。DeepThink 仍按模型 id 决定。

Codex 的安装 **不会** 写入 `forced_login_method = api`。在 Codex CLI 里，这一行会把你登出 ChatGPT。普通的 `codex` 仍然走 ChatGPT。FreeDeepseek 这个配置才跟本代理说话。

图片：

- Claude Code：粘贴或附加。Anthropic 的 `image` 块会送到 DeepSeek Web。
- Codex：`codex -i screenshot.png`。多张图就多写几个 `-i`。`/v1/responses` 接受 `input_image`。
- OpenCode：粘贴或拖入图片。生成的配置不会丢掉它。
- 其他 OpenAI 客户端：`image_url` 用 base64 data URL 或公开的 HTTPS URL。

从备份恢复：

```bash
node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/<stamp>
```

两个代理同时跑，需要 `accounts/` 里有两个 Web 登录。细节见 [docs/zh/agents.md](docs/zh/agents.md)。

---

## 检查是否正常

```bash
curl http://127.0.0.1:9655/health
curl http://127.0.0.1:9655/readyz
curl http://127.0.0.1:9655/v1/models
curl http://127.0.0.1:9655/v1/model-capabilities
```

`/health` 说明进程还在。`/readyz` 只有在至少一个登录能接请求时才是 `200`。`/v1/models` 返回四个 DeepSeek-V4.1-Flash id。

---

## 请求示例

### Chat Completions

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "用一句话回答。"}],
    "stream": false
  }'
```

### DeepThink

`-thinking` 是聊天输入框里的 DeepThink 开关。模型还是 DeepSeek-V4.1-Flash。它会先推理再回答。

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking",
    "messages": [{"role": "user", "content": "天空为什么是蓝的？简短一点。"}],
    "stream": false
  }'
```

推理放在哪里：

- 非流式：`choices[0].message.reasoning_content`
- 流式：`choices[0].delta.reasoning_content`
- 用量：`usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` 是按抽出来的 DeepThink 文本估算的。网页流不会单独给出官方的推理 token 用量。

带工具调用的回合不会把推理贴到那条消息上。有些代理把工具调用旁边的任何文字都当成最终答案，然后停下来。

### 自带网页搜索

`-search` 打开 chat.deepseek.com 的原生 Web Search。网上的问题走这个搜索。不要让模型去用 bash、curl，或者 harness 的 `websearch` / `webfetch`。

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-search",
    "messages": [{"role": "user", "content": "找一条关于 DeepSeek 的最新事实，简短回答。"}],
    "stream": false
  }'
```

两个开关一起开：

```bash
curl -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-thinking-search",
    "messages": [{"role": "user", "content": "这周 DeepSeek 网站上有什么变化？"}],
    "stream": false
  }'
```

请求里有本地工具时，即使模型是普通的 `deepseek-v4-flash`，原生搜索也会打开。id 里没有 `-thinking` 时，DeepThink 仍然是关的。

### Streaming

```bash
curl -N -X POST http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "讲一个短笑话。"}],
    "stream": true
  }'
```

最后一个 SSE 块带 `usage`，然后是 `data: [DONE]`。

### Anthropic Messages

```bash
curl -X POST http://127.0.0.1:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "只回答 OK"}],
    "stream": false
  }'
```

Claude Code 在 `npm run setup:agents -- --target claude-code` 之后：

```bash
claude --settings ~/.claude/freedeepseek.settings.json
```

`claude-sonnet-*` 和 `claude-opus-*` 会映射到 DeepSeek-V4.1-Flash，以及带 DeepThink 的 DeepSeek-V4.1-Flash，所以旧的 Claude id 仍然能跑。

### OpenAI Responses

```bash
curl -X POST http://127.0.0.1:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "input": "只回答 OK",
    "stream": false
  }'
```

Codex 走的就是这条路由。安装之后：

```bash
codex --profile freedeepseek
```

### 工具调用

代理接受 OpenAI 的 `tools`、Anthropic 的 `tools`，以及 Responses 的 function tools。

DeepSeek Web 没有真正的 tool call 数组。代理把工具列表写进提示，再把模型回复解析回 OpenAI 的 `tool_calls`。这些形式都能认：

- `{"tool_call":{"name":"...","arguments":{...}}}`
- `{"tool_calls":[{"name":"...","arguments":{...}}]}`，一次最多 8 个互不依赖的调用
- `TOOL_CALL:` 后面跟一个 JSON 对象
- 围栏里的 JSON，带 `tool_call`、`tool_calls` 或 `function_call` 信封
- `<tool_call>...</tool_call>`
- DeepSeek DSML，包括带双竖线的网页变体

`execute_code` 和 `web_search` 是 DeepSeek 自己的工具。它们不会在你的电脑上执行。如果它们和真正的本地工具（比如 `read_file`）写在一起，它们会被丢掉，本地调用会留下来。没写完的工具块不会执行。代理会再要一次严格 JSON。还是坏的话，这一回合返回 `502 malformed_tool_call`，聊天保持打开。

harness 的 `websearch`、`webfetch` 和 `WebFetch` 会被拿掉。要查网上的事，用 chat.deepseek.com 自带的搜索。

### 图片

支持 PNG、JPEG、WebP 和 GIF。最多 10 张，解码后每张 20 MiB。JSON 正文默认上限 30 MiB。

代理把图片上传到 DeepSeek Web，等解析结束，再发送文件 id。别人的 `file_id` 会被拒绝。URL 必须是公开的 HTTPS。跳转到本机、私网或 link-local 地址会被拒绝。

OpenAI Chat Completions 用 `image_url`。Responses 用 `input_image`。Anthropic 用带 base64 的 `image` 块。见 [docs/api.md](docs/api.md)。

---

## 模型

`GET /v1/models` 只返回 DeepSeek-V4.1-Flash。

| ID | DeepThink | 自带网页搜索 | 作用 |
|---|---|---|---|
| `deepseek-v4-flash` | 关 | 关 | DeepSeek-V4.1-Flash。`deepseek-flash` 是同一个 id |
| `deepseek-v4-flash-thinking` | 开 | 关 | 先 DeepThink，再回答 |
| `deepseek-v4-flash-search` | 关 | 开 | 用 chat.deepseek.com 的自带搜索查实时网络 |
| `deepseek-v4-flash-thinking-search` | 开 | 开 | DeepThink 加上自带搜索 |

这两个后缀是 DeepSeek 聊天里的两个开关。它们不会换成另一个模型。

旧 id 没有注册，会返回 `400 invalid_model`：

`deepseek-chat`、`deepseek-reasoner`、`deepseek-r1`、`deepseek-v3`、`deepseek-instant`、`deepseek-expert`、`deepseek-v4-pro`、`deepseek-chat-search`，以及 vision。

```bash
curl http://127.0.0.1:9655/v1/model-capabilities
```

完整表格见 [docs/zh/models.md](docs/zh/models.md)。

---

## Endpoints

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/health` | 进程是否活着。没有代理密钥，或 bearer 匹配时，还会带账号状态 |
| `GET` | `/readyz` | 只有登录能接请求时才是 `200` |
| `GET` | `/v1/models` | 四个 DeepSeek-V4.1-Flash id |
| `GET` | `/v1/model-capabilities` | id、DeepThink 和自带搜索 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/responses` | OpenAI Responses |
| `GET` | `/v1/sessions` | 本地代理会话 |
| `POST` | `/reset-session?agent=<id>` | 关掉一个 Web 聊天 |
| `POST` | `/reset-session?agent=all` | 关掉全部 Web 聊天 |

---

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `HOST` | `127.0.0.1` | 绑定地址。绑到非 loopback 又没有代理密钥时会打印警告 |
| `PORT` | `9655` | 端口 |
| `PROXY_API_KEY` | 关闭 | 设置后，`/v1/*` 必须带 bearer |
| `REQUIRE_PROXY_API_KEY` | 关闭 | 没有密钥就拒绝启动。容器里是打开的 |
| `PROXY_CORS_ORIGINS` | loopback | 额外允许的精确浏览器 origin |
| `DEEPSEEK_AUTH_PATH` | `./deepseek-auth.json` | 一个文件，或逗号分隔的列表 |
| `DEEPSEEK_AUTH_DIR` | 目录存在时为 `./accounts` | 里面所有 `*.json` |
| `DEEPSEEK_MAX_PROMPT_CHARS` | `80000` | 发往上游的字符上限。最小 16000 |
| `DEEPSEEK_MAX_RETRIES` | `2` | 空回复在同一个聊天里重试的次数 |
| `DEEPSEEK_REQUEST_DEADLINE_MS` | `120000` | 单次请求的时间上限 |
| `DEEPSEEK_MAX_CONCURRENT` | `24` | 进程上限。真正的并行度是空闲登录的数量 |
| `DEEPSEEK_ACCOUNT_LOCK_WAIT_MS` | `120000` | 第二个聊天等多久才会放弃忙碌的登录 |
| `DEEPSEEK_ACCOUNT_COOLDOWN_MS` | `600000` | 401、403 或 429 之后 |
| `TRUST_PROXY` | 关闭 | 设为 `1` 时，客户端 IP 取自 `X-Forwarded-For` |
| `MAX_REQUEST_BODY_BYTES` | `31457280` | JSON 正文上限，含 base64 图片 |
| `NON_INTERACTIVE` / `SKIP_ACCOUNT_MENU` | 关闭 | 跳过启动菜单 |

---

## 错误

| 状态 | `error.type` | 怎么办 |
|---|---|---|
| 400 | `invalid_model` | 用 `GET /v1/models` 里的 id |
| 400 | `context_length_exceeded` | 压缩之后提示仍然太长 |
| 401 | `authentication_error` | 代理密钥不对 |
| 429 | `concurrent_chat_blocked` | 等待忙碌登录超时。再加一个登录，或稍后重试 |
| 429 | `rate_limit` | 所有登录都在冷却。遵守 `Retry-After` |
| 502 | `malformed_tool_call` | 修过一次之后工具标记仍然坏掉。聊天还在 |
| 502 | `empty_response` | 重试之后 DeepSeek 仍然没有内容 |
| 503 | `overloaded` / `no_auth` | 在途请求太多，或没有 auth 文件 |
| 504 | `request_timeout` | 超过 `DEEPSEEK_REQUEST_DEADLINE_MS` |

---

## Open WebUI

同一台机器上、Docker 里的 Open WebUI，Base URL 用：

```text
http://host.docker.internal:9655/v1
```

本机、不用 Docker：

```text
http://127.0.0.1:9655/v1
```

没设 `PROXY_API_KEY` 时，API key 随便填。设了的话，客户端必须发这个密钥。代理会在模型、会话和补全之前检查 bearer。

普通回答用 `deepseek-v4-flash`，要 DeepThink 用 `deepseek-v4-flash-thinking`，问题需要实时网络时用 `deepseek-v4-flash-search`，走的是 chat.deepseek.com 的自带搜索。

---

## 重新登录

```bash
npm run auth
npm start
```

DeepSeek 返回 `401` 或 `403`，或者 PoW 失败时，重新登录并替换 `deepseek-auth.json`。

这些不会进 git：

- `deepseek-auth.json`
- `accounts/*.json`
- 登录脚本使用的 Chrome 配置目录
- `.env`

---

## 测试

语法和单元测试，不联网：

```bash
npm test
```

对已经跑起来的代理做在线冒烟测试：

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-v4-flash npm run test:live
```

`npm test` 对入口跑 `node --check`，再跑 `node --test tests/unit.test.js`。它不会请求 DeepSeek。

---

## 项目状态

FreeDeepseekAPI 是本地网页聊天代理。它依赖 chat.deepseek.com 当前的协议。协议一变，登录或请求体就可能要跟着改。

调用突然不行时：

1. 用 `npm run auth` 重新登录。
2. 跑 `npm run doctor`。
3. 看 `GET /v1/model-capabilities`，改用 DeepSeek-V4.1-Flash 的 id。
4. 同一个聊天还是失败，就调用 `POST /reset-session?agent=<id>` 再试。
5. 还是不行，多半是 DeepSeek 改了内部 Web API。

安全问题请走非公开的 GitHub advisory，不要开公开 issue。见 [SECURITY.md](SECURITY.md)。维护者名单见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 文档

- [登录](docs/zh/auth.md)
- [编程代理](docs/zh/agents.md)
- [模型](docs/zh/models.md)
- [HTTP API](docs/api.md)

## Star

<a href="https://github.com/dekrezz/FreeDeepseekAPI/stargazers">
  <img src="docs/assets/stars.svg" alt="Star 历史" width="800" />
</a>

## 许可证

Apache-2.0。Copyright 2026 dekrezz。
