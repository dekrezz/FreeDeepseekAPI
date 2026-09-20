#!/usr/bin/env node
/**
 * One-click wiring of FreeDeepseekAPI into Claude Code, Codex, OpenCode, Hermes, OpenClaw, Cursor.
 * Writes the live config each tool actually reads. Backs up first.
 *
 *   npm run setup:agents
 *   npm run setup:agents -- --target claude-code --model deepseek-v4-pro
 *   npm run setup:agents -- --all --dry-run
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.SETUP_HOME || os.homedir();
const VALID_TARGETS = ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'cursor'];
const VALID_MODELS = ['deepseek-v4-flash', 'deepseek-v4-flash-thinking', 'deepseek-v4-pro', 'deepseek-v4-pro-thinking'];

function argValue(args, name, fallback = '') {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] || '';
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return fallback;
}
function hasArg(args, ...names) { return args.some(a => names.includes(a)); }
function isTruthy(v) { return /^(1|true|yes|on)$/i.test(String(v || '')); }
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function die(msg, code = 2) { console.error(msg); process.exit(code); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
function readJson(file, fallback = null) {
  const raw = readText(file);
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}
function writeFile(file, body, { dryRun, written }) {
  if (dryRun) {
    console.log(`[dry-run] write ${file}\n${String(body).slice(0, 1200)}${body.length > 1200 ? '\n…' : ''}\n`);
    return;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  written.push(file);
  console.log(`wrote ${file}`);
}
function backupFile(file, backupDir, { dryRun }) {
  if (!fs.existsSync(file)) return null;
  const dest = path.join(backupDir, path.basename(file));
  if (dryRun) {
    console.log(`[dry-run] backup ${file} → ${dest}`);
    return dest;
  }
  ensureDir(backupDir);
  fs.copyFileSync(file, dest);
  console.log(`backup ${file} → ${dest}`);
  return dest;
}

function defaultBaseUrl() {
  const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
  const port = process.env.PORT || '9655';
  return process.env.PROXY_BASE_URL || `http://${host}:${port}`;
}
function openaiBase(baseUrl) { return `${String(baseUrl).replace(/\/+$/, '')}/v1`; }
function anthropicBase(baseUrl) { return String(baseUrl).replace(/\/+$/, ''); }

function parseArgs(argv) {
  const args = argv.slice(2);
  if (hasArg(args, '--help', '-h')) return { help: true };
  const model = argValue(args, '--model', 'deepseek-v4-flash');
  if (!VALID_MODELS.includes(model)) die(`Unknown --model ${model}. Use: ${VALID_MODELS.join(', ')}`);
  let targets = [];
  if (hasArg(args, '--all')) targets = [...VALID_TARGETS];
  const target = argValue(args, '--target', '');
  if (target) {
    const list = target.split(',').map(s => s.trim()).filter(Boolean);
    for (const t of list) if (!VALID_TARGETS.includes(t)) die(`Unknown --target ${t}. Use: ${VALID_TARGETS.join(', ')}`);
    targets = list;
  }
  return {
    help: false,
    interactive: targets.length === 0 && !hasArg(args, '--non-interactive'),
    targets,
    model,
    baseUrl: argValue(args, '--base-url', defaultBaseUrl()),
    apiKey: argValue(args, '--api-key', process.env.PROXY_API_KEY || 'local'),
    scope: argValue(args, '--scope', 'user'),
    dryRun: hasArg(args, '--dry-run'),
    restore: argValue(args, '--restore', ''),
  };
}

function printHelp() {
  console.log(`FreeDeepseekAPI agent setup

One press writes the config each agent actually reads (with backup).

Usage:
  node scripts/setup-agents.js
  node scripts/setup-agents.js --all --model deepseek-v4-flash
  node scripts/setup-agents.js --target claude-code,codex --model deepseek-v4-pro
  node scripts/setup-agents.js --dry-run --target hermes

Options:
  --target    ${VALID_TARGETS.join(' | ')} | comma-list
  --all       every target
  --model     ${VALID_MODELS.join(' | ')}
  --base-url  proxy origin (default ${defaultBaseUrl()})
  --api-key   PROXY_API_KEY or "local"
  --scope     user (default) | project
  --dry-run   print files, write nothing
  --restore <dir>  copy backups from a previous run back into place
`);
}

function claudeSettings(opts) {
  const haiku = 'deepseek-v4-flash';
  const opus = opts.model.includes('pro') ? 'deepseek-v4-pro-thinking' : 'deepseek-v4-flash-thinking';
  return {
    env: {
      ANTHROPIC_BASE_URL: anthropicBase(opts.baseUrl),
      ANTHROPIC_AUTH_TOKEN: opts.apiKey,
      ANTHROPIC_MODEL: opts.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: opts.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
      CLAUDE_CODE_SUBAGENT_MODEL: haiku,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    },
    model: opts.model,
  };
}

function mergeClaudeSettings(existing, incoming) {
  const out = existing && typeof existing === 'object' ? { ...existing } : {};
  out.env = { ...(out.env || {}), ...incoming.env };
  out.model = incoming.model;
  return out;
}

function setupClaudeCode(opts) {
  const dest = opts.scope === 'project'
    ? path.join(process.cwd(), '.claude', 'freedeepseek.settings.json')
    : path.join(HOME, '.claude', 'freedeepseek.settings.json');
  backupFile(dest, opts.backupDir, opts);
  writeFile(dest, `${JSON.stringify(claudeSettings(opts), null, 2)}\n`, opts);
  console.log(`Claude Code: native defaults unchanged. Opt in with: claude --settings ${dest}`);
}

function tomlEscape(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

function upsertTomlKey(text, key, value) {
  const line = `${key} = ${tomlEscape(value)}`;
  const re = new RegExp(`^${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${line}\n${text}`;
}

function upsertTomlTable(text, heading, body) {
  const re = new RegExp(`\\n\\[${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?(?=\\n\\[|$)`);
  const block = `\n[${heading}]\n${body.trim()}\n`;
  if (re.test(`\n${text}`)) return (`\n${text}`).replace(re, block).replace(/^\n/, '');
  return `${text.replace(/\s*$/, '')}\n${block}`;
}

function setupCodex(opts) {
  const dir = path.join(HOME, '.codex');
  const catalogPath = path.join(dir, 'freedeepseek-models.json');
  const profilePath = path.join(dir, 'freedeepseek.config.toml');

  const catalog = {
    models: VALID_MODELS.map(slug => ({
      slug,
      display_name: 'DeepSeek-V4.1-Flash (FreeDeepseekAPI)',
      description: 'Routed through local FreeDeepseekAPI (DeepSeek Web V4.1-Flash).',
      supported_reasoning_levels: [],
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: 'You are a coding agent. Follow developer instructions, use tools when needed, and report results concisely.',
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: 'none',
      support_verbosity: false,
      default_verbosity: null,
      input_modalities: ['text', 'image'],
      context_window: 1048576,
      max_context_window: 1048576,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      truncation_policy: { mode: 'tokens', limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_search_tool: false,
      prefer_websockets: false,
      apply_patch_tool_type: 'freeform',
    })),
  };
  writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, opts);

  const providerBody = [
    'name = "FreeDeepseekAPI"',
    `base_url = ${tomlEscape(openaiBase(opts.baseUrl))}`,
    'wire_api = "responses"',
    `experimental_bearer_token = ${tomlEscape(opts.apiKey)}`,
  ].join('\n');

  const profile = [
    `model = ${tomlEscape(opts.model)}`,
    'model_provider = "freedeepseek"',
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    `model_catalog_json = ${tomlEscape(catalogPath)}`,
    '',
    '[model_providers.freedeepseek]',
    providerBody,
    '',
  ].join('\n');
  writeFile(profilePath, profile, opts);

  console.log('Codex: native GPT model/provider unchanged. Opt in with: codex --profile freedeepseek');
}

function yamlQuote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function upsertYamlModelBlock(text, opts) {
  const block = [
    'model:',
    `  default: ${yamlQuote(opts.model)}`,
    '  provider: custom',
    `  base_url: ${yamlQuote(openaiBase(opts.baseUrl))}`,
    `  api_key: ${yamlQuote(opts.apiKey)}`,
    '  api_mode: chat_completions',
    '',
  ].join('\n');
  const src = String(text || '');
  if (!src.trim()) return block;
  const re = /^model:\s*(?:\n[ \t]+[^\n]*)*\n?/m;
  if (re.test(src)) return src.replace(re, block);
  return `${block}${src.startsWith('\n') ? '' : '\n'}${src}`;
}

function setupHermes(opts) {
  const dest = path.join(HOME, '.hermes', 'freedeepseek.yaml');
  backupFile(dest, opts.backupDir, opts);
  const next = upsertYamlModelBlock('', opts);
  writeFile(dest, next.endsWith('\n') ? next : `${next}\n`, opts);
  console.log(`Hermes: native config unchanged. FreeDeepseekAPI profile written to ${dest}.`);
}

function setupOpenClaw(opts) {
  const dest = path.join(HOME, '.openclaw', 'openclaw.json');
  backupFile(dest, opts.backupDir, opts);
  const cfg = readJson(dest, {});
  const models = [];
  for (const id of VALID_MODELS) {
    models.push({
      id,
      name: id,
      reasoning: id.includes('thinking'),
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
  }
  cfg.models = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
  cfg.models.mode = cfg.models.mode || 'merge';
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers.freedeepseek = {
    baseUrl: openaiBase(opts.baseUrl),
    apiKey: opts.apiKey,
    api: 'openai-completions',
    models,
  };
  writeFile(dest, `${JSON.stringify(cfg, null, 2)}\n`, opts);
  console.log('OpenClaw: provider added; existing primary model unchanged. Select freedeepseek/<id> explicitly.');
}

function setupOpenCode(opts) {
  const dest = path.join(HOME, '.config', 'opencode', 'opencode.json');
  backupFile(dest, opts.backupDir, opts);
  const cfg = readJson(dest, {});
  const models = {};
  for (const id of VALID_MODELS) {
    models[id] = {
      name: `${id} (FreeDeepseekAPI)`,
      attachment: true,
      reasoning: id.includes('thinking'),
      tool_call: true,
      modalities: {
        input: ['text', 'image'],
        output: ['text'],
      },
      limit: {
        context: 128000,
        output: 8192,
      },
    };
  }
  cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
  cfg.provider = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
  cfg.provider.freedeepseek = {
    npm: '@ai-sdk/openai-compatible',
    name: 'FreeDeepseekAPI',
    options: {
      baseURL: openaiBase(opts.baseUrl),
      apiKey: opts.apiKey,
    },
    models,
  };
  cfg.attachment = cfg.attachment && typeof cfg.attachment === 'object' ? cfg.attachment : {};
  cfg.attachment.image = {
    ...(cfg.attachment.image || {}),
    auto_resize: true,
    max_width: 2000,
    max_height: 2000,
    max_base64_bytes: 5242880,
  };
  writeFile(dest, `${JSON.stringify(cfg, null, 2)}\n`, opts);
  console.log('OpenCode: provider added; existing default model unchanged. Select freedeepseek/<id> explicitly.');
}

function cursorSettingsSnippet(opts) {
  return {
    'openai.baseUrl': openaiBase(opts.baseUrl),
    'openai.apiBase': openaiBase(opts.baseUrl),
  };
}

function setupCursor(opts) {
  const snippetPath = path.join(ROOT, 'integrations', 'cursor', 'settings.json');
  const launchPath = path.join(ROOT, 'integrations', 'cursor', 'launch-cursor-deepseek.sh');
  const body = `${JSON.stringify({
    ...cursorSettingsSnippet(opts),
    '//openaiApiKey': 'Paste PROXY_API_KEY (or "local") in Cursor Settings → Models → OpenAI API Key',
    '//addModels': VALID_MODELS,
    '//overrideOpenAiBaseUrl': openaiBase(opts.baseUrl),
  }, null, 2)}\n`;
  writeFile(snippetPath, body, opts);

  const launch = `#!/bin/sh
# Launch Cursor with FreeDeepseekAPI as the OpenAI-compatible endpoint.
export OPENAI_BASE_URL=${JSON.stringify(openaiBase(opts.baseUrl))}
export OPENAI_API_KEY=${JSON.stringify(opts.apiKey)}
if command -v cursor >/dev/null 2>&1; then
  exec cursor "$@"
fi
if [ "$(uname)" = Darwin ] && [ -d "/Applications/Cursor.app" ]; then
  exec open -a Cursor --args "$@"
fi
echo "Cursor CLI/app not found. Set Override OpenAI Base URL to $OPENAI_BASE_URL" >&2
exit 1
`;
  writeFile(launchPath, launch, opts);
  if (!opts.dryRun) fs.chmodSync(launchPath, 0o755);

  console.log('Cursor: existing editor settings unchanged.');
  console.log(`        Optional profile launcher uses OpenAI Base URL = ${openaiBase(opts.baseUrl)}`);
  console.log(`        Add models: ${VALID_MODELS.join(', ')}`);
  console.log(`        Or: sh ${launchPath}`);
}

const HANDLERS = {
  'claude-code': setupClaudeCode,
  codex: setupCodex,
  opencode: setupOpenCode,
  hermes: setupHermes,
  openclaw: setupOpenClaw,
  cursor: setupCursor,
};

function restoreFrom(dir) {
  if (!fs.existsSync(dir)) die(`backup dir not found: ${dir}`);
  const map = {
    'settings.json': path.join(HOME, '.claude', 'settings.json'),
    'settings.local.json': path.join(process.cwd(), '.claude', 'settings.local.json'),
    'config.toml': path.join(HOME, '.codex', 'config.toml'),
    'models.json': path.join(HOME, '.codex', 'models.json'),
    'opencode.json': path.join(HOME, '.config', 'opencode', 'opencode.json'),
    'config.yaml': path.join(HOME, '.hermes', 'config.yaml'),
    'openclaw.json': path.join(HOME, '.openclaw', 'openclaw.json'),
  };
  for (const [name, dest] of Object.entries(map)) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    console.log(`restored ${dest}`);
  }
}

async function interactive(opts) {
  console.log('FreeDeepseekAPI — one-click agent model setup');
  console.log(`Proxy: ${opts.baseUrl}   model: ${opts.model}`);
  console.log('1  all');
  VALID_TARGETS.forEach((t, i) => console.log(`${i + 2}  ${t}`));
  console.log('0  exit');
  const choice = (await prompt('Choice [1]: ')) || '1';
  if (choice === '0') return [];
  if (choice === '1') return [...VALID_TARGETS];
  const idx = Number(choice) - 2;
  if (!VALID_TARGETS[idx]) die('Invalid choice');
  return [VALID_TARGETS[idx]];
}

async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return; }
  if (opts.restore) { restoreFrom(opts.restore); return; }
  if (opts.interactive) opts.targets = await interactive(opts);
  if (!opts.targets.length) die('No --target. See --help.');

  opts.backupDir = path.join(HOME, '.freedeepseek-api', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  opts.written = [];
  console.log(`model=${opts.model} base=${opts.baseUrl} key=${opts.apiKey ? 'set' : 'missing'} dryRun=${opts.dryRun}`);
  for (const target of opts.targets) HANDLERS[target](opts);
  if (!opts.dryRun) console.log(`\nBackups: ${opts.backupDir}\nRestore: node scripts/setup-agents.js --restore ${opts.backupDir}`);
}

if (require.main === module) {
  main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = {
  VALID_TARGETS,
  VALID_MODELS,
  claudeSettings,
  mergeClaudeSettings,
  upsertTomlKey,
  upsertTomlTable,
  upsertYamlModelBlock,
  openaiBase,
  anthropicBase,
  parseArgs,
  main,
};
