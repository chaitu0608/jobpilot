import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadConfig, DB_PATH, buildPacket, ROOT_DIR } from './config.js';
import {
  openDb, getJob, listJobs, setStatus, stats, recentEvents, recentRuns, addEvent, pruneOld,
  listWorkbook, getWorkbook, upsertWorkbook, deleteWorkbook, addCapture, getCapture, listCaptures,
  listCompanies, getCompany, upsertCompany, deleteCompany,
  listContacts, getContact, upsertContact, deleteContact,
  listPipeline, getPipelineForJob, upsertPipeline, deletePipeline, PIPELINE_STATUSES,
  createResearchRun, getResearchRun, listResearchRuns, updateResearchRun,
  addResearchStep, listResearchSteps, updateResearchStep,
  addAudit, listAudit, getCriteria, setCriteria, upsertJob,
  addMemory, listMemories, deleteMemory,
  saveWorkflow, getWorkflow, listWorkflows, deleteWorkflow,
} from './db.js';
import { runServerScan, ingestItems } from './sources/index.js';
import { enqueue, claimNext, complete, onWake, commandsState, pendingCount, getCommand, waitForCommand } from './commands.js';
import { buildDigest } from './digest.js';
import { rescoreAll, scoreJob } from './scoring.js';
import { nowIso, safeParse } from './util.js';
import { fingerprint } from './normalize.js';
import { DEFAULT_CRITERIA, normalizeCriteria } from './criteria.js';
import { classifyEligibility, summarizeBuckets, BUCKET } from './eligibility.js';
import { createAdapters, clinqyCapabilities, BROWSY_TOOLS, CLINQY_TOOLS } from './adapters.js';
import { buildResearchPlan, RESEARCH_SITES } from './research.js';
import { toCsv, flattenJob, flattenPipeline, buildBrief } from './exporters.js';
import { extractCapture } from './capture.js';
import { LocalBrowserAdapter, LOCAL_BROWSER_TOOLS } from './browser-local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(DB_PATH);

const addAuditSink = (entry) => { try { addAudit(db, entry); } catch { /* ignore */ } };
const adapters = createAdapters({ onAudit: addAuditSink });
const { browsy, clinqy } = adapters;
const localBrowser = new LocalBrowserAdapter({
  db,
  isConnected: () => Date.now() - ext.lastPoll < 20000,
  onAudit: addAuditSink,
});

const ext = { lastPoll: 0 };
let scanning = false;
let lastScan = null;

/** Editable candidate criteria, stored in the DB — separate from config.json. */
function loadCriteria() {
  const stored = getCriteria(db);
  return stored ? normalizeCriteria(stored) : structuredClone(DEFAULT_CRITERIA);
}

/* ------------------------------------------------ security helpers (unchanged) */

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];
function hostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').toLowerCase();
  if (!host) return false;
  const ok = [];
  for (const name of LOOPBACK_HOSTS) {
    ok.push(name + ':' + port);
    if (port === 80) ok.push(name);
  }
  return ok.includes(host);
}
function isCrossOriginWebRequest(req) {
  const origin = req.headers.origin;
  if (!origin || !/^https?:\/\//i.test(origin)) return false;
  const host = String(req.headers.host || '').toLowerCase();
  try { return new URL(origin).host.toLowerCase() !== host; } catch { return true; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, code, s, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(code, { 'content-type': type, ...extraHeaders });
  res.end(s);
}
const MAX_BODY = 2 * 1024 * 1024;
async function readBody(req) {
  const chunks = [];
  let len = 0;
  for await (const c of req) {
    len += c.length;
    if (len > MAX_BODY) { const e = new Error('request body too large'); e.code = 'BODY_TOO_LARGE'; throw e; }
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  try { return JSON.parse(s); } catch { const e = new Error('invalid JSON body'); e.code = 'BAD_JSON'; throw e; }
}

function extStatus() {
  const cfg = loadConfig();
  return {
    connected: Date.now() - ext.lastPoll < 20000,
    lastPoll: ext.lastPoll || null,
    pending: pendingCount(db),
    scanning,
    lastScan,
    config: {
      xQueries: (cfg.x?.queries || []).length,
      xAccounts: (cfg.x?.accounts || []).length,
      redditSubs: cfg.reddit?.subs || [],
      hasProfile: Boolean(cfg.profile?.firstName && cfg.profile?.email),
      hasResume: Boolean(cfg.profile?.resumePath),
      autoSubmit: Boolean(cfg.safety?.autoSubmit),
    },
    commands: commandsState(db, 8),
  };
}

function connectionsSummary() {
  const b = browsy.status();
  const c = clinqy.status();
  return {
    browsy: { connected: b.connected, available: b.available, discovered: b.discovered, toolCount: b.toolCount, serverInfo: b.serverInfo, error: b.error },
    clinqy: { connected: c.connected, available: c.available, discovered: c.discovered, toolCount: c.toolCount, serverInfo: c.serverInfo, error: c.error },
    localBrowser: {
      engine: 'extension',
      connected: Date.now() - ext.lastPoll < 20000,
      toolCount: Object.keys(LOCAL_BROWSER_TOOLS).length,
    },
    extension: { connected: Date.now() - ext.lastPoll < 20000 },
  };
}

/* -------------------------------------------------------------- job enrichment */

function enrichJob(job, criteria) {
  if (!job) return null;
  const eligibility = classifyEligibility(job, criteria);
  const pipeline = getPipelineForJob(db, job.id);
  const linkedCompany = pipeline && pipeline.company_id ? getCompany(db, pipeline.company_id) : null;
  const linkedContact = pipeline && pipeline.contact_id ? getContact(db, pipeline.contact_id) : null;
  return { ...job, eligibility, pipeline, linkedCompany, linkedContact, captures: listCaptures(db, job.id, 5) };
}

function decorateList(rows, criteria) {
  return rows.map((r) => ({ ...r, eligibility: classifyEligibility(r, criteria) }));
}

/* -------------------------------------------------------------------- research */

function planFromBody(body) {
  const plan = buildResearchPlan({
    city: body.city || '',
    role: body.role || '',
    employer: body.employer || '',
    sites: body.sites,
  });
  return plan;
}

/* -------------------------------------------------------------------- import */

/** Create a job from REVIEWED capture fields — no guessing, provenance kept. */
function importCaptureJob(body) {
  const cfg = loadConfig();
  const f = body.fields || {};
  const title = String(f.title || '').trim();
  if (!title) throw new Error('title is required');
  const company = String(f.company || '').trim() || null;
  const location = String(f.location || '').trim() || null;
  const sourceUrl = String(body.source_url || f.url || '').trim() || null;
  const description = String(f.description || body.description || '').trim() || null;
  const requirements = String(f.requirements || '').trim();
  const pay = String(f.pay || '').trim() || null;
  const fp = fingerprint(company, title, sourceUrl);
  const job = {
    fingerprint: fp, source: 'browsy', source_id: null, source_url: sourceUrl,
    company, title, location, remote: f.remote === true || f.remote === 'yes' ? 1 : 0,
    salary: pay, tags: '[]',
    description: requirements && description ? `${description}\n\nRequirements:\n${requirements}` : (description || requirements || null),
    apply_url: String(f.apply_url || '').trim() || sourceUrl, apply_email: String(f.apply_email || '').trim() || null,
    author: null, posted_at: null,
    extra: { captured: true, captureId: body.captureId ?? null, reviewed: true, typeStated: String(f.type || '') },
  };
  const { score, why } = scoreJob(job, cfg?.targets || {});
  job.score = score;
  job.extra.why = why;
  // upsertJob wants JSON strings for tags/extra/seen_sources
  job.tags = '[]';
  job.extra = JSON.stringify(job.extra);
  const res = upsertJobSafe(job);
  if (body.captureId) {
    try { db.prepare('UPDATE captures SET job_id = ? WHERE id = ?').run(res.id, Number(body.captureId)); } catch { /* ignore */ }
  }
  addEvent(db, res.id, 'captured', `imported from Browsy capture${company ? ' · ' + company : ''}`);
  return { id: res.id, added: res.added };
}
function upsertJobSafe(job) {
  return upsertJob(db, job);
}

/* -------------------------------------------------------------------- brief */

function jobBrief(jobId) {
  const job = getJob(db, jobId);
  if (!job) return null;
  const criteria = loadCriteria();
  const eligibility = classifyEligibility(job, criteria);
  const pipeline = getPipelineForJob(db, job.id);
  const company = pipeline && pipeline.company_id ? getCompany(db, pipeline.company_id) : null;
  const contact = pipeline && pipeline.contact_id ? getContact(db, pipeline.contact_id) : null;
  const md = buildBrief({ job, eligibility, company, contact, criteria });
  return { md, job, eligibility, company, contact };
}

/* -------------------------------------------------------------------- routes */

const handlers = {
  async 'GET /api/state'() {
    const criteria = loadCriteria();
    const all = db.prepare('SELECT id, source, title, location, remote, description, posted_at, tags, extra, status, score FROM jobs').all();
    const buckets = summarizeBuckets(decorateList(all, criteria));
    return [200, {
      stats: stats(db),
      buckets,
      ext: extStatus(),
      connections: connectionsSummary(),
      runs: recentRuns(db, 8),
      events: recentEvents(db, 12),
      pipeline: listPipeline(db).length,
      companies: listCompanies(db).length,
      contacts: listContacts(db).length,
    }];
  },

  async 'GET /api/jobs'(req, url) {
    const q = Object.fromEntries(url.searchParams.entries());
    const criteria = loadCriteria();
    const statusFilter = q.status;
    // pull a wide window, decorate with eligibility, then filter/sort/paginate here
    const base = listJobs(db, {
      status: statusFilter, source: q.source, q: q.q, minScore: q.minScore,
      remote: q.remote === '1', sort: q.sort, limit: 500, offset: 0, sinceDays: q.sinceDays,
    });
    let rows = decorateList(base.rows, criteria);
    if (q.bucket) rows = rows.filter((j) => j.eligibility.bucket === q.bucket);
    const total = rows.length;
    const offset = Number(q.offset) || 0;
    const limit = Math.min(Number(q.limit) || 60, 500);
    return [200, {
      total,
      serverTotal: base.total,
      buckets: summarizeBuckets(rows),
      rows: rows.slice(offset, offset + limit),
    }];
  },

  async 'GET /api/jobs/:id'(req, url) {
    const id = Number(url.pathname.split('/')[3]);
    const job = getJob(db, id);
    if (!job) return [404, { error: 'job not found' }];
    return [200, enrichJob(job, loadCriteria())];
  },

  async 'GET /api/jobs/:id/packet'() {
    return [200, buildPacket(loadConfig())];
  },

  async 'GET /api/digest'() {
    return [200, buildDigest(db, {})];
  },

  async ['POST /api/scan'](req, url, body) {
    const cfg = loadConfig();
    const sources = body.sources || ['boards', 'hn', 'reddit'];
    const log = (l) => console.log('[scan]', l);
    if (body.await) {
      const r = await runServerScan(db, cfg, { sources, log });
      lastScan = { at: nowIso(), sources, result: r };
      return [200, r];
    }
    if (!scanning) {
      scanning = true;
      runServerScan(db, cfg, { sources, log })
        .then((r) => { lastScan = { at: nowIso(), sources, result: r }; })
        .catch((e) => console.error('[scan] failed', e))
        .finally(() => { scanning = false; });
    }
    return [200, { started: true, scanning: true, sources }];
  },

  async ['POST /api/ext/scan'](req, url, body) {
    const cfg = loadConfig();
    if (body.target === 'x') {
      const cmd = enqueue(db, 'scan_x', {
        queries: body.queries || cfg.x?.queries || [],
        accounts: body.accounts || cfg.x?.accounts || [],
        perQuery: cfg.x?.perQuery || 60,
        maxScrolls: cfg.x?.maxScrolls || 3,
      });
      return [200, { queued: cmd.id, hint: 'Extension will open X tabs and scrape. Keep Chrome open.' }];
    }
    if (body.target === 'reddit') {
      const cmd = enqueue(db, 'scan_reddit', { subs: body.subs || cfg.reddit?.subs || [] });
      return [200, { queued: cmd.id }];
    }
    return [400, { error: 'target must be "x" or "reddit"' }];
  },

  async ['POST /api/apply/:id'](req, url) {
    const id = Number(url.pathname.split('/')[3]);
    const job = getJob(db, id);
    if (!job) return [404, { error: 'job not found' }];
    const target = job.apply_url || job.source_url;
    if (!target) return [400, { error: 'no apply url on this job' }];
    const cfg = loadConfig();
    const packet = buildPacket(cfg);
    if (!packet.profile.firstName || !packet.profile.email) {
      return [400, { error: 'profile is empty — run "node server/cli.js setup" first' }];
    }
    const cmd = enqueue(db, 'open_and_fill', { jobId: job.id, url: target, packet });
    addEvent(db, job.id, 'fill_queued', target);
    if (url.searchParams.get('await') === '1') {
      try {
        const done = await waitForCommand(db, cmd.id, { timeoutMs: 120000 });
        return [200, { queued: cmd.id, url: target, resume: packet.resume?.name || null, result: done.result?.result ?? null, error: done.result?.error || null, status: done.status }];
      } catch (e) {
        return [504, { queued: cmd.id, url: target, error: e.message }];
      }
    }
    return [200, { queued: cmd.id, url: target, resume: packet.resume?.name || null }];
  },

  async 'POST /api/jobs/:id/status'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    const job = getJob(db, id);
    if (!job) return [404, { error: 'job not found' }];
    if (!body.status) return [400, { error: 'status required' }];
    const allowed = ['new', 'saved', 'in_progress', 'applied', 'skipped', 'archived'];
    if (!allowed.includes(String(body.status))) return [400, { error: 'invalid status' }];
    return [200, setStatus(db, id, body.status)];
  },

  async 'POST /api/jobs/:id/notes'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(String(body.notes || '').slice(0, 4000), id);
    addEvent(db, id, 'note');
    return [200, { ok: true }];
  },

  async 'POST /api/rescore'() {
    const n = rescoreAll(db, loadConfig(), {});
    return [200, { rescored: n, note: 'Eligibility is computed on read, so the new classifier applies immediately without rescoring.' }];
  },

  /* --------------------------------------------------------------- criteria */

  async 'GET /api/criteria'() {
    return [200, { criteria: loadCriteria(), defaults: DEFAULT_CRITERIA }];
  },
  async ['POST /api/criteria'](req, url, body) {
    const merged = normalizeCriteria({ ...loadCriteria(), ...(body.criteria || body || {}) });
    setCriteria(db, merged);
    return [200, { criteria: merged }];
  },

  /* ------------------------------------------------------------ connections */

  async 'GET /api/connections'(req, url) {
    const refresh = url.searchParams.get('refresh') === '1';
    const b = await browsy.discover({ refresh });
    const c = await clinqy.discover({ refresh });
    return [200, {
      browsy: { ...browsy.status(), discover: { available: b.available, error: b.error || null } },
      clinqy: { ...clinqy.status(), discover: { available: c.available, error: c.error || null } },
      localBrowser: {
        engine: 'extension',
        available: true,
        connected: Date.now() - ext.lastPoll < 20000,
        toolCount: Object.keys(LOCAL_BROWSER_TOOLS).length,
        tools: Object.keys(LOCAL_BROWSER_TOOLS),
      },
      clinqyCapabilities: clinqyCapabilities(clinqy.status()),
      extension: { connected: Date.now() - ext.lastPoll < 20000 },
      audit: listAudit(db, 30),
    }];
  },

  /* ---------------------------------------------------------------- browsy */

  async 'GET /api/browsy/tabs'() {
    const disc = await browsy.discover({});
    if (disc.available) {
      try {
        const r = await browsy.listTabs();
        return [200, { ok: r.ok, engine: 'browsy', tabs: (r.parsed && Array.isArray(r.parsed)) ? r.parsed : [], unknownOutcome: Boolean(r.unknownOutcome) }];
      } catch { /* fall back to the built-in extension engine */ }
    }
    try {
      const r = await localBrowser.listTabs();
      return [200, { ok: true, engine: 'extension', tabs: r.parsed || [] }];
    } catch (e) {
      return [502, { error: e.message, tabs: [], engine: 'extension' }];
    }
  },

  async 'POST /api/browsy/call'(req, url, body) {
    const tool = String(body.tool || '');
    const args = body.arguments || body.args || {};
    const disc = await browsy.discover({});
    if (!disc.available) {
      // Built-in engine: same tool names, served by our own extension.
      if (!LOCAL_BROWSER_TOOLS[tool]) return [400, { error: `unknown Browsy tool "${tool}"` }];
      if (body.preview) return [200, localBrowser.preview(tool, args)];
      try {
        const r = await localBrowser.call(tool, args, { confirmed: body.confirmed === true });
        return [200, {
          ok: r.ok, engine: 'extension', isError: !r.ok, unknownOutcome: false,
          text: r.text, images: r.images, parsed: r.parsed, error: null,
          target: r.target, needsApproval: r.needsApproval, needsInspection: r.needsInspection,
        }];
      } catch (e) {
        return [e.unknownOutcome ? 504 : 400, {
          error: e.message, engine: 'extension', unknownOutcome: Boolean(e.unknownOutcome),
          needsInspection: args.tabId != null ? localBrowser.needsInspection(args.tabId) : localBrowser.needsInspection(null),
        }];
      }
    }
    if (!BROWSY_TOOLS[tool]) return [400, { error: `unknown Browsy tool "${tool}"` }];
    if (body.preview) {
      return [200, browsy.preview(tool, args)];
    }
    try {
      const r = await browsy.call(tool, args, { confirmed: body.confirmed === true, timeoutMs: BROWSY_TOOLS[tool].mutating ? 60000 : 45000 });
      return [200, { ok: r.ok, engine: 'browsy', isError: r.isError, unknownOutcome: Boolean(r.unknownOutcome), text: r.text, images: r.images, parsed: r.parsed, error: r.error || null, needsInspection: browsy.needsInspection(args.tabId) }];
    } catch (e) {
      const code = e.unknownOutcome ? 504 : 400;
      return [code, { error: e.message, engine: 'browsy', unknownOutcome: Boolean(e.unknownOutcome), needsInspection: args.tabId != null ? browsy.needsInspection(args.tabId) : browsy.needsInspection(null) }];
    }
  },

  async 'POST /api/browsy/capture'(req, url, body) {
    const tabId = body.tabId != null ? Number(body.tabId) : null;
    if (tabId == null || !Number.isInteger(tabId)) return [400, { error: 'tabId required' }];
    let snap = null;
    let engine = 'browsy';
    // Prefer the external Browsy server; fall back to the built-in extension.
    const disc = await browsy.discover({});
    if (disc.available) {
      try { snap = await browsy.snapshot(tabId); } catch { snap = null; }
    }
    if (!snap || !snap.ok) {
      engine = 'extension';
      try { snap = await localBrowser.snapshot(tabId); } catch (e) { return [502, { error: `could not snapshot the tab: ${e.message}` }]; }
    }
    if (!snap.ok) return [502, { error: 'snapshot failed', detail: snap.text }];
    const meta = engine === 'browsy'
      ? ((snap.parsed && snap.parsed.meta) || {})
      : ((snap.parsed && snap.parsed.meta) || {});
    const snapText = engine === 'browsy'
      ? ((snap.parsed && snap.parsed.snapshot) || snap.text || '')
      : ((snap.parsed && snap.parsed.snapshot) || '') + (snap.parsed?.pageText ? `\n\n${snap.parsed.pageText}` : '');
    const extraction = extractCapture({ snapshotText: snapText, url: meta.url || '', pageTitle: meta.title || '' });
    const cap = addCapture(db, {
      job_id: null, source_url: meta.url || '', title: meta.title || '',
      capture_text: snapText, method: engine === 'extension' ? 'extension-snapshot' : 'browsy-snapshot',
      meta: { tabId, engine, scope: meta.scope || 'main-frame', truncated: Boolean(meta.truncated), url: meta.url || '' },
    });
    return [200, { captureId: cap.id, capturedAt: cap.captured_at, engine, url: meta.url || '', pageTitle: meta.title || '', extraction }];
  },

  async 'POST /api/captures/import'(req, url, body) {
    try {
      const r = importCaptureJob(body);
      return [200, { ...r, job: enrichJob(getJob(db, r.id), loadCriteria()) }];
    } catch (e) { return [400, { error: e.message }]; }
  },

  async 'GET /api/captures'(req, url) {
    const jobId = url.searchParams.get('jobId');
    return [200, { captures: listCaptures(db, jobId ? Number(jobId) : null, 100).map((c) => ({ id: c.id, job_id: c.job_id, source_url: c.source_url, title: c.title, method: c.method, captured_at: c.captured_at, bytes: (c.capture_text || '').length })) }];
  },

  /* ---------------------------------------------------------------- clinqy */

  async 'POST /api/clinqy/look'(req, url, body) {
    try { const r = await clinqy.look(body.mode); return [200, { ok: r.ok, text: r.text, isError: r.isError }]; }
    catch (e) { return [502, { error: e.message }]; }
  },
  async 'GET /api/clinqy/stats'(req, url) {
    const days = url.searchParams.get('days');
    const last = url.searchParams.get('last') === '1';
    try { const r = await clinqy.stats(days != null ? Number(days) : undefined, last); return [200, { ok: r.ok, text: r.text, isError: r.isError }]; }
    catch (e) { return [502, { error: e.message }]; }
  },
  async 'POST /api/clinqy/preview'(req, url, body) {
    const tool = String(body.tool || 'clinqy_run');
    return [200, clinqy.preview(tool, body.arguments || {})];
  },
  async 'POST /api/clinqy/run'(req, url, body) {
    const task = String(body.task || '').trim();
    if (!task) return [400, { error: 'task is required' }];
    if (body.confirmed !== true) return [400, { error: 'explicit confirmation required to run a native task' }];
    try {
      const r = await clinqy.run(task, { dry: body.dry === true, timeoutSec: Number(body.timeout) || 120, confirmed: true });
      return [200, { ok: r.ok, isError: r.isError, text: r.text }];
    } catch (e) { return [e.unknownOutcome ? 504 : 502, { error: e.message }]; }
  },
  async 'POST /api/clinqy/cancel'() {
    return [200, { cancelled: clinqy.cancelCurrent() }];
  },
  async 'POST /api/clinqy/open'(req, url, body) {
    // Fixed native-app handoff only. No arbitrary URLs, no shell.
    const ALLOWED = new Set(['clinqy://open', 'clinqy://watch', 'clinqy://stop-watching', 'clinqy://workflow', 'clinqy://browser', 'clinqy://reload-extension']);
    const target = String(body.target || '');
    if (!ALLOWED.has(target)) return [400, { error: 'target not allowed' }];
    try { execFile('open', [target]); return [200, { opened: target }]; }
    catch (e) { return [502, { error: e.message }]; }
  },

  /* --------------------------------------------------------- local browser */
  /* Browsy's tool surface, served by our own extension (no Browsy install). */

  async 'GET /api/browser/tabs'() {
    try {
      const r = await localBrowser.listTabs();
      return [200, { ok: true, engine: 'extension', tabs: r.parsed || [] }];
    } catch (e) {
      return [502, { error: e.message, tabs: [], engine: 'extension' }];
    }
  },

  async 'POST /api/browser/preview'(req, url, body) {
    const tool = String(body.tool || '');
    if (!LOCAL_BROWSER_TOOLS[tool]) return [400, { error: `unknown browser tool "${tool}"` }];
    return [200, localBrowser.preview(tool, body.arguments || body.args || {})];
  },

  async ['POST /api/browser/call'](req, url, body) {
    const tool = String(body.tool || '');
    const args = body.arguments || body.args || {};
    if (!LOCAL_BROWSER_TOOLS[tool]) return [400, { error: `unknown browser tool "${tool}"` }];
    if (body.preview) return [200, localBrowser.preview(tool, args)];
    try {
      const r = await localBrowser.call(tool, args, { confirmed: body.confirmed === true });
      return [200, {
        ok: r.ok, engine: 'extension', text: r.text, images: r.images, parsed: r.parsed,
        target: r.target, needsApproval: r.needsApproval, needsInspection: r.needsInspection,
      }];
    } catch (e) {
      return [e.unknownOutcome ? 504 : 400, {
        error: e.message, unknownOutcome: Boolean(e.unknownOutcome),
        needsInspection: args.tabId != null ? localBrowser.needsInspection(Number(args.tabId)) : localBrowser.needsInspection(null),
      }];
    }
  },

  async 'GET /api/commands/:id'(req, url) {
    const cmd = getCommand(db, Number(url.pathname.split('/')[3]));
    if (!cmd) return [404, { error: 'command not found' }];
    return [200, {
      id: cmd.id, type: cmd.type, status: cmd.status,
      result: cmd.result?.result ?? null, error: cmd.result?.error ?? null,
      created_at: cmd.created_at, finished_at: cmd.finished_at,
    }];
  },

  /** Enqueue an extension command and wait for its result (bounded). */
  async ['POST /api/ext/run'](req, url, body) {
    const type = String(body.type || '');
    const allowed = new Set(['scan_x', 'scan_reddit', 'fill_current', 'ping']);
    if (!allowed.has(type)) return [400, { error: 'type must be one of scan_x, scan_reddit, fill_current, ping' }];
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 180000, 5000), 600000);
    const cfg = loadConfig();
    let payload = body.payload || {};
    if (type === 'scan_x') {
      payload = {
        queries: payload.queries || cfg.x?.queries || [],
        accounts: payload.accounts || cfg.x?.accounts || [],
        perQuery: payload.perQuery || cfg.x?.perQuery || 60,
        maxScrolls: payload.maxScrolls || cfg.x?.maxScrolls || 3,
      };
    } else if (type === 'scan_reddit') {
      payload = { subs: payload.subs || cfg.reddit?.subs || [] };
    }
    const cmd = enqueue(db, type, payload);
    try {
      const done = await waitForCommand(db, cmd.id, { timeoutMs });
      return [200, { queued: cmd.id, type, status: done.status, result: done.result?.result ?? null, error: done.result?.error ?? null }];
    } catch (e) {
      return [504, { queued: cmd.id, type, error: e.message }];
    }
  },

  /* --------------------------------------------------------------- memories */

  async 'GET /api/memories'(req, url) {
    return [200, { memories: listMemories(db, { q: url.searchParams.get('q') || '', limit: url.searchParams.get('limit') || 50 }) }];
  },
  async ['POST /api/memories'](req, url, body) {
    try { return [201, { memory: addMemory(db, body.text, body.tags || []) }]; }
    catch (e) { return [400, { error: e.message }]; }
  },
  async 'DELETE /api/memories/:id'(req, url) {
    const n = deleteMemory(db, Number(url.pathname.split('/')[3]));
    return [n ? 200 : 404, n ? { deleted: n } : { error: 'memory not found' }];
  },

  /* -------------------------------------------------------------- workflows */

  async 'GET /api/workflows'() { return [200, { workflows: listWorkflows(db) }]; },
  async ['POST /api/workflows'](req, url, body) {
    try { return [200, { workflow: saveWorkflow(db, body.name, body.steps) }]; }
    catch (e) { return [400, { error: e.message }]; }
  },
  async 'DELETE /api/workflows/:id'(req, url) {
    const n = deleteWorkflow(db, Number(url.pathname.split('/')[3]));
    return [n ? 200 : 404, n ? { deleted: n } : { error: 'workflow not found' }];
  },

  /* -------------------------------------------------------------- research */

  async 'GET /api/research/runs'() {
    return [200, { runs: listResearchRuns(db, 60), sites: RESEARCH_SITES }];
  },
  async 'GET /api/research/runs/:id'(req, url) {
    const id = Number(url.pathname.split('/')[3]);
    const run = getResearchRun(db, id);
    if (!run) return [404, { error: 'run not found' }];
    return [200, run];
  },
  async 'POST /api/research/runs'(req, url, body) {
    const plan = planFromBody(body);
    if (!plan.steps.length) return [400, { error: 'no sites selected' }];
    const run = createResearchRun(db, { city: plan.city, role: plan.role, employer: plan.employer, sites: plan.sites, query: plan.query });
    for (const s of plan.steps) addResearchStep(db, run.id, s);
    return [200, getResearchRun(db, run.id)];
  },
  async 'POST /api/research/runs/:id/status'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    const status = String(body.status || '');
    if (!['active', 'paused', 'completed', 'cancelled'].includes(status)) return [400, { error: 'invalid status' }];
    const run = updateResearchRun(db, id, { status });
    if (!run) return [404, { error: 'run not found' }];
    return [200, run];
  },
  async 'POST /api/research/runs/:id/step/:stepId/open'(req, url, body) {
    const parts = url.pathname.split('/');
    const runId = Number(parts[4]);
    const stepId = Number(parts[6]);
    const run = getResearchRun(db, runId);
    if (!run) return [404, { error: 'run not found' }];
    if (run.status === 'cancelled' || run.status === 'completed') return [400, { error: `run is ${run.status} — cannot open new steps` }];
    const step = (run.steps || []).find((s) => s.id === stepId);
    if (!step) return [404, { error: 'step not found' }];
    if (step.status === 'done') return [400, { error: 'step already done' }];
    if (run.status === 'paused') return [400, { error: 'run is paused — resume it first' }];
    try {
      const r = await browsy.openTab(step.url, { confirmed: true });
      const tabId = tabFromResult(r);
      updateResearchStep(db, stepId, { status: 'opened', tab_id: tabId });
      return [200, { ok: r.ok, tabId, url: step.url, step: updateResearchStep(db, stepId, {}) }];
    } catch (e) { return [502, { error: e.message }]; }
  },
  async 'POST /api/research/runs/:id/step/:stepId/result'(req, url, body) {
    const parts = url.pathname.split('/');
    const runId = Number(parts[4]);
    const stepId = Number(parts[6]);
    const run = getResearchRun(db, runId);
    if (!run) return [404, { error: 'run not found' }];
    const step = (run.steps || []).find((s) => s.id === stepId);
    if (!step) return [404, { error: 'step not found' }];
    const status = String(body.status || 'done');
    if (!['pending', 'opened', 'done', 'skipped'].includes(status)) return [400, { error: 'invalid step status' }];
    return [200, updateResearchStep(db, stepId, { status, note: String(body.note || '').slice(0, 2000) })];
  },

  /* ------------------------------------------------------ companies / people */

  async 'GET /api/companies'() { return [200, { rows: listCompanies(db) }]; },
  async 'POST /api/companies'(req, url, body) {
    const name = String(body.name || (body.data && body.data.company) || '').trim();
    if (!name) return [400, { error: 'name required' }];
    return [200, upsertCompany(db, name, body.data || {})];
  },
  async 'POST /api/companies/:id'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    const c = getCompany(db, id);
    if (!c) return [404, { error: 'company not found' }];
    return [200, upsertCompany(db, body.name || c.name, body.data || {})];
  },
  async 'DELETE /api/companies/:id'(req, url) {
    return [200, deleteCompany(db, Number(url.pathname.split('/')[3]))];
  },

  async 'GET /api/contacts'(req, url) {
    return [200, { rows: listContacts(db, { companyId: url.searchParams.get('companyId') ? Number(url.searchParams.get('companyId')) : null, jobId: url.searchParams.get('jobId') ? Number(url.searchParams.get('jobId')) : null }) }];
  },
  async 'POST /api/contacts'(req, url, body) {
    const id = body.id ? Number(body.id) : null;
    if (!id && !String(body.name || '').trim()) return [400, { error: 'name required' }];
    return [200, upsertContact(db, id, body)];
  },
  async 'DELETE /api/contacts/:id'(req, url) {
    return [200, deleteContact(db, Number(url.pathname.split('/')[3]))];
  },

  /* -------------------------------------------------------------- pipeline */

  async 'GET /api/pipeline'() {
    const statuses = PIPELINE_STATUSES;
    const rows = listPipeline(db).map((p) => {
      const job = p.job_id ? getJob(db, p.job_id) : null;
      const company = p.company_id ? getCompany(db, p.company_id) : null;
      const contact = p.contact_id ? getContact(db, p.contact_id) : null;
      return { ...p, job: job ? { id: job.id, title: job.title, company: job.company, source_url: job.source_url, status: job.status, score: job.score } : null, company, contact };
    });
    return [200, { rows, statuses }];
  },
  async 'POST /api/pipeline'(req, url, body) {
    const jobId = body.job_id != null ? Number(body.job_id) : null;
    if (!jobId) return [400, { error: 'job_id required' }];
    const job = getJob(db, jobId);
    if (!job) return [404, { error: 'job not found' }];
    let companyId = body.company_id != null ? Number(body.company_id) : undefined;
    if (companyId === undefined && body.company_name) {
      const c = upsertCompany(db, body.company_name, body.company_data || {});
      companyId = c ? c.id : undefined;
    }
    const patch = {
      status: body.status, next_action: body.next_action, next_action_date: body.next_action_date,
      brief_md: body.brief_md, data: body.data,
    };
    if (companyId !== undefined) patch.company_id = companyId;
    if (body.contact_id !== undefined) patch.contact_id = body.contact_id == null ? null : Number(body.contact_id);
    try {
      const row = upsertPipeline(db, jobId, patch);
      addEvent(db, jobId, 'pipeline', `→ ${row.status}`);
      return [200, row];
    } catch (e) { return [400, { error: e.message }]; }
  },
  async 'DELETE /api/pipeline/:id'(req, url) {
    return [200, deletePipeline(db, Number(url.pathname.split('/')[3]))];
  },

  /* ---------------------------------------------------------------- brief */

  async 'GET /api/jobs/:id/brief'(req, url) {
    const id = Number(url.pathname.split('/')[3]);
    const b = jobBrief(id);
    if (!b) return [404, { error: 'job not found' }];
    const existing = getPipelineForJob(db, id);
    return [200, { markdown: (existing && existing.brief_md) || b.md, generated: b.md, saved: Boolean(existing && existing.brief_md) }];
  },
  async 'POST /api/jobs/:id/brief'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    const job = getJob(db, id);
    if (!job) return [404, { error: 'job not found' }];
    const md = String(body.markdown || '').slice(0, 40000);
    const row = upsertPipeline(db, id, { brief_md: md });
    addEvent(db, id, 'brief', 'application brief saved');
    return [200, row];
  },

  /* ---------------------------------------------------------------- workbook (legacy import) */

  async 'GET /api/workbook'(req, url) {
    return [200, { rows: listWorkbook(db, url.searchParams.get('kind') || null) }];
  },
  async ['POST /api/workbook'](req, url, body) {
    if (!body.kind || !body.key) return [400, { error: 'kind and key required' }];
    const r = upsertWorkbook(db, body.kind, body.key, body.data || {});
    return [200, { ...r, row: getWorkbook(db, r.id) }];
  },
  async ['POST /api/workbook/import'](req, url, body) {
    if (!body.kind || !Array.isArray(body.records)) return [400, { error: 'kind + records[] required' }];
    let added = 0, merged = 0, skipped = 0;
    for (const rec of body.records) {
      if (!rec || !rec.key) { skipped++; continue; }
      const r = upsertWorkbook(db, body.kind, rec.key, rec.data || {});
      if (r.added) added++; else merged++;
    }
    return [200, { added, merged, skipped, total: added + merged }];
  },
  async 'POST /api/workbook/:id'(req, url, body) {
    const id = Number(url.pathname.split('/')[3]);
    const row = getWorkbook(db, id);
    if (!row) return [404, { error: 'record not found' }];
    upsertWorkbook(db, row.kind, row.key, body.data || {});
    return [200, { row: getWorkbook(db, id) }];
  },
  async 'DELETE /api/workbook/:id'(req, url) {
    return [200, deleteWorkbook(db, Number(url.pathname.split('/')[3]))];
  },

  /* ------------------------------------------------------------ extension api */

  async 'GET /ext/poll'(req, url) {
    ext.lastPoll = Date.now();
    const wait = Math.min(Number(url.searchParams.get('wait')) || 20, 25);
    let cmd = claimNext(db);
    if (!cmd) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; off(); clearTimeout(timer); resolve(); };
        const off = onWake(finish);
        const timer = setTimeout(finish, wait * 1000);
        req.on('close', finish);
      });
      cmd = claimNext(db);
    }
    return [200, { command: cmd, now: nowIso() }];
  },

  async 'POST /ext/result'(req, url, body) {
    if (!body.id) return [400, { error: 'id required' }];
    const cmd = getCommand(db, body.id);
    const done = complete(db, body.id, { ok: body.ok !== false, result: body.result ?? null, error: body.error ?? null });
    if (cmd && cmd.type === 'open_and_fill' && body.result) {
      addEvent(db, body.result.jobId ?? null, 'fill_report',
        `filled ${body.result.filled ?? '?'} of ${(body.result.filled ?? 0) + (body.result.missing?.length ?? 0)} fields` +
        (body.result.missing?.length ? ` — missing: ${body.result.missing.slice(0, 4).join(', ')}` : ''));
    }
    if (cmd && (cmd.type === 'scan_x' || cmd.type === 'scan_reddit')) {
      addEvent(db, null, 'ext_scan', `${cmd.type}: ${body.result?.items ?? 0} items, ${body.result?.added ?? 0} new`);
    }
    return [200, done];
  },

  async 'POST /ext/ingest'(req, url, body) {
    const cfg = loadConfig();
    if (!body.source || !Array.isArray(body.items)) return [400, { error: 'source + items[] required' }];
    const res = ingestItems(db, cfg, body.source, body.items, { log: (l) => console.log('[ext]', l) });
    return [200, res];
  },

  async 'POST /ext/submitted'(req, url, body) {
    if (!body.jobId) return [400, { error: 'jobId required' }];
    setStatus(db, Number(body.jobId), 'applied');
    addEvent(db, Number(body.jobId), 'submitted', 'submitted from the review bar');
    return [200, { ok: true }];
  },

  async 'POST /ext/fill_report'(req, url, body) {
    addEvent(db, body.jobId ?? null, 'fill_report', body.summary || '');
    return [200, { ok: true }];
  },

  async 'GET /ext/status'() {
    return [200, { ...extStatus(), stats: stats(db), runs: recentRuns(db, 5) }];
  },

  async 'GET /ext/packet'() {
    return [200, buildPacket(loadConfig())];
  },
};

function tabFromResult(r) {
  try {
    const p = r.parsed;
    if (p && typeof p === 'object') return p.id ?? p.tabId ?? null;
    const arr = JSON.parse(r.text);
    return Array.isArray(arr) ? (arr[0] && arr[0].id) ?? null : (arr && (arr.id ?? arr.tabId)) ?? null;
  } catch { return null; }
}

/* -------------------------------------------------------------- csv endpoints */

function csvResponse(res, filename, content) {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(content),
  });
  res.end(content);
}
function jsonDownload(res, filename, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function exportJobs() {
  const criteria = loadCriteria();
  const rows = decorateList(listJobs(db, { limit: 500 }).rows, criteria);
  return { csv: toCsv(rows.map((j) => flattenJob(j, j.eligibility))), json: rows.map((j) => flattenJob(j, j.eligibility)) };
}
function exportPipeline() {
  const rows = listPipeline(db).map((p) => flattenPipeline(p, { job: p.job_id ? getJob(db, p.job_id) : null, company: p.company_id ? getCompany(db, p.company_id) : null, contact: p.contact_id ? getContact(db, p.contact_id) : null }));
  return { csv: toCsv(rows), json: rows };
}

/* -------------------------------------------------------------------- server */

const port = Number(process.env.JOBPILOT_PORT || loadConfig().port || 8787);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (!hostAllowed(req.headers.host, port)) return json(res, 403, { error: 'host not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (isCrossOriginWebRequest(req)) return json(res, 403, { error: 'cross-origin requests are not allowed' });

    // Serve the shared classifier + criteria modules to the same-origin dashboard.
    if (req.method === 'GET' && (url.pathname === '/eligibility.js' || url.pathname === '/criteria.js')) {
      const f = path.join(__dirname, url.pathname.slice(1));
      if (!fs.existsSync(f)) return text(res, 404, 'not found');
      return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return text(res, 200, fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ----- CSV / JSON exports (raw responses) -----
    if (req.method === 'GET' && url.pathname.startsWith('/api/export/')) {
      const stamp = new Date().toISOString().slice(0, 10);
      if (url.pathname === '/api/export/jobs.csv') { const e = exportJobs(); return csvResponse(res, `jobpilot-jobs-${stamp}.csv`, e.csv); }
      if (url.pathname === '/api/export/jobs.json') { const e = exportJobs(); return jsonDownload(res, `jobpilot-jobs-${stamp}.json`, e.json); }
      if (url.pathname === '/api/export/pipeline.csv') { const e = exportPipeline(); return csvResponse(res, `jobpilot-pipeline-${stamp}.csv`, e.csv); }
      if (url.pathname === '/api/export/pipeline.json') { const e = exportPipeline(); return jsonDownload(res, `jobpilot-pipeline-${stamp}.json`, e.json); }
      if (url.pathname === '/api/export/companies.csv') { return csvResponse(res, `jobpilot-companies-${stamp}.csv`, toCsv(listCompanies(db).map((c) => ({ id: c.id, name: c.name, ...c.data })))); }
      if (url.pathname === '/api/export/contacts.csv') { return csvResponse(res, `jobpilot-contacts-${stamp}.csv`, toCsv(listContacts(db).map((c) => ({ id: c.id, name: c.name, company_id: c.company_id, job_id: c.job_id, ...c.data })))); }
      return json(res, 404, { error: 'unknown export' });
    }

    // ----- per-job markdown brief -----
    let m = url.pathname.match(/^\/api\/jobs\/(\d+)\/brief\.md$/);
    if (m && req.method === 'GET') {
      const b = jobBrief(Number(m[1]));
      if (!b) return json(res, 404, { error: 'job not found' });
      const saved = getPipelineForJob(db, Number(m[1]));
      const md = (saved && saved.brief_md) || b.md;
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="brief-job-${m[1]}.md"` });
      return res.end(md);
    }

    // resume download for the extension
    if (req.method === 'GET' && url.pathname === '/ext/resume') {
      const cfg = loadConfig();
      const rp = (cfg.profile?.resumePath || '').replace(/^~(?=$|\/)/, process.env.HOME || '');
      if (!rp || !fs.existsSync(rp)) return json(res, 404, { error: 'no resume configured — set profile.resumePath in config.json' });
      const buf = fs.readFileSync(rp);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, 'x-filename': path.basename(rp) });
      return res.end(buf);
    }

    const routeKey = Object.keys(handlers).find((h) => {
      const [method, pattern] = h.split(' ');
      if (method !== req.method) return false;
      const rx = new RegExp('^' + pattern.replace(/:[A-Za-z]+/g, '\\d+').replace(/\//g, '\\/') + '$');
      return rx.test(url.pathname);
    });
    if (routeKey) {
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (mutating) {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
        if (hasBody && !ct.includes('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
      }
      let body = {};
      try { body = mutating ? await readBody(req) : {}; }
      catch (e) {
        if (e.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'request body too large' });
        if (e.code === 'BAD_JSON') return json(res, 400, { error: 'invalid JSON body' });
        throw e;
      }
      const [code, payload] = await handlers[routeKey](req, url, body);
      return json(res, code, payload);
    }

    return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (err) {
    console.error('[http]', err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  local job cockpit  →  http://127.0.0.1:${port}\n`);
  console.log(`  dashboard: http://127.0.0.1:${port}`);
  console.log(`  db: ${DB_PATH}`);
  console.log(`  Browsy: ${browsy.resolved() ? 'found' : 'not found'} · Clinqy: ${clinqy.resolved() ? 'found' : 'not found'}\n`);
  try { pruneOld(db, 60); } catch { /* ignore */ }
});

function shutdown() {
  try { browsy.close(); clinqy.close(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
