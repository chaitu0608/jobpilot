import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso, safeParse } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE,
  source TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  company TEXT,
  title TEXT,
  location TEXT,
  remote INTEGER DEFAULT 0,
  salary TEXT,
  tags TEXT DEFAULT '[]',
  description TEXT,
  apply_url TEXT,
  apply_email TEXT,
  author TEXT,
  posted_at TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  notes TEXT,
  seen_sources TEXT DEFAULT '[]',
  extra TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_fp ON jobs(fingerprint);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  kind TEXT,
  detail TEXT,
  at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  started_at TEXT,
  finished_at TEXT,
  found INTEGER,
  added INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS ext_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  result TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Durable workflow: provenance, company targets, contacts, pipeline, research.
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  source_url TEXT,
  title TEXT,
  capture_text TEXT,
  method TEXT,
  meta TEXT DEFAULT '{}',
  captured_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_job ON captures(job_id);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  data TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  company_id INTEGER,
  job_id INTEGER,
  data TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_job ON contacts(job_id);

CREATE TABLE IF NOT EXISTS pipeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER UNIQUE,
  company_id INTEGER,
  contact_id INTEGER,
  status TEXT DEFAULT 'shortlisted',
  next_action TEXT,
  next_action_date TEXT,
  brief_md TEXT,
  data TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_status ON pipeline(status);

CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT, role TEXT, employer TEXT,
  sites TEXT DEFAULT '[]',
  query TEXT DEFAULT '{}',
  status TEXT DEFAULT 'active',
  data TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS research_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  seq INTEGER,
  kind TEXT, label TEXT, url TEXT,
  status TEXT DEFAULT 'pending',
  note TEXT,
  tab_id INTEGER,
  at TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_steps_run ON research_steps(run_id);

CREATE TABLE IF NOT EXISTS adapter_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter TEXT, tool TEXT, outcome TEXT,
  args TEXT DEFAULT '{}', tab_id INTEGER, at TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON adapter_audit(at);

CREATE TABLE IF NOT EXISTS workbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_workbook_kind ON workbook(kind);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_at ON memories(created_at);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  steps TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const JOB_COLUMNS = [
  'fingerprint', 'source', 'source_id', 'source_url', 'company', 'title', 'location',
  'remote', 'salary', 'tags', 'description', 'apply_url', 'apply_email', 'author',
  'posted_at', 'first_seen_at', 'last_seen_at', 'score', 'status', 'notes',
  'seen_sources', 'extra',
];

/** Insert a job, or merge into the existing one (same fingerprint). Returns {id, added}. */
export function upsertJob(db, job) {
  const now = nowIso();
  const row = {
    tags: '[]', seen_sources: '[]', extra: '{}', remote: 0, status: 'new', score: 0,
    ...job,
  };
  const existing = row.fingerprint
    ? db.prepare('SELECT * FROM jobs WHERE fingerprint = ?').get(row.fingerprint)
    : null;

  if (existing) {
    const seen = new Set([...safeParse(existing.seen_sources, []), row.source]);
    const merged = { ...existing };
    // Fresh upstream values win for fields boards/ATSes actually update
    // (salary ranges change, locations change, apply URLs move).
    for (const f of ['company', 'title', 'location', 'salary', 'apply_url', 'apply_email']) {
      if (row[f]) merged[f] = row[f];
    }
    for (const f of ['posted_at', 'author']) {
      if (!merged[f] && row[f]) merged[f] = row[f];
    }
    if (row.description && String(row.description).length > String(merged.description || '').length) {
      merged.description = row.description;
    }
    if (!merged.remote && row.remote) merged.remote = 1;
    merged.score = Math.max(existing.score || 0, row.score || 0);
    merged.tags = JSON.stringify([...new Set([...safeParse(existing.tags, []), ...safeParse(row.tags, [])])].slice(0, 40));
    merged.extra = JSON.stringify({ ...safeParse(existing.extra, {}), ...safeParse(row.extra, {}) });
    merged.seen_sources = JSON.stringify([...seen]);
    merged.last_seen_at = now;

    db.prepare(
      `UPDATE jobs SET company=?, title=?, location=?, remote=?, salary=?, tags=?, description=?,
       apply_url=?, apply_email=?, author=?, posted_at=?, last_seen_at=?, score=?, seen_sources=?, extra=?
       WHERE id=?`
    ).run(
      merged.company ?? null, merged.title ?? null, merged.location ?? null, merged.remote ? 1 : 0,
      merged.salary ?? null, merged.tags, merged.description ?? null, merged.apply_url ?? null,
      merged.apply_email ?? null, merged.author ?? null, merged.posted_at ?? null, merged.last_seen_at,
      merged.score ?? 0, merged.seen_sources, merged.extra, existing.id
    );
    return { id: existing.id, added: false, id_was: existing.id };
  }

  const cols = [...JOB_COLUMNS];
  const values = cols.map((c) => {
    if (c === 'first_seen_at' || c === 'last_seen_at') return row[c] || now;
    if (c === 'remote') return row.remote ? 1 : 0;
    if (c === 'score') return Number(row.score) || 0;
    if (c === 'status') return row.status || 'new';
    if (c === 'tags') return JSON.stringify(safeParse(row.tags, []) );
    if (c === 'seen_sources') return JSON.stringify([...(safeParse(row.seen_sources, [])), row.source]);
    if (c === 'extra') return JSON.stringify(safeParse(row.extra, {}));
    return row[c] ?? null;
  });
  const info = db.prepare(
    `INSERT INTO jobs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...values);
  return { id: Number(info.lastInsertRowid), added: true };
}

export function getJob(db, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  if (!job) return null;
  job.tags = safeParse(job.tags, []);
  job.seen_sources = safeParse(job.seen_sources, []);
  job.extra = safeParse(job.extra, {});
  // Recent timeline for the dashboard detail view (status changes, fills, notes…).
  job.events = db.prepare('SELECT id, kind, detail, at FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 30')
    .all(Number(id));
  return job;
}

export function setStatus(db, id, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(String(status), Number(id));
  addEvent(db, Number(id), 'status', status);
  return getJob(db, id);
}

export function listJobs(db, f = {}) {
  const where = [];
  const args = [];
  if (f.status) {
    const statuses = String(f.status).split(',').map((s) => s.trim()).filter(Boolean);
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (f.source) {
    const sources = String(f.source).split(',').map((s) => s.trim()).filter(Boolean);
    where.push(`source IN (${sources.map(() => '?').join(',')})`);
    args.push(...sources);
  }
  if (f.q) {
    where.push('(title LIKE ? OR company LIKE ? OR description LIKE ?)');
    const like = `%${f.q}%`;
    args.push(like, like, like);
  }
  if (f.minScore) {
    where.push('score >= ?');
    args.push(Number(f.minScore));
  }
  if (f.remote) where.push('remote = 1');
  if (f.sinceDays) {
    where.push('COALESCE(posted_at, first_seen_at) >= ?');
    args.push(new Date(Date.now() - Number(f.sinceDays) * 86400000).toISOString());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sort =
    f.sort === 'new' ? 'first_seen_at DESC, id DESC'
    : f.sort === 'date' ? 'COALESCE(posted_at, first_seen_at) DESC'
    : 'score DESC, COALESCE(posted_at, first_seen_at) DESC';

  const limit = Math.min(Number(f.limit) || 50, 500);
  const offset = Number(f.offset) || 0;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...args).n;
  // applied_at / last_status_at are derived from the events log so the dashboard can show
  // follow-up context without a schema change. Additive columns — existing callers ignore them.
  const rows = db.prepare(
    `SELECT *,
       (SELECT MAX(e.at) FROM events e WHERE e.job_id = jobs.id AND e.kind='status' AND e.detail='applied') AS applied_at,
       (SELECT MAX(e.at) FROM events e WHERE e.job_id = jobs.id AND e.kind='status') AS last_status_at
     FROM jobs ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  return { total, rows: rows.map((r) => ({ ...r, tags: safeParse(r.tags, []), seen_sources: safeParse(r.seen_sources, []) })) };
}

export function addEvent(db, jobId, kind, detail = '') {
  db.prepare('INSERT INTO events (job_id, kind, detail, at) VALUES (?,?,?,?)')
    .run(jobId ?? null, kind, String(detail).slice(0, 500), nowIso());
}

export function recentEvents(db, limit = 20) {
  return db.prepare(
    `SELECT e.*, j.title, j.company, j.source FROM events e
     LEFT JOIN jobs j ON j.id = e.job_id ORDER BY e.id DESC LIMIT ?`
  ).all(Number(limit));
}

export function addRun(db, run) {
  db.prepare('INSERT INTO runs (source, started_at, finished_at, found, added, error) VALUES (?,?,?,?,?,?)')
    .run(run.source, run.started_at, run.finished_at || nowIso(), run.found ?? 0, run.added ?? 0, run.error || null);
}

export function recentRuns(db, limit = 10) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(Number(limit));
}

export function stats(db) {
  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all().map((r) => [r.status, r.n])
  );
  const bySource = Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) AS n FROM jobs GROUP BY source').all().map((r) => [r.source, r.n])
  );
  const total = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const highScore = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE score >= 60 AND status = 'new'").get().n;
  const last24h = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE COALESCE(posted_at, first_seen_at) >= ?`
  ).get(new Date(Date.now() - 86400000).toISOString()).n;
  return { total, byStatus, bySource, highScore, last24h };
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** ---- local workbook records (Roles / Employer Targets / HR & Outreach imports) ---- */

export function listWorkbook(db, kind = null) {
  const rows = kind
    ? db.prepare('SELECT * FROM workbook WHERE kind = ? ORDER BY id').all(String(kind))
    : db.prepare('SELECT * FROM workbook ORDER BY kind, id').all();
  return rows.map((r) => ({ ...r, data: safeParse(r.data, {}) }));
}

export function getWorkbook(db, id) {
  const r = db.prepare('SELECT * FROM workbook WHERE id = ?').get(Number(id));
  return r ? { ...r, data: safeParse(r.data, {}) } : null;
}

/** Insert or merge a record by (kind, key). Import re-runs merge so fields aren't wiped. */
export function upsertWorkbook(db, kind, key, data = {}) {
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM workbook WHERE kind = ? AND key = ?').get(String(kind), String(key));
  if (existing) {
    const merged = { ...safeParse(existing.data, {}), ...(data || {}) };
    db.prepare('UPDATE workbook SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now, existing.id);
    return { id: existing.id, added: false };
  }
  const info = db.prepare('INSERT INTO workbook (kind, key, data, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(String(kind), String(key), JSON.stringify(data ?? {}), now, now);
  return { id: Number(info.lastInsertRowid), added: true };
}

export function deleteWorkbook(db, id) {
  const info = db.prepare('DELETE FROM workbook WHERE id = ?').run(Number(id));
  return { deleted: Number(info.changes || 0) };
}

export function pruneOld(db, days = 60) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  db.prepare("DELETE FROM jobs WHERE status IN ('skipped','archived') AND last_seen_at < ?").run(cutoff);
  db.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
  db.prepare("DELETE FROM ext_commands WHERE created_at < ? AND status != 'pending'").run(cutoff);
  db.prepare('DELETE FROM adapter_audit WHERE at < ?').run(cutoff);
}

/* ------------------------------------------------ durable capture provenance */

export function addCapture(db, cap) {
  const info = db.prepare(
    `INSERT INTO captures (job_id, source_url, title, capture_text, method, meta, captured_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    cap.job_id ?? null, cap.source_url ?? null, cap.title ?? null,
    String(cap.capture_text ?? '').slice(0, 200000), cap.method ?? 'browsy-snapshot',
    JSON.stringify(cap.meta ?? {}), cap.captured_at || nowIso()
  );
  return getCapture(db, Number(info.lastInsertRowid));
}
export function getCapture(db, id) {
  const r = db.prepare('SELECT * FROM captures WHERE id = ?').get(Number(id));
  return r ? { ...r, meta: safeParse(r.meta, {}) } : null;
}
export function listCaptures(db, jobId = null, limit = 100) {
  const rows = jobId
    ? db.prepare('SELECT * FROM captures WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(Number(jobId), Number(limit))
    : db.prepare('SELECT * FROM captures ORDER BY id DESC LIMIT ?').all(Number(limit));
  return rows.map((r) => ({ ...r, meta: safeParse(r.meta, {}) }));
}

/* ------------------------------------------------------- companies / contacts */

export function listCompanies(db) {
  return db.prepare('SELECT * FROM companies ORDER BY name').all().map((r) => ({ ...r, data: safeParse(r.data, {}) }));
}
export function getCompany(db, id) {
  const r = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(id));
  return r ? { ...r, data: safeParse(r.data, {}) } : null;
}
/** Match a company by normalised name; create or merge otherwise. */
export function upsertCompany(db, name, data = {}) {
  const key = String(name || '').trim();
  if (!key) return null;
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM companies WHERE lower(name) = lower(?)').get(key);
  if (existing) {
    const merged = { ...safeParse(existing.data, {}), ...(data || {}) };
    db.prepare('UPDATE companies SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now, existing.id);
    return getCompany(db, existing.id);
  }
  const info = db.prepare('INSERT INTO companies (name, data, created_at, updated_at) VALUES (?,?,?,?)')
    .run(key, JSON.stringify(data || {}), now, now);
  return getCompany(db, Number(info.lastInsertRowid));
}
export function deleteCompany(db, id) {
  db.prepare('UPDATE contacts SET company_id = NULL WHERE company_id = ?').run(Number(id));
  db.prepare('UPDATE pipeline SET company_id = NULL WHERE company_id = ?').run(Number(id));
  const info = db.prepare('DELETE FROM companies WHERE id = ?').run(Number(id));
  return { deleted: Number(info.changes || 0) };
}

export function listContacts(db, { companyId = null, jobId = null } = {}) {
  let sql = 'SELECT * FROM contacts';
  const where = []; const args = [];
  if (companyId != null) { where.push('company_id = ?'); args.push(Number(companyId)); }
  if (jobId != null) { where.push('job_id = ?'); args.push(Number(jobId)); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...args).map((r) => ({ ...r, data: safeParse(r.data, {}) }));
}
export function getContact(db, id) {
  const r = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
  return r ? { ...r, data: safeParse(r.data, {}) } : null;
}
export function upsertContact(db, idOrNull, patch = {}) {
  const now = nowIso();
  if (idOrNull) {
    const existing = getContact(db, idOrNull);
    if (!existing) return null;
    const merged = { ...existing.data, ...(patch.data || {}) };
    db.prepare('UPDATE contacts SET name = ?, company_id = ?, job_id = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name ?? existing.name, patch.company_id !== undefined ? patch.company_id : existing.company_id,
        patch.job_id !== undefined ? patch.job_id : existing.job_id, JSON.stringify(merged), now, existing.id
      );
    return getContact(db, existing.id);
  }
  const info = db.prepare('INSERT INTO contacts (name, company_id, job_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(patch.name ?? null, patch.company_id ?? null, patch.job_id ?? null, JSON.stringify(patch.data || {}), now, now);
  return getContact(db, Number(info.lastInsertRowid));
}
export function deleteContact(db, id) {
  db.prepare('UPDATE pipeline SET contact_id = NULL WHERE contact_id = ?').run(Number(id));
  const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(id));
  return { deleted: Number(info.changes || 0) };
}

/* ----------------------------------------------------------------- pipeline */

const PIPELINE_STATUSES = ['shortlisted', 'reviewing', 'drafting', 'applied', 'interview', 'rejected', 'offer', 'withdrawn', 'archived'];

export function listPipeline(db) {
  return db.prepare('SELECT * FROM pipeline ORDER BY updated_at DESC')
    .all().map((r) => ({ ...r, data: safeParse(r.data, {}) }));
}
export function getPipelineForJob(db, jobId) {
  const r = db.prepare('SELECT * FROM pipeline WHERE job_id = ?').get(Number(jobId));
  return r ? { ...r, data: safeParse(r.data, {}) } : null;
}
export function upsertPipeline(db, jobId, patch = {}) {
  const now = nowIso();
  const existing = getPipelineForJob(db, jobId);
  if (existing) {
    const merged = { ...existing.data, ...(patch.data || {}) };
    const status = patch.status != null ? String(patch.status) : existing.status;
    if (!PIPELINE_STATUSES.includes(status)) throw new Error(`invalid pipeline status "${status}"`);
    db.prepare(
      `UPDATE pipeline SET company_id = ?, contact_id = ?, status = ?, next_action = ?, next_action_date = ?, brief_md = ?, data = ?, updated_at = ? WHERE id = ?`
    ).run(
      patch.company_id !== undefined ? patch.company_id : existing.company_id,
      patch.contact_id !== undefined ? patch.contact_id : existing.contact_id,
      status,
      patch.next_action !== undefined ? patch.next_action : existing.next_action,
      patch.next_action_date !== undefined ? patch.next_action_date : existing.next_action_date,
      patch.brief_md !== undefined ? patch.brief_md : existing.brief_md,
      JSON.stringify(merged), now, existing.id
    );
    return getPipelineForJob(db, jobId);
  }
  const status = patch.status != null ? String(patch.status) : 'shortlisted';
  if (!PIPELINE_STATUSES.includes(status)) throw new Error(`invalid pipeline status "${status}"`);
  const info = db.prepare(
    `INSERT INTO pipeline (job_id, company_id, contact_id, status, next_action, next_action_date, brief_md, data, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Number(jobId), patch.company_id ?? null, patch.contact_id ?? null, status,
    patch.next_action ?? null, patch.next_action_date ?? null, patch.brief_md ?? null,
    JSON.stringify(patch.data || {}), now, now
  );
  void info;
  return getPipelineForJob(db, jobId);
}
export function deletePipeline(db, jobId) {
  const info = db.prepare('DELETE FROM pipeline WHERE job_id = ?').run(Number(jobId));
  return { deleted: Number(info.changes || 0) };
}
export { PIPELINE_STATUSES };

/* ----------------------------------------------------------------- research */

export function createResearchRun(db, run) {
  const now = nowIso();
  const info = db.prepare(
    'INSERT INTO research_runs (city, role, employer, sites, query, status, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    run.city ?? null, run.role ?? null, run.employer ?? null,
    JSON.stringify(run.sites || []), JSON.stringify(run.query || {}),
    run.status || 'active', JSON.stringify(run.data || {}), now, now
  );
  return getResearchRun(db, Number(info.lastInsertRowid));
}
export function getResearchRun(db, id) {
  const r = db.prepare('SELECT * FROM research_runs WHERE id = ?').get(Number(id));
  if (!r) return null;
  return {
    ...r,
    sites: safeParse(r.sites, []), query: safeParse(r.query, {}), data: safeParse(r.data, {}),
    steps: listResearchSteps(db, r.id),
  };
}
export function listResearchRuns(db, limit = 50) {
  return db.prepare('SELECT * FROM research_runs ORDER BY id DESC LIMIT ?').all(Number(limit)).map((r) => ({
    ...r, sites: safeParse(r.sites, []), query: safeParse(r.query, {}), data: safeParse(r.data, {}),
    steps: listResearchSteps(db, r.id),
  }));
}
export function updateResearchRun(db, id, patch = {}) {
  const r = db.prepare('SELECT * FROM research_runs WHERE id = ?').get(Number(id));
  if (!r) return null;
  db.prepare('UPDATE research_runs SET status = ?, data = ?, updated_at = ? WHERE id = ?').run(
    patch.status != null ? String(patch.status) : r.status,
    JSON.stringify({ ...safeParse(r.data, {}), ...(patch.data || {}) }), nowIso(), Number(id)
  );
  return getResearchRun(db, id);
}
export function addResearchStep(db, runId, step) {
  const info = db.prepare(
    'INSERT INTO research_steps (run_id, seq, kind, label, url, status, note, tab_id, at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    Number(runId), Number(step.seq || 0), step.kind || 'query', step.label || null, step.url || null,
    step.status || 'pending', step.note || null, step.tab_id ?? null, nowIso()
  );
  return db.prepare('SELECT * FROM research_steps WHERE id = ?').get(Number(info.lastInsertRowid));
}
export function listResearchSteps(db, runId) {
  return db.prepare('SELECT * FROM research_steps WHERE run_id = ? ORDER BY seq, id').all(Number(runId));
}
export function updateResearchStep(db, id, patch = {}) {
  const r = db.prepare('SELECT * FROM research_steps WHERE id = ?').get(Number(id));
  if (!r) return null;
  db.prepare('UPDATE research_steps SET status = ?, note = ?, tab_id = ?, at = ? WHERE id = ?').run(
    patch.status != null ? String(patch.status) : r.status,
    patch.note !== undefined ? patch.note : r.note,
    patch.tab_id !== undefined ? patch.tab_id : r.tab_id,
    nowIso(), Number(id)
  );
  return db.prepare('SELECT * FROM research_steps WHERE id = ?').get(Number(id));
}

/* ------------------------------------------------------------ adapter audit */

export function addAudit(db, entry) {
  db.prepare('INSERT INTO adapter_audit (adapter, tool, outcome, args, tab_id, at) VALUES (?,?,?,?,?,?)')
    .run(entry.adapter ?? null, entry.tool ?? null, entry.outcome ?? null,
      JSON.stringify(entry.args ?? {}), entry.tabId ?? entry.tab_id ?? null, nowIso());
}
export function listAudit(db, limit = 40) {
  return db.prepare('SELECT * FROM adapter_audit ORDER BY id DESC LIMIT ?').all(Number(limit))
    .map((r) => ({ ...r, args: safeParse(r.args, {}) }));
}

export function getCriteria(db) {
  const v = getMeta(db, 'criteria', null);
  return v ? safeParse(v, null) : null;
}
export function setCriteria(db, criteria) {
  setMeta(db, 'criteria', JSON.stringify(criteria || {}));
  return criteria;
}

/* --------------------------------------------------------------- memories */

export function addMemory(db, text, tags = []) {
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) throw new Error('memory text required');
  const at = nowIso();
  const info = db.prepare('INSERT INTO memories (text, tags, created_at) VALUES (?,?,?)')
    .run(t, JSON.stringify(Array.isArray(tags) ? tags.slice(0, 12).map(String) : []), at);
  return { id: Number(info.lastInsertRowid), text: t, tags, created_at: at };
}

export function listMemories(db, { q = '', limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = q
    ? db.prepare('SELECT * FROM memories WHERE text LIKE ? ORDER BY id DESC LIMIT ?').all(`%${q}%`, n)
    : db.prepare('SELECT * FROM memories ORDER BY id DESC LIMIT ?').all(n);
  return rows.map((r) => ({ ...r, tags: safeParse(r.tags, []) }));
}

export function deleteMemory(db, id) {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(Number(id)).changes;
}

/* -------------------------------------------------------------- workflows */

export function saveWorkflow(db, name, steps) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw new Error('workflow name required');
  if (!Array.isArray(steps) || !steps.length) throw new Error('workflow needs at least one step');
  const at = nowIso();
  const existing = db.prepare('SELECT id FROM workflows WHERE name = ?').get(n);
  if (existing) {
    db.prepare('UPDATE workflows SET steps = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), at, existing.id);
    return getWorkflow(db, existing.id);
  }
  const info = db.prepare('INSERT INTO workflows (name, steps, created_at, updated_at) VALUES (?,?,?,?)')
    .run(n, JSON.stringify(steps), at, at);
  return getWorkflow(db, Number(info.lastInsertRowid));
}

export function getWorkflow(db, key) {
  const row = typeof key === 'number'
    ? db.prepare('SELECT * FROM workflows WHERE id = ?').get(key)
    : db.prepare('SELECT * FROM workflows WHERE name = ?').get(String(key));
  return row ? { ...row, steps: safeParse(row.steps, []) } : null;
}

export function listWorkflows(db) {
  return db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all()
    .map((r) => ({ ...r, steps: safeParse(r.steps, []) }));
}

export function deleteWorkflow(db, key) {
  return typeof key === 'number'
    ? db.prepare('DELETE FROM workflows WHERE id = ?').run(key).changes
    : db.prepare('DELETE FROM workflows WHERE name = ?').run(String(key)).changes;
}
