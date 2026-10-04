# One-click agent setup

`npm run setup:agents` adds FreeDeepseekAPI as an **opt-in provider/profile**. It does not replace the current Claude, GPT, or other default model.

```bash
npm run setup:agents
# or non-interactive:
npm run setup:agents -- --all --model deepseek-v4-flash
npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
npm run setup:agents -- --dry-run --target hermes,openclaw,opencode
```

Requires the proxy already listening (`npm start`). Default origin: `http://127.0.0.1:9655`. Override with `--base-url` / `PROXY_BASE_URL`. If `PROXY_API_KEY` is set, it is copied into the agent configs.

Setup only reads and writes files inside your home folder (or the project folder with `--scope project`). A config file, or a folder above it, that is a link to somewhere outside it is refused (`file_outside_home`), and so is a config file over 1 MiB (`file_too_large`). If any selected agent can't be planned, nothing is written; replace the link with the real file, or edit that agent's config by hand.

`--model` is always DeepSeek-V4.1-Flash, with native chat.deepseek.com search on for the live web. `-thinking` turns DeepThink on. `-nosearch` turns search off; the agent then keeps its own web tools. An old `-search` ID maps to the same ID without the suffix.

| Target | Added configuration | Selection |
|---|---|---|
| Claude Code | `~/.claude/freedeepseek.settings.json` | `claude --settings ~/.claude/freedeepseek.settings.json`; normal `claude` keeps native models |
| Codex | `~/.codex/freedeepseek.config.toml` + catalog JSON | `codex --profile freedeepseek` (Codex 0.134+ reads profiles from `~/.codex/<name>.config.toml`); normal Codex keeps GPT/default provider |
| OpenCode | `freedeepseek` entry in `~/.config/opencode/opencode.json` plus autonomy rules in `~/.config/opencode/AGENTS.md` | Select `freedeepseek/<id>`; existing `model` remains unchanged |
| Hermes | `~/.hermes/freedeepseek.yaml` | Native config remains unchanged. **Hermes does not load this file by itself**: it reads `~/.hermes/config.yaml`, or `~/.hermes/profiles/<name>/config.yaml` with `hermes -p <name>`. Copy the `model:` block into one of those, or use `--mode replace` |
| OpenClaw | `freedeepseek` provider in `~/.openclaw/openclaw.json` | Select explicitly; existing primary model remains unchanged |
| Cursor | Template + optional launcher in `integrations/cursor/` | Existing editor settings remain unchanged |

## Images in coding agents

- **Claude Code:** paste or attach an image normally. Its Anthropic `image` block is converted to a DeepSeek Web file.
- **Codex:** `codex -i screenshot.png` (repeat `-i` for multiple files). The generated model catalog advertises image input, and `/v1/responses` accepts `input_image`.
- **OpenCode:** paste or drag an image into the prompt. The generated config sets both `attachment: true` and `modalities.input: ["text", "image"]`, so OpenCode does not strip the attachment.
- **OpenClaw and other OpenAI-compatible clients:** send a Chat Completions `image_url` part as a base64 data URL or public HTTPS URL.

Protocol examples and limits: [HTTP API → Image input](api.md#image-input).

With `--mode replace`, each agent starts on DeepSeek by default: Claude Code `~/.claude/settings.json`, Codex `~/.codex/config.toml` (root keys only; `[profiles.*]` and other tables stay), OpenCode `model`, Hermes the `model:` section of `~/.hermes/config.yaml`, OpenClaw `agents.defaults.model.primary`. Everything else in those files is kept.

### What OpenCode setup changes globally

The OpenCode target changes more than the `freedeepseek` provider, in both modes:

- Turns off OpenCode's own `websearch` and `webfetch` tools for **every** model, and denies them in `permission` (DeepSeek searches the web itself).
- Resizes attached images to at most 2000 × 2000 px for every model (`attachment.image`).
- Adds a marked FreeDeepseekAPI section to `~/.config/opencode/AGENTS.md`, which every OpenCode model reads.
- If the default `model` is already a `freedeepseek/` model, sets it to `freedeepseek/deepseek-v4-flash-thinking` (add mode).

## Dashboard: Agents page

`/dashboard` → Settings → **Agents** does the same per agent, one at a time:

- Each agent shows whether it uses this proxy (as default, alongside, not set up, needs update, or can't read its file), and why.
- Open an agent to see every file it reads, with secrets masked (`‹proxy-key›`, `‹secret:…›`): values under key-like names, items of secret lists, values after flags like `--api-key`, and known token shapes. The masked values never leave the machine.
- Pick a model, the install mode and the proxy address. The page shows the exact change as a diff before anything is written.
- **Apply** backs up the files it changes first, writes each one atomically, and refuses if a file changed on disk after the preview.
- Cursor keeps its settings inside the app, so the page only shows the settings and a launcher to copy or download.

The page only works in a browser on the machine running the proxy (`127.0.0.1`), even with `PROXY_API_KEY` set. The container image does not include the setup script; run `npm run setup:agents` where your agents are installed. API: [HTTP API → Agents API](api.md#agents-api).

## Backups and restore

Every run (CLI or dashboard) that changes a file first makes a restore point in `~/.freedeepseek-api/backups/<time>/`:

- a copy of each existing file it changes, named `<agent>.<file><ext>` (for example `codex.config.toml`), so files with the same name from different agents never collide;
- `manifest.json`, listing every file the run wrote, including the ones it created.

```bash
node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/<stamp>
```

Restoring copies the saved files back and **deletes files the run created**. The versions it replaces are saved as a new restore point first. From the terminal the restore always overwrites; the dashboard asks first if a file changed after the backup. Folders made by older versions have no manifest: the terminal restores them by file name, as before, and prints `skipped <name>: no known destination` for anything else. Restore points are not pruned.

Copy-paste templates live in [`integrations/`](../integrations/).

Sources: [Claude vision blocks](https://platform.claude.com/docs/en/build-with-claude/vision), [Codex CLI image flag](https://developers.openai.com/codex/cli/reference), [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenCode custom providers](https://opencode.ai/docs/providers/), [OpenClaw custom providers](https://docs.openclaw.ai/gateway/config-tools).
