const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

const els = {
  callout: document.getElementById('callout'),
  calloutTitle: document.getElementById('calloutTitle'),
  calloutBody: document.getElementById('calloutBody'),
  btnCollect: document.getElementById('btnCollect'),
  btnCopy: document.getElementById('btnCopy'),
  btnSave: document.getElementById('btnSave'),
  rowToken: document.getElementById('rowToken'),
  rowCookie: document.getElementById('rowCookie'),
};

let lastExport = null;

function cookieCount(cookie) {
  return String(cookie || '').split(';').map((p) => p.trim()).filter(Boolean).length;
}

function buildAuthJson(data) {
  const cookie = String(data.cookie || '').trim() || [
    data.ds_session_id && `ds_session_id=${data.ds_session_id}`,
    data.smidV2 && `smidV2=${data.smidV2}`,
  ].filter(Boolean).join('; ');

  return {
    token: data.token || '',
    hif_dliq: data.hif_dliq || '',
    hif_leim: data.hif_leim || '',
    cookie,
    wasmUrl: data.wasmUrl || WASM_URL,
  };
}

function exportText(auth) {
  return `${JSON.stringify(auth, null, 2)}\n`;
}

function setValue(el, text, kind) {
  el.textContent = text;
  el.className = `value${kind ? ` ${kind}` : ''}`;
}

function showCallout(kind, title, body) {
  els.callout.hidden = false;
  els.callout.className = `callout ${kind}`;
  els.calloutTitle.textContent = title;
  els.calloutBody.textContent = body;
}

function render(data) {
  const source = data && typeof data === 'object' ? data : {};
  const auth = buildAuthJson(source);
  lastExport = auth;
  const ready = !!(auth.token && auth.cookie);
  const cookieN = cookieCount(auth.cookie);
  els.btnCopy.disabled = !ready;
  els.btnSave.disabled = !ready;

  setValue(
    els.rowToken,
    auth.token ? 'Ready' : source._lastUpdated ? 'Missing' : 'Not read',
    auth.token ? 'ready' : source._lastUpdated ? 'missing' : ''
  );
  setValue(
    els.rowCookie,
    cookieN ? 'Ready' : source._lastUpdated ? 'Missing' : 'Not read',
    cookieN ? 'ready' : source._lastUpdated ? 'missing' : ''
  );

  if (!source._lastUpdated) {
    showCallout('warning', 'Open DeepSeek first', 'Sign in, then read the current tab.');
    return;
  }

  if (ready) {
    showCallout('ok', 'Session captured', 'Your credentials are ready to export.');
  } else if (!auth.token && cookieN) {
    showCallout(
      'warning',
      'Send one message',
      'Then read the tab again to capture the token.'
    );
  } else {
    showCallout('warning', 'Session not found', 'Sign in to DeepSeek and try again.');
  }

}

function flashButton(btn, label) {
  const target = btn.querySelector('.btn-label');
  const prev = target.textContent;
  target.textContent = label;
  window.setTimeout(() => { target.textContent = prev; }, 1200);
}

function inExtension() {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
}

function send(action) {
  return new Promise((resolve, reject) => {
    if (!inExtension()) {
      reject(new Error('Reload the unpacked extension, then open this popup from the toolbar.'));
      return;
    }
    chrome.runtime.sendMessage({ action }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function loadAuth() {
  try {
    const response = await send('export');
    if (response && response.success) render(response.auth);
    else showCallout('error', 'Could not read stored session', '');
  } catch (e) {
    showCallout('error', 'Extension error', e.message);
  }
}

els.btnCollect.addEventListener('click', async () => {
  showCallout('warning', 'Reading tab…', 'Looking for your active session.');
  try {
    const response = await send('collect');
    if (response && response.success) render(response.auth);
    else showCallout('error', 'Collect failed', response?.error || 'Unknown error');
  } catch (e) {
    showCallout('error', 'Collect failed', e.message);
  }
});

els.btnCopy.addEventListener('click', async () => {
  if (!lastExport?.token || !lastExport?.cookie) return;
  await navigator.clipboard.writeText(exportText(lastExport));
  flashButton(els.btnCopy, 'Copied');
});

els.btnSave.addEventListener('click', () => {
  if (!lastExport?.token || !lastExport?.cookie) return;
  const blob = new Blob([exportText(lastExport)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deepseek-auth.json';
  a.click();
  URL.revokeObjectURL(url);
  flashButton(els.btnSave, 'Saved');
});

if (inExtension()) loadAuth();
else render({});
