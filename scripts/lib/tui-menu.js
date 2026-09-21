'use strict';

const readline = require('readline');
const { execFileSync } = require('child_process');

const LANGS = ['en', 'ru', 'zh'];

const STRINGS = {
  en: {
    authTitle: 'Sign in',
    authSubtitle: 'DeepSeek Web session',
    startTitle: 'Start',
    startSubtitle: 'Local proxy',
    session: 'Session',
    token: 'Token',
    cookies: 'Cookies',
    profile: 'Chrome profile',
    accounts: 'Logins',
    models: 'Models',
    missing: 'missing',
    found: 'ok',
    none: 'none',
    login: 'Sign in with Chrome',
    import: 'Import auth file / cookies',
    status: 'Show status',
    remove: 'Remove local auth file',
    modelsList: 'Show models',
    start: 'Start proxy',
    quit: 'Quit',
    back: 'Back',
    confirmRemove: 'Delete deepseek-auth.json? Chrome profile stays.',
    yes: 'Yes, delete',
    no: 'Cancel',
    hint: 'click · ↑↓ · enter · 1–9 · tab · q',
    hintLang: 'click language · [ ] cycle',
    pressEnter: 'Press Enter to return',
    removed: 'Removed local auth file. Chrome profile was left in place.',
    needAuth: 'Add a login first (Chrome or import).',
    helpLogin: 'Open Chrome and capture token + cookies',
    helpImport: 'Load a saved JSON or browser cookie export',
    helpStatus: 'Print token / cookie / profile details',
    helpRemove: 'Delete deepseek-auth.json only',
    helpStart: 'Listen on the local API port',
    helpModels: 'List supported model ids',
    helpQuit: 'Leave this menu',
    importPath: 'Path to JSON',
    typePath: 'Type a path…',
    importHint: 'type a path · enter · esc',
    importOk: 'Imported',
    importFail: 'Could not import',
    chromeOpen: 'Chrome will open. Sign in at chat.deepseek.com.',
    sendTest: 'Sign in, then send a short message such as “ok”.',
    continue: 'I signed in — continue',
    done: 'Done',
    cancelled: 'Cancelled',
    standard: 'Standard',
    think: 'DeepThink',
    search: 'Search',
    thinkSearch: 'DeepThink + Search',
    setupSubtitle: 'Choose integrations',
    allTargets: 'Configure all',
    chooseModel: 'Choose the default model',
    installMode: 'How should FreeDeepseekAPI be added?',
    addAlongside: 'Add alongside existing models',
    replaceDefault: 'Make DeepSeek the default model',
    selectAgents: 'Select coding agents',
    continueSetup: 'Continue',
    setupComplete: 'Coding agents are configured',
    setupCancelled: 'Setup cancelled. Come back anytime.',
    selected: 'Selected',
    spaceToggle: 'space/click toggle · enter continue · ctrl+c back',
    readingSession: 'Reading the DeepSeek session…',
    openingChrome: 'Opening Chrome…',
    authReady: 'Connected. Your DeepSeek session is ready.',
    configureAgents: 'Configure coding agents',
  },
  ru: {
    authTitle: 'Вход',
    authSubtitle: 'Сессия DeepSeek Web',
    startTitle: 'Запуск',
    startSubtitle: 'Локальный прокси',
    session: 'Сессия',
    token: 'Токен',
    cookies: 'Cookies',
    profile: 'Профиль Chrome',
    accounts: 'Логины',
    models: 'Модели',
    missing: 'нет',
    found: 'ок',
    none: 'нет',
    login: 'Войти через Chrome',
    import: 'Импорт auth-файла / cookies',
    status: 'Показать статус',
    remove: 'Удалить локальный auth',
    modelsList: 'Показать модели',
    start: 'Запустить прокси',
    quit: 'Выход',
    back: 'Назад',
    confirmRemove: 'Удалить deepseek-auth.json? Профиль Chrome останется.',
    yes: 'Да, удалить',
    no: 'Отмена',
    hint: 'клик · ↑↓ · enter · 1–9 · tab · q',
    hintLang: 'клик по языку · [ ] переключить',
    pressEnter: 'Enter — вернуться',
    removed: 'Локальный auth удалён. Профиль Chrome не трогали.',
    needAuth: 'Сначала добавьте логин (Chrome или импорт).',
    helpLogin: 'Открыть Chrome и снять token + cookies',
    helpImport: 'Загрузить готовый JSON или cookies из браузера',
    helpStatus: 'Показать token / cookie / профиль',
    helpRemove: 'Удалить только deepseek-auth.json',
    helpStart: 'Слушать локальный порт API',
    helpModels: 'Список рабочих model id',
    helpQuit: 'Закрыть меню',
    importPath: 'Путь к JSON',
    typePath: 'Ввести путь…',
    importHint: 'путь · enter · esc',
    importOk: 'Импортировано',
    importFail: 'Не вышло импортировать',
    chromeOpen: 'Сейчас откроется Chrome. Войдите на chat.deepseek.com.',
    sendTest: 'Войдите и отправьте короткое сообщение, например «ok».',
    continue: 'Я вошёл — продолжить',
    done: 'Готово',
    cancelled: 'Отменено',
    standard: 'Обычная',
    think: 'DeepThink',
    search: 'Search',
    thinkSearch: 'DeepThink + Search',
    setupSubtitle: 'Выберите интеграции',
    allTargets: 'Настроить всё',
    chooseModel: 'Выберите модель по умолчанию',
    installMode: 'Как подключить FreeDeepseekAPI?',
    addAlongside: 'Добавить рядом с текущими моделями',
    replaceDefault: 'Сделать DeepSeek моделью по умолчанию',
    selectAgents: 'Выберите coding-агентов',
    continueSetup: 'Продолжить',
    setupComplete: 'Coding-агенты настроены',
    setupCancelled: 'Настройка отменена. Возвращайтесь ещё.',
    selected: 'Выбрано',
    spaceToggle: 'пробел/клик — галочка · enter — дальше · ctrl+c — назад',
    readingSession: 'Читаю сессию DeepSeek…',
    openingChrome: 'Открываю Chrome…',
    authReady: 'Готово. Сессия DeepSeek подключена.',
    configureAgents: 'Настроить coding-агентов',
  },
  zh: {
    authTitle: '登录',
    authSubtitle: 'DeepSeek Web 会话',
    startTitle: '启动',
    startSubtitle: '本地代理',
    session: '会话',
    token: 'Token',
    cookies: 'Cookies',
    profile: 'Chrome 配置',
    accounts: '登录',
    models: '模型',
    missing: '缺失',
    found: '正常',
    none: '无',
    login: '用 Chrome 登录',
    import: '导入 auth / cookies',
    status: '查看状态',
    remove: '删除本地 auth',
    modelsList: '显示模型',
    start: '启动代理',
    quit: '退出',
    back: '返回',
    confirmRemove: '删除 deepseek-auth.json？Chrome 配置保留。',
    yes: '删除',
    no: '取消',
    hint: '点击 · ↑↓ · enter · 1–9 · tab · q',
    hintLang: '点击语言 · [ ] 切换',
    pressEnter: '按 Enter 返回',
    removed: '已删除本地 auth。Chrome 配置未动。',
    needAuth: '请先登录（Chrome 或导入）。',
    helpLogin: '打开 Chrome 并采集 token + cookies',
    helpImport: '载入已有 JSON 或浏览器 cookies',
    helpStatus: '显示 token / cookie / 配置',
    helpRemove: '只删除 deepseek-auth.json',
    helpStart: '监听本地 API 端口',
    helpModels: '列出可用 model id',
    helpQuit: '离开菜单',
    importPath: 'JSON 路径',
    typePath: '输入路径…',
    importHint: '输入路径 · enter · esc',
    importOk: '已导入',
    importFail: '导入失败',
    chromeOpen: '即将打开 Chrome。请在 chat.deepseek.com 登录。',
    sendTest: '登录后发送一条短消息，例如“ok”。',
    continue: '已登录 — 继续',
    done: '完成',
    cancelled: '已取消',
    standard: '标准',
    think: 'DeepThink',
    search: 'Search',
    thinkSearch: 'DeepThink + Search',
    setupSubtitle: '选择集成',
    allTargets: '配置全部',
    chooseModel: '选择默认模型',
    installMode: '如何添加 FreeDeepseekAPI？',
    addAlongside: '与现有模型一起添加',
    replaceDefault: '将 DeepSeek 设为默认模型',
    selectAgents: '选择 Coding Agent',
    continueSetup: '继续',
    setupComplete: 'Coding Agent 配置完成',
    setupCancelled: '设置已取消，欢迎下次再来。',
    selected: '已选择',
    spaceToggle: '空格/点击切换 · Enter 继续 · Ctrl+C 返回',
    readingSession: '正在读取 DeepSeek 会话…',
    openingChrome: '正在打开 Chrome…',
    authReady: '连接成功。DeepSeek 会话已就绪。',
    configureAgents: '配置 Coding Agent',
  },
};

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  blue: '\x1b[94m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  brightYellow: '\x1b[93m',
  magenta: '\x1b[35m',
  inv: '\x1b[7m',
  bg: '\x1b[48;5;23m',
};

const GLYPH = {
  D: ['██████ ', '██   ██', '██   ██', '██   ██', '██████ '],
  E: ['███████', '██     ', '█████  ', '██     ', '███████'],
  F: ['███████', '██     ', '█████  ', '██     ', '██     '],
  P: ['██████ ', '██   ██', '██████ ', '██     ', '██     '],
  R: ['██████ ', '██   ██', '██████ ', '██   ██', '██   ██'],
};

function wordmarkLines(word = 'FREEDEEP') {
  const letters = [...String(word).toUpperCase()].map(ch => GLYPH[ch]);
  if (letters.some(g => !g)) return [word];
  return [0, 1, 2, 3, 4].map(row => letters.map(g => g[row]).join(' '));
}

function t(lang, key) {
  const pack = STRINGS[lang] || STRINGS.en;
  return pack[key] || STRINGS.en[key] || key;
}

function languageFromLocale(locale) {
  const value = String(locale || '').trim().toLowerCase();
  if (value.startsWith('ru')) return 'ru';
  if (value.startsWith('zh')) return 'zh';
  return 'en';
}

function systemLocale(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      return execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }
    if (platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', '(Get-Culture).Name'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    }
    return execFileSync('locale', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).match(/^(?:LANG|LC_MESSAGES)=([^\n]+)/m)?.[1]?.replace(/^"|"$/g, '') || '';
  } catch {
    return '';
  }
}

function detectLocale(env = process.env, platform = process.platform) {
  const flag = String(env.FREDEEPSEEK_LANG || env.DEEPSEEK_LANG || '').toLowerCase();
  if (LANGS.includes(flag)) return flag;
  if (env === process.env && (platform === 'darwin' || platform === 'win32')) {
    const nativeLocale = systemLocale(platform);
    if (nativeLocale) return languageFromLocale(nativeLocale);
  }
  const envLocale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  if (envLocale) return languageFromLocale(envLocale);
  return languageFromLocale(env === process.env ? systemLocale(platform) : '');
}

function loadUiLang() {
  return detectLocale();
}

function saveUiLang() {
  // Language selection is session-local. Every new run follows the OS locale.
}

function cellWidth(ch) {
  const code = ch.codePointAt(0);
  if (!code || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) return 2;
  return 1;
}

function visibleWidth(text) {
  const plain = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  let w = 0;
  for (const ch of plain) w += cellWidth(ch);
  return w;
}

function padVisible(text, width) {
  const extra = Math.max(0, width - visibleWidth(text));
  return `${text}${' '.repeat(extra)}`;
}

function centered(text, width) {
  return `${' '.repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)))}${text}`;
}

function parseSgrMouse(chunk) {
  const events = [];
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m;
  while ((m = re.exec(String(chunk))) !== null) {
    const button = Number(m[1]);
    events.push({
      button,
      x: Number(m[2]),
      y: Number(m[3]),
      press: m[4] === 'M',
      motion: (button & 32) === 32,
      wheel: button === 64 || button === 65,
      left: (button & 3) === 0 && (button & 64) === 0,
    });
  }
  return events;
}

function hitTest(regions, x, y) {
  return regions.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) || null;
}

function parseKey(chunk) {
  const s = String(chunk);
  if (s === '\x03') return 'ctrl-c';
  if (s === '\x1b') return 'esc';
  if (s === '\r' || s === '\n') return 'enter';
  if (s === ' ') return 'space';
  if (s === '\t') return 'tab';
  if (s === '\x1b[A' || s === 'k') return 'up';
  if (s === '\x1b[B' || s === 'j') return 'down';
  if (s === '\x1b[D') return 'left';
  if (s === '\x1b[C') return 'right';
  if (s === '[' || s === 'h') return 'lang-prev';
  if (s === ']' || s === 'l') return 'lang-next';
  if (s === 'q' || s === 'Q') return 'quit';
  if (/^[1-9]$/.test(s)) return s;
  return null;
}

function cycleLang(lang, dir) {
  const i = LANGS.indexOf(lang);
  const next = (i < 0 ? 0 : i) + dir;
  return LANGS[(next + LANGS.length) % LANGS.length];
}

function enableInteractive() {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
}

function disableInteractive() {
  process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* already cooked */ }
  }
}

function renderFrame(state) {
  const width = Math.max(60, process.stdout.columns || 80);
  const menuWidth = Math.min(38, width - 8);
  const contentHeight = 5 + 1 + 1 + 1 + state.status.length + 1
    + (state.field ? 2 : 0) + state.items.length + 2;
  const topBlank = Math.max(2, Math.floor(((process.stdout.rows || 30) - contentHeight) / 2));
  const lang = state.lang;
  const regions = [];
  const lines = Array(topBlank).fill('');
  let y = topBlank + 1;

  const mark = wordmarkLines('FREEDEEP');
  mark.forEach((row) => {
    lines.push(centered(`${C.bold}${row}${C.reset}`, width));
    y += 1;
  });
  lines.push('');
  y += 1;

  const credit = `${C.dim}from${C.reset} ${C.brightYellow}${C.bold}dekrezz${C.reset}`;
  let langBits = '';
  for (const code of LANGS) {
    const label = ` ${code.toUpperCase()} `;
    const selected = code === lang;
    const hovered = state.hover === `lang:${code}`;
    const shown = selected
      ? `${C.inv}${label}${C.reset}`
      : hovered
        ? `${C.cyan}${label}${C.reset}`
        : `${C.dim}${label}${C.reset}`;
    langBits += shown;
  }
  const languageWidth = visibleWidth(langBits);
  let languageX = Math.max(1, width - languageWidth - 2);
  for (const code of LANGS) {
    regions.push({ id: `lang:${code}`, x: languageX, y: 2, w: 4, h: 1 });
    languageX += 4;
  }
  lines[1] = `${' '.repeat(Math.max(0, width - languageWidth - 3))}${langBits}`;
  lines.push(centered(credit, width));
  y += 1;

  lines.push('');
  y += 1;

  for (const row of state.status) {
    const dot = row.ok ? `${C.green}▸${C.reset}` : `${C.red}▸${C.reset}`;
    const label = row.label ? `${C.dim}${row.label}${C.reset}  ` : '';
    lines.push(centered(`${dot}  ${label}${row.value}`, width));
    y += 1;
  }

  lines.push('');
  y += 1;

  if (state.field) {
    const typed = state.field.value || '';
    const placeholder = typed ? typed : t(lang, 'importPath');
    const body = typed
      ? `${C.bold}${typed}${C.reset}${C.cyan}▏${C.reset}`
      : `${C.dim}${placeholder}${C.reset}${C.cyan}▏${C.reset}`;
    lines.push(centered(`${C.cyan}▌${C.reset}  ${body}`, width));
    y += 1;
    lines.push('');
    y += 1;
  }

  state.items.forEach((item, i) => {
    const active = i === state.index;
    const hovered = state.hover === `item:${i}`;
    const slab = active ? `${C.cyan}▌${C.reset}` : hovered ? `${C.cyan}│${C.reset}` : ' ';
    const check = typeof item.checked === 'boolean'
      ? `${item.checked ? `${C.green}◆${C.reset}` : `${C.dim}◇${C.reset}`}  `
      : '';
    const label = active || hovered
      ? `${check}${C.bold}${item.label}${C.reset}`
      : `${check}${C.dim}${item.label}${C.reset}`;
    const itemLine = `${slab}  ${label}`;
    const itemX = Math.max(1, Math.floor((width - menuWidth) / 2) + 1);
    lines.push(`${' '.repeat(itemX - 1)}${padVisible(itemLine, menuWidth)}`);
    regions.push({ id: `item:${i}`, x: itemX, y, w: menuWidth, h: 1 });
    y += 1;
  });

  if (state.items.length) {
    lines.push('');
    lines.push(centered(`${C.dim}${state.footer || '↑↓  enter  ·  click'}${C.reset}`, width));
  }

  process.stdout.write(`\x1b[H\x1b[J${lines.join('\n')}\n`);
  return regions;
}

async function readChunk() {
  return new Promise(resolve => {
    const onData = (data) => {
      process.stdin.off('data', onData);
      resolve(data);
    };
    process.stdin.on('data', onData);
  });
}

async function runInteractiveMenu(getState, setLang, options = {}) {
  enableInteractive();
  let index = 0;
  let hover = '';
  const cleanup = () => disableInteractive();
  try {
    while (true) {
      const snap = getState();
      if (!snap.items.length) return { id: 'quit' };
      index = Math.max(0, Math.min(index, snap.items.length - 1));
      const regions = renderFrame({ ...snap, index, hover });
      const chunk = await readChunk();
      const mouse = parseSgrMouse(chunk);
      if (mouse.length) {
        const ev = mouse[mouse.length - 1];
        const hit = hitTest(regions, ev.x, ev.y);
        if (ev.motion || !ev.press) {
          hover = hit ? hit.id : '';
          if (hit && hit.id.startsWith('item:')) index = Number(hit.id.slice(5));
          continue;
        }
        if (ev.press && ev.left && hit) {
          if (hit.id.startsWith('lang:')) {
            setLang(hit.id.slice(5));
            continue;
          }
          if (hit.id.startsWith('item:')) {
            index = Number(hit.id.slice(5));
            return { id: snap.items[index].id };
          }
        }
        if (ev.wheel) {
          index = ev.button === 64 ? Math.max(0, index - 1) : Math.min(snap.items.length - 1, index + 1);
        }
        continue;
      }
      const key = parseKey(chunk);
      if (key === 'ctrl-c' || key === 'esc') return { id: options.cancelId || 'quit' };
      if (key === 'quit') return { id: options.quitId || options.cancelId || 'quit' };
      if (key === 'up') index = (index - 1 + snap.items.length) % snap.items.length;
      else if (key === 'down') index = (index + 1) % snap.items.length;
      else if (key === 'lang-prev' || key === 'left') setLang(cycleLang(snap.lang, -1));
      else if (key === 'lang-next' || key === 'right' || key === 'tab') setLang(cycleLang(snap.lang, 1));
      else if (key === 'enter') return { id: snap.items[index].id };
      else if (key && /^[1-9]$/.test(key)) {
        const n = Number(key) - 1;
        if (snap.items[n]) return { id: snap.items[n].id };
      }
    }
  } finally {
    cleanup();
  }
}

async function runInteractiveMulti(getState, setLang, initial = [], options = {}) {
  enableInteractive();
  const selected = new Set(initial);
  let index = 0;
  let hover = '';
  try {
    while (true) {
      const snap = getState();
      const selectable = snap.items;
      const items = [
        ...selectable.map(item => ({ ...item, checked: selected.has(item.id) })),
        { id: '__continue', label: t(snap.lang, 'continueSetup') },
      ];
      index = Math.max(0, Math.min(index, items.length - 1));
      const regions = renderFrame({
        ...snap,
        items,
        index,
        hover,
        footer: t(snap.lang, 'spaceToggle'),
      });
      const chunk = await readChunk();
      const mouse = parseSgrMouse(chunk);
      if (mouse.length) {
        const ev = mouse[mouse.length - 1];
        const hit = hitTest(regions, ev.x, ev.y);
        if (ev.motion || !ev.press) {
          hover = hit ? hit.id : '';
          if (hit?.id.startsWith('item:')) index = Number(hit.id.slice(5));
          continue;
        }
        if (ev.press && ev.left && hit) {
          if (hit.id.startsWith('lang:')) {
            setLang(hit.id.slice(5));
            continue;
          }
          if (hit.id.startsWith('item:')) {
            index = Number(hit.id.slice(5));
            const item = items[index];
            if (item.id === '__continue') {
              if (selected.size) return { id: 'continue', ids: [...selected] };
            } else if (selected.has(item.id)) selected.delete(item.id);
            else selected.add(item.id);
          }
        }
        if (ev.wheel) {
          index = ev.button === 64 ? Math.max(0, index - 1) : Math.min(items.length - 1, index + 1);
        }
        continue;
      }
      const key = parseKey(chunk);
      if (key === 'ctrl-c' || key === 'esc') return { id: options.cancelId || 'quit', ids: [...selected] };
      if (key === 'quit') return { id: options.quitId || options.cancelId || 'quit', ids: [...selected] };
      if (key === 'up') index = (index - 1 + items.length) % items.length;
      else if (key === 'down') index = (index + 1) % items.length;
      else if (key === 'lang-prev' || key === 'left') setLang(cycleLang(snap.lang, -1));
      else if (key === 'lang-next' || key === 'right' || key === 'tab') setLang(cycleLang(snap.lang, 1));
      else if (key === 'space') {
        const item = items[index];
        if (item.id === '__continue') {
          if (selected.size) return { id: 'continue', ids: [...selected] };
        } else if (selected.has(item.id)) selected.delete(item.id);
        else selected.add(item.id);
      } else if (key === 'enter' && selected.size) return { id: 'continue', ids: [...selected] };
    }
  } finally {
    disableInteractive();
  }
}

async function runPlainMenu(getState, setLang) {
  const snap = getState();
  console.log(`\nFreeDeepseekAPI — ${snap.subtitle}`);
  console.log(`lang: ${snap.lang}   (${LANGS.join('|')}; FREDEEPSEEK_LANG or --lang)`);
  for (const row of snap.status) {
    console.log(`  ${row.ok ? '+' : '-'} ${row.label}: ${row.value}`);
  }
  snap.items.forEach((item, i) => console.log(`  ${i + 1}  ${item.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('> ', resolve));
  rl.close();
  const raw = String(answer || '').trim().toLowerCase();
  if (LANGS.includes(raw)) {
    setLang(raw);
    return runPlainMenu(getState, setLang);
  }
  if (!raw || raw === 'q' || raw === 'quit') return { id: 'quit' };
  if (/^[1-9]$/.test(raw) && snap.items[Number(raw) - 1]) return { id: snap.items[Number(raw) - 1].id };
  const byId = snap.items.find(item => item.id === raw);
  return byId ? { id: byId.id } : { id: 'quit' };
}

async function pick(getState, setLang, options = {}) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  return interactive ? runInteractiveMenu(getState, setLang, options) : runPlainMenu(getState, setLang);
}

async function pickMany(getState, setLang, initial = [], options = {}) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  if (interactive) return runInteractiveMulti(getState, setLang, initial, options);
  const snap = getState();
  console.log(`\nFreeDeepseekAPI — ${snap.subtitle}`);
  snap.items.forEach((item, i) => console.log(`  ${i + 1}  ${item.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('Select numbers separated by commas: ', resolve));
  rl.close();
  const ids = String(answer || '').split(',')
    .map(value => snap.items[Number(value.trim()) - 1]?.id)
    .filter(Boolean);
  return ids.length ? { id: 'continue', ids } : { id: options.cancelId || 'quit', ids: [] };
}

async function pause(lang) {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question(`\n${t(lang, 'pressEnter')}\n`, resolve));
  rl.close();
}

async function runProgress(getState, task) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  if (!interactive) return task();
  enableInteractive();
  let tick = 0;
  const draw = () => {
    const snap = getState(tick++);
    renderFrame({ ...snap, index: 0, hover: '' });
  };
  draw();
  const timer = setInterval(draw, 180);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    disableInteractive();
  }
}

function printWordmark(subtitle = '') {
  const width = Math.max(60, process.stdout.columns || 80);
  console.log('');
  for (const row of wordmarkLines('FREEDEEP')) console.log(centered(`${C.bold}${row}${C.reset}`, width));
  console.log('');
  console.log(centered(`${C.dim}from${C.reset} ${C.brightYellow}${C.bold}dekrezz${C.reset}`, width));
  if (subtitle) console.log(centered(`${C.dim}${subtitle}${C.reset}`, width));
  console.log('');
}

async function askText(getState, setLang) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
  if (!interactive) {
    const snap = getState('');
    printWordmark(snap.subtitle);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(`  ${t(snap.lang, 'importPath')}: `, resolve));
    rl.close();
    return String(answer || '').trim();
  }

  enableInteractive();
  let value = String(getState('').field?.value || '');
  let hover = '';
  const cleanup = () => disableInteractive();
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  try {
    while (true) {
      const snap = getState(value);
      const regions = renderFrame({ ...snap, index: 0, hover, field: { value } });
      const chunk = await readChunk();
      const mouse = parseSgrMouse(chunk);
      if (mouse.length) {
        const ev = mouse[mouse.length - 1];
        const hit = hitTest(regions, ev.x, ev.y);
        if (ev.motion || !ev.press) {
          hover = hit ? hit.id : '';
          continue;
        }
        if (ev.press && ev.left && hit) {
          if (hit.id.startsWith('lang:')) {
            setLang(hit.id.slice(5));
            continue;
          }
          if (hit.id.startsWith('item:')) {
            const item = snap.items[Number(hit.id.slice(5))];
            if (item?.id === 'cancel' || item?.id === 'back' || item?.id === 'quit') return '';
            if (item?.id === 'submit') return value.trim();
          }
        }
        continue;
      }
      const s = String(chunk);
      if (s === '\x03') return '';
      if (s === '\x1b') return '';
      if (s === '\r' || s === '\n') return value.trim();
      if (s === '\x7f' || s === '\b') {
        value = [...value].slice(0, -1).join('');
        continue;
      }
      if (s === '\x1b[D' || s === '\x1b[C' || s === '\t') {
        setLang(cycleLang(snap.lang, s === '\x1b[D' ? -1 : 1));
        continue;
      }
      if (s.startsWith('\x1b')) continue;
      const text = [...s].filter(ch => {
        const code = ch.codePointAt(0);
        return code >= 32 && code !== 127;
      }).join('');
      if (text) value += text;
    }
  } finally {
    cleanup();
  }
}

module.exports = {
  LANGS,
  STRINGS,
  t,
  languageFromLocale,
  detectLocale,
  loadUiLang,
  saveUiLang,
  visibleWidth,
  parseSgrMouse,
  parseKey,
  hitTest,
  cycleLang,
  pick,
  pickMany,
  pause,
  runProgress,
  askText,
  printWordmark,
  wordmarkLines,
  C,
};
