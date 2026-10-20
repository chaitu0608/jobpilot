#!/usr/bin/env node
/**
 * Job Pilot MCP server — stdio JSON-RPC 2.0 (newline-delimited), no SDK.
 *
 * One local MCP server for the whole cockpit:
 *   jobpilot_*   the job database, scans, digests, applications
 *   browser_*    Browsy's 17-tool surface, served by our own Chrome extension
 *   clinqy_*     the real Clinqy native app (look / stats / run / handoff)
 *   memory_*     durable preferences and facts (SQLite, local only)
 *   workflow_*   watch-and-learn style record/replay of browser actions
 *
 * Safety model: browser mutations and native tasks require confirmed=true;
 * submit-like clicks also require approved=true. Applications are filled, never
 * submitted — the human reviews the page and clicks Submit.
 *
 * The server auto-starts the local HTTP server on 127.0.0.1:8787 if needed.
 * stdout is reserved for JSON-RPC frames; logs go to stderr.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.JOBPILOT_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '0.2.0';

// stdout must carry JSON-RPC only.
for (const m of ['log', 'info', 'debug']) console[m] = (...a) => console.error('[jobpilot-mcp]', ...a);
process.on('uncaughtException', (e) => console.error('[jobpilot-mcp] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[jobpilot-mcp] unhandled', e));

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/* ------------------------------------------------------------------ server */

let ensured = false;
let starting = null;

async function ensureServer() {
  if (ensured) return;
  try {
    await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) });
    ensured = true;
    return;
  } catch { /* not running */ }
  if (!starting) {
    starting = (async () => {
      console.error(`[jobpilot-mcp] starting local server on ${BASE}`);
      const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'server', 'http.js')], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, JOBPILOT_PORT: String(PORT) },
      });
      child.unref();
      const start = Date.now();
      while (Date.now() - start < 20000) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1000) });
          ensured = true;
          return;
        } catch { /* keep waiting */ }
      }
      throw new Error(`local server did not start on ${BASE}`);
    })();
  }
  try { await starting; } finally { starting = null; }
}

async function api(pathname, { method = 'GET', body, timeout = 30000 } = {}) {
  await ensureServer();
  const res = await fetch(BASE + pathname, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, timeout)),
  });
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/* ------------------------------------------------------------------ format */

const trunc = (s, n = 500) => {
  const t = String(s == null ? '' : s).replace(/\r/g, '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function ago(iso) {
  if (!iso) return '?';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '?';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function fmtJob(j) {
  const bits = [
    `#${j.id}`,
    `[${j.score ?? 0}]`,
    `${j.company || j.author || '?'} — ${j.title || '(untitled)'}`,
    j.location || (j.remote ? 'Remote' : 'unknown location'),
  ];
  if (j.remote && j.location && !/remote/i.test(j.location)) bits.push('remote');
  bits.push(j.source || '?');
  bits.push(ago(j.posted_at || j.first_seen_at));
  bits.push(j.status || 'new');
  if (j.eligibility?.bucket) bits.push(`elig:${j.eligibility.bucket}`);
  return bits.join(' · ');
}

const textResult = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const errorResult = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true });
const jsonText = (v, cap = 8000) => trunc(JSON.stringify(v, null, 2), cap);

/* --------------------------------------------------------------- JSON types */

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const CONFIRMED = bool('Set true ONLY after the user explicitly approved this action. Required for mutations.');
const APPROVED = bool('Set true only after the user approved a consequential click (submit/send/pay/delete).');

/* ------------------------------------------------------------- browser core */

/** Raw local engine call; does not format. Throws on HTTP/adapter errors. */
async function localCall(tool, args = {}) {
  const confirmed = args.confirmed === true;
  const clean = { ...args };
  delete clean.confirmed;
  const res = await api('/api/browser/call', {
    method: 'POST',
    body: { tool, arguments: clean, confirmed },
    timeout: 70000,
  });
  return res;
}

function formatBrowserResult(tool, res) {
  if (res.needsApproval) {
    return errorResult(
      `Approval required — ${res.text || 'this control looks consequential.'}\n` +
      `Target: ${res.target?.selector || '?'} (${res.target?.role || '?'} "${res.target?.name || ''}")\n` +
      'Show this to the user. If they approve, retry with approved=true (and confirmed=true for the mutation).'
    );
  }
  if (res.ok === false) return errorResult(res.text || 'browser action failed');
  if (tool === 'browser_screenshot' && Array.isArray(res.images) && res.images.length) {
    return {
      content: [
        ...res.images.map((i) => ({ type: 'image', mimeType: i.mimeType || 'image/png', data: i.data })),
        { type: 'text', text: res.text || 'Screenshot captured.' },
      ],
    };
  }
  let text = res.text;
  if (text == null || text === '') {
    if (tool === 'browser_list_tabs') text = jsonText(res.parsed || []);
    else if (tool === 'browser_get_html') text = String(res.parsed?.html || '');
    else text = jsonText(res.parsed ?? res, 8000);
  }
  return textResult(text);
}

/* --------------------------------------------------------- workflow recording */

let recording = null;

const RECORDABLE = new Set([
  'browser_open_tab', 'browser_navigate', 'browser_click', 'browser_type',
  'browser_press_key', 'browser_scroll', 'browser_wait', 'browser_reload',
  'browser_back', 'browser_forward',
]);

function maybeRecord(tool, args, res) {
  if (!recording || !RECORDABLE.has(tool) || res.ok === false || res.needsApproval) return;
  let step = null;
  if (tool === 'browser_click') {
    const selector = res.target?.selector || args.selector;
    if (!selector) return; // coordinate clicks are not safely replayable
    step = { tool, args: { selector } };
  } else if (tool === 'browser_type') {
    const selector = res.target?.selector || args.selector;
    if (!selector) return;
    step = { tool, args: { selector, text: String(args.text ?? ''), replaceExisting: args.replaceExisting !== false } };
  } else if (tool === 'browser_open_tab' || tool === 'browser_navigate') {
    step = { tool, args: { url: args.url } };
  } else if (tool === 'browser_press_key') {
    step = { tool, args: { key: args.key } };
  } else if (tool === 'browser_scroll') {
    step = { tool, args: { direction: args.direction || 'down', amount: args.amount || 600 } };
  } else if (tool === 'browser_wait') {
    step = { tool, args: { milliseconds: args.milliseconds || 500 } };
  } else {
    step = { tool, args: {} };
  }
  recording.steps.push(step);
}

async function handleBrowser(tool, args) {
  const res = await localCall(tool, args);
  maybeRecord(tool, args, res);
  return formatBrowserResult(tool, res);
}

/* ---------------------------------------------------------------- jobpilot */

async function statusTool() {
  const state = await api('/api/state');
  let packet = null;
  try { packet = await api('/ext/packet'); } catch { /* optional */ }
  const c = state.connections || {};
  const profileKeys = packet?.profile ? Object.keys(packet.profile) : [];
  const ready = Boolean(packet?.profile?.firstName && packet?.profile?.email);
  const lines = [
    `Jobs: ${state.stats?.total ?? '?'} total · ${state.stats?.highScore ?? '?'} high-scoring new (≥60)`,
    `Buckets: ${Object.entries(state.buckets || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`,
    `Pipeline: ${state.pipeline ?? 0} · companies: ${state.companies ?? 0} · contacts: ${state.contacts ?? 0}`,
    `Extension: ${state.ext?.connected ? 'connected' : 'offline'} · built-in browser engine: ${c.localBrowser?.connected ? 'ready' : 'offline'}`,
    `External Browsy: ${c.browsy?.available ? (c.browsy?.connected ? 'connected' : 'installed, not connected') : 'not installed (built-in engine used)'}`,
    `Clinqy: ${c.clinqy?.available ? (c.clinqy?.connected ? 'connected' : 'installed, not connected') : 'not available'}`,
    `Profile: ${ready ? `ready (${profileKeys.length} fields)` : 'INCOMPLETE — run `node server/cli.js setup`'}`,
    `Resume: ${packet?.resume ? (packet.resume.missing ? `MISSING at ${packet.resume.path}` : packet.resume.name) : 'not set (profile.resumePath)'}`,
    `Auto-submit: ${packet?.autoSubmit ? 'ON (unsafe)' : 'off — you always review and submit'}`,
  ];
  return textResult(lines.join('\n'));
}

async function listJobs(args) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'remote') { if (v) params.set('remote', '1'); continue; }
    params.set(k, String(v));
  }
  const data = await api(`/api/jobs?${params.toString()}`);
  const rows = data.rows || [];
  const header = `${data.total} matching job(s) (${data.serverTotal ?? '?'} in scope)`;
  const buckets = data.buckets
    ? `buckets: ${Object.entries(data.buckets).map(([k, v]) => `${k} ${v}`).join(' · ')}`
    : '';
  const body = rows.map(fmtJob).join('\n') || 'No jobs matched. Try a lower minScore or a scan.';
  const more = data.total > rows.length
    ? `\n\nShowing ${rows.length}; use offset=${(Number(args.offset) || 0) + rows.length} for the next page.`
    : '';
  return textResult(`${header}\n${buckets}\n\n${body}${more}`);
}

async function getJob(args) {
  const j = await api(`/api/jobs/${Number(args.id)}`);
  const lines = [
    `${fmtJob(j)}`,
    `URL: ${j.source_url || '—'}`,
    `Posted: ${j.posted_at || '?'} · first seen ${j.first_seen_at || '?'} · last seen ${j.last_seen_at || '?'}`,
    `Eligibility: ${j.eligibility?.bucket || '—'}${j.eligibility?.reasons?.length ? ` — ${j.eligibility.reasons.join('; ')}` : ''}`,
  ];
  if (j.salary) lines.push(`Pay: ${j.salary}`);
  if (Array.isArray(j.extra?.why) && j.extra.why.length) lines.push(`Why: ${j.extra.why.join(' · ')}`);
  const desc = j.description || j.extra?.description || '';
  if (desc) lines.push(`\nDescription:\n${trunc(desc, 1400)}`);
  if (j.notes) lines.push(`\nNotes: ${trunc(j.notes, 800)}`);
  if (Array.isArray(j.events) && j.events.length) {
    lines.push(`\nTimeline:\n${j.events.slice(0, 8).map((e) => `- ${e.at} ${e.kind}${e.detail ? `: ${trunc(e.detail, 120)}` : ''}`).join('\n')}`);
  }
  return textResult(lines.join('\n'));
}

async function digest() {
  const d = await api('/api/digest');
  return textResult(trunc(d.markdown || jsonText(d, 12000), 14000));
}

async function applyPacket(args) {
  const id = Number(args.id);
  const [job, packet] = await Promise.all([api(`/api/jobs/${id}`), api(`/api/jobs/${id}/packet`)]);
  const profile = packet.profile || {};
  const answers = packet.answers || [];
  const lines = [
    `Application packet — #${job.id} ${job.title || ''} @ ${job.company || '?'}`,
    `Apply URL: ${job.source_url || '—'}`,
    `Profile: ${Object.entries(profile).map(([k, v]) => `${k}=${trunc(v, 120)}`).join(' · ') || '(empty — run setup)'}`,
    `Resume: ${packet.resume ? (packet.resume.missing ? `MISSING ${packet.resume.path}` : `${packet.resume.name} (${packet.resume.size} bytes)`) : 'not configured'}`,
    `Saved answers: ${answers.length}`,
    '',
    'Use jobpilot_apply to open the posting and pre-fill it. It never submits: review every field, then click Submit yourself.',
  ];
  return textResult(lines.join('\n'));
}

async function applyJob(args) {
  const id = Number(args.id);
  const data = await api(`/api/apply/${id}?await=1`, { method: 'POST', body: {}, timeout: 140000 });
  const r = data.result || {};
  const lines = [`Opened and pre-filled #${id}.`, `URL: ${data.url || '—'}`];
  if (data.error) lines.push(`Extension error: ${data.error}`);
  if (r.filled != null) lines.push(`Filled: ${Array.isArray(r.filled) ? r.filled.length : r.filled} field(s)`);
  if (Array.isArray(r.missing) && r.missing.length) lines.push(`Needs you: ${r.missing.join(', ')}`);
  if (r.resumeAttached != null) lines.push(`Resume attached: ${r.resumeAttached ? 'check the page' : 'NOT attached — attach manually'}`);
  if (r.framesWithForms != null) lines.push(`Forms found: ${r.framesWithForms}`);
  lines.push('', 'Nothing was submitted. Review the page in Chrome and click Submit yourself.');
  return textResult(lines.join('\n'));
}

async function fillCurrent() {
  const data = await api('/api/ext/run', {
    method: 'POST',
    body: { type: 'fill_current', payload: {}, timeoutMs: 120000 },
    timeout: 135000,
  });
  if (data.error) throw new Error(data.error);
  return textResult(`Pre-filled the active tab.\n${jsonText(data.result, 6000)}\n\nNothing was submitted — review and click Submit yourself.`);
}

async function scanTool(args) {
  const sources = Array.isArray(args.sources) && args.sources.length
    ? args.sources
    : ['boards', 'hn', 'reddit'];
  const r = await api('/api/scan', {
    method: 'POST',
    body: { sources, await: true },
    timeout: 310000,
  });
  return textResult(`Scan complete.\n${jsonText({ ...r, items: undefined }, 5000)}`);
}

async function extScan(type, args) {
  const payload = { ...args };
  delete payload.timeoutMs;
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 240000, 10000), 540000);
  const data = await api('/api/ext/run', {
    method: 'POST',
    body: { type, payload, timeoutMs },
    timeout: timeoutMs + 15000,
  });
  if (data.error) throw new Error(data.error);
  const r = data.result || {};
  const summary = { ...r };
  if (Array.isArray(summary.items)) {
    summary.itemCount = summary.items.length;
    summary.items = summary.items.slice(0, 5);
  }
  return textResult(`${type} complete.\n${jsonText(summary, 7000)}`);
}

async function captureTool(args) {
  const r = await api('/api/browsy/capture', { method: 'POST', body: { tabId: Number(args.tabId) }, timeout: 70000 });
  return textResult(
    `Captured tab as capture #${r.captureId} (engine: ${r.engine}).\n` +
    `${jsonText(r.extraction, 5000)}\n\n` +
    'These are suggestions with a stated basis, not verified facts. Review them, then use jobpilot_import_capture with corrected fields.'
  );
}

async function importCapture(args) {
  const f = args.fields || {};
  if (!f.title) return errorResult('fields.title is required (reviewed, not guessed).');
  const body = {
    capture_id: args.captureId != null ? Number(args.captureId) : null,
    source_url: f.url || args.source_url || null,
    description: f.description || args.description || null,
    fields: {
      title: f.title,
      company: f.company || null,
      location: f.location || null,
      remote: f.remote === true,
      pay: f.pay || null,
      requirements: f.requirements || null,
      description: f.description || null,
      url: f.url || args.source_url || null,
    },
  };
  const r = await api('/api/captures/import', { method: 'POST', body, timeout: 30000 });
  return textResult(`Imported as job #${r.id ?? r.job?.id}. Review it: ${fmtJob(r.job || { id: r.id })}`);
}

async function researchPlan(args) {
  const body = {
    city: args.city || '',
    role: args.role || 'software engineer',
    employer: args.employer || '',
    sites: Array.isArray(args.sites) ? args.sites : [],
    query: args.query || '',
  };
  const run = await api('/api/research/runs', { method: 'POST', body, timeout: 30000 });
  const steps = run.steps || [];
  return textResult(
    `Research run #${run.id}: ${run.role || ''} ${run.city || ''}\n` +
    `Sites: ${(run.sites || []).join(', ') || '—'}\n` +
    `Steps: ${steps.length}\n${steps.slice(0, 12).map((s, i) => `${i + 1}. ${s.site}: ${s.url || s.query || ''}`).join('\n')}\n\n` +
    'Open/execute steps from the dashboard (Research section) so each read is human-driven.'
  );
}

async function researchList() {
  const r = await api('/api/research/runs');
  const runs = r.runs || [];
  if (!runs.length) return textResult('No research runs yet. Create one with jobpilot_research_plan.');
  return textResult(runs.slice(0, 20).map((x) => `#${x.id} ${x.role || ''} ${x.city || ''} · ${x.status} · ${(x.steps || []).length} step(s) · ${ago(x.created_at)}`).join('\n'));
}

async function briefTool(args) {
  const r = await api(`/api/jobs/${Number(args.id)}/brief`);
  return textResult(typeof r === 'string' ? r : (r.brief || r.markdown || jsonText(r, 8000)));
}

/* ----------------------------------------------------------------- clinqy */

async function clinqyRun(args) {
  if (args.confirmed !== true) {
    return errorResult('Native Mac tasks can click and type anywhere. Ask the user for explicit approval, then call again with confirmed=true.');
  }
  const r = await api('/api/clinqy/run', {
    method: 'POST',
    body: { task: args.task, dry: args.dry === true, timeout: Number(args.timeout) || 120, confirmed: true },
    timeout: (Number(args.timeout) || 120) * 1000 + 15000,
  });
  return r.isError ? errorResult(r.text || 'Clinqy task failed') : textResult(r.text || 'Clinqy task finished.');
}

/* ---------------------------------------------------------------- tool defs */

const browserTools = [
  {
    name: 'browser_list_tabs',
    description: 'List every open Chrome tab (id, title, url, active, window). Read-only. Start here to pick a tabId.',
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: 'browser_open_tab',
    description: 'Open a new tab at an http(s) URL. Opens in the background by default; use browser_focus_tab to show it. Returns the new tab id.',
    inputSchema: obj({ url: str('http(s) URL to open'), active: bool('Focus the tab immediately (default false)'), confirmed: CONFIRMED }, ['url', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_focus_tab',
    description: 'Bring a tab to the foreground in its window.',
    inputSchema: obj({ tabId: int('Tab id from browser_list_tabs'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab. This discards the page state.',
    inputSchema: obj({ tabId: int('Tab id'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_snapshot',
    description: 'Compact view of the page: title/URL, headings, interactive elements with short-lived [eN] refs, and visible text. Take a fresh snapshot after navigation or before clicking refs.',
    inputSchema: obj({ tabId: int('Tab id') }, ['tabId']),
    readOnly: true,
  },
  {
    name: 'browser_get_html',
    description: 'Outer HTML of the page or a CSS selector, truncated. Use for structured scraping; prefer snapshots for actions.',
    inputSchema: obj({ tabId: int('Tab id'), selector: str('CSS selector (default: documentElement)'), maxLength: int('Max characters (default 200000)') }, ['tabId']),
    readOnly: true,
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the visible viewport as a downscaled JPEG image. Brings the tab to the foreground.',
    inputSchema: obj({ tabId: int('Tab id') }, ['tabId']),
    readOnly: true,
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref (from snapshot), CSS selector, or x/y coordinates. Submit/send/pay/delete controls are refused without approved=true. Mutations need confirmed=true.',
    inputSchema: obj({
      tabId: int('Tab id'),
      ref: str('Element ref from the latest snapshot, e.g. e12'),
      selector: str('CSS selector (alternative to ref; survives replay)'),
      x: num('Viewport x coordinate'),
      y: num('Viewport y coordinate'),
      approved: APPROVED,
      confirmed: CONFIRMED,
    }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_type',
    description: 'Type into an input, textarea, select, or contenteditable element by ref or selector. Replaces the value by default. Mutations need confirmed=true.',
    inputSchema: obj({
      tabId: int('Tab id'),
      ref: str('Element ref from the latest snapshot'),
      selector: str('CSS selector (alternative to ref)'),
      text: str('Text (or option label for a select)'),
      replaceExisting: bool('Replace the current value (default true)'),
      confirmed: CONFIRMED,
    }, ['tabId', 'text', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or chord on the focused element (e.g. Enter, Tab, Escape, Meta+a).',
    inputSchema: obj({ tabId: int('Tab id'), key: str('Key or chord'), confirmed: CONFIRMED }, ['tabId', 'key', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page by pixels. Useful to load lazy content before a new snapshot.',
    inputSchema: obj({ tabId: int('Tab id'), direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction' }, amount: int('Pixels (default 600)'), confirmed: CONFIRMED }, ['tabId', 'direction', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to an http(s) URL. Prefer reusing a tab; open new ones only when needed.',
    inputSchema: obj({ tabId: int('Tab id'), url: str('http(s) URL'), confirmed: CONFIRMED }, ['tabId', 'url', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_back',
    description: 'Go back in the tab history.',
    inputSchema: obj({ tabId: int('Tab id'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_forward',
    description: 'Go forward in the tab history.',
    inputSchema: obj({ tabId: int('Tab id'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_reload',
    description: 'Reload the tab.',
    inputSchema: obj({ tabId: int('Tab id'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
  {
    name: 'browser_wait',
    description: 'Wait up to 10 seconds for the page to settle. Read-only.',
    inputSchema: obj({ tabId: int('Tab id'), milliseconds: int('Wait time (default 500, max 10000)') }, ['tabId']),
    readOnly: true,
  },
  {
    name: 'browser_release',
    description: 'Release the refs for a tab (clears the short-lived element map).',
    inputSchema: obj({ tabId: int('Tab id'), confirmed: CONFIRMED }, ['tabId', 'confirmed']),
    mutating: true,
  },
];

const tools = [
  /* ------------------------------------------------------------- job tools */
  {
    name: 'jobpilot_status',
    description: 'Overview: job counts, buckets, pipeline, extension/browser/Clinqy connectivity, profile readiness, resume, auto-submit state.',
    inputSchema: obj({}),
    readOnly: true,
    handler: statusTool,
  },
  {
    name: 'jobpilot_scan',
    description: 'Scan public sources server-side (job boards, HN, Reddit, RemoteOK). May take several minutes. Does not touch Chrome.',
    inputSchema: obj({
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['boards', 'hn', 'reddit', 'greenhouse', 'lever', 'ashby', 'remoteok'] },
        description: 'Sources (default boards, hn, reddit)',
      },
    }),
    mutating: true,
    handler: scanTool,
  },
  {
    name: 'jobpilot_scan_x',
    description: 'Scan X hiring posts in the user\'s real logged-in Chrome session through the extension. Fills the job database. Requires the extension.',
    inputSchema: obj({
      queries: { type: 'array', items: { type: 'string' }, description: 'Search queries' },
      accounts: { type: 'array', items: { type: 'string' }, description: 'Optional accounts to scan' },
      maxScrolls: int('Scroll depth per query'),
    }),
    mutating: true,
    handler: (a) => extScan('scan_x', a),
  },
  {
    name: 'jobpilot_scan_reddit',
    description: 'Scan Reddit hiring posts with the extension (logged-in session). Jobs are filtered by [HIRING] + role keywords.',
    inputSchema: obj({
      subs: { type: 'array', items: { type: 'string' }, description: 'Subreddits (default forhire, jobbit, hiring, RemoteJobs)' },
    }),
    mutating: true,
    handler: (a) => extScan('scan_reddit', a),
  },
  {
    name: 'jobpilot_list_jobs',
    description: 'List stored jobs, filtered and scored. Includes eligibility buckets and ids for follow-up tools.',
    inputSchema: obj({
      minScore: int('Minimum score'),
      status: { type: 'string', enum: ['new', 'saved', 'in_progress', 'applied', 'skipped', 'archived'] },
      source: str('Source filter, e.g. greenhouse'),
      q: str('Text search'),
      remote: bool('Remote only'),
      sinceDays: int('Only jobs first seen in the last N days'),
      bucket: { type: 'string', enum: ['suitable', 'review', 'excluded', 'unknown'], description: 'Eligibility bucket' },
      sort: { type: 'string', enum: ['score', 'newest'] },
      limit: int('Rows (default 40, max 500)'),
      offset: int('Pagination offset'),
    }),
    readOnly: true,
    handler: listJobs,
  },
  {
    name: 'jobpilot_get_job',
    description: 'Full detail for one job: score, eligibility, pay, why-it-matches, description, notes, timeline, apply URL.',
    inputSchema: obj({ id: int('Job id'), }, ['id']),
    readOnly: true,
    handler: getJob,
  },
  {
    name: 'jobpilot_set_status',
    description: 'Set a job status (new/saved/in_progress/applied/skipped/archived). Use after a real action, not speculatively.',
    inputSchema: obj({
      id: int('Job id'),
      status: { type: 'string', enum: ['new', 'saved', 'in_progress', 'applied', 'skipped', 'archived'] },
    }, ['id', 'status']),
    mutating: true,
    handler: async (a) => {
      const j = await api(`/api/jobs/${Number(a.id)}/status`, { method: 'POST', body: { status: a.status } });
      return textResult(`#${j.id} status → ${j.status}`);
    },
  },
  {
    name: 'jobpilot_digest',
    description: 'Markdown digest of the best new jobs, grouped for a quick read.',
    inputSchema: obj({}),
    readOnly: true,
    handler: digest,
  },
  {
    name: 'jobpilot_apply_packet',
    description: 'Assemble everything needed to apply to one job: profile, saved answers, resume availability, URL. Read-only; nothing is filled.',
    inputSchema: obj({ id: int('Job id') }, ['id']),
    readOnly: true,
    handler: applyPacket,
  },
  {
    name: 'jobpilot_apply',
    description: 'Open a job posting and pre-fill the application with the saved profile + resume. Never submits; waits for the fill report. Review and submit manually.',
    inputSchema: obj({ id: int('Job id') }, ['id']),
    mutating: true,
    handler: applyJob,
  },
  {
    name: 'jobpilot_fill_current',
    description: 'Pre-fill the application form in the currently active tab. Never submits. Review in Chrome.',
    inputSchema: obj({}),
    mutating: true,
    handler: fillCurrent,
  },
  {
    name: 'jobpilot_capture',
    description: 'Snapshot a tab and turn it into an editable job capture (suggested fields with a stated basis). Does not import.',
    inputSchema: obj({ tabId: int('Tab id') }, ['tabId']),
    mutating: true,
    handler: captureTool,
  },
  {
    name: 'jobpilot_import_capture',
    description: 'Import reviewed capture fields as a job. Only call with user-reviewed fields; title is required. No facts are invented.',
    inputSchema: obj({
      captureId: int('Capture id from jobpilot_capture'),
      source_url: str('Original posting URL'),
      description: str('Reviewed description'),
      fields: obj({
        title: str('Job title (required)'),
        company: str('Company'),
        location: str('Location'),
        remote: bool('Remote'),
        pay: str('Pay / salary text'),
        requirements: str('Requirements text'),
        description: str('Description'),
        url: str('Posting URL'),
      }, ['title']),
    }, ['fields']),
    mutating: true,
    handler: importCapture,
  },
  {
    name: 'jobpilot_rescore',
    description: 'Re-run the scorer for all jobs against the current criteria/profile.',
    inputSchema: obj({}),
    mutating: true,
    handler: async () => {
      const r = await api('/api/rescore', { method: 'POST', body: {}, timeout: 60000 });
      return textResult(`Rescored ${r.rescored} job(s). ${r.note || ''}`);
    },
  },
  {
    name: 'jobpilot_research_plan',
    description: 'Create a research plan (city/role/employer + sites) with concrete steps. Execution stays human-driven in the dashboard.',
    inputSchema: obj({
      city: str('City, e.g. Bangalore'),
      role: str('Role, e.g. backend engineer'),
      employer: str('Optional employer'),
      sites: { type: 'array', items: { type: 'string' }, description: 'Sites (defaults chosen by the server)' },
      query: str('Optional search query'),
    }),
    mutating: true,
    handler: researchPlan,
  },
  {
    name: 'jobpilot_research_list',
    description: 'List research runs and their status.',
    inputSchema: obj({}),
    readOnly: true,
    handler: researchList,
  },
  {
    name: 'jobpilot_brief',
    description: 'Read the factual company/person brief for a job (generated by the app; no invented facts).',
    inputSchema: obj({ id: int('Job id') }, ['id']),
    readOnly: true,
    handler: briefTool,
  },

  /* ------------------------------------------------------------ browser */
  ...browserTools.map((t) => ({
    ...t,
    title: t.name.replace('browser_', 'Browser: '),
    readOnly: Boolean(t.readOnly),
    handler: (a) => handleBrowser(t.name, a),
  })),

  /* -------------------------------------------------------------- clinqy */
  {
    name: 'clinqy_look',
    description: 'Ask the installed Clinqy app to look at the current page/screen and describe it. Read-only.',
    inputSchema: obj({ mode: { type: 'string', enum: ['page', 'read', 'url'] } }),
    readOnly: true,
    handler: async (a) => {
      const r = await api('/api/clinqy/look', { method: 'POST', body: { mode: a.mode }, timeout: 90000 });
      return r.isError ? errorResult(r.text || 'Clinqy look failed') : textResult(r.text || '(no text)');
    },
  },
  {
    name: 'clinqy_stats',
    description: 'Clinqy usage stats (native app). Read-only.',
    inputSchema: obj({ days: num('Window in days'), last: bool('Only the latest run') }),
    readOnly: true,
    handler: async (a) => {
      const p = new URLSearchParams();
      if (a.days != null) p.set('days', String(a.days));
      if (a.last) p.set('last', '1');
      const r = await api(`/api/clinqy/stats${p.toString() ? `?${p}` : ''}`, { timeout: 60000 });
      return r.isError ? errorResult(r.text || 'Clinqy stats failed') : textResult(r.text || '(no text)');
    },
  },
  {
    name: 'clinqy_run',
    description: 'Run a natural-language task in the native Clinqy app (can control Mac apps). REQUIRES confirmed=true after explicit user approval. dry=true previews.',
    inputSchema: obj({
      task: str('Natural-language task'),
      dry: bool('Preview without acting'),
      timeout: int('Seconds (default 120, max 900)'),
      confirmed: CONFIRMED,
    }, ['task']),
    mutating: true,
    handler: clinqyRun,
  },
  {
    name: 'clinqy_open',
    description: 'Open a fixed Clinqy native handoff (watch mode, workflow recorder, browser pairing). No arbitrary URLs.',
    inputSchema: obj({
      target: {
        type: 'string',
        enum: ['clinqy://open', 'clinqy://watch', 'clinqy://stop-watching', 'clinqy://workflow', 'clinqy://browser', 'clinqy://reload-extension'],
      },
    }, ['target']),
    mutating: true,
    handler: async (a) => {
      const r = await api('/api/clinqy/open', { method: 'POST', body: { target: a.target } });
      return textResult(`Opened ${r.opened}`);
    },
  },

  /* -------------------------------------------------------------- memory */
  {
    name: 'memory_remember',
    description: 'Save a durable fact or preference locally (SQLite). Use for things the user wants remembered across sessions, e.g. "prefers remote-only, no on-call".',
    inputSchema: obj({
      text: str('The fact/preference, written clearly'),
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
    }, ['text']),
    mutating: true,
    handler: async (a) => {
      const r = await api('/api/memories', { method: 'POST', body: { text: a.text, tags: a.tags || [] } });
      return textResult(`Remembered #${r.memory.id}: ${trunc(r.memory.text, 200)}`);
    },
  },
  {
    name: 'memory_recall',
    description: 'Search remembered facts/preferences.',
    inputSchema: obj({ query: str('Substring to search'), limit: int('Max results (default 20)') }),
    readOnly: true,
    handler: async (a) => {
      const p = new URLSearchParams();
      if (a.query) p.set('q', a.query);
      if (a.limit) p.set('limit', String(a.limit));
      const r = await api(`/api/memories${p.toString() ? `?${p}` : ''}`);
      const rows = r.memories || [];
      if (!rows.length) return textResult('No memories matched.');
      return textResult(rows.map((m) => `#${m.id} ${m.text}${m.tags?.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n'));
    },
  },
  {
    name: 'memory_forget',
    description: 'Delete a remembered fact by id.',
    inputSchema: obj({ id: int('Memory id') }, ['id']),
    mutating: true,
    handler: async (a) => {
      await api(`/api/memories/${Number(a.id)}`, { method: 'DELETE' });
      return textResult(`Deleted memory #${a.id}.`);
    },
  },

  /* ------------------------------------------------------------ workflows */
  {
    name: 'workflow_record_start',
    description: 'Start recording browser actions into a reusable workflow. Subsequent browser_click/type/navigate/wait calls are captured (selectors, not ephemeral refs).',
    inputSchema: obj({ name: str('Workflow name (e.g. "greenhouse-apply")') }, ['name']),
    mutating: true,
    handler: async (a) => {
      if (recording) return errorResult(`Already recording "${recording.name}" with ${recording.steps.length} step(s). Stop it first.`);
      recording = { name: String(a.name), steps: [], startedAt: Date.now() };
      return textResult(`Recording "${recording.name}". Perform the browser steps, then call workflow_record_stop. Read-only tools are not recorded; typed text IS stored locally (avoid secrets).`);
    },
  },
  {
    name: 'workflow_record_stop',
    description: 'Stop recording and save the workflow to SQLite.',
    inputSchema: obj({}),
    mutating: true,
    handler: async () => {
      if (!recording) return errorResult('Not recording.');
      const cur = recording;
      recording = null;
      if (!cur.steps.length) return errorResult('Recording was empty — no workflow saved.');
      const r = await api('/api/workflows', { method: 'POST', body: { name: cur.name, steps: cur.steps } });
      return textResult(`Saved workflow "${r.workflow.name}" with ${cur.steps.length} step(s):\n${cur.steps.map((s, i) => `${i + 1}. ${s.tool} ${s.args.selector || s.args.url || s.args.key || ''}`).join('\n')}`);
    },
  },
  {
    name: 'workflow_list',
    description: 'List saved workflows with step counts.',
    inputSchema: obj({}),
    readOnly: true,
    handler: async () => {
      const r = await api('/api/workflows');
      const rows = r.workflows || [];
      if (!rows.length) return textResult('No workflows saved yet.');
      return textResult(rows.map((w) => `#${w.id} ${w.name} · ${w.steps.length} step(s) · updated ${ago(w.updated_at)}`).join('\n'));
    },
  },
  {
    name: 'workflow_run',
    description: 'Replay a saved workflow in the active tab (or a tab it opens). Requires confirmed=true. Submit-like clicks still need approved=true. Use dryRun=true to preview.',
    inputSchema: obj({
      name: str('Workflow name'),
      dryRun: bool('Preview steps without acting'),
      approved: APPROVED,
      confirmed: CONFIRMED,
    }, ['name']),
    mutating: true,
    handler: async (a) => {
      const r = await api('/api/workflows');
      const wf = (r.workflows || []).find((w) => w.name === a.name);
      if (!wf) return errorResult(`No workflow named "${a.name}".`);
      if (a.dryRun) {
        return textResult(`Workflow "${wf.name}" — ${wf.steps.length} step(s):\n${wf.steps.map((s, i) => `${i + 1}. ${s.tool} ${s.args.selector || s.args.url || s.args.key || (s.args.text ? `"${trunc(s.args.text, 40)}"` : '')}`).join('\n')}`);
      }
      if (a.confirmed !== true) return errorResult('Replaying a workflow changes the browser. Ask the user, then call again with confirmed=true.');

      const tabsRes = await localCall('browser_list_tabs', {});
      const usable = (tabsRes.parsed || []).filter((t) => /^https?:/i.test(t.url || ''));
      let tabId = (usable.find((t) => t.active) || usable[0])?.id ?? null;
      const done = [];
      for (let i = 0; i < wf.steps.length; i += 1) {
        const step = wf.steps[i];
        const args = { ...step.args };
        try {
          if (step.tool === 'browser_open_tab') {
            const res = await localCall(step.tool, { ...args, confirmed: true });
            if (res.parsed?.id) tabId = res.parsed.id;
            done.push(`${i + 1}. opened ${args.url}`);
            await new Promise((r2) => setTimeout(r2, 600));
            continue;
          }
          if (tabId == null) throw new Error('no usable http(s) tab — open one first');
          if (args.tabId == null) args.tabId = tabId;
          if (step.tool === 'browser_click' && a.approved === true) args.approved = true;
          const res = await localCall(step.tool, { ...args, confirmed: true });
          if (res.needsApproval) {
            return errorResult(`Stopped at step ${i + 1} (${step.tool}): ${res.text} Target: ${res.target?.selector || '?'}. Ask the user, then rerun with approved=true.`);
          }
          if (res.ok === false) throw new Error(res.text || 'step failed');
          done.push(`${i + 1}. ${step.tool} ${args.selector || args.url || args.key || ''}`);
          if (step.tool === 'browser_navigate') await new Promise((r2) => setTimeout(r2, 500));
        } catch (e) {
          return errorResult(`Workflow "${wf.name}" failed at step ${i + 1} (${step.tool}): ${e.message}\nCompleted:\n${done.join('\n')}`);
        }
      }
      return textResult(`Replayed "${wf.name}" — ${done.length} step(s):\n${done.join('\n')}\n\nNothing was submitted by Job Pilot; submit-like clicks require explicit approval.`);
    },
  },
  {
    name: 'workflow_delete',
    description: 'Delete a saved workflow by name.',
    inputSchema: obj({ name: str('Workflow name') }, ['name']),
    mutating: true,
    handler: async (a) => {
      const r = await api('/api/workflows');
      const wf = (r.workflows || []).find((w) => w.name === a.name);
      if (!wf) return errorResult(`No workflow named "${a.name}".`);
      await api(`/api/workflows/${wf.id}`, { method: 'DELETE' });
      return textResult(`Deleted workflow "${wf.name}".`);
    },
  },
];

/* ------------------------------------------------------------- instructions */

const INSTRUCTIONS = `Job Pilot is a local-first job-search and application cockpit running on this Mac.

Use the tools in this order:
1. jobpilot_status / jobpilot_list_jobs / jobpilot_digest to see the pipeline.
2. browser_list_tabs → browser_snapshot to inspect pages in the user's real Chrome session.
3. jobpilot_capture → review fields → jobpilot_import_capture to add a posting.
4. jobpilot_apply_packet → jobpilot_apply to open and pre-fill an application.

Hard safety rules:
- NEVER submit an application or send a message on the user's behalf. jobpilot_apply only fills the form; the human reviews the page and clicks Submit.
- Browser actions that change state require confirmed=true, and you must have asked the user first. Submit/send/pay/delete clicks additionally require approved=true.
- clinqy_run controls the whole Mac and requires confirmed=true after explicit approval.
- Refuse to pass secrets or payment details to browser_type. Do not record passwords in workflows.
- If a mutating browser call reports an unknown outcome, take a fresh browser_snapshot before retrying.
- Prefer read-only tools (snapshot, get_html, list_jobs) before acting.

Built-in engines:
- The browser_* tools are served by the Job Pilot Chrome extension (Browsy-style surface) and work in the user's logged-in session.
- The clinqy_* tools proxy the real Clinqy macOS app when it is installed.
- memory_* and workflow_* are local SQLite; they never leave the machine.`;

/* ------------------------------------------------------------------ dispatch */

const toolsByName = new Map(tools.map((t) => [t.name, t]));

function toolsList() {
  return tools.map((t) => ({
    name: t.name,
    title: t.title || t.name,
    description: t.description,
    inputSchema: t.inputSchema || obj({}),
    annotations: {
      title: t.title || t.name,
      readOnlyHint: Boolean(t.readOnly),
      destructiveHint: Boolean(t.mutating && /delete|close|run|apply|import|forget/.test(t.name)),
      idempotentHint: Boolean(t.readOnly),
      openWorldHint: t.name.startsWith('browser_') || t.name.startsWith('clinqy_') || t.name.startsWith('jobpilot_scan'),
    },
  }));
}

async function callTool(name, args) {
  const t = toolsByName.get(name);
  if (!t) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  try {
    return await t.handler(args && typeof args === 'object' ? args : {});
  } catch (e) {
    return errorResult(`${name} failed: ${e.message}`);
  }
}

const cancelled = new Set();
const queue = [];
let working = false;

function pump() {
  if (working) return;
  working = true;
  (async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        if (job && job.__batch) {
          for (const m of job.__batch) await handleMessage(m);
        } else {
          await handleMessage(job);
        }
      } catch (e) {
        console.error('[jobpilot-mcp] handler error', e);
      }
    }
    working = false;
  })();
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'notifications/cancelled') {
    if (params?.requestId != null) cancelled.add(String(params.requestId));
    return;
  }
  if (isNotification) return;

  const reply = (result) => {
    if (cancelled.delete(String(id))) {
      send({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Request cancelled' } });
      return;
    }
    send({ jsonrpc: '2.0', id, result });
  };
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        reply({
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: { name: 'jobpilot', title: 'Job Pilot', version: VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: toolsList() });
        return;
      case 'tools/call': {
        const name = params?.name;
        if (!name) return fail(-32602, 'tools/call requires a name');
        const result = await callTool(String(name), params?.arguments || {});
        if (result?.__rpcError) return fail(result.__rpcError.code, result.__rpcError.message);
        reply(result);
        return;
      }
      case 'resources/list': {
        const resources = [
          { uri: 'jobpilot://status', name: 'Job Pilot status', description: 'Live status snapshot', mimeType: 'application/json' },
          { uri: 'jobpilot://capabilities', name: 'Capabilities and safety rules', description: 'What the agent may do', mimeType: 'text/markdown' },
        ];
        reply({ resources });
        return;
      }
      case 'resources/templates/list':
        reply({ resourceTemplates: [] });
        return;
      case 'resources/read': {
        const uri = String(params?.uri || '');
        if (uri === 'jobpilot://status') {
          const r = await api('/api/state');
          reply({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] });
          return;
        }
        if (uri === 'jobpilot://capabilities') {
          reply({ contents: [{ uri, mimeType: 'text/markdown', text: INSTRUCTIONS }] });
          return;
        }
        return fail(-32002, `Resource not found: ${uri}`);
      }
      case 'prompts/list':
        reply({ prompts: [] });
        return;
      default:
        fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, e.message || 'Internal error');
  }
}

/* --------------------------------------------------------------------- main */

console.error(`[jobpilot-mcp] Job Pilot MCP v${VERSION} — server ${BASE}, root ${ROOT}`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) {
    const batch = msg.map((m) => m);
    queue.push({ __batch: batch });
  } else {
    queue.push(msg);
  }
  pump();
});

// Expand batches inside pump (handled in order, so browser actions never race).
rl.on('close', async () => {
  // Let queued calls finish before exiting.
  const wait = setInterval(() => {
    if (!working && !queue.length) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 50);
  setTimeout(() => process.exit(0), 30000).unref();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
