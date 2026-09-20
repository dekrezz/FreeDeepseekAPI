# Auth

`deepseek-auth.json` is a live Web session. Mode `600`. Do not commit it.

| Command | What |
|---|---|
| `npm run auth` | Menu: login / import / status |
| `npm run deepseek:auth` | Chrome capture of token + cookies |
| `npm run auth:import` | Import `deepseek-auth.json` or browser cookie export |
| `npm run doctor` | Validate files; omit `--offline` to hit PoW |

Chrome extension: `chrome-extension/` on an open `chat.deepseek.com` tab. Collect until **Token** is Ready, then Save File. Do not paste the JSON into chat.

Fields: `token`, `cookie`, `wasmUrl`. Optional: `hif_dliq`, `hif_leim`, `name` (label), `enabled` (`false` pauses the login). See [`auth.example.json`](../auth.example.json).

## Pool (2–3 accounts)

One login = one in-flight chat. For two agents or two OpenCode sessions at once, import a second session:

```bash
mkdir -p accounts
npm run auth:import -- --input ~/Downloads/deepseek-auth.json --output ./accounts/worker-2.json
```

The proxy also loads `./accounts/*.json` next to the default `deepseek-auth.json`. Override with `DEEPSEEK_AUTH_DIR` or a comma list in `DEEPSEEK_AUTH_PATH`.

HTTP details: [`api.md`](api.md).
