const SERVER = 'http://127.0.0.1:8787';
const $ = (s) => document.querySelector(s);

const setStatus = (html, cls = '') => {
  $('#status').innerHTML = `<span class="${cls}">${html}</span>`;
};

async function serverGet(path) {
  const res = await fetch(SERVER + path, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function refresh() {
  try {
    const st = await serverGet('/ext/status');
    $('#dot').className = 'dot' + (st.ext?.connected || st.connected ? ' on' : '');
    $('#connTxt').textContent = st.connected ? 'server + extension online' : 'server online';
    $('#cNew').textContent = st.stats?.byStatus?.new ?? 0;
    $('#cHot').textContent = st.stats?.highScore ?? 0;
    if (!st.connected) setStatus('extension not seen by server yet…', 'bad');
    else setStatus('');
  } catch {
    $('#dot').className = 'dot';
    $('#connTxt').textContent = 'server offline';
    setStatus('start it with: <b>node server/cli.js serve</b>', 'bad');
  }
  try {
    const { history = [] } = await chrome.storage.local.get('history');
    $('#hist').innerHTML =
      history.slice(0, 5).map((h) => {
        const label = h.type === 'open_and_fill' ? 'autofill' : h.type.replace('_', ' ');
        const extra = h.status === 'done'
          ? h.result?.items != null
            ? `${h.result.items} items → ${h.result.added ?? 0} new`
            : h.result?.filled != null
              ? `${h.result.filled} fields filled`
              : 'done'
          : h.error || h.status;
        return `<div><b>${label}</b> — ${String(extra).slice(0, 70)} <span class="dim">${Math.round((Date.now() - h.at) / 60000)}m</span></div>`;
      }).join('') || '<span class="dim">nothing yet</span>';
  } catch { /* ignore */ }
}

$('#fill').onclick = async () => {
  setStatus('injecting form filler…');
  const r = await chrome.runtime.sendMessage({ type: 'jp_fill_current' });
  if (r?.ok) setStatus(`filled <b class="ok">${r.filled}</b> fields${r.resumeAttached ? ' + resume' : ''}${r.missing?.length ? ` · review ${r.missing.length}` : ''} — check the page`, 'ok');
  else setStatus('fill failed: ' + (r?.error || 'unknown'), 'bad');
};

$('#scanx').onclick = async () => {
  setStatus('queued X scan — watch Chrome');
  const r = await chrome.runtime.sendMessage({ type: 'jp_quick_scan', target: 'x' });
  setStatus(r?.ok ? 'X scan queued — Chrome will open search tabs' : 'failed: ' + (r?.error || ''), r?.ok ? 'ok' : 'bad');
};

$('#scanr').onclick = async () => {
  setStatus('queued reddit scan');
  const r = await chrome.runtime.sendMessage({ type: 'jp_quick_scan', target: 'reddit' });
  setStatus(r?.ok ? 'reddit scan queued — reading via your session' : 'failed: ' + (r?.error || ''), r?.ok ? 'ok' : 'bad');
};

$('#dash').onclick = () => chrome.tabs.create({ url: SERVER });

refresh();
setInterval(refresh, 3000);
