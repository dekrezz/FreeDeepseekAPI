# 鉴权

`deepseek-auth.json` 是 chat.deepseek.com 的有效 Web 会话。权限 `600`。不要提交到 git。

| 命令 | 作用 |
|---|---|
| `npm run auth` | 菜单：登录 / 导入 / 状态 |
| `npm run deepseek:auth` | 用 Chrome 采集 token 和 cookies |
| `npm run auth:import` | 导入 `deepseek-auth.json` 或浏览器 cookies |
| `npm run doctor` | 校验文件；去掉 `--offline` 还会打 PoW |

Chrome 扩展：在已打开的 `chat.deepseek.com` 标签页加载 `chrome-extension/`。等到 **Token: Ready** 再 Save File。不要把 JSON 贴进聊天。

字段：`token`、`cookie`、`wasmUrl`。可选 `hif_dliq`、`hif_leim`。文件里写 `enabled: false` 会暂停该登录。示例：[`auth.example.json`](../../auth.example.json)。

## 多个账号

一个 Web 登录同一时刻只能跑一个聊天。两个 Agent 或两个 OpenCode 会话并行，就准备 2–3 个文件：

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
```

代理会加载 `./deepseek-auth.json` 以及 `./accounts/*.json`。也可用 `DEEPSEEK_AUTH_DIR` 指定目录，或在 `DEEPSEEK_AUTH_PATH` 里用逗号列出文件。加完文件后重启服务。

给每个客户端不同的 `x-agent-session`。不能把某个登录绑到某个客户端：代理自己选空闲的。同一登录上的第二个请求会排队等待，而不会并行发出（并行会被 DeepSeek 封禁数天）。

协议细节见 [HTTP API](../api.md)。
