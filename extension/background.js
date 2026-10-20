/**
 * Clinqy × Browsy — background service worker.
 *
 * Talks to the local Clinqy × Browsy server (http://127.0.0.1:8787):
 *  - long-polls /ext/poll for commands
 *  - scan_x:      opens X search tabs in your logged-in session, scrolls, extracts hiring posts
 *  - scan_reddit: fetches reddit JSON with your cookies (DOM fallback)
 *  - open_and_fill / fill_current: injects content/ats.js and fills an application form
 * Results go back via /ext/result and /ext/ingest.
 */
const SERVER = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[jobpilot]', ...a);

const runtime = { lastPoll: 0, lastError: null, loopStarted: false, busy: null };

// ---------------------------------------------------------------- server io

async function serverFetch(pathname, opts = {}, timeoutMs = 30000) {
  return fetch(SERVER + pathname, { signal: AbortSignal.timeout(timeoutMs), ...opts });
}

async function postJson(pathname, body, timeoutMs = 30000) {
  const res = await serverFetch(
    pathname,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function guessMime(name = '') {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.doc')) return 'application/msword';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

async function addHistory(entry) {
  try {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ ...entry, at: Date.now() });
    await chrome.storage.local.set({ history: history.slice(0, 30) });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- poll loop

async function pollLoop() {
  if (runtime.loopStarted) return;
  runtime.loopStarted = true;
  for (;;) {
    try {
      const res = await serverFetch('/ext/poll?wait=20', {}, 32000);
      if (res.ok) {
        runtime.lastPoll = Date.now();
        runtime.lastError = null;
        const data = await res.json();
        if (data.command) await runCommand(data.command);
      }
    } catch (err) {
      runtime.lastError = err.message;
      await sleep(5000);
    }
    await sleep(250);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  log('installed / updated');
  pollLoop();
});
chrome.runtime.onStartup.addListener(() => pollLoop());
chrome.alarms.create('jp-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => pollLoop());
pollLoop();

async function runCommand(cmd) {
  runtime.busy = { type: cmd.type, since: Date.now() };
  const started = Date.now();
  try {
    let result = null;
    if (cmd.type === 'scan_x') result = await scanX(cmd.payload || {});
    else if (cmd.type === 'scan_reddit') result = await scanReddit(cmd.payload || {});
    else if (cmd.type === 'open_and_fill') result = await openAndFill(cmd.payload || {});
    else if (cmd.type === 'fill_current') result = await fillCurrent(cmd.payload || {});
    else if (cmd.type === 'browser') result = await runBrowser(cmd.payload?.tool, cmd.payload?.args || {});
    else if (cmd.type === 'ping') result = { pong: true };
    else throw new Error(`unknown command: ${cmd.type}`);
    await postJson('/ext/result', { id: cmd.id, ok: true, result }, 25000);
    await addHistory({ id: cmd.id, type: cmd.type, status: 'done', ms: Date.now() - started, result });
    log('done', cmd.type, Date.now() - started + 'ms', result);
  } catch (err) {
    log('failed', cmd.type, err.message);
    await postJson('/ext/result', { id: cmd.id, ok: false, error: err.message }).catch(() => {});
    await addHistory({ id: cmd.id, type: cmd.type, status: 'failed', ms: Date.now() - started, error: err.message });
  } finally {
    runtime.busy = null;
  }
}

// ---------------------------------------------------------------- tab helpers

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}

async function callInTab(tabId, func, args = [], target = {}) {
  const results = await chrome.scripting.executeScript({ target: { tabId, ...target }, func, args });
  return results.map((r) => r?.result).filter((r) => r !== undefined);
}

// ---------------------------------------------------------------- X scanning

/** Runs inside the X page. Self-contained (serialized by chrome.scripting). */
function pageScrapeX() {
  const out = [];
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    let url = null;
    for (const l of a.querySelectorAll('a[href*="/status/"]')) {
      const h = l.getAttribute('href') || '';
      if (/\/status\/\d+/.test(h)) {
        try {
          url = new URL(h, location.origin).href;
        } catch { /* ignore */ }
        break;
      }
    }
    if (!url) continue;
    const m = url.match(/status\/(\d+)/);
    const id = m ? m[1] : url;
    const text = (a.querySelector('[data-testid="tweetText"]')?.innerText || '').trim();
    const nameBlock = (a.querySelector('[data-testid="User-Name"]')?.innerText || '').replace(/\n/g, ' ').trim();
    const handle = (nameBlock.match(/@[\w.]+/) || [])[0] || '';
    const dt = a.querySelector('time')?.getAttribute('datetime') || '';
    const likeEl = a.querySelector('[data-testid="like"]');
    const likes = likeEl ? (likeEl.getAttribute('aria-label') || '').trim() : '';
    out.push({ id, url, text, author: handle || nameBlock, posted_at: dt, likes });
  }
  return out;
}

async function scanX({ queries = [], accounts = [], perQuery = 60, maxScrolls = 3 } = {}) {
  const seen = new Set();
  const items = [];
  const targets = [
    ...queries.map((q) => ({ url: `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`, label: q })),
    ...accounts.map((a) => ({ url: `https://x.com/${String(a).replace(/^@/, '')}`, label: `@${String(a).replace(/^@/, '')}` })),
  ];
  if (!targets.length) throw new Error('no X queries or accounts configured');

  let successfulTabs = 0;
  const errors = [];

  for (const t of targets) {
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: t.url, active: false });
      await waitTabComplete(tab.id, 35000);
      await sleep(2500);

      const [gate] = await callInTab(tab.id, () => {
        const count = document.querySelectorAll('article[data-testid="tweet"]').length;
        const href = location.href;
        const loginWall = /\/i\/flow\/login|\/login|\/i\/flow\/signup/.test(href);
        const bodyText = document.body?.innerText || '';
        const confirmWall = /Confirm your identity|Something went wrong|unusual activity|rate limit/i.test(bodyText) && count === 0;
        return { count, loginWall, confirmWall, href };
      });

      if (gate?.loginWall) throw new Error('not logged into X — open x.com in this Chrome profile and sign in first');
      if (gate?.confirmWall) throw new Error('X is rate-limiting or asking for confirmation — retry later');
      if (!gate?.count) throw new Error('no tweets found on the page');

      for (let round = 0; round < Math.max(1, Number(maxScrolls) || 3); round++) {
        const [batch] = await callInTab(tab.id, pageScrapeX);
        for (const it of batch || []) {
          if (!it.text || it.text.length < 25) continue;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          items.push({ ...it, query: t.label });
        }
        if (items.length >= (Number(perQuery) || 60) * targets.length) break;
        await callInTab(tab.id, () => window.scrollBy(0, Math.round(window.innerHeight * 2.4)));
        await sleep(1500);
      }
      successfulTabs++;
    } catch (err) {
      errors.push(`${t.label}: ${err.message}`);
    } finally {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    }
    await sleep(1200);
  }

  if (!successfulTabs && !items.length) {
    throw new Error(errors[0] || 'could not read X');
  }

  const payload = items.map((it) => ({
    source: 'x',
    source_id: it.id,
    source_url: it.url,
    author: it.author,
    posted_at: it.posted_at ? new Date(it.posted_at).toISOString() : null,
    title: it.text.split('\n')[0].slice(0, 180),
    description: it.text,
    keepAll: false,
    extra: { query: it.query, likes: it.likes },
  }));

  const ing = await postJson('/ext/ingest', { source: 'x', items: payload }, 60000);
  return { items: payload.length, added: ing.added || 0, merged: ing.merged || 0, filtered: ing.skipped || 0, errors };
}

// ---------------------------------------------------------------- reddit scanning

function pageScrapeReddit() {
  const out = [];
  for (const p of document.querySelectorAll('shreddit-post, article[data-testid="post-container"]')) {
    const title = p.getAttribute?.('post-title') || p.querySelector('h1, h2, [slot="title"]')?.innerText || '';
    const permalink = p.getAttribute?.('permalink') || p.querySelector('a[href*="/comments/"]')?.getAttribute('href') || '';
    const author = p.getAttribute?.('author') || '';
    const created = p.getAttribute?.('created-timestamp') || '';
    const body = p.querySelector('[slot="text-body"], .md')?.innerText || '';
    const sub = p.getAttribute?.('subreddit-prefixed-name') || '';
    if (!title || !permalink) continue;
    out.push({ title: title.trim(), permalink, author, created, body, sub });
  }
  return out;
}

async function scanReddit({ subs = [] } = {}) {
  if (!subs.length) throw new Error('no subreddits configured');
  const items = [];
  const errors = [];

  for (const sub of subs) {
    let got = false;
    // 1) JSON with your cookies
    try {
      const res = await fetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=100&raw_json=1`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        const children = data?.data?.children || [];
        if (children.length) {
          for (const ch of children) {
            const d = ch.data;
            if (!d) continue;
            items.push({
              source: 'reddit',
              source_id: d.name,
              source_url: 'https://www.reddit.com' + d.permalink,
              author: d.author ? `u/${d.author}` : null,
              posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
              title: d.title,
              description: d.selftext || '',
              extra: { sub: d.subreddit, score: d.score, comments: d.num_comments, postUrl: d.url },
            });
          }
          got = true;
        }
      }
    } catch { /* fall through */ }

    // 2) DOM fallback (a tab)
    if (!got) {
      let tab = null;
      try {
        tab = await chrome.tabs.create({ url: `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/`, active: false });
        await waitTabComplete(tab.id, 30000);
        await sleep(2200);
        const [posts] = await callInTab(tab.id, pageScrapeReddit);
        for (const p of posts || []) {
          items.push({
            source: 'reddit',
            source_id: p.permalink,
            source_url: p.permalink.startsWith('http') ? p.permalink : 'https://www.reddit.com' + p.permalink,
            author: p.author ? `u/${p.author}` : null,
            posted_at: p.created ? new Date(p.created).toISOString() : null,
            title: p.title,
            description: p.body || '',
            extra: { sub },
          });
        }
        got = (posts || []).length > 0;
      } catch (err) {
        errors.push(`${sub}: ${err.message}`);
      } finally {
        if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
    if (!got) errors.push(`${sub}: no posts read`);
    await sleep(1000);
  }

  const ing = await postJson('/ext/ingest', { source: 'reddit', items }, 60000);
  return { items: items.length, added: ing.added || 0, merged: ing.merged || 0, filtered: ing.skipped || 0, errors };
}

// ---------------------------------------------------------------- apply / fill

async function hydratePacket(packet) {
  const out = {
    profile: packet.profile || {},
    answers: packet.answers || [],
    autoSubmit: false,
    jobId: packet.jobId || null,
    resume: null,
  };
  if (packet.resume && !packet.resume.missing) {
    try {
      const res = await serverFetch('/ext/resume', {}, 25000);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const name = res.headers.get('x-filename') || packet.resume.name || 'resume.pdf';
        out.resume = { name, type: guessMime(name), dataB64: toB64(buf) };
      }
    } catch (err) {
      log('resume fetch failed', err.message);
    }
  }
  return out;
}

async function fillTab(tabId, packet) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/ats.js'] });
  } catch (err) {
    // some frames (cross-origin sandboxes) refuse injection — inject main frame only
    log('allFrames inject failed, trying main frame', err.message);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/ats.js'] });
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async (pkt) => (typeof window.__jobpilotATSFill === 'function' ? await window.__jobpilotATSFill(pkt) : null),
    args: [packet],
  });
  return results.map((r) => r?.result).filter(Boolean);
}

async function openAndFill({ jobId, url, packet }) {
  if (!url) throw new Error('no apply url');
  const full = await hydratePacket({ ...packet, jobId });
  const tab = await chrome.tabs.create({ url, active: true });
  await waitTabComplete(tab.id, 40000);
  await sleep(2200);
  const results = await fillTab(tab.id, full);
  const best =
    results
      .filter((r) => r && (r.filled?.length || r.missing?.length))
      .sort((a, b) => (b.filled?.length || 0) - (a.filled?.length || 0))[0] || {};
  return {
    jobId,
    url,
    filled: best.filled?.length || 0,
    missing: (best.missing || []).map((m) => m.label).slice(0, 10),
    resumeAttached: best.resumeAttached || false,
    framesWithForms: results.filter((r) => r && r.fieldsSeen > 3).length,
  };
}

async function fillCurrent({ packet } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('no http(s) tab in focus');
  let pk = packet;
  if (!pk || !pk.profile) {
    const res = await serverFetch('/ext/packet', {}, 15000);
    pk = await res.json();
  }
  const full = await hydratePacket(pk);
  const results = await fillTab(tab.id, full);
  const best = results.sort((a, b) => (b?.filled?.length || 0) - (a?.filled?.length || 0))[0] || {};
  return { filled: best.filled?.length || 0, missing: (best.missing || []).map((m) => m.label).slice(0, 8), resumeAttached: best.resumeAttached || false };
}

// ---------------------------------------------------------------- browser engine

/** Run one browser tool for the local MCP bridge (Browsy-style surface). */
async function runBrowser(tool, args = {}) {
  switch (tool) {
    case 'browser_list_tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title || '',
          url: t.url || '',
          active: Boolean(t.active),
          windowId: t.windowId,
          pinned: Boolean(t.pinned),
        })),
      };
    }
    case 'browser_open_tab': {
      if (!/^https?:\/\//i.test(String(args.url || ''))) throw new Error('only http(s) URLs are supported');
      const tab = await chrome.tabs.create({ url: args.url, active: args.active === true });
      return { id: tab.id, windowId: tab.windowId, url: args.url, active: Boolean(tab.active), status: tab.status || 'loading' };
    }
    case 'browser_focus_tab': {
      const tab = await chrome.tabs.get(Number(args.tabId));
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, id: tab.id };
    }
    case 'browser_close_tab': {
      await chrome.tabs.remove(Number(args.tabId));
      return { ok: true, id: Number(args.tabId) };
    }
    case 'browser_navigate': {
      if (!/^https?:\/\//i.test(String(args.url || ''))) throw new Error('only http(s) URLs are supported');
      await chrome.tabs.update(Number(args.tabId), { url: args.url });
      return { ok: true, id: Number(args.tabId), url: args.url };
    }
    case 'browser_back': {
      await chrome.tabs.goBack(Number(args.tabId));
      return { ok: true, id: Number(args.tabId) };
    }
    case 'browser_forward': {
      await chrome.tabs.goForward(Number(args.tabId));
      return { ok: true, id: Number(args.tabId) };
    }
    case 'browser_reload': {
      await chrome.tabs.reload(Number(args.tabId));
      return { ok: true, id: Number(args.tabId) };
    }
    case 'browser_wait': {
      const ms = Math.max(0, Math.min(Number(args.milliseconds) || 500, 10000));
      await sleep(ms);
      return { ok: true, waitedMs: ms };
    }
    case 'browser_screenshot': return screenshotTab(Number(args.tabId));
    default:
      break;
  }

  // Remaining tools run inside the page.
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId)) throw new Error('tabId required');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) throw new Error('this tab cannot be scripted (not an http(s) page)');

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/browser.js'] });
  } catch (err) {
    throw new Error(`cannot script this tab: ${err.message}`);
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (payload) => window.__jpBrowser.act(payload),
    args: [{ tool, args }],
  });
  if (!res || res.result == null) throw new Error(`${tool} returned no result`);
  return res.result;
}

/** Capture the visible viewport, downscaled to keep the MCP payload small. */
async function screenshotTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(300);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / bmp.width);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return { mimeType: 'image/jpeg', data: toB64(await out.arrayBuffer()), width: canvas.width, height: canvas.height };
  } catch (err) {
    // Fall back to the raw PNG if canvas processing is unavailable.
    const data = String(dataUrl).replace(/^data:[^,]+,/, '');
    return { mimeType: 'image/png', data };
  }
}

// ---------------------------------------------------------------- popup messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'jp_status') {
        return sendResponse({
          ok: true,
          status: {
            connected: Date.now() - runtime.lastPoll < 15000,
            lastPoll: runtime.lastPoll,
            lastError: runtime.lastError,
            busy: runtime.busy,
          },
        });
      }
      if (msg?.type === 'jp_quick_scan') {
        await postJson('/api/ext/scan', { target: msg.target });
        return sendResponse({ ok: true });
      }
      if (msg?.type === 'jp_fill_current') {
        const r = await fillCurrent({});
        return sendResponse({ ok: true, ...r });
      }
      if (msg?.type === 'jp_submitted') {
        await postJson('/ext/submitted', { jobId: msg.jobId, url: msg.url }).catch(() => {});
        return sendResponse({ ok: true });
      }
      if (msg?.type === 'jp_fill_report') {
        await postJson('/ext/fill_report', { jobId: msg.jobId, summary: msg.summary }).catch(() => {});
        return sendResponse({ ok: true });
      }
      sendResponse({ ok: false, error: 'unknown message' });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});
