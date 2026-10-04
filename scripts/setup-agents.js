#!/usr/bin/env node
/**
 * One-click wiring of FreeDeepseekAPI into Claude Code, Codex, OpenCode, Hermes, OpenClaw, Cursor.
 * Writes the live config each tool actually reads. Backs up first.
 *
 *   npm run setup:agents
 *   npm run setup:agents -- --target claude-code --model deepseek-v4-flash-thinking
 *   npm run setup:agents -- --all --dry-run
 *
 * The same functions back the dashboard's Agents page (server.js requires this file
 * lazily). Library functions are pure over an explicit ctx = { home, root, cwd,
 * pathEnv, platform } and throw SetupError; only the CLI path calls die().
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { t, loadUiLang, saveUiLang, pick, pickMany } = require('./lib/tui-menu');

const ROOT = path.resolve(__dirname, '..');
const VALID_TARGETS = ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'cursor'];
// Native Web Search is on by default; -nosearch turns it off.
const VALID_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-thinking',
  'deepseek-v4-flash-nosearch',
  'deepseek-v4-flash-thinking-nosearch',
];
// Search used to need a -search suffix; those IDs now mean the default model.
const LEGACY_SEARCH_MODELS = {
  'deepseek-v4-flash-search': 'deepseek-v4-flash',
  'deepseek-v4-flash-thinking-search': 'deepseek-v4-flash-thinking',
};
const DEFAULT_MODEL = 'deepseek-v4-flash';
const CODEX_BASE_INSTRUCTIONS = 'You are a coding agent. Follow developer instructions and use local tools when needed. Local tools are JSON, and several independent calls may be one tool_calls array.';
const CODEX_NATIVE_SEARCH_INSTRUCTIONS = 'Do not use the Codex/harness web search tool. DeepSeek native Web Search is enabled — use it for live web data and report the findings.';
const OPENCODE_MODEL_LABEL = 'DeepSeek 4.1';
const OPENCODE_PROVIDER_LABEL = 'Flash';
const AGENT_FILE_MAX_BYTES = 1024 * 1024;
const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[a-z0-9]{4})?$/;

class SetupError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SetupError';
    this.code = code;
    this.extra = extra;
  }
}

function argValue(args, name, fallback = '') {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] || '';
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return fallback;
}
function hasArg(args, ...names) { return args.some(a => names.includes(a)); }
function isTruthy(v) { return /^(1|true|yes|on)$/i.test(String(v || '')); }
function die(msg, code = 2) { console.error(msg); process.exit(code); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function defaultBaseUrl() {
  const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
  const port = process.env.PORT || '9655';
  return process.env.PROXY_BASE_URL || `http://${host}:${port}`;
}
function openaiBase(baseUrl) { return `${String(baseUrl).replace(/\/+$/, '')}/v1`; }
function anthropicBase(baseUrl) { return String(baseUrl).replace(/\/+$/, ''); }

// ---------- paths, revisions, safe reads ----------

function displayPath(ctx, p) {
  if (!p) return p;
  const home = String(ctx.home).replace(/[\\/]+$/, '');
  if (p === home) return '~';
  if (home && p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}
function revisionOf(salt, data) {
  return crypto.createHmac('sha256', salt).update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).digest('hex').slice(0, 16);
}
function realHome(ctx) {
  try { return fs.realpathSync(ctx.home); } catch (e) { return path.resolve(ctx.home); }
}
function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function unreadable(ctx, file, error) {
  return new SetupError('file_unreadable', `Could not read ${displayPath(ctx, file)}: ${error.message}`, { path: displayPath(ctx, file) });
}

// The folder a setup file has to stay inside once every link is followed: HOME,
// or the project folder for project-scope files that live outside HOME.
function containerOf(ctx, file) {
  const home = path.resolve(ctx.home);
  if (isInside(home, file)) return { dir: home, real: realHome(ctx), label: 'your home folder' };
  if (ctx.cwd) {
    const cwd = path.resolve(ctx.cwd);
    if (isInside(cwd, file)) {
      let real;
      try { real = fs.realpathSync(cwd); } catch (e) { real = cwd; }
      return { dir: cwd, real, label: 'the project folder' };
    }
  }
  return { dir: home, real: realHome(ctx), label: 'your home folder' };
}

// The real path of `file`, following links in the file and in every folder above
// it. For a file that does not exist yet, the nearest existing folder is resolved.
function realPathOf(ctx, file, F) {
  let dir = file;
  const rest = [];
  for (;;) {
    try {
      return path.join(F.realpathSync(dir), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw unreadable(ctx, file, e);
      const up = path.dirname(dir);
      if (up === dir) return file;
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

// Where a read or write of `file` really lands. Links (on the file or on a folder
// above it) are followed only while they stay inside HOME, so a link can never
// make setup read or write somewhere else.
function resolveRealPath(ctx, file, F = fs) {
  const dp = displayPath(ctx, file);
  let lst;
  let exists = true;
  try { lst = F.lstatSync(file); } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw unreadable(ctx, file, e);
    exists = false;
  }
  if (lst && lst.isSymbolicLink()) {
    try { F.statSync(file); } catch (e) {
      if (e.code === 'ENOENT') throw new SetupError('file_unreadable', `${dp} is a symlink to a file that does not exist.`, { path: dp });
      throw unreadable(ctx, file, e);
    }
  }
  const real = realPathOf(ctx, file, F);
  const box = containerOf(ctx, file);
  if (!isInside(box.real, real)) {
    throw new SetupError('file_outside_home', `${dp} ${exists ? 'links to' : 'would be written through a link to'} ${real}, outside ${box.label}. Setup only reads and changes files inside it; replace the link with a real file or folder, or edit ${path.basename(file)} by hand.`, { path: dp });
  }
  // Linked when the file itself is a link or a folder above it points elsewhere.
  const linked = Boolean(lst && lst.isSymbolicLink()) || path.relative(box.real, real) !== path.relative(box.dir, path.resolve(file));
  if (!exists) return { exists: false, real, symlink: linked, stat: null };
  let stat;
  try { stat = F.statSync(real); } catch (e) { throw unreadable(ctx, file, e); }
  if (!stat.isFile()) throw new SetupError('file_not_text', `${dp} is not a regular file.`, { path: dp });
  return { exists: true, real, symlink: linked, stat };
}

function readSafe(ctx, file) {
  const info = resolveRealPath(ctx, file);
  if (!info.exists) return { ...info, bytes: null, text: null };
  const dp = displayPath(ctx, file);
  const tooLarge = (size) => new SetupError('file_too_large', `${dp} is ${size} bytes. Files over 1 MiB (${AGENT_FILE_MAX_BYTES} bytes) are not read.`, { path: dp, size, limit: AGENT_FILE_MAX_BYTES });
  if (info.stat.size > AGENT_FILE_MAX_BYTES) throw tooLarge(info.stat.size);
  let bytes;
  try { bytes = fs.readFileSync(info.real); } catch (e) { throw unreadable(ctx, file, e); }
  if (bytes.length > AGENT_FILE_MAX_BYTES) throw tooLarge(bytes.length);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch (e) {
    throw new SetupError('file_not_text', `${dp} is not UTF-8 text.`, { path: dp });
  }
  return { ...info, bytes, text };
}

// read(absPath) → { exists, text, revision } for planTarget.
function fileReader(ctx, { salt = crypto.randomBytes(16) } = {}) {
  return (file) => {
    const r = readSafe(ctx, file);
    return { exists: r.exists, text: r.text, revision: r.exists ? revisionOf(salt, r.bytes) : null };
  };
}

// ---------- options ----------

function normalizeModel(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new SetupError('invalid_option', `model is required. Use one of: ${VALID_MODELS.join(', ')}`, { field: 'model' });
  }
  const model = LEGACY_SEARCH_MODELS[id] || id;
  if (!VALID_MODELS.includes(model)) {
    throw new SetupError('invalid_option', `Unknown model ${id}. Use one of: ${VALID_MODELS.join(', ')}`, { field: 'model' });
  }
  return model;
}

function normalizeBaseUrl(value) {
  const bad = () => new SetupError('invalid_option', `base_url must be an http(s) origin like http://127.0.0.1:9655 (got ${String(value).slice(0, 200)})`, { field: 'base_url' });
  if (typeof value !== 'string' || !value.trim()) throw bad();
  let u;
  try { u = new URL(value.trim()); } catch (e) { throw bad(); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad();
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(value)) throw bad();
  if (!['', '/', '/v1', '/v1/'].includes(u.pathname)) throw bad();
  return `${u.protocol}//${u.host}`;
}

function validateOptions({ model, mode, baseUrl, scope } = {}) {
  const m = normalizeModel(model);
  if (mode !== 'add' && mode !== 'replace') {
    throw new SetupError('invalid_option', `mode must be add or replace (got ${String(mode).slice(0, 40)})`, { field: 'mode' });
  }
  const s = scope === undefined ? 'user' : scope;
  if (s !== 'user' && s !== 'project') {
    throw new SetupError('invalid_option', `scope must be user or project (got ${String(scope).slice(0, 40)})`, { field: 'scope' });
  }
  return { model: m, mode, baseUrl: normalizeBaseUrl(baseUrl), scope: s };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (hasArg(args, '--help', '-h')) return { help: true };
  const requestedModel = argValue(args, '--model', 'deepseek-v4-flash');
  const model = LEGACY_SEARCH_MODELS[requestedModel] || requestedModel;
  if (!VALID_MODELS.includes(model)) die(`Unknown --model ${model}. Use: ${VALID_MODELS.join(', ')}`);
  const mode = argValue(args, '--mode', 'add');
  if (!['add', 'replace'].includes(mode)) die('Unknown --mode. Use: add, replace');
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
    mode,
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
  node scripts/setup-agents.js --target claude-code,codex --model deepseek-v4-flash-thinking
  node scripts/setup-agents.js --dry-run --target hermes

Options:
  --target    ${VALID_TARGETS.join(' | ')} | comma-list
  --all       every target
  --model     ${VALID_MODELS.join(' | ')}
  --mode      add (default) | replace
  --base-url  proxy origin (default ${defaultBaseUrl()})
  --api-key   PROXY_API_KEY or "local"
  --scope     user (default) | project
  --dry-run   print files, write nothing
  --restore <dir>  put a previous run's files back (and remove files it created)

Safety:
  Setup only reads and writes files inside your home folder (or the project
  folder with --scope project). A config file, or a folder above it, that links
  outside that folder is refused, and so is a config file over 1 MiB. Nothing is
  written unless every selected agent can be planned; on a write error the
  files already written are put back.
`);
}

// ---------- config builders (shared by CLI and dashboard) ----------

function claudeSettings(opts) {
  const haiku = 'deepseek-v4-flash';
  const opus = 'deepseek-v4-flash-thinking';
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

function tomlEscape(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

// The structure of a TOML document, line by line: which lines are real table
// headers and where each key/value pair starts and ends. A line that starts
// with `[` inside a multi-line array or string is part of a value, not a header.
// → { headers: [{ name, start, end }], keys: [{ key, table, start, end }] }
// Offsets: start is the line start, end is the end of the pair's last line (no \n).
function tomlLayout(src) {
  const headers = [];
  const keys = [];
  let table = null;           // null = root
  let str = null;             // open multi-line string delimiter
  let depth = 0;              // open [ / { inside a value
  let open = null;            // the key pair still being read
  let pos = 0;
  // Advances over value text from i to the line end, tracking strings and brackets.
  const scan = (line, i) => {
    while (i < line.length) {
      if (str) {
        const close = line.indexOf(str, i);
        if (close === -1) return;
        if (str === '"""') {
          let bs = 0;
          for (let j = close - 1; j >= 0 && line[j] === '\\'; j--) bs++;
          if (bs % 2) { i = close + 1; continue; }
        }
        // """" or """"" close with the quotes before them as content.
        let end = close + 3;
        while (end < line.length && line[end] === str[0] && end - close < 5) end++;
        i = end;
        str = null;
        continue;
      }
      const c = line[i];
      if (c === '#') return;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) { str = line.slice(i, i + 3); i += 3; continue; }
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const close = line.indexOf("'", i + 1);
        i = close === -1 ? line.length : close + 1;
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && depth > 0) depth--;
      i++;
    }
  };
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? src.length : nl;
    const line = src.slice(pos, end);
    if (str || depth) {
      scan(line, 0);
    } else {
      const header = /^[ \t]*\[\[?\s*([^\]#]+?)\s*\]\]?[ \t]*(?:#.*)?$/.exec(line);
      const kv = header ? null : /^[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)[ \t]*=[ \t]*/.exec(line);
      if (header) {
        table = line.trimStart().startsWith('[[') ? `[[${header[1]}]]` : header[1];
        headers.push({ name: table, start: pos, end });
      } else if (kv) {
        open = { key: unquoteTomlKey(kv[1]), table, start: pos, end };
        scan(line, kv[0].length);
      }
    }
    if (open) {
      open.end = end;
      if (!str && !depth) { keys.push(open); open = null; }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (open) keys.push(open);
  return { headers, keys };
}

function unquoteTomlKey(k) {
  if (k.startsWith('"')) { try { return JSON.parse(k); } catch (e) { return k.slice(1, -1); } }
  if (k.startsWith("'")) return k.slice(1, -1);
  return k;
}

// Sets a root-level key, so a `model = …` inside [profiles.x] or another table
// is never touched. A new key goes at the top of the file.
function upsertTomlKey(text, key, value) {
  const line = `${key} = ${tomlEscape(value)}`;
  const src = String(text || '');
  const found = tomlLayout(src).keys.find(k => k.table === null && k.key === key);
  if (found) return src.slice(0, found.start) + line + src.slice(found.end);
  return `${line}\n${src}`;
}

// Replaces the whole [heading] table (up to the next real header) or appends it.
function upsertTomlTable(text, heading, body) {
  const src = String(text || '');
  const block = `[${heading}]\n${body.trim()}\n`;
  const { headers } = tomlLayout(src);
  const i = headers.findIndex(hd => hd.name === heading);
  if (i === -1) return `${src.replace(/\s*$/, '')}\n\n${block}`.replace(/^\n+/, '');
  const next = headers[i + 1];
  if (!next) return src.slice(0, headers[i].start) + block;
  return `${src.slice(0, headers[i].start)}${block}\n${src.slice(next.start)}`;
}

function yamlQuote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// A top-level `model:` scalar or block with every indented line under it. Blank
// lines belong to it only when more of the block follows them.
const YAML_MODEL_BLOCK_RE = /^model:[^\n]*(?:(?:\n[ \t]*(?=\n))*\n[ \t]+\S[^\n]*)*\n?/m;

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
  if (YAML_MODEL_BLOCK_RE.test(src)) return src.replace(YAML_MODEL_BLOCK_RE, () => block);
  return `${block}${src.startsWith('\n') ? '' : '\n'}${src}`;
}

const OPENCODE_AGENTS_MARKER = 'freedeepseek-autonomy';
const OPENCODE_AGENTS_GUIDANCE = `# FreeDeepseekAPI

This model is a chat agent, not a metered API. Token cost does not matter.

Finish the user's task autonomously: inspect the repo, make the changes, run the relevant checks, and keep going until the work is done or a real blocker (missing credential, destructive action, or a choice only the user can make). Do not ask clarifying questions, do not stop at a plan or a first step, and do not wait for permission. Finish every unblocked part first.

DeepSeek native Web Search is your web access. Use it for live information. Do not use bash, curl, or a harness web search tool, and do not say you have no web access.`;

function upsertMarkedSection(existing, marker, body) {
  const start = `<!-- ${marker} -->`;
  const end = `<!-- /${marker} -->`;
  const block = `${start}\n${String(body || '').trim()}\n${end}\n`;
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  const src = String(existing || '');
  if (re.test(src)) return src.replace(re, () => block);
  const base = src.replace(/\s*$/, '');
  return base ? `${base}\n\n${block}` : block;
}

function cursorSettingsSnippet(opts) {
  return {
    'openai.baseUrl': openaiBase(opts.baseUrl),
    'openai.apiBase': openaiBase(opts.baseUrl),
  };
}

function codexCatalog() {
  return {
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
      base_instructions: slug.endsWith('-nosearch')
        ? CODEX_BASE_INSTRUCTIONS
        : `${CODEX_BASE_INSTRUCTIONS} ${CODEX_NATIVE_SEARCH_INSTRUCTIONS}`,
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
}

// ---------- JSON with honest error positions ----------

// Offset of the first syntax error, found by a small JSON grammar walk. V8 does not
// always report a position, and its message can quote file text (maybe a secret),
// so the message shown is rebuilt from the error kind plus this offset.
function jsonErrorOffset(s) {
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const fail = () => { throw i; };
  const str = () => {
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c === '\\') { i += 2; continue; }
      if (c < ' ') fail();
      i++;
    }
    fail();
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; ws();
      if (s[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        str(); ws();
        if (s[i] !== ':') fail();
        i++; value(); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return; }
        fail();
      }
    }
    if (c === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return; }
        fail();
      }
    }
    if (c === '"') return str();
    const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (num && num[0]) { i += num[0].length; return; }
    for (const word of ['true', 'false', 'null']) if (s.startsWith(word, i)) { i += word.length; return; }
    fail();
  };
  try {
    value(); ws();
    if (i < s.length) fail();
    return null;
  } catch (pos) {
    return typeof pos === 'number' ? Math.min(pos, s.length) : null;
  }
}

function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

// The reason is built from the error position only. V8's message quotes up to
// ten characters of the file around the error, which can be part of a secret.
function jsonErrorReason(text, offset) {
  if (offset >= text.length) return 'The file ends too early';
  const c = text[offset];
  if ('{}[],:"'.includes(c)) return `Unexpected ${c}`;
  return 'Unexpected text';
}

function parseJsonFile(ctx, spec, text) {
  if (text === null || text === undefined || !String(text).trim()) return {};
  const dp = displayPath(ctx, spec.path);
  let value;
  try { value = JSON.parse(text); } catch (e) {
    const offset = jsonErrorOffset(text);
    if (offset === null) {
      // The grammar walk accepts what V8 rejects: say so instead of guessing a spot.
      throw new SetupError('invalid_existing_file', `${dp} is not valid JSON. Fix the file or restore a backup, then try again.`, { file_id: spec.id, path: dp, line: null, column: null });
    }
    const { line, column } = lineColumn(text, offset);
    throw new SetupError('invalid_existing_file', `${dp} is not valid JSON: ${jsonErrorReason(text, offset)} at line ${line}, column ${column}. Fix the file or restore a backup, then try again.`, { file_id: spec.id, path: dp, line, column });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SetupError('invalid_existing_file', `${dp} is not a JSON object. Fix the file or restore a backup, then try again.`, { file_id: spec.id, path: dp, line: 1, column: 1 });
  }
  return value;
}

// ---------- minimal TOML / YAML readers (inspection only) ----------

function tomlScalar(raw) {
  const v = String(raw).trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch (e) { return m[1]; } }
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end > 0) return v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, '');
}

function readTomlInfo(text) {
  const root = {};
  const tables = {};
  let current = root;
  for (const line of String(text || '').split('\n')) {
    const table = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      const name = table[1].trim();
      current = tables[name] = tables[name] || {};
      continue;
    }
    if (/^\s*\[\[/.test(line)) { current = {}; continue; }
    const kv = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) current[kv[1].replace(/^"|"$/g, '')] = tomlScalar(kv[2]);
  }
  return { root, tables };
}

function yamlScalar(raw) {
  const v = String(raw).trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch (e) { return m[1]; } }
  }
  if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(v);
    if (m) return m[1].replace(/''/g, "'");
  }
  return v.replace(/\s+#.*$/, '');
}

// The children of the top-level `model:` block, or { default } for `model: name`.
function readYamlModelBlock(text) {
  const m = YAML_MODEL_BLOCK_RE.exec(String(text || ''));
  if (!m) return null;
  const lines = m[0].split('\n');
  const head = yamlScalar(lines[0].slice('model:'.length));
  if (head) return { default: head };
  const out = {};
  for (const line of lines.slice(1)) {
    const kv = /^[ \t]+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = yamlScalar(kv[2]);
  }
  return out;
}

// ---------- registry ----------

const FORMAT_EXT = { json: '.json', toml: '.toml', yaml: '.yaml', markdown: '.md', shell: '.sh' };

// The only files setup may show or write. Paths are built here from ctx.home;
// nothing from a request or a manifest ever becomes a path on its own.
const FILE_TABLE = {
  'claude-code': [
    { id: 'profile', rel: ['.claude', 'freedeepseek.settings.json'], project: 'freedeepseek.settings.json', role: 'profile', format: 'json', modes: ['add'] },
    { id: 'settings', rel: ['.claude', 'settings.json'], project: 'settings.local.json', role: 'native', format: 'json', modes: ['replace'] },
  ],
  codex: [
    { id: 'profile', rel: ['.codex', 'freedeepseek.config.toml'], role: 'profile', format: 'toml', modes: ['add'] },
    { id: 'config', rel: ['.codex', 'config.toml'], role: 'native', format: 'toml', modes: ['replace'] },
    { id: 'catalog', rel: ['.codex', 'freedeepseek-models.json'], role: 'catalog', format: 'json', modes: ['add', 'replace'] },
  ],
  opencode: [
    { id: 'config', rel: ['.config', 'opencode', 'opencode.json'], role: 'native', format: 'json', modes: ['add', 'replace'] },
    { id: 'agents_md', rel: ['.config', 'opencode', 'AGENTS.md'], role: 'guidance', format: 'markdown', modes: ['add', 'replace'] },
  ],
  hermes: [
    { id: 'profile', rel: ['.hermes', 'freedeepseek.yaml'], role: 'profile', format: 'yaml', modes: ['add'] },
    { id: 'config', rel: ['.hermes', 'config.yaml'], role: 'native', format: 'yaml', modes: ['replace'] },
  ],
  openclaw: [
    { id: 'config', rel: ['.openclaw', 'openclaw.json'], role: 'native', format: 'json', modes: ['add', 'replace'] },
  ],
  cursor: [
    { id: 'settings_snippet', virtual: true, label: 'settings.json', role: 'snippet', format: 'json', modes: [] },
    { id: 'launcher', virtual: true, label: 'launch-cursor-deepseek.sh', role: 'snippet', format: 'shell', modes: [] },
  ],
};

function agentNotFound(id) {
  return new SetupError('agent_not_found', `No agent named ${String(id).slice(0, 64)}. Known: ${VALID_TARGETS.join(', ')}`);
}

function filesFor(target, ctx, { scope = 'user', projectDir } = {}) {
  const table = FILE_TABLE[target];
  if (!table) throw agentNotFound(target);
  if (scope === 'project' && target === 'claude-code' && !projectDir) {
    throw new SetupError('invalid_option', 'scope project needs the project folder.', { field: 'scope' });
  }
  return table.map((f) => {
    let p = null;
    if (!f.virtual) {
      p = scope === 'project' && f.project ? path.join(projectDir, '.claude', f.project) : path.join(ctx.home, ...f.rel);
    }
    return {
      id: f.id,
      label: f.virtual ? f.label : path.basename(p),
      role: f.role,
      format: f.format,
      path: p,
      display_path: f.virtual ? 'Generated (not written)' : displayPath(ctx, p),
      virtual: Boolean(f.virtual),
      modes: [...f.modes],
    };
  });
}

const REPLACE_USAGE = { label: 'Start it as usual', command: null, note: 'Starts on DeepSeek by default.' };

function pickerUsage(app) {
  return (mode, ctx, model) => (mode === 'replace' ? REPLACE_USAGE : {
    label: `Pick it in ${app}`, command: null, note: `Choose freedeepseek/${model || DEFAULT_MODEL} in the model picker.`,
  });
}

function planJson(h, id, build) {
  const spec = h.file(id);
  const existing = parseJsonFile(h.ctx, spec, h.cur(id).text);
  return { id, after: `${JSON.stringify(build(existing), null, 2)}\n` };
}

const TARGETS = {
  'claude-code': {
    name: 'Claude Code',
    kind: 'cli',
    binaries: ['claude'],
    configDir: ['.claude'],
    native: 'settings',
    modes: [
      { value: 'add', title: 'Alongside', description: 'Claude Code keeps its own models. Start it with the FreeDeepseekAPI settings file when you want DeepSeek.', writes: ['profile'] },
      { value: 'replace', title: 'As default', description: 'Claude Code starts on DeepSeek every time. Your other settings in settings.json stay.', writes: ['settings'] },
    ],
    fixedModels: [
      { slot: 'Fast tasks (Haiku)', model: 'deepseek-v4-flash' },
      { slot: 'Hard tasks (Opus)', model: 'deepseek-v4-flash-thinking' },
      { slot: 'Subagents', model: 'deepseek-v4-flash' },
    ],
    effects: [],
    usage(mode, ctx) {
      if (mode === 'replace') return REPLACE_USAGE;
      return { label: 'Start it with', command: `claude --settings ${displayPath(ctx, path.join(ctx.home, '.claude', 'freedeepseek.settings.json'))}`, note: null };
    },
    plan(opts, h) {
      if (opts.mode === 'replace') return [planJson(h, 'settings', existing => mergeClaudeSettings(existing, claudeSettings(opts)))];
      return [{ id: 'profile', after: `${JSON.stringify(claudeSettings(opts), null, 2)}\n` }];
    },
    inspect(h) {
      const settings = h.json('settings') || {};
      const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
      const profile = h.json('profile') || {};
      const penv = profile.env && typeof profile.env === 'object' ? profile.env : {};
      if (env.ANTHROPIC_BASE_URL && (h.pointsHere(env.ANTHROPIC_BASE_URL) || /^deepseek-/.test(String(env.ANTHROPIC_MODEL || '')))) {
        return { wired: 'default', file_id: 'settings', model: env.ANTHROPIC_MODEL || settings.model || null, base_url: env.ANTHROPIC_BASE_URL, key: env.ANTHROPIC_AUTH_TOKEN };
      }
      if (penv.ANTHROPIC_BASE_URL) {
        return { wired: 'alongside', file_id: 'profile', model: penv.ANTHROPIC_MODEL || profile.model || null, base_url: penv.ANTHROPIC_BASE_URL, key: penv.ANTHROPIC_AUTH_TOKEN };
      }
      return { wired: null };
    },
  },
  codex: {
    name: 'Codex',
    kind: 'cli',
    binaries: ['codex'],
    configDir: ['.codex'],
    native: 'config',
    modes: [
      { value: 'add', title: 'Alongside', description: 'Codex keeps its own default model. Start it with the FreeDeepseekAPI profile when you want DeepSeek.', writes: ['profile', 'catalog'] },
      { value: 'replace', title: 'As default', description: 'Codex starts on DeepSeek every time. Your other settings in config.toml stay.', writes: ['config', 'catalog'] },
    ],
    fixedModels: [],
    effects: [],
    usage(mode) {
      if (mode === 'replace') return REPLACE_USAGE;
      return { label: 'Start it with', command: 'codex --profile freedeepseek', note: 'Codex 0.134 or newer reads profiles from ~/.codex/<name>.config.toml.' };
    },
    plan(opts, h) {
      const catalogPath = h.file('catalog').path;
      const providerBody = [
        'name = "FreeDeepseekAPI"',
        `base_url = ${tomlEscape(openaiBase(opts.baseUrl))}`,
        'wire_api = "responses"',
        `experimental_bearer_token = ${tomlEscape(opts.apiKey)}`,
      ].join('\n');
      const out = [];
      if (opts.mode === 'replace') {
        let next = h.cur('config').text || '';
        next = upsertTomlKey(next, 'model', opts.model);
        next = upsertTomlKey(next, 'model_provider', 'freedeepseek');
        next = upsertTomlKey(next, 'model_catalog_json', catalogPath);
        next = upsertTomlTable(next, 'model_providers.freedeepseek', providerBody);
        out.push({ id: 'config', after: next });
      } else {
        out.push({
          id: 'profile',
          after: [
            `model = ${tomlEscape(opts.model)}`,
            'model_provider = "freedeepseek"',
            `model_catalog_json = ${tomlEscape(catalogPath)}`,
            '',
            '[model_providers.freedeepseek]',
            providerBody,
            '',
          ].join('\n'),
        });
      }
      out.push({ id: 'catalog', after: `${JSON.stringify(codexCatalog(), null, 2)}\n` });
      return out;
    },
    inspect(h) {
      const cfg = readTomlInfo(h.text('config'));
      const profile = readTomlInfo(h.text('profile'));
      const provider = (info) => info.tables['model_providers.freedeepseek'];
      let found = null;
      if (cfg.root.model_provider === 'freedeepseek') {
        const p = provider(cfg) || {};
        found = { wired: 'default', file_id: 'config', model: cfg.root.model || null, base_url: p.base_url || null, key: p.experimental_bearer_token };
      } else if (h.exists('profile')) {
        const own = provider(profile);
        const p = own || provider(cfg) || {};
        found = { wired: 'alongside', file_id: own || !provider(cfg) ? 'profile' : 'config', model: profile.root.model || null, base_url: p.base_url || null, key: p.experimental_bearer_token };
      }
      if (!found) return { wired: null };
      if (!h.exists('catalog')) {
        found.issues = [{ code: 'catalog_missing', file_id: 'catalog', message: `${h.file('catalog').display_path} is missing, so Codex can't list the DeepSeek models.` }];
      }
      return found;
    },
  },
  opencode: {
    name: 'OpenCode',
    kind: 'cli',
    binaries: ['opencode'],
    configDir: ['.config', 'opencode'],
    native: 'config',
    modes: [
      { value: 'add', title: 'Alongside', description: 'OpenCode keeps its default model. DeepSeek shows up in the model picker under freedeepseek.', writes: ['config', 'agents_md'] },
      { value: 'replace', title: 'As default', description: 'OpenCode starts on DeepSeek every time. Your other settings in opencode.json stay.', writes: ['config', 'agents_md'] },
    ],
    fixedModels: [],
    effects: [
      "Turns off OpenCode's own web search and web fetch tools for every model, and denies them in permissions.",
      'Resizes attached images to at most 2000 × 2000 px for every model.',
      'Adds a FreeDeepseekAPI section to ~/.config/opencode/AGENTS.md, which every OpenCode model reads.',
      'If the default model is already a freedeepseek/ model, sets it to freedeepseek/deepseek-v4-flash-thinking.',
    ],
    usage: pickerUsage('OpenCode'),
    plan(opts, h) {
      const config = planJson(h, 'config', (cfg) => {
        const models = {};
        for (const id of VALID_MODELS) {
          models[id] = {
            name: OPENCODE_MODEL_LABEL,
            attachment: true,
            reasoning: id.includes('thinking'),
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 1048576, output: 8192 },
          };
        }
        cfg.$schema = cfg.$schema || 'https://opencode.ai/config.json';
        cfg.provider = cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
        cfg.provider.freedeepseek = {
          npm: '@ai-sdk/openai-compatible',
          name: OPENCODE_PROVIDER_LABEL,
          options: { baseURL: openaiBase(opts.baseUrl), apiKey: opts.apiKey },
          models,
        };
        cfg.tools = { ...(cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {}), websearch: false, webfetch: false };
        cfg.permission = { ...(cfg.permission && typeof cfg.permission === 'object' ? cfg.permission : {}), websearch: 'deny', webfetch: 'deny' };
        if (String(cfg.model || '').startsWith('freedeepseek/')) cfg.model = 'freedeepseek/deepseek-v4-flash-thinking';
        if (opts.mode === 'replace') cfg.model = `freedeepseek/${opts.model}`;
        cfg.attachment = cfg.attachment && typeof cfg.attachment === 'object' ? cfg.attachment : {};
        cfg.attachment.image = {
          ...(cfg.attachment.image || {}),
          auto_resize: true,
          max_width: 2000,
          max_height: 2000,
          max_base64_bytes: 5242880,
        };
        return cfg;
      });
      return [config, { id: 'agents_md', after: upsertMarkedSection(h.cur('agents_md').text, OPENCODE_AGENTS_MARKER, OPENCODE_AGENTS_GUIDANCE) }];
    },
    inspect(h) {
      const cfg = h.json('config') || {};
      const prov = cfg.provider && cfg.provider.freedeepseek;
      const options = prov && prov.options ? prov.options : {};
      const model = String(cfg.model || '');
      if (model.startsWith('freedeepseek/')) return { wired: 'default', file_id: 'config', model: model.slice('freedeepseek/'.length), base_url: options.baseURL || null, key: options.apiKey };
      if (prov) return { wired: 'alongside', file_id: 'config', model: null, base_url: options.baseURL || null, key: options.apiKey };
      return { wired: null };
    },
  },
  hermes: {
    name: 'Hermes',
    kind: 'cli',
    binaries: ['hermes'],
    configDir: ['.hermes'],
    native: 'config',
    modes: [
      { value: 'add', title: 'Alongside', description: "Writes a separate freedeepseek.yaml and leaves config.yaml alone. Hermes doesn't load that file by itself: copy its model block into a Hermes profile, or install as default.", writes: ['profile'] },
      { value: 'replace', title: 'As default', description: 'Hermes starts on DeepSeek every time. Only the model section of config.yaml changes.', writes: ['config'] },
    ],
    fixedModels: [],
    effects: [],
    usage(mode) {
      if (mode === 'replace') return REPLACE_USAGE;
      return {
        label: "Hermes doesn't load this file",
        command: null,
        note: 'Hermes reads ~/.hermes/config.yaml, or ~/.hermes/profiles/<name>/config.yaml with hermes -p <name>. Copy the model block into one of those, or install as default.',
      };
    },
    plan(opts, h) {
      const id = opts.mode === 'replace' ? 'config' : 'profile';
      const next = upsertYamlModelBlock(opts.mode === 'replace' ? h.cur('config').text : '', opts);
      return [{ id, after: next.endsWith('\n') ? next : `${next}\n` }];
    },
    inspect(h) {
      const cfg = readYamlModelBlock(h.text('config'));
      if (cfg && cfg.base_url && (h.pointsHere(cfg.base_url) || (cfg.provider === 'custom' && /^deepseek-/.test(String(cfg.default || ''))))) {
        return { wired: 'default', file_id: 'config', model: cfg.default || null, base_url: cfg.base_url, key: cfg.api_key };
      }
      if (h.exists('profile')) {
        const prof = readYamlModelBlock(h.text('profile')) || {};
        return { wired: 'alongside', file_id: 'profile', model: prof.default || null, base_url: prof.base_url || null, key: prof.api_key };
      }
      return { wired: null };
    },
  },
  openclaw: {
    name: 'OpenClaw',
    kind: 'cli',
    binaries: ['openclaw'],
    configDir: ['.openclaw'],
    native: 'config',
    modes: [
      { value: 'add', title: 'Alongside', description: 'OpenClaw keeps its primary model. DeepSeek is added as the freedeepseek provider.', writes: ['config'] },
      { value: 'replace', title: 'As default', description: 'OpenClaw uses DeepSeek as its primary model. Your other settings in openclaw.json stay.', writes: ['config'] },
    ],
    fixedModels: [],
    effects: [],
    usage: pickerUsage('OpenClaw'),
    plan(opts, h) {
      return [planJson(h, 'config', (cfg) => {
        const models = VALID_MODELS.map(id => ({
          id,
          name: id,
          reasoning: id.includes('thinking'),
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }));
        cfg.models = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
        cfg.models.mode = cfg.models.mode || 'merge';
        cfg.models.providers = cfg.models.providers || {};
        cfg.models.providers.freedeepseek = {
          baseUrl: openaiBase(opts.baseUrl),
          apiKey: opts.apiKey,
          api: 'openai-completions',
          models,
        };
        if (opts.mode === 'replace') {
          cfg.agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
          cfg.agents.defaults = cfg.agents.defaults && typeof cfg.agents.defaults === 'object' ? cfg.agents.defaults : {};
          cfg.agents.defaults.model = { primary: `freedeepseek/${opts.model}` };
        }
        return cfg;
      })];
    },
    inspect(h) {
      const cfg = h.json('config') || {};
      const prov = cfg.models && cfg.models.providers && cfg.models.providers.freedeepseek;
      const primary = String((((cfg.agents || {}).defaults || {}).model || {}).primary || '');
      const p = prov || {};
      if (primary.startsWith('freedeepseek/')) return { wired: 'default', file_id: 'config', model: primary.slice('freedeepseek/'.length), base_url: p.baseUrl || null, key: p.apiKey };
      if (prov) return { wired: 'alongside', file_id: 'config', model: null, base_url: p.baseUrl || null, key: p.apiKey };
      return { wired: null };
    },
  },
  cursor: {
    name: 'Cursor',
    kind: 'editor',
    binaries: ['cursor'],
    configDir: ['.cursor'],
    native: 'settings_snippet',
    modes: [],
    fixedModels: [],
    effects: [],
    usage() { return null; },
    plan(opts) {
      const settings = `${JSON.stringify({
        ...cursorSettingsSnippet(opts),
        '//openaiApiKey': 'Paste PROXY_API_KEY (or "local") in Cursor Settings → Models → OpenAI API Key',
        '//addModels': VALID_MODELS,
        '//overrideOpenAiBaseUrl': openaiBase(opts.baseUrl),
      }, null, 2)}\n`;
      // apiKeyRef (dashboard): the launcher reads the key from the shell, so the
      // browser never receives it. The CLI keeps baking in --api-key.
      const keyLine = opts.apiKeyRef
        ? 'export OPENAI_API_KEY="${PROXY_API_KEY:-local}"'
        : `export OPENAI_API_KEY=${JSON.stringify(opts.apiKey)}`;
      const launch = `#!/bin/sh
# Launch Cursor with FreeDeepseekAPI as the OpenAI-compatible endpoint.
export OPENAI_BASE_URL=${JSON.stringify(openaiBase(opts.baseUrl))}
${keyLine}
if command -v cursor >/dev/null 2>&1; then
  exec cursor "$@"
fi
if [ "$(uname)" = Darwin ] && [ -d "/Applications/Cursor.app" ]; then
  exec open -a Cursor --args "$@"
fi
echo "Cursor CLI/app not found. Set Override OpenAI Base URL to $OPENAI_BASE_URL" >&2
exit 1
`;
      return [{ id: 'settings_snippet', after: settings }, { id: 'launcher', after: launch }];
    },
    inspect() { return { wired: null }; },
  },
};
for (const id of VALID_TARGETS) TARGETS[id].files = (ctx, scope) => filesFor(id, ctx, scope);

// ---------- planner ----------

// Pure: reads through `read`, never writes. Returns every file the mode writes,
// with before/after text and create | update | unchanged.
function planTarget(target, opts, ctx, { read }) {
  const def = TARGETS[target];
  if (!def) throw agentNotFound(target);
  const specs = filesFor(target, ctx, { scope: opts.scope, projectDir: opts.projectDir });
  const byId = Object.fromEntries(specs.map(f => [f.id, f]));
  const cache = {};
  const cur = (id) => {
    if (!cache[id]) cache[id] = byId[id].virtual ? { exists: false, text: null, revision: null } : read(byId[id].path);
    return cache[id];
  };
  const outputs = def.plan(opts, { ctx, file: id => byId[id], cur });
  const order = specs.map(f => f.id);
  outputs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    target,
    options: { model: opts.model, mode: opts.mode, baseUrl: opts.baseUrl, ...(opts.scope === 'project' ? { scope: 'project', projectDir: opts.projectDir } : {}) },
    files: outputs.map(({ id, after }) => {
      const spec = byId[id];
      const c = cur(id);
      return {
        ...spec,
        existed: c.exists,
        revision: c.revision,
        before: c.exists ? c.text : null,
        after,
        action: spec.virtual || !c.exists ? 'create' : (c.text === after ? 'unchanged' : 'update'),
      };
    }),
    effects: [...def.effects],
    usage: def.usage(opts.mode, ctx, opts.model),
  };
}

// ---------- inspection ----------

function proxyIdentity(url) {
  try {
    const u = new URL(String(url).trim());
    let host = u.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) host = 'loopback';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const p = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${u.protocol}//${host}:${port}${p}`;
  } catch (e) {
    return null;
  }
}
function sameProxy(a, b) {
  const ia = proxyIdentity(a);
  return ia !== null && ia === proxyIdentity(b);
}

function detectTool(target, ctx) {
  const def = TARGETS[target];
  for (const dir of String(ctx.pathEnv || '').split(path.delimiter).filter(Boolean)) {
    for (const bin of def.binaries) {
      const p = path.join(dir, bin);
      try {
        if (fs.statSync(p).isFile()) {
          fs.accessSync(p, fs.constants.X_OK);
          return { found: true, how: 'path', detail: p };
        }
      } catch (e) { /* not here */ }
    }
  }
  if (target === 'cursor' && ctx.platform === 'darwin' && fs.existsSync('/Applications/Cursor.app')) {
    return { found: true, how: 'app', detail: '/Applications/Cursor.app' };
  }
  const dir = path.join(ctx.home, ...def.configDir);
  try {
    if (fs.statSync(dir).isDirectory()) return { found: true, how: 'config_dir', detail: displayPath(ctx, dir) };
  } catch (e) { /* missing */ }
  return { found: false, how: null, detail: null };
}

function octalMode(mode) { return (mode & 0o777).toString(8).padStart(4, '0'); }

function virtualMeta(spec, text, salt) {
  return {
    ...spec,
    exists: true,
    size: Buffer.byteLength(text, 'utf8'),
    mtime: null,
    file_mode: null,
    symlink_target: null,
    revision: revisionOf(salt, text),
    error: null,
  };
}

function cursorTexts(proxy) {
  const out = TARGETS.cursor.plan({ model: DEFAULT_MODEL, mode: 'add', baseUrl: proxy.baseUrl, apiKey: 'local', apiKeyRef: true });
  return Object.fromEntries(out.map(o => [o.id, o.after]));
}

function diskMeta(ctx, spec, salt) {
  const base = { ...spec, exists: false, size: null, mtime: null, file_mode: null, symlink_target: null, revision: null, error: null };
  try {
    const r = readSafe(ctx, spec.path);
    if (!r.exists) return { meta: base, text: null };
    return {
      meta: {
        ...base,
        exists: true,
        size: r.stat.size,
        mtime: Math.round(r.stat.mtimeMs),
        file_mode: octalMode(r.stat.mode),
        symlink_target: r.symlink ? displayPath(ctx, r.real) : null,
        revision: revisionOf(salt, r.bytes),
      },
      text: r.text,
    };
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    let st = null;
    try { st = fs.lstatSync(spec.path); } catch (err) { /* gone */ }
    return {
      meta: { ...base, exists: true, size: st ? st.size : null, mtime: st ? Math.round(st.mtimeMs) : null, error: { type: e.code, message: e.message } },
      text: null,
    };
  }
}

function readAgentFile(ctx, target, fileId, { salt, baseUrl }) {
  const def = TARGETS[target];
  if (!def) throw agentNotFound(target);
  const spec = filesFor(target, ctx).find(f => f.id === fileId);
  if (!spec) {
    throw new SetupError('unknown_file', `${def.name} has no file ${String(fileId).slice(0, 64)}. Known: ${filesFor(target, ctx).map(f => f.id).join(', ')}`);
  }
  if (spec.virtual) {
    const text = cursorTexts({ baseUrl })[spec.id];
    return { meta: virtualMeta(spec, text, salt), text };
  }
  const r = readSafe(ctx, spec.path);
  if (!r.exists) throw new SetupError('file_missing', `${spec.display_path} does not exist.`, { path: spec.display_path });
  return {
    meta: {
      ...spec,
      exists: true,
      size: r.stat.size,
      mtime: Math.round(r.stat.mtimeMs),
      file_mode: octalMode(r.stat.mode),
      symlink_target: r.symlink ? displayPath(ctx, r.real) : null,
      revision: revisionOf(salt, r.bytes),
      error: null,
    },
    text: r.text,
  };
}

function isKnownModel(id) {
  try { normalizeModel(id); return true; } catch (e) { return false; }
}

// AgentSummary: what the agent reads now, whether it reaches this proxy, and
// the options the dashboard preselects. Never contains a stored key.
function inspectTarget(target, ctx, { baseUrl, apiKey, salt }) {
  const def = TARGETS[target];
  if (!def) throw agentNotFound(target);
  const specs = filesFor(target, ctx);
  const metas = {};
  const texts = {};
  const virtualTexts = target === 'cursor' ? cursorTexts({ baseUrl }) : {};
  for (const spec of specs) {
    if (spec.virtual) {
      metas[spec.id] = virtualMeta(spec, virtualTexts[spec.id], salt);
      texts[spec.id] = virtualTexts[spec.id];
    } else {
      const { meta, text } = diskMeta(ctx, spec, salt);
      metas[spec.id] = meta;
      texts[spec.id] = text;
    }
  }
  const unreadableIssues = [];
  const noteError = (id) => {
    const m = metas[id];
    if (m.error && !unreadableIssues.some(i => i.file_id === id)) unreadableIssues.push({ code: 'file_unreadable', file_id: id, message: m.error.message });
  };
  const h = {
    ctx,
    file: id => metas[id],
    exists: id => metas[id].exists && !metas[id].error,
    text: (id) => { noteError(id); return texts[id]; },
    json(id) {
      noteError(id);
      if (texts[id] === null || texts[id] === undefined) return null;
      try {
        return parseJsonFile(ctx, metas[id], texts[id]);
      } catch (e) {
        if (!(e instanceof SetupError)) throw e;
        unreadableIssues.push({ code: 'file_unreadable', file_id: id, message: e.message, line: e.extra.line, column: e.extra.column });
        return null;
      }
    },
    pointsHere: url => sameProxy(url, baseUrl),
  };

  let setup;
  if (target === 'cursor') {
    setup = { state: 'manual', mode: null, model: null, base_url: null, points_here: null, key: null, issues: [] };
  } else {
    const found = def.inspect(h);
    const wired = found.wired;
    const issues = [];
    let pointsHere = null;
    let key = null;
    // Values from the file are shown masked: a gateway URL can carry a token.
    const masked = v => maskValue(v, { proxyKey: apiKey, salt });
    const shownUrl = found.base_url ? masked(found.base_url) : null;
    const knownModel = found.model && isKnownModel(found.model) ? normalizeModel(found.model) : null;
    const shownModel = found.model ? (knownModel || masked(found.model)) : null;
    if (wired) {
      const label = metas[found.file_id].label;
      pointsHere = found.base_url ? sameProxy(found.base_url, baseUrl) : false;
      if (!pointsHere) {
        const proxyForm = /\/v1\/?$/.test(String(found.base_url || '')) || !found.base_url ? openaiBase(baseUrl) : anthropicBase(baseUrl);
        issues.push({
          code: 'base_url_mismatch',
          file_id: found.file_id,
          message: found.base_url
            ? `${label} sends ${def.name} to ${shownUrl}, not this proxy (${proxyForm}).`
            : `${label} has no FreeDeepseekAPI address for ${def.name}.`,
        });
      }
      const stored = found.key === undefined || found.key === null ? '' : String(found.key);
      key = !stored ? 'missing' : (stored === apiKey ? 'matches' : 'differs');
      if (key === 'differs' || (key === 'missing' && apiKey !== 'local')) {
        issues.push({ code: 'key_differs', file_id: found.file_id, message: key === 'missing' ? `${label} sends no access key, but this proxy needs its PROXY_API_KEY.` : `${label} sends a different access key than this proxy expects.` });
      }
      if (found.model && !knownModel) {
        issues.push({ code: 'model_unknown', file_id: found.file_id, message: `${label} asks for ${shownModel}, which this proxy doesn't serve. Pick a current model and apply.` });
      }
      issues.push(...(found.issues || []));
    }
    let state = wired || 'none';
    if (unreadableIssues.length) state = 'unreadable';
    else if (wired && issues.length) state = 'outdated';
    setup = {
      state,
      mode: wired === 'default' ? 'replace' : wired === 'alongside' ? 'add' : null,
      // An older name of a served model (…-search) reads as the model it names now.
      model: wired ? shownModel : null,
      ...(wired && knownModel && knownModel !== found.model ? { model_written: found.model } : {}),
      base_url: wired ? shownUrl : null,
      points_here: wired ? pointsHere : null,
      key,
      issues: [...unreadableIssues, ...issues],
    };
  }

  const hasProfile = specs.some(f => f.id === 'profile');
  const entry = target === 'cursor' ? 'settings_snippet' : (setup.mode === 'add' && hasProfile ? 'profile' : def.native);
  const setUp = setup.mode && setup.points_here;
  const defaults = {
    model: setUp && setup.model && isKnownModel(setup.model) ? normalizeModel(setup.model) : DEFAULT_MODEL,
    mode: setUp ? setup.mode : 'add',
    base_url: baseUrl,
  };
  return {
    id: target,
    name: def.name,
    kind: def.kind,
    writable: target !== 'cursor',
    tool: detectTool(target, ctx),
    setup,
    entry_file: entry,
    defaults,
    modes: def.modes.map(m => ({ ...m, writes: [...m.writes], usage: def.usage(m.value, ctx, defaults.model) })),
    fixed_models: def.fixedModels.map(f => ({ ...f })),
    effects: [...def.effects],
    usage: setup.mode ? def.usage(setup.mode, ctx, setup.model || defaults.model) : null,
    files: specs.map(f => metas[f.id]),
  };
}

// ---------- secret masking ----------

// Key names whose values are secrets. Substrings first (apiKey, AUTH_TOKEN), then
// a trailing key/pat/auth word (key, DEEPSEEK_KEY, GITHUB_PAT, X-Auth, accessKey).
// Names that only point at a secret (env_key = "OPENAI_API_KEY", key_file, …) are not.
const SECRET_KEY_RE = /(api[_-]?key|apikey|token|secret|password|passwd|passphrase|authorization|bearer|cookie|credential|private[_-]?key|client[_-]?secret)/i;
const SECRET_KEY_END_RE = /(?:^|[_.\-\s])(?:key|keys|pat|auth|pass|pwd)$/i;
const SECRET_KEY_CAMEL_RE = /[a-z0-9](?:Key|Keys|Pat|Auth)$/;
const NOT_SECRET_KEY_RE = /(?:^|[_.\-]|[a-z0-9])(?:env[_-]?key|file|path|env|name|names|id|ids|type|url|uri|header|helper|cmd|command|count|length|limit|ttl)$/i;
function isSecretKey(name) {
  const k = String(name || '');
  // "//note" keys are JSON comments (the Cursor snippet uses them); the value
  // pass below still catches a credential pasted into one.
  if (!k || k.startsWith('//') || NOT_SECRET_KEY_RE.test(k)) return false;
  return SECRET_KEY_RE.test(k) || SECRET_KEY_END_RE.test(k) || SECRET_KEY_CAMEL_RE.test(k);
}
// `--api-key`, `-token`, `--key=value`: a command-line flag whose value is a secret.
const FLAG_RE = /^(--?[A-Za-z][A-Za-z0-9_-]*)(=.*)?$/;
function secretFlag(arg) {
  const m = FLAG_RE.exec(String(arg));
  if (!m || !isSecretKey(m[1].replace(/^-+/, ''))) return null;
  return { name: m[1], inline: m[2] === undefined ? null : m[2].slice(1) };
}
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
// "${PROXY_API_KEY:-local}" or "$TOKEN" names a variable; it is not itself a secret.
const ENV_REF_RE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=?+][^}]*)?\}|[A-Za-z_][A-Za-z0-9_]*)$/;

function secretToken(value, { proxyKey, salt }) {
  return proxyKey && value === proxyKey
    ? { text: '‹proxy-key›', kind: 'proxy_key' }
    : { text: `‹secret:${crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 6)}›`, kind: 'secret' };
}

// A single value read from a config (a base URL, a model ID) made safe to show:
// the password in user:pass@, secret query values, token-like path segments and
// known credential shapes are replaced. Everything else stays as written.
const TOKENISH_RE = /^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}$|^[0-9a-f]{32,}$/i;
function maskValue(value, opts) {
  if (value === null || value === undefined) return value;
  let out = String(value);
  const tok = v => secretToken(v, opts).text;
  out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i, (all, scheme, info) => {
    const colon = info.indexOf(':');
    return colon === -1 ? `${scheme}${tok(info)}@` : `${scheme}${info.slice(0, colon)}:${tok(info.slice(colon + 1))}@`;
  });
  out = out.replace(/([?&;])([^=&#;]+)=([^&#;]*)/g, (all, sep, name, v) => {
    let n = name;
    try { n = decodeURIComponent(name); } catch (e) { /* keep as written */ }
    return v && isSecretKey(n) ? `${sep}${name}=${tok(v)}` : all;
  });
  out = out.replace(/(^[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/i, (all, origin, p) => (origin || '') + p.split('/').map((seg) => {
    if (TOKENISH_RE.test(seg) && (/^[0-9a-f]+$/i.test(seg) ? seg.length >= 32 : /[a-z]/.test(seg) && /[A-Z]/.test(seg))) return tok(seg);
    return seg;
  }).join('/'));
  return maskSecrets(out, null, opts).text;
}

function quotedEnd(line, start, quote) {
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') { i++; continue; }
    if (line[i] === quote) {
      if (quote === "'" && line[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

function unquoteKey(k) {
  if (/^".*"$/.test(k)) { try { return JSON.parse(k); } catch (e) { return k.slice(1, -1); } }
  if (/^'.*'$/.test(k)) return k.slice(1, -1);
  return k;
}

function forEachLine(src, fn) {
  let pos = 0;
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? src.length : nl;
    const skipTo = fn(src.slice(pos, end), pos, end);
    if (typeof skipTo === 'number' && skipTo > end) {
      const next = src.indexOf('\n', skipTo);
      if (next === -1) break;
      pos = next + 1;
      continue;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
}

// One element of an argument list. `owner` is the secret key the whole list
// belongs to (every element is masked) or null; `state.flag` carries a secret
// flag over to the element after it ("--api-key", "value").
function argSpan(spans, state, owner, start, end, value) {
  if (owner) { spans.push({ start, end, key: owner, value }); state.flag = null; return; }
  if (state.flag) { spans.push({ start, end, key: state.flag, value }); state.flag = null; return; }
  const f = secretFlag(value);
  if (!f) return;
  if (f.inline === null) { state.flag = f.name; return; }
  const at = end - f.inline.length;
  if (f.inline) spans.push({ start: at, end, key: f.name, value: f.inline });
}

// A bracketed list starting at src[i] === '[' (TOML array or YAML flow sequence):
// quoted elements, and plain ones when `plain` is set. Returns the index after `]`.
function listSpans(src, i, owner, spans, { plain = false } = {}) {
  const state = { flag: null };
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const close = quotedEnd(src, i, c);
      if (close === -1) return src.length;
      const raw = src.slice(i + 1, close);
      let value = raw;
      if (c === '"') { try { value = JSON.parse(`"${raw}"`); } catch (e) { value = raw; } }
      if (depth === 1) argSpan(spans, state, owner, i + 1, close, value);
      i = close + 1;
      continue;
    }
    if (c === '#' && !plain) { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') { depth--; i++; if (depth === 0) return i; continue; }
    if (plain && depth === 1 && !/[\s,]/.test(c)) {
      const m = /^[^,\]\n]*/.exec(src.slice(i));
      const text = m[0].replace(/\s+$/, '');
      argSpan(spans, state, owner, i, i + text.length, text);
      i += Math.max(1, m[0].length);
      continue;
    }
    i++;
  }
  return src.length;
}

function jsonSecretSpans(src, spans) {
  // Open objects and arrays. An array or object that is the value of a secret
  // key is secret as a whole; arrays also carry a pending secret flag.
  const stack = [];
  let pendingKey = null;
  let i = 0;
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
      const end = i;
      i++;
      const raw = src.slice(start, end + 1);
      let value;
      try { value = JSON.parse(raw); } catch (e) { value = raw.slice(1, -1); }
      const t = top();
      if (pendingKey === null && t && !t.arr) {
        let j = i;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ':') { pendingKey = value; i = j + 1; continue; }
      }
      const key = pendingKey;
      pendingKey = null;
      if (key !== null && isSecretKey(key)) spans.push({ start: start + 1, end, key, value });
      else if (t && t.arr) argSpan(spans, t, t.secret, start + 1, end, value);
      else if (t && t.secret) spans.push({ start: start + 1, end, key: t.secret, value });
      continue;
    }
    if (c === '{' || c === '[') {
      const t = top();
      const secret = pendingKey !== null && isSecretKey(pendingKey) ? pendingKey : (t ? t.secret : null);
      if (t && t.arr) t.flag = null;
      stack.push({ arr: c === '[', secret, flag: null });
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '}' || c === ']') { stack.pop(); pendingKey = null; i++; continue; }
    if (!/[\s,]/.test(c)) {
      // A number, true, false or null.
      pendingKey = null;
      const t = top();
      if (t && t.arr) t.flag = null;
      while (i < src.length && !/[\s,\]}]/.test(src[i])) i++;
      continue;
    }
    i++;
  }
}

// `key = "…"` pairs at the start of a line or inside an inline table
// (`env = { API_KEY = "…" }`, common for Codex MCP servers).
const TOML_PAIR_RE = /(^|[{,])(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)(\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g;

function tomlSecretSpans(src, spans) {
  forEachLine(src, (line, lineStart) => {
    if (/^\s*#/.test(line)) return null;
    const m = /^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)(\s*=\s*)/.exec(line);
    if (m) {
      const key = unquoteKey(m[2]);
      const valStart = lineStart + m[0].length;
      if (src[valStart] === '[') return listSpans(src, valStart, isSecretKey(key) ? key : null, spans) - 1;
      if (isSecretKey(key)) {
        for (const triple of ['"""', "'''"]) {
          if (src.startsWith(triple, valStart)) {
            const close = src.indexOf(triple, valStart + 3);
            if (close === -1) return null;
            spans.push({ start: valStart + 3, end: close, key, value: src.slice(valStart + 3, close) });
            return close;
          }
        }
      }
    }
    TOML_PAIR_RE.lastIndex = 0;
    for (let p = TOML_PAIR_RE.exec(line); p; p = TOML_PAIR_RE.exec(line)) {
      const key = unquoteKey(p[3]);
      if (!isSecretKey(key)) continue;
      const valStart = lineStart + p.index + p[1].length + p[2].length + p[3].length + p[4].length;
      const raw = p[5].slice(1, -1);
      let value = raw;
      if (p[5][0] === '"') { try { value = JSON.parse(`"${raw}"`); } catch (e) { value = raw; } }
      spans.push({ start: valStart + 1, end: valStart + p[5].length - 1, key, value });
    }
    return null;
  });
}

// A YAML scalar at src[start…]: quoted (inside the quotes) or plain (up to a comment).
function yamlValueSpan(src, start, text) {
  const q = text[0];
  if (q === '"' || q === "'") {
    const close = quotedEnd(text, 0, q);
    if (close === -1) return null;
    return { start: start + 1, end: start + close, value: yamlScalar(text.slice(0, close + 1)) };
  }
  if (!text || /^[&*!{[#|>]/.test(text)) return null;
  const plain = text.replace(/\s+#.*$/, '').replace(/\s+$/, '');
  return plain ? { start, end: start + plain.length, value: plain } : null;
}

function yamlSecretSpans(src, spans) {
  let block = null;   // { indent, key, scalar } — everything under a secret key
  let list = null;    // { indent, flag } — a sequence where a secret flag was seen
  forEachLine(src, (line, lineStart) => {
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (!line.trim()) return null;
    if (block) {
      const item = /^-(?:\s+|$)/.test(line.slice(indent));
      if (indent > block.indent || (!block.scalar && item && indent === block.indent)) {
        if (block.scalar) {
          const content = line.slice(indent).replace(/\s+$/, '');
          spans.push({ start: lineStart + indent, end: lineStart + indent + content.length, key: block.key, value: content });
          return null;
        }
        // A list item or a nested `name: value` under a secret key: mask the value.
        let at = indent;
        const dash = /^-\s*/.exec(line.slice(at));
        if (dash) at += dash[0].length;
        const kv = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.$-]+)\s*:(?:\s+|$)/.exec(line.slice(at));
        if (kv) at += kv[0].length;
        const v = yamlValueSpan(src, lineStart + at, line.slice(at));
        if (v) spans.push({ ...v, key: block.key });
        return null;
      }
      block = null;
    }
    const itemM = /^(\s*-\s+)(.*)$/.exec(line);
    if (itemM && !/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.$-]+)\s*:(?=\s|$)/.test(itemM[2])) {
      // A sequence item: an argument list may hold "--api-key" then its value.
      const at = lineStart + itemM[1].length;
      const v = yamlValueSpan(src, at, itemM[2]);
      if (!list || list.indent !== indent) list = { indent, flag: null };
      if (v) argSpan(spans, list, null, v.start, v.end, v.value);
      return null;
    }
    if (list && indent <= list.indent) list = null;
    const m = /^(\s*-?\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.$-]+)\s*:(?=\s|$)\s*/.exec(line);
    if (!m) return null;
    const key = unquoteKey(m[2]);
    const rest = line.slice(m[0].length);
    const valStart = lineStart + m[0].length;
    if (rest[0] === '[') return listSpans(src, valStart, isSecretKey(key) ? key : null, spans, { plain: true }) - 1;
    if (!isSecretKey(key)) return null;
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(rest)) {
      block = { indent, key, scalar: true };
      return null;
    }
    if (!rest || /^#/.test(rest)) {
      block = { indent, key, scalar: false };
      return null;
    }
    const v = yamlValueSpan(src, valStart, rest);
    if (v) spans.push({ ...v, key });
    return null;
  });
}

// `--api-key value`, `--token=value` and `-key "value"` on a command line.
const SHELL_FLAG_RE = /(^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)(=|\s+)("[^"\n]*"|'[^'\n]*'|[^\s"';|&<>]+)/g;
function shellFlagSpans(line, lineStart, spans) {
  SHELL_FLAG_RE.lastIndex = 0;
  for (let m = SHELL_FLAG_RE.exec(line); m; m = SHELL_FLAG_RE.exec(line)) {
    if (!secretFlag(m[2])) continue;
    const raw = m[4];
    if (raw.startsWith('-')) { SHELL_FLAG_RE.lastIndex = m.index + m[1].length + m[2].length; continue; }
    const at = lineStart + m.index + m[1].length + m[2].length + m[3].length;
    const quoted = raw[0] === '"' || raw[0] === "'";
    const value = quoted ? raw.slice(1, -1) : raw;
    spans.push({ start: quoted ? at + 1 : at, end: quoted ? at + raw.length - 1 : at + raw.length, key: m[2], value });
  }
}

function shellSecretSpans(src, spans) {
  forEachLine(src, (line, lineStart) => {
    if (/^\s*#/.test(line)) return null;
    shellFlagSpans(line, lineStart, spans);
    const m = /^(\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || !isSecretKey(m[2])) return null;
    const rest = m[3];
    const valStart = lineStart + m[1].length + m[2].length + 1;
    const q = rest[0];
    if (q === '"' || q === "'") {
      const close = quotedEnd(rest, 0, q);
      if (close === -1) return null;
      spans.push({ start: valStart + 1, end: valStart + close, key: m[2], value: rest.slice(1, close) });
      return null;
    }
    const plain = /^[^\s;#]*/.exec(rest)[0];
    if (plain) spans.push({ start: valStart, end: valStart + plain.length, key: m[2], value: plain });
    return null;
  });
}

function keyOnLine(line) {
  const m = /^\s*(?:export\s+)?-?\s*["']?([A-Za-z0-9_.$-]+)["']?\s*[:=]/.exec(line);
  return m ? m[1] : null;
}

function maskSecrets(text, format, { proxyKey, salt }) {
  const src = String(text === null || text === undefined ? '' : text);
  const spans = [];
  if (format === 'json') jsonSecretSpans(src, spans);
  else if (format === 'toml') tomlSecretSpans(src, spans);
  else if (format === 'yaml') yamlSecretSpans(src, spans);
  else if (format === 'shell') shellSecretSpans(src, spans);
  const token = value => secretToken(value, { proxyKey, salt });
  const masks = [];
  let out = '';
  let pos = 0;
  let line = 1;
  const count = (s) => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start < pos || !span.value || ENV_REF_RE.test(String(span.value))) continue;
    const chunk = src.slice(pos, span.start);
    line += count(chunk);
    out += chunk;
    const tok = token(span.value);
    masks.push({ line, key: span.key, kind: tok.kind });
    out += tok.text;
    pos = span.end;
  }
  out += src.slice(pos);

  // Second pass: credential shapes, whatever the key.
  let final = '';
  let last = 0;
  SECRET_VALUE_RE.lastIndex = 0;
  for (let m = SECRET_VALUE_RE.exec(out); m; m = SECRET_VALUE_RE.exec(out)) {
    final += out.slice(last, m.index);
    const tok = token(m[1]);
    const lineNo = count(out.slice(0, m.index)) + 1;
    const lineStart = out.lastIndexOf('\n', m.index - 1) + 1;
    const lineEnd = out.indexOf('\n', m.index);
    masks.push({ line: lineNo, key: keyOnLine(out.slice(lineStart, lineEnd === -1 ? out.length : lineEnd)), kind: tok.kind });
    final += tok.text;
    last = m.index + m[0].length;
  }
  final += out.slice(last);
  masks.sort((a, b) => a.line - b.line);
  return { text: final, masked: masks.length, masks };
}

// ---------- line diff (Myers) ----------

function splitLines(text) {
  if (text === null || text === undefined || text === '') return [];
  const lines = String(text).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MYERS_TRACE_LIMIT = 8e6;

// Edit script for a → b as ' ' / '-' / '+' ops. Falls back to "replace the
// middle" (still a correct diff, just not minimal) when the search gets huge.
function myersOps(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  if (max === 0) return [];
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let traced = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    traced += v.length;
    if (traced > MYERS_TRACE_LIMIT) return [...a.map(() => '-'), ...b.map(() => '+')];
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) {
        const ops = [];
        let cx = N;
        let cy = M;
        for (let dd = d; dd >= 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = (kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1])) ? kk + 1 : kk - 1;
          const prevX = pv[off + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) { ops.push(' '); cx--; cy--; }
          if (dd > 0) {
            if (cx === prevX) { ops.push('+'); cy--; } else { ops.push('-'); cx--; }
          }
        }
        return ops.reverse();
      }
    }
  }
  return [];
}

function lineDiff(beforeText, afterText, { context = 3, labelA = 'a', labelB = 'b' } = {}) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const mid = myersOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  const ops = [...Array(pre).fill(' '), ...mid, ...Array(suf).fill(' ')];
  const lines = [];
  let oi = 0;
  let ni = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === ' ') { lines.push({ op, text: a[oi], old: oi + 1, new: ni + 1 }); oi++; ni++; }
    else if (op === '-') { lines.push({ op, text: a[oi], old: oi + 1, new: null }); oi++; removed++; }
    else { lines.push({ op, text: b[ni], old: null, new: ni + 1 }); ni++; added++; }
  }
  const changes = [];
  lines.forEach((l, i) => { if (l.op !== ' ') changes.push(i); });
  const ranges = [];
  for (const i of changes) {
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length, i + context + 1);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end);
    else ranges.push({ start, end });
  }
  const hunks = ranges.map(({ start, end }) => {
    const slice = lines.slice(start, end);
    let oldBefore = 0;
    let newBefore = 0;
    for (const l of lines.slice(0, start)) { if (l.op !== '+') oldBefore++; if (l.op !== '-') newBefore++; }
    const oldLines = slice.filter(l => l.op !== '+').length;
    const newLines = slice.filter(l => l.op !== '-').length;
    return {
      old_start: oldLines ? oldBefore + 1 : oldBefore,
      old_lines: oldLines,
      new_start: newLines ? newBefore + 1 : newBefore,
      new_lines: newLines,
      lines: slice.map(l => ({ ...l })),
    };
  });
  const unified = hunks.length
    ? `--- ${labelA}\n+++ ${labelB}\n${hunks.map(h => `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@\n${h.lines.map(l => `${l.op}${l.text}\n`).join('')}`).join('')}`
    : '';
  return { added, removed, hunks, unified };
}

// ---------- backups (manifest v1), atomic writes, restore ----------

function backupsRoot(ctx) { return path.join(ctx.home, '.freedeepseek-api', 'backups'); }

// Revisions in manifests must survive a restart, so they use a salt stored next
// to the backups rather than the server's in-memory one.
function backupSalt(ctx, F = fs, { create = true } = {}) {
  const root = backupsRoot(ctx);
  const file = path.join(root, '.salt');
  try {
    const b = F.readFileSync(file);
    if (b.length !== 16) {
      throw new SetupError('file_unreadable', `${displayPath(ctx, file)} is damaged (expected 16 bytes). Delete it; restore points made before that will then ask before overwriting.`, { path: displayPath(ctx, file) });
    }
    return b;
  } catch (e) {
    if (e instanceof SetupError) throw e;
    if (e.code !== 'ENOENT') throw unreadable(ctx, file, e);
  }
  if (!create) return null;
  F.mkdirSync(root, { recursive: true, mode: 0o700 });
  const salt = crypto.randomBytes(16);
  try {
    F.writeFileSync(file, salt, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return F.readFileSync(file);
    throw e;
  }
  return salt;
}

function backupStamp(now) { return new Date(now).toISOString().replace(/[:.]/g, '-'); }
function rand36(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(n), b => chars[b % 36]).join('');
}

function makeBackupDir(ctx, now, F) {
  const root = backupsRoot(ctx);
  F.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = backupStamp(now);
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = attempt === 0 ? stamp : `${stamp}-${rand36(4)}`;
    const dir = path.join(root, id);
    try {
      F.mkdirSync(dir, { mode: 0o700 });
      return { id, dir };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new SetupError('write_failed', `Could not create a backup folder in ${displayPath(ctx, root)}.`, { path: displayPath(ctx, root), rolled_back: true });
}

function atomicWrite(real, data, mode, F = fs) {
  const dir = path.dirname(real);
  F.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(real)}.fdsa-${rand36(6)}.tmp`);
  let fd = null;
  try {
    fd = F.openSync(tmp, 'wx', mode);
    F.fchmodSync(fd, mode);
    F.writeFileSync(fd, data);
    F.fsyncSync(fd);
    F.closeSync(fd);
    fd = null;
    F.renameSync(tmp, real);
  } catch (e) {
    if (fd !== null) { try { F.closeSync(fd); } catch (err) { /* already closed */ } }
    try { F.unlinkSync(tmp); } catch (err) { /* never created or already renamed */ }
    throw e;
  }
}

// items: [{ agent_id, file_id, path, format, real, next: Buffer|null }]
// Copies what exists now, writes manifest.json, and returns the per-item state.
// A backup that fails part way is removed, so no restore point without a
// manifest is ever left behind; nothing has been written to the agent files yet.
function writeBackup(ctx, items, { source, now, agents, options }, F) {
  const salt = backupSalt(ctx, F);
  const { id, dir } = makeBackupDir(ctx, now, F);
  const entries = [];
  const states = [];
  let step = null;
  try {
    for (const item of items) {
      let current = null;
      let mode = 0o600;
      step = `read ${displayPath(ctx, item.path)}`;
      try {
        current = F.readFileSync(item.real);
        mode = F.statSync(item.real).mode & 0o777;
      } catch (e) {
        if (e.code !== 'ENOENT') throw unreadable(ctx, item.path, e);
      }
      const backupName = current ? `${item.agent_id}.${item.file_id}${FORMAT_EXT[item.format] || ''}` : null;
      step = `back up ${displayPath(ctx, item.path)}`;
      if (current) F.writeFileSync(path.join(dir, backupName), current, { mode: 0o600 });
      entries.push({
        agent_id: item.agent_id,
        file_id: item.file_id,
        path: item.path,
        existed: Boolean(current),
        backup_name: backupName,
        revision_after: item.next ? revisionOf(salt, item.next) : null,
      });
      states.push({ ...item, existed: Boolean(current), mode, backupName });
    }
    const manifest = { version: 1, created_at: now, source, agents, options: options || null, files: entries };
    step = `back up the files: writing ${displayPath(ctx, path.join(dir, 'manifest.json'))} failed`;
    F.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    let removed = true;
    try { F.rmSync(dir, { recursive: true, force: true }); } catch (err) { removed = false; }
    if (e instanceof SetupError) throw e;
    const where = displayPath(ctx, dir);
    throw new SetupError('write_failed', `Could not ${step} (${e.message}). No agent file was changed.${removed ? '' : ` Delete the incomplete backup folder ${where} by hand.`}`, { path: where, rolled_back: true });
  }
  return { id, dir, entries, states };
}

function rollbackWrites(done, dir, F) {
  for (const s of [...done].reverse()) {
    if (s.existed) atomicWrite(s.real, F.readFileSync(path.join(dir, s.backupName)), s.mode, F);
    else { try { F.unlinkSync(s.real); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
}

// Apply one or more plans as one change with one backup. Unchanged and virtual
// files are skipped. On any failure the files already written are put back.
function applyPlans(plans, ctx, { source, now = Date.now(), fs: F = fs, onBackup } = {}) {
  const items = [];
  for (const plan of plans) {
    for (const f of plan.files) {
      if (f.virtual || f.action === 'unchanged') continue;
      const { real } = resolveRealPath(ctx, f.path, F);
      items.push({ agent_id: plan.target, file_id: f.id, path: f.path, format: f.format, real, next: Buffer.from(f.after, 'utf8'), after: f.after });
    }
  }
  if (!items.length) return { written: [], backup: null };
  const first = plans[0].options || {};
  const options = { model: first.model, mode: first.mode, base_url: first.baseUrl };
  if (first.scope === 'project') Object.assign(options, { scope: 'project', project_dir: first.projectDir });
  const agents = [...new Set(items.map(i => i.agent_id))];
  const backup = writeBackup(ctx, items, { source, now, agents, options }, F);
  if (onBackup) for (const s of backup.states) if (s.existed) onBackup(s.path, path.join(backup.dir, s.backupName));
  const done = [];
  for (const s of backup.states) {
    try {
      atomicWrite(s.real, s.next, s.existed ? s.mode : 0o600, F);
      done.push(s);
    } catch (e) {
      let rolledBack = true;
      try { rollbackWrites(done, backup.dir, F); } catch (err) { rolledBack = false; }
      if (rolledBack) { try { F.rmSync(backup.dir, { recursive: true, force: true }); } catch (err) { /* left behind, still valid */ } }
      const dp = displayPath(ctx, s.path);
      throw new SetupError('write_failed', rolledBack
        ? `Could not write ${dp}: ${e.message}`
        : `Could not write ${dp}: ${e.message}. Putting the earlier files back also failed; restore them from ${displayPath(ctx, backup.dir)}.`, {
        agent_id: s.agent_id, file_id: s.file_id, path: dp, rolled_back: rolledBack,
      });
    }
  }
  return {
    written: backup.states.map(s => ({ target: s.agent_id, id: s.file_id, path: s.path, action: s.existed ? 'update' : 'create' })),
    backup: { id: backup.id, dir: backup.dir, files: backup.entries.length },
  };
}

function applyPlan(plan, ctx, opts) { return applyPlans([plan], ctx, opts); }

function legacyReason(id) {
  return `Made by an older setup without a file list. Restore it from a terminal: node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/${id}`;
}
function createdFromId(id) {
  return Date.parse(id.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*$/, '$1:$2:$3.$4Z'));
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { error: `manifest.json could not be read: ${e.message}` };
  }
  let m;
  try { m = JSON.parse(raw); } catch (e) { return { error: 'manifest.json in this restore point is damaged, so it cannot be restored here.' }; }
  if (!m || m.version !== 1 || !Array.isArray(m.files) || !Number.isFinite(m.created_at)) {
    return { error: 'manifest.json in this restore point has an unknown format, so it cannot be restored here.' };
  }
  return { manifest: m };
}

function listBackups(ctx) {
  const root = backupsRoot(ctx);
  let names;
  try { names = fs.readdirSync(root); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw unreadable(ctx, root, e);
  }
  const out = [];
  for (const id of names) {
    if (!BACKUP_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
    const r = readManifest(dir);
    if (!r.manifest) {
      out.push({ id, created_at: createdFromId(id), source: 'cli', agents: [], options: null, files: [], restorable: false, reason: r.missing ? legacyReason(id) : r.error });
      continue;
    }
    const m = r.manifest;
    const project = m.options && m.options.scope === 'project';
    out.push({
      id,
      created_at: m.created_at,
      source: ['cli', 'dashboard', 'restore'].includes(m.source) ? m.source : 'cli',
      agents: Array.isArray(m.agents) ? m.agents.filter(a => VALID_TARGETS.includes(a)) : [],
      options: m.options ? { model: m.options.model, mode: m.options.mode } : null,
      files: m.files.map(f => ({ agent_id: f.agent_id, file_id: f.file_id, display_path: displayPath(ctx, String(f.path)), existed: Boolean(f.existed) })),
      restorable: !project,
      reason: project ? `Made for the project folder ${m.options.project_dir}. Restore it from a terminal: node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/${id}` : null,
    });
  }
  return out.sort((a, b) => (b.created_at - a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function restoreFromDir(ctx, dir, { force = false, now = Date.now(), fs: F = fs, allowProject = false } = {}) {
  const id = path.basename(dir);
  const r = readManifest(dir);
  if (r.missing) throw new SetupError('backup_not_restorable', legacyReason(id));
  if (!r.manifest) throw new SetupError('invalid_backup', r.error);
  const m = r.manifest;
  const scope = m.options && m.options.scope === 'project' ? { scope: 'project', projectDir: m.options.project_dir } : {};
  if (scope.scope && !allowProject) {
    throw new SetupError('backup_not_restorable', `Made for the project folder ${m.options.project_dir}. Restore it from a terminal: node scripts/setup-agents.js --restore ~/.freedeepseek-api/backups/${id}`);
  }
  const entries = m.files.map((e) => {
    if (!e || typeof e !== 'object' || !TARGETS[e.agent_id] || e.agent_id === 'cursor') {
      throw new SetupError('invalid_backup', `manifest.json lists an unknown agent (${String(e && e.agent_id).slice(0, 40)}).`);
    }
    const spec = filesFor(e.agent_id, ctx, scope).find(f => f.id === e.file_id);
    if (!spec || spec.virtual || spec.path !== e.path) {
      throw new SetupError('invalid_backup', `manifest.json lists ${String(e.path).slice(0, 200)} for ${e.agent_id} ${String(e.file_id).slice(0, 40)}, which is not where setup keeps that file${spec && spec.path ? ` (${spec.display_path})` : ''}.`);
    }
    let bytes = null;
    if (e.existed) {
      if (typeof e.backup_name !== 'string' || path.basename(e.backup_name) !== e.backup_name || e.backup_name.startsWith('.')) {
        throw new SetupError('invalid_backup', `manifest.json has an invalid copy name for ${spec.display_path}.`);
      }
      try { bytes = F.readFileSync(path.join(dir, e.backup_name)); } catch (err) {
        throw new SetupError('invalid_backup', `The copy of ${spec.display_path} is missing from this restore point.`);
      }
    }
    return { e, spec, bytes, real: resolveRealPath(ctx, spec.path, F).real };
  });

  if (!force) {
    const salt = backupSalt(ctx, F, { create: false });
    const conflicts = [];
    for (const { e, spec, real } of entries) {
      let current = null;
      try { current = F.readFileSync(real); } catch (err) { if (err.code !== 'ENOENT') throw unreadable(ctx, spec.path, err); }
      if (e.revision_after === null || e.revision_after === undefined) {
        if (current) conflicts.push({ display_path: spec.display_path, reason: 'changed_since' });
      } else if (!current) {
        conflicts.push({ display_path: spec.display_path, reason: 'missing' });
      } else if (!salt || revisionOf(salt, current) !== e.revision_after) {
        conflicts.push({ display_path: spec.display_path, reason: 'changed_since' });
      }
    }
    if (conflicts.length) {
      const n = conflicts.length;
      throw new SetupError('restore_conflict', `${n} ${n === 1 ? 'file' : 'files'} changed after this backup: ${conflicts.map(c => c.display_path).join(', ')}. Restore anyway to overwrite them.`, { files: conflicts });
    }
  }

  const safety = writeBackup(ctx, entries.map(({ e, spec, bytes, real }) => ({
    agent_id: e.agent_id, file_id: e.file_id, path: spec.path, format: spec.format, real, next: bytes,
  })), { source: 'restore', now, agents: [...new Set(entries.map(x => x.e.agent_id))], options: null }, F);
  const done = [];
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const { e, spec, bytes, real } = entries[i];
    const s = safety.states[i];
    try {
      if (e.existed) atomicWrite(real, bytes, s.existed ? s.mode : 0o600, F);
      else { try { F.unlinkSync(real); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
      done.push(s);
      files.push({ agent_id: e.agent_id, file_id: e.file_id, path: spec.path, action: e.existed ? 'restored' : 'deleted' });
    } catch (err) {
      let rolledBack = true;
      try { rollbackWrites(done, safety.dir, F); } catch (rbErr) { rolledBack = false; }
      throw new SetupError('write_failed', rolledBack
        ? `Could not restore ${spec.display_path}: ${err.message}`
        : `Could not restore ${spec.display_path}: ${err.message}. Putting the other files back also failed; restore them from ${displayPath(ctx, safety.dir)}.`, {
        file_id: e.file_id, path: spec.display_path, rolled_back: rolledBack,
      });
    }
  }
  return { backup_id: id, files, safety_backup: { id: safety.id, dir: safety.dir } };
}

function restoreBackup(ctx, id, opts = {}) {
  const notFound = () => new SetupError('backup_not_found', `No restore point named ${String(id).slice(0, 64)}.`);
  if (typeof id !== 'string' || !BACKUP_ID_RE.test(id)) throw notFound();
  const dir = path.join(backupsRoot(ctx), id);
  try { if (!fs.statSync(dir).isDirectory()) throw notFound(); } catch (e) {
    if (e instanceof SetupError) throw e;
    throw notFound();
  }
  return restoreFromDir(ctx, dir, opts);
}

// ---------- interactive wizard ----------

async function interactive(opts) {
  const langRef = { current: loadUiLang() };
  const setLang = (next) => { langRef.current = next; saveUiLang(next); };
  let selected = [...VALID_TARGETS];
  let step = 'targets';
  while (true) {
    if (step === 'targets') {
      const chosen = await pickMany(
        () => ({
          lang: langRef.current,
          subtitle: t(langRef.current, 'selectAgents'),
          status: [
            { ok: true, label: 'Proxy', value: opts.baseUrl },
          ],
          items: VALID_TARGETS.map(target => ({ id: target, label: target })),
        }),
        setLang,
        selected,
        { cancelId: 'cancel' },
      );
      if (chosen.id === 'cancel') {
        await pick(
          () => ({
            lang: langRef.current,
            subtitle: t(langRef.current, 'setupCancelled'),
            status: [],
            items: [{ id: 'done', label: t(langRef.current, 'back') }],
          }),
          setLang,
          { cancelId: 'done' },
        );
        return null;
      }
      selected = chosen.ids;
      step = 'model';
    } else if (step === 'model') {
      const chosen = await pick(
        () => ({
          lang: langRef.current,
          subtitle: t(langRef.current, 'chooseModel'),
          status: [{ ok: true, label: t(langRef.current, 'selected'), value: selected.join(', ') }],
          items: VALID_MODELS.map(model => ({ id: model, label: model })),
        }),
        setLang,
        { cancelId: 'back' },
      );
      if (chosen.id === 'back') step = 'targets';
      else {
        opts.model = chosen.id;
        step = 'mode';
      }
    } else {
      const chosen = await pick(
        () => ({
          lang: langRef.current,
          subtitle: t(langRef.current, 'installMode'),
          status: [{ ok: true, label: 'Model', value: opts.model }],
          items: [
            { id: 'add', label: t(langRef.current, 'addAlongside') },
            { id: 'replace', label: t(langRef.current, 'replaceDefault') },
          ],
        }),
        setLang,
        { cancelId: 'back' },
      );
      if (chosen.id === 'back') step = 'model';
      else return { targets: selected, model: opts.model, mode: chosen.id, langRef, setLang };
    }
  }
}

async function showResults(wizard, results) {
  await pick(
    () => ({
      lang: wizard.langRef.current,
      subtitle: t(wizard.langRef.current, 'setupComplete'),
      status: results.map(result => ({
        ok: result.ok,
        label: result.target,
        value: result.ok ? t(wizard.langRef.current, 'done') : result.error,
      })),
      items: [{ id: 'done', label: t(wizard.langRef.current, 'back') }],
    }),
    wizard.setLang,
    { cancelId: 'done' },
  );
}


// ---------- CLI ----------

function cliSentences(target, opts, plan) {
  const p = id => plan.files.find(f => f.id === id).path;
  switch (target) {
    case 'claude-code':
      return [opts.mode === 'replace'
        ? `Claude Code: default model replaced in ${p('settings')}.`
        : `Claude Code: native defaults unchanged. Opt in with: claude --settings ${p('profile')}`];
    case 'codex':
      return [opts.mode === 'replace'
        ? 'Codex: FreeDeepseekAPI is now the default provider.'
        : 'Codex: native GPT model/provider unchanged. Opt in with: codex --profile freedeepseek'];
    case 'hermes':
      return [opts.mode === 'replace'
        ? `Hermes: default model set to FreeDeepseekAPI in ${p('config')}. The rest of the file is unchanged.`
        : `Hermes: native config unchanged. FreeDeepseekAPI profile written to ${p('profile')}. Hermes does not load it by itself: copy its model block into ~/.hermes/config.yaml or a profile (~/.hermes/profiles/<name>/config.yaml).`];
    case 'openclaw':
      return [opts.mode === 'replace'
        ? `OpenClaw: provider added and freedeepseek/${opts.model} set as the primary model.`
        : 'OpenClaw: provider added; existing primary model unchanged. Select freedeepseek/<id> explicitly.'];
    case 'opencode':
      return [opts.mode === 'replace'
        ? `OpenCode: provider added and freedeepseek/${opts.model} set as the default model.`
        : 'OpenCode: provider added; existing default model unchanged. Select freedeepseek/<id> explicitly.'];
    default:
      return [];
  }
}

// Cursor keeps its settings in the app; the CLI writes the template and launcher
// into integrations/cursor/ (not backed up: they are tracked repo files).
function writeCursorTemplates(ctx, opts, plan) {
  const dir = path.join(ctx.root, 'integrations', 'cursor');
  let launchPath = '';
  for (const f of plan.files) {
    const dest = path.join(dir, f.label);
    if (f.id === 'launcher') launchPath = dest;
    if (opts.dryRun) {
      console.log(`[dry-run] write ${dest}\n${f.after.slice(0, 1200)}${f.after.length > 1200 ? '\n…' : ''}\n`);
      continue;
    }
    ensureDir(dir);
    fs.writeFileSync(dest, f.after, { encoding: 'utf8', mode: 0o600 });
    console.log(`wrote ${dest}`);
  }
  if (!opts.dryRun) fs.chmodSync(launchPath, 0o755);
  console.log('Cursor: existing editor settings unchanged.');
  console.log(`        Optional profile launcher uses OpenAI Base URL = ${openaiBase(opts.baseUrl)}`);
  console.log(`        Add models: ${VALID_MODELS.join(', ')}`);
  console.log(`        Or: sh ${launchPath}`);
}

function restoreCli(ctx, dirArg) {
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(dir)) die(`backup dir not found: ${dirArg}`);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    // The user named this restore point explicitly, so later edits are overwritten.
    const r = restoreFromDir(ctx, dir, { force: true, allowProject: true });
    for (const f of r.files) console.log(`${f.action} ${f.path}`);
    console.log(`\nThe replaced versions are in ${r.safety_backup.dir}`);
    return;
  }
  const map = {
    'settings.json': path.join(ctx.home, '.claude', 'settings.json'),
    'settings.local.json': path.join(ctx.cwd, '.claude', 'settings.local.json'),
    'config.toml': path.join(ctx.home, '.codex', 'config.toml'),
    'models.json': path.join(ctx.home, '.codex', 'models.json'),
    'opencode.json': path.join(ctx.home, '.config', 'opencode', 'opencode.json'),
    'AGENTS.md': path.join(ctx.home, '.config', 'opencode', 'AGENTS.md'),
    'config.yaml': path.join(ctx.home, '.hermes', 'config.yaml'),
    'openclaw.json': path.join(ctx.home, '.openclaw', 'openclaw.json'),
  };
  for (const [name, dest] of Object.entries(map)) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    console.log(`restored ${dest}`);
  }
  for (const name of fs.readdirSync(dir)) {
    if (!Object.hasOwn(map, name)) console.log(`skipped ${name}: no known destination`);
  }
}

async function main(argv = process.argv) {
  const ctx = { home: process.env.SETUP_HOME || os.homedir(), root: ROOT, cwd: process.cwd(), pathEnv: process.env.PATH, platform: process.platform };
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return; }
  if (opts.restore) { restoreCli(ctx, opts.restore); return; }
  let wizard = null;
  if (opts.interactive) {
    wizard = await interactive(opts);
    if (!wizard) return;
    opts.targets = wizard.targets;
    opts.model = wizard.model;
    opts.mode = wizard.mode;
  }
  if (!opts.targets.length) die('No --target. See --help.');
  if (!['user', 'project'].includes(opts.scope)) die('Unknown --scope. Use: user, project');

  console.log(`model=${opts.model} base=${opts.baseUrl} key=${opts.apiKey ? 'set' : 'missing'} dryRun=${opts.dryRun}`);
  const planOpts = { model: opts.model, mode: opts.mode, baseUrl: opts.baseUrl, apiKey: opts.apiKey, scope: opts.scope, projectDir: ctx.cwd };
  const read = fileReader(ctx);
  const results = [];
  const plans = [];
  let cursorPlan = null;
  for (const target of opts.targets) {
    try {
      const plan = planTarget(target, planOpts, ctx, { read });
      if (target === 'cursor') cursorPlan = plan;
      else plans.push(plan);
    } catch (error) {
      if (!wizard) throw error;
      results.push({ target, ok: false, error: error.message });
    }
  }

  if (opts.dryRun) {
    const backupDir = path.join(backupsRoot(ctx), backupStamp(Date.now()));
    for (const plan of plans) {
      for (const f of plan.files) {
        if (f.action === 'unchanged') { console.log(`[dry-run] unchanged ${f.path}`); continue; }
        if (f.existed) console.log(`[dry-run] backup ${f.path} → ${path.join(backupDir, `${plan.target}.${f.id}${FORMAT_EXT[f.format]}`)}`);
        console.log(`[dry-run] write ${f.path}\n${f.after.slice(0, 1200)}${f.after.length > 1200 ? '\n…' : ''}\n`);
      }
      for (const line of cliSentences(plan.target, opts, plan)) console.log(line);
      results.push({ target: plan.target, ok: true });
    }
  } else if (plans.length) {
    let applied = null;
    try {
      applied = applyPlans(plans, ctx, { source: 'cli', now: Date.now(), onBackup: (src, dest) => console.log(`backup ${src} → ${dest}`) });
    } catch (error) {
      if (!wizard) throw error;
      // One change for every agent: when it fails, none of them was written.
      const failed = error.extra && error.extra.agent_id;
      const why = error.extra && error.extra.rolled_back === false
        ? error.message
        : `Not written: ${TARGETS[failed] ? TARGETS[failed].name : 'another agent'} failed, so the whole change was put back. ${error.message}`;
      for (const plan of plans) results.push({ target: plan.target, ok: false, error: plan.target === failed ? error.message : why });
    }
    if (applied) {
      for (const w of applied.written) console.log(`wrote ${w.path}`);
      for (const plan of plans) {
        for (const f of plan.files) if (f.action === 'unchanged') console.log(`unchanged ${f.path}`);
        for (const line of cliSentences(plan.target, opts, plan)) console.log(line);
        results.push({ target: plan.target, ok: true });
      }
      if (applied.backup) console.log(`\nBackups: ${applied.backup.dir}\nRestore: node scripts/setup-agents.js --restore ${applied.backup.dir}`);
      else console.log('\nEvery file already matched, so nothing was written and no backup was made.');
    }
  }
  if (cursorPlan) {
    try {
      writeCursorTemplates(ctx, opts, cursorPlan);
      results.push({ target: 'cursor', ok: true });
    } catch (error) {
      if (!wizard) throw error;
      results.push({ target: 'cursor', ok: false, error: `Could not write the Cursor files in ${path.join(ctx.root, 'integrations', 'cursor')}: ${error.message}` });
    }
  }
  if (wizard) await showResults(wizard, results);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof SetupError ? `${err.message} (${err.code})` : (err.stack || err.message));
    process.exit(1);
  });
}

module.exports = {
  VALID_TARGETS,
  VALID_MODELS,
  AGENT_FILE_MAX_BYTES,
  BACKUP_ID_RE,
  SetupError,
  TARGETS,
  claudeSettings,
  mergeClaudeSettings,
  upsertTomlKey,
  upsertTomlTable,
  upsertYamlModelBlock,
  openaiBase,
  anthropicBase,
  parseArgs,
  upsertMarkedSection,
  OPENCODE_AGENTS_GUIDANCE,
  filesFor,
  normalizeModel,
  normalizeBaseUrl,
  LEGACY_SEARCH_MODELS,
  validateOptions,
  fileReader,
  planTarget,
  applyPlan,
  applyPlans,
  inspectTarget,
  readAgentFile,
  maskSecrets,
  lineDiff,
  listBackups,
  restoreBackup,
  displayPath,
  revisionOf,
  sameProxy,
  main,
};
