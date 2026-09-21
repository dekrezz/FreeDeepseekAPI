#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  t,
  loadUiLang,
  saveUiLang,
  pick,
  LANGS,
} = require('./lib/tui-menu');
const { importFromFile, chooseImportPath, DEFAULT_OUT } = require('./auth_import');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const PROFILE_DIR = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-deepseek');

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
  catch { return null; }
}

function shortPath(file) {
  const home = require('os').homedir();
  const abs = path.resolve(file);
  return abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
}

function authStatus(lang) {
  const auth = loadAuth();
  const profileOk = fs.existsSync(PROFILE_DIR);
  return [
    {
      ok: Boolean(auth?.token && auth?.cookie),
      label: '',
      value: auth ? shortPath(AUTH_PATH) : t(lang, 'missing'),
    },
    {
      ok: profileOk,
      label: t(lang, 'profile'),
      value: profileOk ? t(lang, 'found') : t(lang, 'missing'),
    },
  ];
}

async function panel(langRef, subtitleKey, status, extraItems = []) {
  await pick(
    () => ({
      lang: langRef.current,
      subtitle: t(langRef.current, subtitleKey),
      status,
      items: [
        ...extraItems,
        { id: 'back', label: t(langRef.current, 'back'), help: t(langRef.current, 'pressEnter') },
      ],
    }),
    (next) => { langRef.current = next; saveUiLang(next); },
  );
}

function runDirectAuth() {
  return spawnSync(process.execPath, [path.join(__dirname, 'deepseek_chrome_auth.js')], {
    stdio: 'inherit',
    env: { ...process.env, FREDEEPSEEK_EMBEDDED: '1' },
  }).status;
}

function runAgentSetup() {
  return spawnSync(process.execPath, [path.join(__dirname, 'setup-agents.js')], {
    stdio: 'inherit',
  }).status;
}

async function runImportAuth(langRef) {
  const inputPath = await chooseImportPath(langRef);
  if (!inputPath) return false;
  let result;
  try {
    result = importFromFile(path.resolve(inputPath), DEFAULT_OUT);
  } catch (err) {
    await panel(langRef, 'importFail', [
      { ok: false, label: t(langRef.current, 'importFail'), value: err.message },
    ]);
    return false;
  }
  if (!result.ok) {
    await panel(langRef, 'importFail', [
      { ok: false, label: t(langRef.current, 'importFail'), value: result.errors.join(', ') },
    ]);
    return false;
  }
  await panel(langRef, 'importOk', authStatus(langRef.current));
  return true;
}

function removeLocalAuth() {
  if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { force: true });
}

function printHelp(lang) {
  console.log(`FreeDeepseekAPI — ${t(lang, 'authSubtitle')}

  npm run auth
  npm run auth -- --login
  npm run auth -- --lang ru

  --login      ${t(lang, 'helpLogin')}
  --import     ${t(lang, 'helpImport')}
  --status     ${t(lang, 'helpStatus')}
  --remove     ${t(lang, 'helpRemove')}
  --lang       ${LANGS.join(' | ')}
  --help
`);
}

function parseLangFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') return String(argv[i + 1] || '').toLowerCase();
    if (argv[i].startsWith('--lang=')) return argv[i].slice(7).toLowerCase();
  }
  return '';
}

async function confirmRemove(langRef) {
  const pickId = await pick(
    () => ({
      lang: langRef.current,
      subtitle: t(langRef.current, 'authTitle'),
      status: [{ ok: false, label: t(langRef.current, 'session'), value: t(langRef.current, 'confirmRemove') }],
      items: [
        { id: 'yes', label: t(langRef.current, 'yes'), help: t(langRef.current, 'helpRemove') },
        { id: 'no', label: t(langRef.current, 'no'), help: t(langRef.current, 'back') },
      ],
    }),
    (next) => { langRef.current = next; saveUiLang(next); },
  );
  return pickId.id === 'yes';
}

async function menu(langRef) {
  while (true) {
    const chosen = await pick(
      () => {
        const lang = langRef.current;
        return {
          lang,
          subtitle: t(lang, 'authSubtitle'),
          status: authStatus(lang),
          items: [
            { id: 'login', label: t(lang, 'login'), help: t(lang, 'helpLogin') },
            { id: 'import', label: t(lang, 'import'), help: t(lang, 'helpImport') },
            { id: 'status', label: t(lang, 'status'), help: t(lang, 'helpStatus') },
            { id: 'remove', label: t(lang, 'remove'), help: t(lang, 'helpRemove') },
            { id: 'quit', label: t(lang, 'quit'), help: t(lang, 'helpQuit') },
          ],
        };
      },
      (next) => { langRef.current = next; saveUiLang(next); },
    );
    const lang = langRef.current;
    if (chosen.id === 'login') {
      if (runDirectAuth() === 10) runAgentSetup();
    }
    else if (chosen.id === 'import') await runImportAuth(langRef);
    else if (chosen.id === 'status') await panel(langRef, 'status', authStatus(lang));
    else if (chosen.id === 'remove') {
      if (await confirmRemove(langRef)) {
        removeLocalAuth();
        await panel(langRef, 'done', authStatus(langRef.current));
      }
    }
    else break;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv.filter(a => !a.startsWith('--lang')));
  const flagLang = parseLangFlag(argv);
  const langRef = { current: LANGS.includes(flagLang) ? flagLang : loadUiLang() };
  if (LANGS.includes(flagLang)) saveUiLang(flagLang);

  if (args.has('--help') || args.has('-h')) return printHelp(langRef.current);
  if (args.has('--login') || args.has('--add') || args.has('--relogin')) {
    if (runDirectAuth() === 10) runAgentSetup();
    return;
  }
  if (args.has('--import')) return void await runImportAuth(langRef);
  if (args.has('--status') || args.has('--list')) return void await panel(langRef, 'status', authStatus(langRef.current));
  if (args.has('--remove')) {
    removeLocalAuth();
    return void await panel(langRef, 'done', authStatus(langRef.current));
  }
  await menu(langRef);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { loadAuth, AUTH_PATH };
