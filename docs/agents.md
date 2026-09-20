# One-click agent setup

`npm run setup:agents` adds FreeDeepseekAPI as an **opt-in provider/profile**. It does not replace the current Claude, GPT, or other default model.

```bash
npm run setup:agents
# or non-interactive:
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-pro
npm run setup:agents -- --dry-run --target hermes,openclaw,opencode
```

Requires the proxy already listening (`npm start`). Default origin: `http://127.0.0.1:9655`. Override with `--base-url` / `PROXY_BASE_URL`. If `PROXY_API_KEY` is set, it is copied into the agent configs.

| Target | Added configuration | Selection |
|---|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json` | `claude --settings ~/.claude/freedeepseek.settings.json`; normal `claude` keeps native models |
| Codex | `~/.codex/freedeepseek.config.toml` + catalog JSON | `codex --profile freedeepseek`; normal Codex keeps GPT/default provider |
| OpenCode | `freedeepseek` entry in `~/.config/opencode/opencode.json` | Select `freedeepseek/<id>`; existing `model` remains unchanged |
| Hermes | `~/.hermes/freedeepseek.yaml` | Separate profile file; native config remains unchanged |
| OpenClaw | `freedeepseek` provider in `~/.openclaw/openclaw.json` | Select explicitly; existing primary model remains unchanged |
| Cursor | Template + optional launcher in `integrations/cursor/` | Existing editor settings remain unchanged |

## Images in coding agents

- **Claude Code:** paste or attach an image normally. Its Anthropic `image` block is converted to a DeepSeek Web file.
- **Codex:** `codex -i screenshot.png` (repeat `-i` for multiple files). The generated model catalog advertises image input, and `/v1/responses` accepts `input_image`.
- **OpenCode:** paste or drag an image into the prompt. The generated config sets both `attachment: true` and `modalities.input: ["text", "image"]`, so OpenCode does not strip the attachment.
- **OpenClaw and other OpenAI-compatible clients:** send a Chat Completions `image_url` part as a base64 data URL or public HTTPS URL.

Protocol examples and limits: [HTTP API → Image input](api.md#image-input).

Copy-paste templates live in [`integrations/`](../integrations/). Restore: `node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/<stamp>`.

Sources: [Claude vision blocks](https://platform.claude.com/docs/en/build-with-claude/vision), [Codex CLI image flag](https://developers.openai.com/codex/cli/reference), [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenCode custom providers](https://opencode.ai/docs/providers/), [OpenClaw custom providers](https://docs.openclaw.ai/gateway/config-tools).
