const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const A = require('../scripts/setup-agents.js');
const S = require('../server.js').__test;

const BASE = 'http://127.0.0.1:9655';
const OPTS = { model: 'deepseek-v4-flash-thinking', mode: 'add', baseUrl: BASE, apiKey: 'local' };
const SALT = crypto.randomBytes(16);

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-agents-')); }
function ctxFor(home) { return { home, root: ROOT, cwd: home, pathEnv: '', platform: 'linux' }; }
function put(home, rel, body, mode) {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}
function read(home, rel) { return fs.readFileSync(path.join(home, rel), 'utf8'); }
function plan(target, opts, home) {
  const ctx = ctxFor(home);
  return A.planTarget(target, { ...OPTS, ...opts }, ctx, { read: A.fileReader(ctx, { salt: SALT }) });
}
function fileOf(p, id) { return p.files.find(f => f.id === id); }
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); }
      else if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`;
      else out[rel] = `${(st.mode & 0o777).toString(8)} ${fs.readFileSync(full, 'base64')}`;
    }
  };
  walk(dir);
  return out;
}
function throwsCode(fn, code, check = () => true) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return check(e) !== false;
  });
}

// ---------- pure: planner ----------

test('claude add writes only the profile, built from claudeSettings', () => {
  const home = tmpdir();
  put(home, '.claude/settings.json', '{"model":"claude-opus"}');
  const p = plan('claude-code', { mode: 'add' }, home);
  assert.deepEqual(p.files.map(f => f.id), ['profile']);
  assert.equal(p.files[0].action, 'create');
  assert.equal(p.files[0].path, path.join(home, '.claude', 'freedeepseek.settings.json'));
  assert.deepEqual(JSON.parse(p.files[0].after), A.claudeSettings({ ...OPTS }));
});

test('claude replace keeps unrelated keys and env entries and sets the model', () => {
  const home = tmpdir();
  put(home, '.claude/settings.json', JSON.stringify({ theme: 'dark', env: { KEEP: 'yes' } }));
  const p = plan('claude-code', { mode: 'replace' }, home);
  assert.deepEqual(p.files.map(f => f.id), ['settings']);
  const after = JSON.parse(p.files[0].after);
  assert.equal(after.theme, 'dark');
  assert.equal(after.env.KEEP, 'yes');
  assert.equal(after.model, 'deepseek-v4-flash-thinking');
  assert.equal(after.env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(p.files[0].action, 'update');
});

test('codex add writes the profile and the catalog only', () => {
  const home = tmpdir();
  put(home, '.codex/config.toml', 'model = "gpt-native"\n');
  const p = plan('codex', { mode: 'add' }, home);
  assert.deepEqual(p.files.map(f => f.id).sort(), ['catalog', 'profile']);
  const catalog = JSON.parse(fileOf(p, 'catalog').after);
  assert.deepEqual(catalog.models.map(m => m.slug), A.VALID_MODELS);
  assert.match(fileOf(p, 'profile').after, /^model_provider = "freedeepseek"$/m);
  assert.equal(p.usage.command, 'codex --profile freedeepseek');
});

test('codex replace only touches root keys and leaves profile tables alone', () => {
  const home = tmpdir();
  put(home, '.codex/config.toml', 'model = "gpt-native"\nsandbox_mode = "workspace-write"\n\n[profiles.work]\nmodel = "x"\n');
  const p = plan('codex', { mode: 'replace' }, home);
  assert.deepEqual(p.files.map(f => f.id).sort(), ['catalog', 'config']);
  const after = fileOf(p, 'config').after;
  assert.match(after, /^model = "deepseek-v4-flash-thinking"$/m);
  assert.equal((after.match(/^model = /gm) || []).length, 2, after);
  assert.ok(after.includes('[profiles.work]\nmodel = "x"\n'), after);
  assert.match(after, /^model_provider = "freedeepseek"$/m);
  assert.match(after, /\[model_providers\.freedeepseek\]/);
  assert.match(after, /sandbox_mode = "workspace-write"/);
});

const HERMES_BLOCK = [
  'model:',
  '  default: deepseek-v4-flash-thinking',
  '  provider: custom',
  '  base_url: http://127.0.0.1:9655/v1',
  '  api_key: local',
  '  api_mode: chat_completions',
  '',
].join('\n');

test('hermes replace swaps a whole model block and keeps the rest exactly', () => {
  assert.equal(
    A.upsertYamlModelBlock('model:\n  default: claude-opus\n  provider: anthropic\nmemory: true\n', OPTS),
    `${HERMES_BLOCK}memory: true\n`,
  );
  assert.equal(A.upsertYamlModelBlock('model: gpt-4\nmemory: true\n', OPTS), `${HERMES_BLOCK}memory: true\n`);
  const home = tmpdir();
  put(home, '.hermes/config.yaml', 'model:\n  default: claude-opus\n  provider: anthropic\nmemory: true\n');
  const p = plan('hermes', { mode: 'replace' }, home);
  assert.deepEqual(p.files.map(f => f.id), ['config']);
  assert.equal(p.files[0].after, `${HERMES_BLOCK}memory: true\n`);
});

test('opencode plan keeps its documented global effects', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', JSON.stringify({ model: 'freedeepseek/deepseek-v4-flash', tools: { bash: true } }));
  const p = plan('opencode', { mode: 'add' }, home);
  assert.equal(p.effects.length, 4);
  assert.deepEqual(p.files.map(f => f.id), ['config', 'agents_md']);
  const cfg = JSON.parse(fileOf(p, 'config').after);
  assert.equal(cfg.model, 'freedeepseek/deepseek-v4-flash-thinking');
  assert.equal(cfg.tools.bash, true);
  assert.equal(cfg.tools.websearch, false);
  assert.equal(cfg.tools.webfetch, false);
  assert.equal(cfg.permission.websearch, 'deny');
  assert.equal(cfg.permission.webfetch, 'deny');
  assert.deepEqual(cfg.attachment.image, { auto_resize: true, max_width: 2000, max_height: 2000, max_base64_bytes: 5242880 });
  assert.equal(fileOf(p, 'agents_md').action, 'create');
  assert.match(fileOf(p, 'agents_md').after, /<!-- freedeepseek-autonomy -->/);
});

test('openclaw replace sets the primary model and keeps the workspace', () => {
  const home = tmpdir();
  put(home, '.openclaw/openclaw.json', JSON.stringify({ agents: { defaults: { workspace: '/tmp/work' } } }));
  const cfg = JSON.parse(plan('openclaw', { mode: 'replace' }, home).files[0].after);
  assert.equal(cfg.agents.defaults.model.primary, 'freedeepseek/deepseek-v4-flash-thinking');
  assert.equal(cfg.agents.defaults.workspace, '/tmp/work');
});

test('cursor launcher reads the key from the shell when apiKeyRef is set', () => {
  const home = tmpdir();
  const p = plan('cursor', { apiKey: 'sk-real-secret-value-123456', apiKeyRef: true }, home);
  const launcher = fileOf(p, 'launcher');
  assert.equal(launcher.virtual, true);
  assert.equal(launcher.path, null);
  assert.ok(launcher.after.includes('export OPENAI_API_KEY="${PROXY_API_KEY:-local}"'), launcher.after);
  assert.ok(!launcher.after.includes('sk-real-secret-value-123456'));
  assert.ok(!fileOf(p, 'settings_snippet').after.includes('sk-real-secret-value-123456'));
});

test('an invalid existing JSON file stops the plan with its line and column', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', '{\n  "model": "x",\n}\n');
  throwsCode(() => plan('opencode', {}, home), 'invalid_existing_file', (e) => {
    assert.equal(e.extra.file_id, 'config');
    assert.equal(e.extra.line, 3);
    assert.equal(e.extra.column, 1);
    assert.equal(e.extra.path, '~/.config/opencode/opencode.json');
    assert.match(e.message, /^~\/\.config\/opencode\/opencode\.json is not valid JSON: .* at line 3, column 1\. Fix the file or restore a backup, then try again\.$/);
  });
});

test('validateOptions accepts proxy origins and rejects everything else', () => {
  const ok = A.validateOptions({ model: 'deepseek-v4-flash-thinking-search', mode: 'add', baseUrl: 'http://127.0.0.1:9655/v1' });
  assert.deepEqual(ok, { model: 'deepseek-v4-flash-thinking', mode: 'add', baseUrl: 'http://127.0.0.1:9655', scope: 'user' });
  assert.equal(A.validateOptions({ model: 'deepseek-v4-flash', mode: 'replace', baseUrl: 'https://h.example/' }).baseUrl, 'https://h.example');
  throwsCode(() => A.validateOptions({ model: 'gpt-4', mode: 'add', baseUrl: BASE }), 'invalid_option', e => e.extra.field === 'model');
  throwsCode(() => A.validateOptions({ model: 'deepseek-v4-flash', mode: 'swap', baseUrl: BASE }), 'invalid_option', e => e.extra.field === 'mode');
  for (const bad of ['ftp://x', 'http://u:p@h', 'http://h/path', 'http://h?q', 'http://h/#x', 'not a url']) {
    throwsCode(() => A.validateOptions({ model: 'deepseek-v4-flash', mode: 'add', baseUrl: bad }), 'invalid_option', e => e.extra.field === 'base_url' && e.message.includes('http://127.0.0.1:9655'));
  }
  assert.equal(A.normalizeModel('deepseek-v4-flash-search'), 'deepseek-v4-flash');
});

// ---------- pure: masking ----------

test('maskSecrets hides secret values by key and by shape, keeping every other byte', () => {
  const salt = Buffer.from('0123456789abcdef');
  const json = '{\n  "provider": { "x": { "options": { "apiKey": "abc-secret", "baseURL": "http://h" } } },\n  "maxTokens": 8192,\n  "other": "sk-abcdefghijklmnop1234",\n  "token": "local"\n}\n';
  const m = A.maskSecrets(json, 'json', { proxyKey: 'local', salt });
  assert.equal(m.masked, 3);
  assert.ok(!m.text.includes('abc-secret'));
  assert.ok(!m.text.includes('sk-abcdefghijklmnop1234'));
  assert.match(m.text, /"apiKey": "‹secret:[0-9a-f]{6}›"/);
  assert.match(m.text, /"token": "‹proxy-key›"/);
  assert.match(m.text, /"maxTokens": 8192/);
  assert.deepEqual(m.masks.map(x => [x.line, x.key, x.kind]), [[2, 'apiKey', 'secret'], [4, 'other', 'secret'], [5, 'token', 'proxy_key']]);
  // Everything outside the masked spans is identical.
  const strip = s => s.replace(/‹[^›]*›/g, '').replace(/abc-secret|sk-abcdefghijklmnop1234|"local"/g, m2 => (m2 === '"local"' ? '""' : ''));
  assert.equal(strip(m.text), strip(json));

  const again = A.maskSecrets('{"api_key": "abc-secret", "secret": "other-value"}', 'json', { proxyKey: 'local', salt });
  const tokens = again.text.match(/‹secret:[0-9a-f]{6}›/g);
  assert.equal(tokens[0], m.text.match(/‹secret:[0-9a-f]{6}›/)[0], 'same value → same token');
  assert.notEqual(tokens[0], tokens[1], 'different values → different tokens');

  const toml = 'model = "x"\n[model_providers.freedeepseek]\nexperimental_bearer_token = "tok-123"\nmax = 5\n';
  const t = A.maskSecrets(toml, 'toml', { proxyKey: 'local', salt });
  assert.equal(t.masked, 1);
  assert.match(t.text, /^experimental_bearer_token = "‹secret:[0-9a-f]{6}›"$/m);
  assert.equal(t.masks[0].line, 3);
  const inline = A.maskSecrets('[mcp_servers.x]\nenv = { API_KEY = "plain-value", MODE = "x" }\n# token = "not-a-value"\n', 'toml', { proxyKey: 'local', salt });
  assert.equal(inline.masked, 1);
  assert.match(inline.text, /env = \{ API_KEY = "‹secret:[0-9a-f]{6}›", MODE = "x" \}/);
  assert.match(inline.text, /# token = "not-a-value"/);

  const yaml = 'model:\n  default: x\n  api_key: hunter2\n  base_url: http://h/v1\n';
  const y = A.maskSecrets(yaml, 'yaml', { proxyKey: 'local', salt });
  assert.equal(y.masked, 1);
  assert.match(y.text, /^ {2}api_key: ‹secret:[0-9a-f]{6}›$/m);

  const sh = '#!/bin/sh\nexport OPENAI_BASE_URL="http://h/v1"\nexport OPENAI_API_KEY="hunter2"\nexport OTHER_KEY="${PROXY_API_KEY:-local}"\n';
  const s = A.maskSecrets(sh, 'shell', { proxyKey: 'local', salt });
  assert.equal(s.masked, 1);
  assert.match(s.text, /^export OPENAI_API_KEY="‹secret:[0-9a-f]{6}›"$/m);
  assert.ok(s.text.includes('${PROXY_API_KEY:-local}'), 'an env reference is not a secret');

  const md = A.maskSecrets('Use key sk-abcdefghijklmnop1234 here\napi_key: plain\n', 'markdown', { proxyKey: 'local', salt });
  assert.equal(md.masked, 1);
  assert.match(md.text, /api_key: plain/);
});

// ---------- pure: diff ----------

test('lineDiff produces minimal hunks with 3 lines of context', () => {
  assert.deepEqual(A.lineDiff('a\nb\n', 'a\nb\n').hunks, []);
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  const before = `${lines.join('\n')}\n`;
  const inserted = [...lines.slice(0, 10), 'NEW', ...lines.slice(10)];
  let d = A.lineDiff(before, `${inserted.join('\n')}\n`, { labelA: 'a.txt', labelB: 'a.txt (after apply)' });
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 1);
  assert.deepEqual([d.hunks[0].old_start, d.hunks[0].old_lines, d.hunks[0].new_start, d.hunks[0].new_lines], [8, 6, 8, 7]);
  assert.deepEqual(d.hunks[0].lines[3], { op: '+', text: 'NEW', old: null, new: 11 });
  assert.equal(d.unified, '--- a.txt\n+++ a.txt (after apply)\n@@ -8,6 +8,7 @@\n l8\n l9\n l10\n+NEW\n l11\n l12\n l13\n');

  d = A.lineDiff(before, `${lines.filter(l => l !== 'l1').join('\n')}\n`);
  assert.equal(d.removed, 1);
  assert.deepEqual([d.hunks[0].old_start, d.hunks[0].old_lines, d.hunks[0].new_start, d.hunks[0].new_lines], [1, 4, 1, 3]);

  // Two changes 5 lines apart share a hunk; 12 lines apart they don't.
  const near = lines.map(l => (l === 'l5' || l === 'l10' ? `${l}x` : l));
  assert.equal(A.lineDiff(before, `${near.join('\n')}\n`).hunks.length, 1);
  const far = lines.map(l => (l === 'l2' || l === 'l18' ? `${l}x` : l));
  assert.equal(A.lineDiff(before, `${far.join('\n')}\n`).hunks.length, 2);

  d = A.lineDiff(null, 'x\ny\n');
  assert.equal(d.added, 2);
  assert.deepEqual([d.hunks[0].old_start, d.hunks[0].old_lines, d.hunks[0].new_start, d.hunks[0].new_lines], [0, 0, 1, 2]);
});

// ---------- pure: apply / backups / restore ----------

function applyCtx(home) { return ctxFor(home); }
function doApply(target, opts, home, extra = {}) {
  const p = plan(target, opts, home);
  return { plan: p, result: A.applyPlan(p, applyCtx(home), { source: 'dashboard', now: Date.now(), ...extra }) };
}

test('applyPlan writes atomically, keeps modes, backs up changed files and lists every write', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n', 0o644);
  const { plan: p, result } = doApply('opencode', { mode: 'add' }, home);
  assert.equal((fs.statSync(path.join(home, '.config/opencode/opencode.json')).mode & 0o777), 0o644);
  assert.equal((fs.statSync(path.join(home, '.config/opencode/AGENTS.md')).mode & 0o777), 0o600);
  assert.equal(read(home, '.config/opencode/opencode.json'), fileOf(p, 'config').after);
  assert.deepEqual(result.written.map(w => [w.id, w.action]), [['config', 'update'], ['agents_md', 'create']]);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backup.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.source, 'dashboard');
  assert.deepEqual(manifest.agents, ['opencode']);
  assert.deepEqual(manifest.files.map(f => [f.file_id, f.existed, f.backup_name]), [['config', true, 'opencode.config.json'], ['agents_md', false, null]]);
  assert.ok(manifest.files.every(f => /^[0-9a-f]{16}$/.test(f.revision_after)));
  assert.deepEqual(fs.readdirSync(result.backup.dir).sort(), ['manifest.json', 'opencode.config.json']);
  assert.equal(fs.readFileSync(path.join(result.backup.dir, 'opencode.config.json'), 'utf8'), '{"model":"openai/gpt"}\n');
  assert.ok(!fs.readdirSync(path.join(home, '.config/opencode')).some(n => n.endsWith('.tmp')));
});

test('applyPlan writes through a symlink inside HOME and refuses one that leaves HOME', () => {
  const home = tmpdir();
  put(home, 'dotfiles/opencode.json', '{}\n');
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  const link = path.join(home, '.config/opencode/opencode.json');
  fs.symlinkSync(path.join(home, 'dotfiles/opencode.json'), link);
  doApply('opencode', { mode: 'add' }, home);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.match(read(home, 'dotfiles/opencode.json'), /freedeepseek/);

  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, 'x.json'), '{}\n');
  const p = plan('opencode', { mode: 'replace' }, home);
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(outside, 'x.json'), link);
  throwsCode(() => A.applyPlan(p, applyCtx(home), { source: 'dashboard', now: Date.now() }), 'file_outside_home');
  assert.equal(fs.readFileSync(path.join(outside, 'x.json'), 'utf8'), '{}\n');
  throwsCode(() => plan('opencode', {}, home), 'file_outside_home');
});

test('a failed write rolls back the files already written', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  put(home, '.config/opencode/AGENTS.md', '# mine\n');
  let renames = 0;
  const failing = { ...fs, renameSync: (a, b) => { renames += 1; if (renames === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.renameSync(a, b); } };
  const p = plan('opencode', {}, home);
  throwsCode(() => A.applyPlan(p, applyCtx(home), { source: 'dashboard', now: Date.now(), fs: failing }), 'write_failed', (e) => {
    assert.equal(e.extra.file_id, 'agents_md');
    assert.equal(e.extra.rolled_back, true);
    assert.match(e.message, /disk full/);
  });
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');
  assert.equal(read(home, '.config/opencode/AGENTS.md'), '# mine\n');
  assert.deepEqual(A.listBackups(applyCtx(home)), []);
});

test('restoreBackup puts files back, deletes created ones, checks for later edits and keeps a safety copy', () => {
  const home = tmpdir();
  const ctx = applyCtx(home);
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  const { result } = doApply('opencode', {}, home);
  const restored = A.restoreBackup(ctx, result.backup.id, { now: Date.now() + 5 });
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');
  assert.ok(!fs.existsSync(path.join(home, '.config/opencode/AGENTS.md')));
  assert.deepEqual(restored.files.map(f => f.action).sort(), ['deleted', 'restored']);
  const list = A.listBackups(ctx);
  assert.equal(list.length, 2);
  assert.equal(list[0].source, 'restore');
  assert.equal(list[0].id, restored.safety_backup.id);

  // A later edit is a conflict unless forced.
  const second = doApply('opencode', {}, home).result;
  put(home, '.config/opencode/opencode.json', '{"edited":true}\n');
  throwsCode(() => A.restoreBackup(ctx, second.backup.id, { now: Date.now() + 10 }), 'restore_conflict', (e) => {
    assert.deepEqual(e.extra.files, [{ display_path: '~/.config/opencode/opencode.json', reason: 'changed_since' }]);
  });
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"edited":true}\n');
  A.restoreBackup(ctx, second.backup.id, { force: true, now: Date.now() + 20 });
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');

  // A manifest path outside the whitelist is refused.
  const third = doApply('opencode', {}, home).result;
  const mf = path.join(third.backup.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.files[0].path = '/etc/passwd';
  fs.writeFileSync(mf, JSON.stringify(manifest));
  throwsCode(() => A.restoreBackup(ctx, third.backup.id, { force: true, now: Date.now() + 30 }), 'invalid_backup');
  throwsCode(() => A.restoreBackup(ctx, '../../etc', {}), 'backup_not_found');
});

test('listBackups is newest first, explains legacy folders and ignores stray names', () => {
  const home = tmpdir();
  const ctx = applyCtx(home);
  assert.deepEqual(A.listBackups(ctx), []);
  const root = path.join(home, '.freedeepseek-api', 'backups');
  fs.mkdirSync(path.join(root, '2026-01-02T03-04-05-678Z'), { recursive: true });
  fs.writeFileSync(path.join(root, '2026-01-02T03-04-05-678Z', 'config.toml'), 'x');
  fs.mkdirSync(path.join(root, 'not-a-backup'));
  put(home, '.config/opencode/opencode.json', '{}\n');
  doApply('opencode', {}, home);
  const list = A.listBackups(ctx);
  assert.equal(list.length, 2);
  assert.equal(list[0].source, 'dashboard');
  assert.equal(list[0].restorable, true);
  assert.deepEqual(list[0].agents, ['opencode']);
  assert.equal(list[1].id, '2026-01-02T03-04-05-678Z');
  assert.equal(list[1].restorable, false);
  assert.equal(list[1].created_at, Date.parse('2026-01-02T03:04:05.678Z'));
  assert.deepEqual(list[1].files, []);
  assert.match(list[1].reason, /node scripts\/setup-agents\.js --restore ~\/\.freedeepseek-api\/backups\/2026-01-02T03-04-05-678Z/);
});

// ---------- pure: inspect ----------

function inspect(target, home, proxy = {}) {
  return A.inspectTarget(target, ctxFor(home), { baseUrl: BASE, apiKey: 'local', salt: SALT, ...proxy });
}

test('inspectTarget derives each setup state from the files on disk', () => {
  const empty = tmpdir();
  for (const id of A.VALID_TARGETS) {
    const s = inspect(id, empty);
    assert.equal(s.setup.state, id === 'cursor' ? 'manual' : 'none', id);
  }
  assert.equal(inspect('cursor', empty).entry_file, 'settings_snippet');
  assert.equal(inspect('codex', empty).entry_file, 'config');

  const home = tmpdir();
  put(home, '.claude/freedeepseek.settings.json', JSON.stringify(A.claudeSettings({ ...OPTS, baseUrl: 'http://localhost:9655' })));
  let s = inspect('claude-code', home);
  assert.equal(s.setup.state, 'alongside');
  assert.equal(s.setup.mode, 'add');
  assert.equal(s.setup.points_here, true, 'localhost and 127.0.0.1 with the same port are the same proxy');
  assert.equal(s.setup.key, 'matches');
  assert.equal(s.entry_file, 'profile');
  assert.deepEqual(s.defaults, { model: 'deepseek-v4-flash-thinking', mode: 'add', base_url: BASE });

  put(home, '.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_MODEL: 'deepseek-v4-flash', ANTHROPIC_AUTH_TOKEN: 'local' } }));
  s = inspect('claude-code', home);
  assert.equal(s.setup.state, 'default');
  assert.equal(s.setup.model, 'deepseek-v4-flash');
  assert.equal(s.entry_file, 'settings');

  put(home, '.codex/config.toml', 'model = "deepseek-v4-flash"\nmodel_provider = "freedeepseek"\n\n[model_providers.freedeepseek]\nbase_url = "http://127.0.0.1:9656/v1"\nexperimental_bearer_token = "local"\n');
  put(home, '.codex/freedeepseek-models.json', '{"models":[]}\n');
  s = inspect('codex', home);
  assert.equal(s.setup.state, 'outdated');
  assert.equal(s.setup.mode, 'replace');
  assert.equal(s.setup.points_here, false);
  assert.equal(s.setup.base_url, 'http://127.0.0.1:9656/v1');
  assert.deepEqual(s.setup.issues.map(i => [i.code, i.file_id]), [['base_url_mismatch', 'config']]);
  assert.equal(s.setup.issues[0].message, 'config.toml sends Codex to http://127.0.0.1:9656/v1, not this proxy (http://127.0.0.1:9655/v1).');
  assert.deepEqual(s.defaults, { model: 'deepseek-v4-flash', mode: 'add', base_url: BASE });

  const codexAdd = tmpdir();
  put(codexAdd, '.codex/freedeepseek.config.toml', `model = "deepseek-v4-flash"\nmodel_provider = "freedeepseek"\n\n[model_providers.freedeepseek]\nbase_url = "${BASE}/v1"\nexperimental_bearer_token = "local"\n`);
  s = inspect('codex', codexAdd);
  assert.equal(s.setup.state, 'outdated');
  assert.deepEqual(s.setup.issues.map(i => i.code), ['catalog_missing']);

  put(home, '.config/opencode/opencode.json', JSON.stringify({ provider: { freedeepseek: { options: { baseURL: `${BASE}/v1`, apiKey: 'other' } } } }));
  s = inspect('opencode', home);
  assert.equal(s.setup.state, 'outdated');
  assert.equal(s.setup.key, 'differs');
  assert.deepEqual(s.setup.issues.map(i => i.code), ['key_differs']);
  assert.equal(s.effects.length, 4);

  put(home, '.config/opencode/opencode.json', '{\n  "model": "x",\n}\n');
  s = inspect('opencode', home);
  assert.equal(s.setup.state, 'unreadable');
  assert.equal(s.setup.issues[0].code, 'file_unreadable');
  assert.equal(s.setup.issues[0].line, 3);
  assert.equal(s.setup.issues[0].column, 1);

  put(home, '.hermes/config.yaml', `model:\n  default: deepseek-v4-flash\n  provider: custom\n  base_url: ${BASE}/v1\n  api_key: local\nmemory: true\n`);
  s = inspect('hermes', home);
  assert.equal(s.setup.state, 'default');
  assert.equal(s.setup.model, 'deepseek-v4-flash');

  put(home, '.openclaw/openclaw.json', JSON.stringify({ models: { providers: { freedeepseek: { baseUrl: `${BASE}/v1`, apiKey: 'local' } } } }));
  s = inspect('openclaw', home);
  assert.equal(s.setup.state, 'alongside');
  assert.equal(s.entry_file, 'config');

  const file = s.files[0];
  assert.equal(file.display_path, '~/.openclaw/openclaw.json');
  assert.equal(file.exists, true);
  assert.match(file.revision, /^[0-9a-f]{16}$/);
  assert.equal(file.file_mode.length, 4);
});

// ---------- CLI regression ----------

function runCli(args, env) {
  return spawnSync(process.execPath, ['scripts/setup-agents.js', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the CLI writes a manifest, and --restore with a manifest deletes files setup created', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  const res = runCli(['--target', 'opencode', '--base-url', BASE, '--api-key', 'local'], { SETUP_HOME: home });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /^wrote .*opencode\.json$/m);
  const dir = res.stdout.match(/^Backups: (.+)$/m)[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.source, 'cli');
  assert.ok(fs.existsSync(path.join(home, '.config/opencode/AGENTS.md')));
  const back = runCli(['--restore', dir], { SETUP_HOME: home });
  assert.equal(back.status, 0, back.stderr || back.stdout);
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');
  assert.ok(!fs.existsSync(path.join(home, '.config/opencode/AGENTS.md')));
});

test('the setup model list is the server model list', () => {
  assert.deepEqual(A.VALID_MODELS, S.SUPPORTED_MODEL_IDS);
});

// ---------- HTTP ----------

async function startServer(t) {
  const server = S.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function request(port, method, pathName, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathName, agent: false,
      headers: { ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function withHome(t, { bin = [] } = {}) {
  const home = tmpdir();
  const binDir = tmpdir();
  for (const name of bin) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
  t.after(S.useAgentContext({ home, path: binDir, platform: 'linux' }));
  return { home, binDir };
}

const PLANTED = 'sk-planted-0123456789abcdef';

test('GET /admin/agents lists six agents and never returns a stored secret', async (t) => {
  const { home, binDir } = withHome(t, { bin: ['codex'] });
  put(home, '.config/opencode/opencode.json', JSON.stringify({ provider: { other: { options: { apiKey: PLANTED } } } }, null, 2));
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/agents');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json.agents.map(a => a.id), ['claude-code', 'codex', 'opencode', 'hermes', 'openclaw', 'cursor']);
  assert.equal(res.json.proxy.base_url_default, `http://127.0.0.1:${port}`);
  assert.equal(res.json.proxy.base_url_source, 'listen');
  assert.equal(res.json.proxy.key_source, 'none');
  assert.equal(res.json.home, home);
  assert.equal(res.json.models.length, 4);
  assert.deepEqual(res.json.models[1], { id: 'deepseek-v4-flash-thinking', label: 'DeepSeek-V4.1-Flash (thinking + web search)', thinking: true, web_search: true, aliases: ['deepseek-v4-flash-thinking-search'] });
  assert.deepEqual(res.json.backups, { count: 0, latest_at: null });
  assert.ok(!res.text.includes(PLANTED));
  const codex = res.json.agents.find(a => a.id === 'codex');
  assert.deepEqual(codex.tool, { found: true, how: 'path', detail: path.join(binDir, 'codex') });
  assert.deepEqual(res.json.agents.find(a => a.id === 'claude-code').tool, { found: false, how: null, detail: null });
  assert.deepEqual(codex.modes.map(m => m.value), ['add', 'replace']);
  assert.deepEqual(res.json.agents.find(a => a.id === 'claude-code').fixed_models.map(f => f.model), ['deepseek-v4-flash', 'deepseek-v4-flash-thinking', 'deepseek-v4-flash']);
  assert.equal(res.json.agents.find(a => a.id === 'cursor').writable, false);

  const one = await request(port, 'GET', '/admin/agents/codex');
  assert.equal(one.status, 200);
  assert.equal(one.json.agent.id, 'codex');
});

test('unknown agents and file ids are 404 before any path is built', async (t) => {
  withHome(t);
  const port = await startServer(t);
  let res = await request(port, 'GET', '/admin/agents/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'agent_not_found');
  assert.match(res.json.error.message, /Known: claude-code, codex, opencode, hermes, openclaw, cursor/);
  res = await request(port, 'GET', '/admin/agents/codex/files/..%2f..%2fetc');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'unknown_file');
  res = await request(port, 'GET', '/admin/agents/codex/files/%E0%A4%A');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'unknown_file');
});

test('GET a file returns masked text, and explains missing, large and binary files', async (t) => {
  const { home } = withHome(t);
  put(home, '.config/opencode/opencode.json', JSON.stringify({ provider: { other: { options: { apiKey: PLANTED } } } }, null, 2));
  const port = await startServer(t);
  let res = await request(port, 'GET', '/admin/agents/opencode/files/config');
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.masked >= 1);
  assert.ok(!res.text.includes(PLANTED));
  assert.equal(res.json.file.display_path, '~/.config/opencode/opencode.json');
  assert.equal(res.json.masks[0].key, 'apiKey');

  res = await request(port, 'GET', '/admin/agents/codex/files/config');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'file_missing');
  assert.equal(res.json.error.message, '~/.codex/config.toml does not exist.');

  put(home, '.codex/config.toml', Buffer.alloc(1024 * 1024 + 1, 0x61));
  res = await request(port, 'GET', '/admin/agents/codex/files/config');
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'file_too_large');
  assert.equal(res.json.error.limit, 1048576);

  put(home, '.hermes/config.yaml', Buffer.from([0x6d, 0xff, 0xfe, 0x0a]));
  res = await request(port, 'GET', '/admin/agents/hermes/files/config');
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'file_not_text');

  res = await request(port, 'GET', '/admin/agents/cursor/files/launcher');
  assert.equal(res.status, 200);
  assert.equal(res.json.file.virtual, true);
  assert.match(res.json.content, /\$\{PROXY_API_KEY:-local\}/);
});

test('POST plan validates options and never writes', async (t) => {
  const { home } = withHome(t);
  put(home, '.codex/config.toml', 'model = "gpt"\n');
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  const port = await startServer(t);
  const before = snapshot(home);

  let res = await request(port, 'POST', '/admin/agents/codex/plan', { body: { model: 'gpt-5', mode: 'add' } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'invalid_option');
  assert.equal(res.json.error.field, 'model');
  res = await request(port, 'POST', '/admin/agents/codex/plan', { body: { model: 'deepseek-v4-flash', mode: 'add', scope: 'project' } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'invalid_request');
  assert.equal(res.json.error.message, 'Unknown field scope. Allowed: model, mode, base_url');
  res = await request(port, 'POST', '/admin/agents/codex/plan', { raw: '{nope' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.type, 'invalid_json');
  res = await request(port, 'POST', '/admin/agents/codex/plan', { body: { model: 'deepseek-v4-flash', mode: 'add', base_url: 'ftp://x' } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.field, 'base_url');

  res = await request(port, 'POST', '/admin/agents/codex/plan', { body: { model: 'deepseek-v4-flash-thinking', mode: 'replace' } });
  assert.equal(res.status, 200, res.text);
  const p = res.json.plan;
  assert.equal(p.agent_id, 'codex');
  assert.deepEqual(p.options, { model: 'deepseek-v4-flash-thinking', mode: 'replace', base_url: `http://127.0.0.1:${port}` });
  assert.equal(p.changes, 2);
  const config = p.files.find(f => f.id === 'config');
  assert.equal(config.action, 'update');
  assert.match(config.revision, /^[0-9a-f]{16}$/);
  assert.equal(config.before, 'model = "gpt"\n');
  assert.match(config.after, /experimental_bearer_token = "‹proxy-key›"/);
  assert.ok(config.diff.added > 0);
  assert.match(config.diff.unified, /^--- ~\/\.codex\/config\.toml\n\+\+\+ ~\/\.codex\/config\.toml \(after apply\)\n@@ /);
  assert.equal(p.files.find(f => f.id === 'catalog').action, 'create');
  assert.equal(p.writable, true);

  res = await request(port, 'POST', '/admin/agents/opencode/plan', { body: { model: 'deepseek-v4-flash', mode: 'add' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.plan.effects.length, 4);

  put(home, '.config/opencode/opencode.json', '{\n  "model": "x",\n}\n');
  const broken = snapshot(home);
  res = await request(port, 'POST', '/admin/agents/opencode/plan', { body: { model: 'deepseek-v4-flash', mode: 'add' } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'invalid_existing_file');
  assert.equal(res.json.error.line, 3);
  assert.deepEqual(snapshot(home), broken);
  delete before['.config/opencode/opencode.json'];
  delete broken['.config/opencode/opencode.json'];
  assert.deepEqual(broken, before);
});

async function planAndExpect(port, id, options) {
  const res = await request(port, 'POST', `/admin/agents/${id}/plan`, { body: options });
  assert.equal(res.status, 200, res.text);
  return { plan: res.json.plan, expect: Object.fromEntries(res.json.plan.files.map(f => [f.id, f.revision])) };
}

test('POST apply writes what the preview showed, with a backup, and refuses stale previews', async (t) => {
  const { home } = withHome(t);
  put(home, '.codex/config.toml', 'model = "gpt"\nsandbox_mode = "x"\n');
  const port = await startServer(t);
  const options = { model: 'deepseek-v4-flash-thinking', mode: 'replace' };

  let res = await request(port, 'POST', '/admin/agents/codex/apply', { body: options });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'invalid_request');
  const { plan: p, expect } = await planAndExpect(port, 'codex', options);
  res = await request(port, 'POST', '/admin/agents/codex/apply', { body: { ...options, expect: { config: expect.config } } });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.type, 'invalid_request');

  // Stale preview: the file changes between plan and apply.
  put(home, '.codex/config.toml', 'model = "gpt"\nsandbox_mode = "y"\n');
  res = await request(port, 'POST', '/admin/agents/codex/apply', { body: { ...options, expect } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'file_changed');
  assert.deepEqual(res.json.error.files, [{ id: 'config', display_path: '~/.codex/config.toml' }]);
  assert.equal(read(home, '.codex/config.toml'), 'model = "gpt"\nsandbox_mode = "y"\n');
  assert.ok(!fs.existsSync(path.join(home, '.codex/freedeepseek-models.json')));

  const fresh = await planAndExpect(port, 'codex', options);
  res = await request(port, 'POST', '/admin/agents/codex/apply', { body: { ...options, expect: fresh.expect } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.applied.files.map(f => [f.id, f.action]).sort(), [['catalog', 'create'], ['config', 'update']]);
  assert.match(res.json.applied.backup.display_dir, /^~\/\.freedeepseek-api\/backups\//);
  assert.equal(res.json.applied.backup.files, 2);
  const config = fresh.plan.files.find(f => f.id === 'config');
  assert.equal(read(home, '.codex/config.toml'), config.after.replace('‹proxy-key›', 'local'));
  assert.ok(fs.existsSync(path.join(home, '.freedeepseek-api/backups', res.json.applied.backup.id, 'manifest.json')));
  assert.equal(res.json.agent.setup.state, 'default');
  assert.equal(res.json.agent.setup.points_here, true);
  assert.equal(p.files.length, 2);
});

test('apply with nothing to change makes no backup', async (t) => {
  const { home } = withHome(t);
  const port = await startServer(t);
  const options = { model: 'deepseek-v4-flash', mode: 'add' };
  let { expect } = await planAndExpect(port, 'openclaw', options);
  let res = await request(port, 'POST', '/admin/agents/openclaw/apply', { body: { ...options, expect } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.agent.setup.state, 'alongside');
  ({ expect } = await planAndExpect(port, 'openclaw', options));
  res = await request(port, 'POST', '/admin/agents/openclaw/apply', { body: { ...options, expect } });
  assert.equal(res.status, 200);
  assert.equal(res.json.applied.backup, null);
  assert.deepEqual(res.json.applied.files, []);
  assert.equal(fs.readdirSync(path.join(home, '.freedeepseek-api/backups')).filter(n => !n.startsWith('.')).length, 1);
});

test('cursor cannot be applied', async (t) => {
  withHome(t);
  const port = await startServer(t);
  const plan = await request(port, 'POST', '/admin/agents/cursor/plan', { body: { model: 'deepseek-v4-flash', mode: 'add' } });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.plan.writable, false);
  assert.ok(plan.json.plan.files.every(f => f.action === 'create'));
  const res = await request(port, 'POST', '/admin/agents/cursor/apply', { body: { model: 'deepseek-v4-flash', mode: 'add', expect: {} } });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'agent_read_only');
});

test('restore points can be listed and restored over HTTP', async (t) => {
  const { home } = withHome(t);
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  const port = await startServer(t);
  const options = { model: 'deepseek-v4-flash', mode: 'add' };
  const { expect } = await planAndExpect(port, 'opencode', options);
  let res = await request(port, 'POST', '/admin/agents/opencode/apply', { body: { ...options, expect } });
  assert.equal(res.status, 200, res.text);
  const id = res.json.applied.backup.id;

  res = await request(port, 'GET', '/admin/agents/backups');
  assert.equal(res.status, 200);
  assert.equal(res.json.backups[0].id, id);
  assert.deepEqual(res.json.backups[0].options, { model: 'deepseek-v4-flash', mode: 'add' });
  assert.deepEqual(res.json.backups[0].files.map(f => [f.file_id, f.existed]), [['config', true], ['agents_md', false]]);

  put(home, '.config/opencode/opencode.json', '{"edited":true}\n');
  res = await request(port, 'POST', `/admin/agents/backups/${id}/restore`, { body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'restore_conflict');
  res = await request(port, 'POST', `/admin/agents/backups/${id}/restore`, { body: { force: true } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.restored.files.map(f => [f.display_path, f.action]), [['~/.config/opencode/opencode.json', 'restored'], ['~/.config/opencode/AGENTS.md', 'deleted']]);
  assert.match(res.json.restored.safety_backup.id, /^\d{4}-/);
  assert.equal(res.json.agents.length, 6);
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');

  res = await request(port, 'POST', `/admin/agents/backups/${id}/restore`, { body: { force: true, extra: 1 } });
  assert.equal(res.status, 422);
  res = await request(port, 'POST', '/admin/agents/backups/..%2f..%2fetc/restore', { body: {} });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'backup_not_found');

  res = await request(port, 'GET', '/admin/agents');
  assert.equal(res.json.backups.count, 2);
});

test('agent routes answer wrong methods and unknown paths plainly', async (t) => {
  withHome(t);
  const port = await startServer(t);
  let res = await request(port, 'GET', '/admin/agents/codex/plan');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
  res = await request(port, 'POST', '/admin/agents', { body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET');
  res = await request(port, 'GET', '/admin/agents/codex/unknown');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.type, 'not_found');
});

test('agent files are only shown to a browser on the proxy machine', async (t) => {
  assert.equal(S.agentsLocalDecision({ remoteAddress: '127.0.0.1', headers: {} }).allowed, true);
  const remote = S.agentsLocalDecision({ remoteAddress: '10.0.0.2', headers: {} }, { port: 9655 });
  assert.equal(remote.allowed, false);
  assert.equal(remote.status, 403);
  assert.equal(remote.error.type, 'agents_local_only');
  assert.match(remote.error.message, /http:\/\/127\.0\.0\.1:9655\/dashboard/);
  assert.equal(S.agentsLocalDecision({ remoteAddress: '::1', headers: { 'x-real-ip': '1.2.3.4' } }).allowed, false);

  // With PROXY_API_KEY set the admin gate lets a relayed request through; the agents gate must not.
  const home = tmpdir();
  const child = spawn(process.execPath, ['-e', "const s=require('./server.js').__test.server;s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port))"], {
    cwd: ROOT, env: { ...process.env, PROXY_API_KEY: 'k-test-123', SETUP_HOME: home, NON_INTERACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => { out += c; const m = out.match(/PORT=(\d+)/); if (m) resolve(Number(m[1])); });
    child.on('exit', code => reject(new Error(`child exited ${code}`)));
  });
  const auth = { authorization: 'Bearer k-test-123' };
  let res = await request(port, 'GET', '/admin/agents', { headers: auth });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.proxy.key_source, 'env');
  assert.ok(!res.text.includes('k-test-123'));
  res = await request(port, 'GET', '/admin/agents', { headers: { ...auth, 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.type, 'agents_local_only');
});

test('a build without the setup module says where to run setup', async (t) => {
  withHome(t);
  t.after(S.useAgentModule(() => {
    const e = new Error("Cannot find module './scripts/setup-agents'\nRequire stack:\n- server.js");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }));
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/agents');
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'agents_unavailable');
  assert.equal(res.json.error.message, 'Agent setup is not included in this build (scripts/setup-agents.js is missing). The container image ships without it. Run npm run setup:agents on the machine where your agents are installed.');
});

test('a second apply while one is writing is refused', async (t) => {
  withHome(t);
  let release;
  let entered;
  const gate = new Promise(r => { release = r; });
  const inside = new Promise(r => { entered = r; });
  t.after(S.useAgentApply(async (mod, p, ctx, opts) => { entered(); await gate; return mod.applyPlan(p, ctx, opts); }));
  const port = await startServer(t);
  const options = { model: 'deepseek-v4-flash', mode: 'add' };
  const { expect } = await planAndExpect(port, 'openclaw', options);
  const first = request(port, 'POST', '/admin/agents/openclaw/apply', { body: { ...options, expect } });
  await inside;
  const second = await request(port, 'POST', '/admin/agents/openclaw/apply', { body: { ...options, expect } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.type, 'agents_busy');
  release();
  assert.equal((await first).status, 200);
});

// ---------- regressions found in review ----------

test('codex replace finds root keys after nested arrays and multi-line strings', () => {
  const nested = 'approval_policy = "never"\nmatrix = [\n  [1, 2],\n]\nmodel = "gpt-5"\n\n[tui]\nx = 1\n';
  const out = A.upsertTomlKey(nested, 'model', 'deepseek-v4-flash');
  assert.equal((out.match(/^model = /gm) || []).length, 1, out);
  assert.equal(out, 'approval_policy = "never"\nmatrix = [\n  [1, 2],\n]\nmodel = "deepseek-v4-flash"\n\n[tui]\nx = 1\n');

  const multi = 'developer_instructions = """\n[Rules]\nmodel = "not a key"\n"""\nmodel = "gpt-5"\n\n[profiles.work]\nmodel = "x"\n';
  const out2 = A.upsertTomlKey(multi, 'model', 'deepseek-v4-flash');
  assert.equal(out2, 'developer_instructions = """\n[Rules]\nmodel = "not a key"\n"""\nmodel = "deepseek-v4-flash"\n\n[profiles.work]\nmodel = "x"\n');

  // A key that is not at the root yet goes in before the first real table.
  const added = A.upsertTomlKey('matrix = [\n  [1],\n]\n\n[tui]\nx = 1\n', 'model_provider', 'freedeepseek');
  assert.equal(added, 'model_provider = "freedeepseek"\nmatrix = [\n  [1],\n]\n\n[tui]\nx = 1\n');

  // A multi-line value of the key itself is replaced whole.
  assert.equal(A.upsertTomlKey('model = """\ngpt\n"""\nx = 1\n', 'model', 'm'), 'model = "m"\nx = 1\n');
});

test('TOML upserts write a key with $ patterns literally', () => {
  const key = 'ab$&cd$\'$`$1';
  const table = A.upsertTomlTable('x = 1\n\n[model_providers.freedeepseek]\nname = "old"\n', 'model_providers.freedeepseek', `experimental_bearer_token = ${JSON.stringify(key)}`);
  assert.equal(table, `x = 1\n\n[model_providers.freedeepseek]\nexperimental_bearer_token = ${JSON.stringify(key)}\n`);
  assert.equal(A.upsertTomlKey('model = "x"\n', 'model', key), `model = ${JSON.stringify(key)}\n`);

  // The provider table ends at the next real table, not at an indented array row.
  const withArray = '[model_providers.freedeepseek]\nname = "old"\nrows = [\n[1],\n]\n\n[tui]\nx = 1\n';
  assert.equal(A.upsertTomlTable(withArray, 'model_providers.freedeepseek', 'name = "new"'), '[model_providers.freedeepseek]\nname = "new"\n\n[tui]\nx = 1\n');

  const home = tmpdir();
  put(home, '.codex/config.toml', 'model = "gpt"\n\n[model_providers.freedeepseek]\nname = "old"\n');
  const p = plan('codex', { mode: 'replace', apiKey: key }, home);
  const after = fileOf(p, 'config').after;
  assert.ok(after.includes(`experimental_bearer_token = ${JSON.stringify(key)}`), after);
  assert.equal((after.match(/\[model_providers\.freedeepseek\]/g) || []).length, 1, after);
});

test('hermes replace keeps the blank line after the model block', () => {
  assert.equal(
    A.upsertYamlModelBlock('model:\n  default: x\n\n# Memory settings\nmemory: true\n', OPTS),
    `${HERMES_BLOCK}\n# Memory settings\nmemory: true\n`,
  );
  // Blank lines inside the block still belong to it.
  assert.equal(
    A.upsertYamlModelBlock('model:\n  default: x\n\n  provider: y\nmemory: true\n', OPTS),
    `${HERMES_BLOCK}memory: true\n`,
  );
});

test('maskSecrets hides key-named fields, flag values and secret lists', () => {
  const salt = Buffer.from('0123456789abcdef');
  const hidden = (text, format, secrets) => {
    const m = A.maskSecrets(text, format, { proxyKey: 'local', salt });
    for (const s of secrets) assert.ok(!m.text.includes(s), `${s} leaked from ${format}:\n${m.text}`);
    return m;
  };
  let m = hidden('[mcp_servers.gh.env]\nGITHUB_PAT = "abcdef0123456789zz"\nDEEPSEEK_KEY = "plainvalue42"\nenv_key = "OPENAI_API_KEY"\n', 'toml', ['abcdef0123456789zz', 'plainvalue42']);
  assert.equal(m.masked, 2);
  assert.match(m.text, /env_key = "OPENAI_API_KEY"/, 'env_key names a variable, not a secret');

  m = hidden(JSON.stringify({
    provider: { x: { options: { key: 'bare-key-value', headers: { 'X-Auth': 'hdr-auth-value', 'X-Key': 'hdr-key-value' } } } },
    env: { DEEPSEEK_KEY: 'env-key-value', OPENROUTER_KEY: 'router-value' },
    mcp: { gh: { args: ['--api-key', 'argv-secret-1', '--token=argv-secret-2', '--verbose', 'keep-me'] } },
    apiKeys: ['list-secret-1', 'list-secret-2'],
    model: 'keep-model',
  }, null, 2), 'json', ['bare-key-value', 'hdr-auth-value', 'hdr-key-value', 'env-key-value', 'router-value', 'argv-secret-1', 'argv-secret-2', 'list-secret-1', 'list-secret-2']);
  assert.match(m.text, /"keep-me"/);
  assert.match(m.text, /"keep-model"/);
  assert.match(m.text, /"--api-key"/);

  m = hidden('api_keys:\n  - yaml-secret-1\n  - "yaml-secret-2"\ntokens: [flow-secret-1, flow-secret-2]\nargs:\n  - --api-key\n  - yaml-argv-secret\nname: keep\n', 'yaml', ['yaml-secret-1', 'yaml-secret-2', 'flow-secret-1', 'flow-secret-2', 'yaml-argv-secret']);
  assert.match(m.text, /^name: keep$/m);

  m = hidden('api_keys = [\n  "toml-secret-1",\n  "toml-secret-2",\n]\nargs = ["--api-key", "toml-argv-secret"]\nname = "keep"\n', 'toml', ['toml-secret-1', 'toml-secret-2', 'toml-argv-secret']);
  assert.match(m.text, /name = "keep"/);

  hidden('#!/bin/sh\nexec cursor --api-key shell-argv-secret "$@"\n', 'shell', ['shell-argv-secret']);
});

test('a broken JSON file never quotes its text in the error', () => {
  const home = tmpdir();
  const secret = 'sk-ant-SECRETVALUE0123456789abcdef';
  put(home, '.claude/settings.json', `{\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": ${secret}\n  }\n}\n`);
  throwsCode(() => plan('claude-code', { mode: 'replace' }, home), 'invalid_existing_file', (e) => {
    for (const part of ['sk-ant', 'SECRET', 'H_TOKEN']) assert.ok(!e.message.includes(part), e.message);
    assert.equal(e.extra.line, 3);
    assert.equal(e.extra.column, 29);
  });
  const s = inspect('claude-code', home);
  assert.equal(s.setup.state, 'unreadable');
  assert.ok(!JSON.stringify(s).includes('SECRET'), JSON.stringify(s.setup.issues));
});

test('inspectTarget never returns a credential from a base URL or model', () => {
  const home = tmpdir();
  const token = 'sk-live0123456789abcdefXYZ';
  put(home, '.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://gw.example.com/u/${token}`, ANTHROPIC_MODEL: 'deepseek-chat' } }));
  let s = inspect('claude-code', home);
  assert.ok(!JSON.stringify(s).includes(token), JSON.stringify(s.setup));
  assert.match(s.setup.base_url, /^https:\/\/gw\.example\.com\/u\/‹secret:[0-9a-f]{6}›$/);

  put(home, '.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://user:pa55word@gw.example.com/v1?api_key=q-secret-77&region=eu', ANTHROPIC_MODEL: 'deepseek-chat' } }));
  s = inspect('claude-code', home);
  const text = JSON.stringify(s);
  for (const part of ['pa55word', 'q-secret-77']) assert.ok(!text.includes(part), text);
  assert.match(s.setup.base_url, /region=eu/);
});

test('a legacy -search model ID reads as the current model', () => {
  const home = tmpdir();
  put(home, '.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_MODEL: 'deepseek-v4-flash-search', ANTHROPIC_AUTH_TOKEN: 'local' } }));
  const s = inspect('claude-code', home);
  assert.equal(s.setup.state, 'default');
  assert.deepEqual(s.setup.issues, []);
  assert.equal(s.setup.model, 'deepseek-v4-flash');
  assert.equal(s.setup.model_written, 'deepseek-v4-flash-search');
  assert.equal(s.defaults.model, 'deepseek-v4-flash');
});

test('a config folder that links outside HOME is refused like a linked file', () => {
  const home = tmpdir();
  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, 'settings.json'), '{"x":"OUTSIDE"}\n');
  fs.symlinkSync(outside, path.join(home, '.claude'));
  throwsCode(() => A.readAgentFile(ctxFor(home), 'claude-code', 'settings', { salt: SALT, baseUrl: BASE }), 'file_outside_home');
  throwsCode(() => plan('claude-code', { mode: 'replace' }, home), 'file_outside_home');
  // A file that does not exist yet under a linked folder is refused too.
  throwsCode(() => plan('claude-code', { mode: 'add' }, home), 'file_outside_home', e => /freedeepseek\.settings\.json/.test(e.message));
  assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), '{"x":"OUTSIDE"}\n');
  assert.deepEqual(fs.readdirSync(outside), ['settings.json']);
  assert.equal(inspect('claude-code', home).setup.state, 'unreadable');

  // A folder linked to another place inside HOME still works.
  const inside = tmpdir();
  fs.mkdirSync(path.join(inside, 'dotfiles', 'claude'), { recursive: true });
  fs.symlinkSync(path.join(inside, 'dotfiles', 'claude'), path.join(inside, '.claude'));
  doApply('claude-code', { mode: 'add' }, inside);
  assert.ok(fs.existsSync(path.join(inside, 'dotfiles', 'claude', 'freedeepseek.settings.json')));
});

test('a failed backup leaves no half-made restore point and changes nothing', () => {
  const home = tmpdir();
  put(home, '.config/opencode/opencode.json', '{"model":"openai/gpt"}\n');
  const failing = {
    ...fs,
    writeFileSync: (file, ...rest) => {
      if (String(file).endsWith('manifest.json')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(file, ...rest);
    },
  };
  const p = plan('opencode', {}, home);
  throwsCode(() => A.applyPlan(p, applyCtx(home), { source: 'dashboard', now: Date.now(), fs: failing }), 'write_failed', (e) => {
    assert.match(e.message, /back up/i);
    assert.match(e.message, /no space left on device/);
    assert.equal(e.extra.rolled_back, true);
  });
  assert.equal(read(home, '.config/opencode/opencode.json'), '{"model":"openai/gpt"}\n');
  assert.ok(!fs.existsSync(path.join(home, '.config/opencode/AGENTS.md')));
  const root = path.join(home, '.freedeepseek-api', 'backups');
  assert.deepEqual((fs.existsSync(root) ? fs.readdirSync(root) : []).filter(n => A.BACKUP_ID_RE.test(n)), []);
  assert.deepEqual(A.listBackups(applyCtx(home)), []);
});

test('the CLI explains in --help and in its error that it only changes files inside HOME', () => {
  const help = runCli(['--help'], {});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /home folder/i);
  assert.match(help.stdout, /1 MiB/);

  const home = tmpdir();
  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, 'opencode.json'), '{}\n');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'opencode.json'), path.join(home, '.config', 'opencode', 'opencode.json'));
  const res = runCli(['--target', 'opencode', '--non-interactive', '--base-url', BASE], { SETUP_HOME: home });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /outside your home folder/);
  assert.match(res.stderr, /\(file_outside_home\)/);
  assert.equal(fs.readFileSync(path.join(outside, 'opencode.json'), 'utf8'), '{}\n');
});

test('GET /admin/agents/backups returns every restore point', async (t) => {
  const { home } = withHome(t);
  const root = path.join(home, '.freedeepseek-api', 'backups');
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 60; i++) {
    const at = start + i * 1000;
    const id = new Date(at).toISOString().replace(/[:.]/g, '-');
    const agent = i === 0 ? 'claude-code' : 'codex';
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify({ version: 1, created_at: at, source: 'dashboard', agents: [agent], options: null, files: [] }));
  }
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/agents/backups');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.backups.length, 60);
  assert.deepEqual(res.json.backups[59].agents, ['claude-code'], 'the oldest point is still listed');
  const all = await request(port, 'GET', '/admin/agents');
  assert.equal(all.json.backups.count, 60);
});

test('a PROXY_BASE_URL with a path is reported, not handed out as a default', async (t) => {
  withHome(t);
  const prev = process.env.PROXY_BASE_URL;
  process.env.PROXY_BASE_URL = 'https://host.example/deepseek';
  t.after(() => { if (prev === undefined) delete process.env.PROXY_BASE_URL; else process.env.PROXY_BASE_URL = prev; });
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/agents');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.proxy.base_url_default, `http://127.0.0.1:${port}`);
  assert.equal(res.json.proxy.base_url_source, 'listen');
  assert.equal(res.json.proxy.base_url_error.type, 'invalid_proxy_base_url');
  assert.match(res.json.proxy.base_url_error.message, /PROXY_BASE_URL/);
  assert.match(res.json.proxy.base_url_error.message, /https:\/\/host\.example\/deepseek/);
  const planned = await request(port, 'POST', '/admin/agents/codex/plan', { body: { model: 'deepseek-v4-flash', mode: 'add' } });
  assert.equal(planned.status, 200, planned.text);
  assert.equal(planned.json.plan.options.base_url, `http://127.0.0.1:${port}`);

  // An origin with /v1 is fine and is used without it.
  process.env.PROXY_BASE_URL = 'https://host.example/v1/';
  const ok = await request(port, 'GET', '/admin/agents');
  assert.equal(ok.json.proxy.base_url_default, 'https://host.example');
  assert.equal(ok.json.proxy.base_url_source, 'PROXY_BASE_URL');
  assert.equal(ok.json.proxy.base_url_error, undefined);
});

test('GET /admin/agents lists the older model names each model answers to', async (t) => {
  withHome(t);
  const port = await startServer(t);
  const res = await request(port, 'GET', '/admin/agents');
  assert.deepEqual(res.json.models.find(m => m.id === 'deepseek-v4-flash').aliases, ['deepseek-v4-flash-search']);
  assert.deepEqual(res.json.models.find(m => m.id === 'deepseek-v4-flash-nosearch').aliases, []);
});
