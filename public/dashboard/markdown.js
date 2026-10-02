// FreeDeepseekAPI dashboard: safe markdown renderer.
// Builds DOM with createElement + textContent only; never innerHTML. Anything the
// parser does not understand renders as literal text. Links: http, https, mailto.
(() => {
  'use strict';

  const F = window.FDSA;
  const { h } = F;

  const LANG_NAMES = {
    js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
    py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby', go: 'Go', rust: 'Rust', rs: 'Rust', java: 'Java',
    kotlin: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', php: 'PHP',
    sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell', console: 'Console', powershell: 'PowerShell', ps1: 'PowerShell',
    json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', html: 'HTML', css: 'CSS',
    scss: 'SCSS', sql: 'SQL', md: 'Markdown', markdown: 'Markdown', diff: 'Diff', dockerfile: 'Dockerfile', text: 'Text', txt: 'Text',
  };
  const langLabel = (lang) => {
    if (!lang) return 'Code';
    const key = lang.toLowerCase();
    return LANG_NAMES[key] || (lang.charAt(0).toUpperCase() + lang.slice(1));
  };

  // ---------------------------------------------------------------- inline
  const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>"']/;

  function safeHref(raw) {
    const url = String(raw || '').trim();
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
    } catch (e) { /* relative or malformed: rendered as text */ }
    return null;
  }

  function linkEl(href, kids) {
    const a = h('a', { href, rel: 'noopener noreferrer', target: '_blank' });
    for (const k of kids) a.append(k);
    a.append(F.icon('external', 'link-ext'));
    return a;
  }

  // Finds the closing delimiter `d` starting at `from`; content must not start/end with space.
  function findClose(text, d, from) {
    let i = from;
    while (i < text.length) {
      const j = text.indexOf(d, i);
      if (j < 0) return -1;
      if (j > from && text[j - 1] !== ' ' && text[j - 1] !== '\\') {
        // for single * / _ make sure this is not part of a double delimiter
        if (d.length === 1 && text[j + 1] === d && text[j - 1] !== d) { i = j + 2; continue; }
        return j;
      }
      i = j + d.length;
    }
    return -1;
  }

  function inline(text, out) {
    let buf = '';
    const flush = () => { if (buf) { out.append(document.createTextNode(buf)); buf = ''; } };
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      // backslash escape / hard break
      if (c === '\\') {
        if (text[i + 1] === '\n') { flush(); out.append(h('br')); i += 2; continue; }
        if (i + 1 < n && ESCAPABLE.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
      }
      // code span
      if (c === '`') {
        let run = 1;
        while (text[i + run] === '`') run++;
        const fence = '`'.repeat(run);
        const close = text.indexOf(fence, i + run);
        if (close > i) {
          let code = text.slice(i + run, close).replace(/\n/g, ' ');
          if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
          flush();
          out.append(h('code', { class: 'md-code', text: code }));
          i = close + run;
          continue;
        }
        buf += fence;
        i += run;
        continue;
      }
      // strong / strike
      const two = text.slice(i, i + 2);
      if ((two === '**' || two === '__' || two === '~~') && text[i + 2] && text[i + 2] !== ' ') {
        if (two === '__' && /\w/.test(text[i - 1] || '')) { buf += two; i += 2; continue; }
        const close = findClose(text, two, i + 2);
        if (close > i + 2) {
          flush();
          const el = h(two === '~~' ? 'del' : 'strong');
          inline(text.slice(i + 2, close), el);
          out.append(el);
          i = close + 2;
          continue;
        }
      }
      // emphasis
      if ((c === '*' || c === '_') && text[i + 1] && text[i + 1] !== ' ' && text[i + 1] !== c) {
        const intraword = c === '_' && /\w/.test(text[i - 1] || '');
        if (!intraword) {
          const close = findClose(text, c, i + 1);
          if (close > i + 1 && !(c === '_' && /\w/.test(text[close + 1] || ''))) {
            flush();
            const el = h('em');
            inline(text.slice(i + 1, close), el);
            out.append(el);
            i = close + 1;
            continue;
          }
        }
      }
      // [text](url)
      if (c === '[') {
        let depth = 0;
        let j = i;
        for (; j < n; j++) {
          if (text[j] === '\\') { j++; continue; }
          if (text[j] === '[') depth++;
          else if (text[j] === ']') { depth--; if (depth === 0) break; }
        }
        if (j < n && text[j + 1] === '(') {
          const end = text.indexOf(')', j + 2);
          if (end > j) {
            const target = text.slice(j + 2, end).trim().split(/\s+/)[0].replace(/^<|>$/g, '');
            const href = safeHref(target);
            if (href) {
              flush();
              const tmp = document.createDocumentFragment();
              inline(text.slice(i + 1, j), tmp);
              out.append(linkEl(href, Array.from(tmp.childNodes)));
              i = end + 1;
              continue;
            }
          }
        }
      }
      // <autolink>
      if (c === '<') {
        const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(i));
        if (m) {
          const href = safeHref(m[1]);
          if (href) { flush(); out.append(linkEl(href, [document.createTextNode(m[1])])); i += m[0].length; continue; }
        }
      }
      // bare URL at a word boundary
      if ((c === 'h') && !/[\w/]/.test(text[i - 1] || '')) {
        const m = /^https?:\/\/[^\s<>"]*[^\s<>".,:;'")\]!?*_]/.exec(text.slice(i));
        if (m) {
          const href = safeHref(m[0]);
          if (href) { flush(); out.append(linkEl(href, [document.createTextNode(m[0])])); i += m[0].length; continue; }
        }
      }
      if (c === '\n') { flush(); out.append(h('br')); i++; continue; }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------- blocks
  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
  const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function codeBlock(code, lang) {
    const pre = h('pre', { class: 'code-pre', tabindex: '0' });
    const codeEl = h('code', { text: code });
    pre.append(codeEl);
    const wrapBtn = h('button', { type: 'button', class: 'code-btn', 'aria-pressed': 'false', text: 'Wrap' });
    wrapBtn.addEventListener('click', () => {
      const on = wrapBtn.getAttribute('aria-pressed') !== 'true';
      wrapBtn.setAttribute('aria-pressed', String(on));
      pre.classList.toggle('is-wrapped', on);
    });
    const copy = h('button', { type: 'button', class: 'code-btn' }, F.icon('copy'), h('span', { class: 'btn-label', text: 'Copy' }));
    copy.addEventListener('click', () => F.copy(code, copy));
    return h('div', { class: 'codeblock' },
      h('div', { class: 'code-head' }, h('span', { class: 'code-lang', text: langLabel(lang) }), h('span', { class: 'code-actions' }, wrapBtn, copy)),
      pre);
  }

  function isBlockStart(line, next) {
    return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) || RE_QUOTE.test(line) || RE_LIST.test(line)
      || (line.includes('|') && next != null && RE_TABLE_SEP.test(next) && next.includes('-'));
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m = RE_FENCE.exec(line);
      if (m) {
        const fence = m[1];
        const lang = m[2] || '';
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) { body.push(lines[i]); i++; }
        i++; // closing fence (or end of text: an unterminated fence still renders as code)
        out.push(codeBlock(body.join('\n'), lang));
        continue;
      }
      m = RE_HEADING.exec(line);
      if (m) {
        const level = Math.min(4, m[1].length);
        out.push(inline(m[2], h(`h${level}`, { class: 'md-h' })));
        i++;
        continue;
      }
      if (RE_HR.test(line)) { out.push(h('hr')); i++; continue; }
      if (RE_QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && lines[i].trim() && (RE_QUOTE.test(lines[i]) || !isBlockStart(lines[i]))) {
          const q = RE_QUOTE.exec(lines[i]);
          inner.push(q ? q[1] : lines[i]);
          i++;
        }
        const bq = h('blockquote');
        for (const b of blocks(inner)) bq.append(b);
        out.push(bq);
        continue;
      }
      if (RE_LIST.test(line)) {
        const start = i;
        const baseIndent = RE_LIST.exec(line)[1].length;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // blank line: list continues if the next line is indented or another item
            const nx = lines[i + 1];
            if (nx != null && (/^\s{2,}/.test(nx) || (RE_LIST.test(nx) && RE_LIST.exec(nx)[1].length >= baseIndent))) { i++; continue; }
            break;
          }
          const lm = RE_LIST.exec(l);
          if (lm && lm[1].length < baseIndent) break;
          if (!lm && !/^\s/.test(l) && isBlockStart(l, lines[i + 1])) break;
          i++;
        }
        out.push(list(lines.slice(start, i)));
        continue;
      }
      if (line.includes('|') && lines[i + 1] != null && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
        const table = h('table', { class: 'md-table' });
        const tr = h('tr');
        head.forEach((c, k) => { const th = inline(c, h('th', { scope: 'col' })); if (aligns[k]) th.style.setProperty('text-align', aligns[k]); tr.append(th); });
        table.append(h('thead', null, tr));
        const tb = h('tbody');
        for (const r of rows) {
          const row = h('tr');
          head.forEach((_, k) => { const td = inline(r[k] || '', h('td')); if (aligns[k]) td.style.setProperty('text-align', aligns[k]); row.append(td); });
          tb.append(row);
        }
        table.append(tb);
        out.push(h('div', { class: 'md-table-wrap', tabindex: '0' }, table));
        continue;
      }
      // paragraph
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
        para.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      // two trailing spaces are a hard break; a single newline is kept as a break too
      out.push(inline(para.join('\n').replace(/ {2,}\n/g, '\n'), h('p')));
    }
    return out;
  }

  function list(lines) {
    const first = RE_LIST.exec(lines[0]);
    const ordered = /\d/.test(first[2]);
    const el = h(ordered ? 'ol' : 'ul', { class: 'md-list' });
    if (ordered) {
      const startNum = parseInt(first[2], 10);
      if (startNum !== 1) el.setAttribute('start', String(startNum));
    }
    const base = first[1].length;
    let items = [];
    let cur = null;
    let loose = false;
    for (const l of lines) {
      const m = RE_LIST.exec(l);
      if (m && m[1].length <= base + 1 && (/\d/.test(m[2]) === ordered)) {
        cur = { lines: [m[3]], indent: m[1].length + m[2].length + 1 };
        items.push(cur);
      } else if (cur) {
        if (!l.trim()) loose = loose || false;
        // strip continuation indent
        cur.lines.push(l.replace(new RegExp(`^ {0,${cur.indent}}`), ''));
      }
    }
    items = items.filter(Boolean);
    for (const item of items) {
      const li = h('li');
      let text = item.lines;
      const task = /^\[([ xX])\]\s+/.exec(text[0]);
      if (task) {
        li.classList.add('md-task');
        li.append(h('input', { type: 'checkbox', disabled: true, checked: task[1].toLowerCase() === 'x', 'aria-label': task[1].trim() ? 'Done' : 'Not done' }));
        text = [text[0].slice(task[0].length)].concat(text.slice(1));
      }
      const kids = blocks(text);
      // tight item: a single paragraph renders inline
      if (!loose && kids.length && kids[0].tagName === 'P') {
        const p = kids.shift();
        const span = h('span');
        while (p.firstChild) span.append(p.firstChild);
        li.append(span);
      }
      for (const k of kids) li.append(k);
      el.append(li);
    }
    return el;
  }

  // Returns an array of top-level block elements (used by the chat reveal).
  F.md = {
    blocks(text) {
      const src = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
      return blocks(src.split('\n'));
    },
    render(text) {
      const frag = document.createDocumentFragment();
      for (const b of F.md.blocks(text)) frag.append(b);
      return frag;
    },
    inline: (text) => inline(String(text || ''), document.createDocumentFragment()),
  };
})();
