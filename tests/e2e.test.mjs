import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../server/mcp-client.js';
import { validateArgs, BROWSY_TOOLS, CLINQY_TOOLS } from '../server/adapters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-test-'));
  return path.join(dir, 'test.db');
}

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['server/http.js'], {
    cwd: ROOT,
    env: { ...process.env, JOBPILOT_DB: dbPath, JOBPILOT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  const api = async (p, opts = {}) => {
    const r = await fetch(base + p, { headers: { 'content-type': 'application/json', host }, ...opts });
    return r;
  };
  for (let i = 0; i < 60; i++) {
    try { const r = await api('/api/state'); if (r.ok) return { child, api, base, host, log: () => out }; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start: ' + out);
}

test('end-to-end: capture import → company/contact link → brief → pipeline → export', async (t) => {
  const db = tmpDb();
  const port = 8900 + Math.floor(Math.random() * 400);
  const s = await startServer(db, port);
  t.after(() => s.child.kill('SIGKILL'));

  // 1. seed a real-shaped posting through the extension ingest path (no live data)
  const seed = { source: 'greenhouse', items: [{
    title: 'Backend Engineer', company: 'Acme', location: 'Pune, India',
    source_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'Build services. 2+ years.',
    tags: ['full-time'],
  }] };
  let r = await s.api('/ext/ingest', { method: 'POST', body: JSON.stringify(seed) });
  assert.equal(r.status, 200);
  const listed = await (await s.api('/api/jobs')).json();
  assert.ok(listed.rows.length >= 1);
  const job = listed.rows[0];
  assert.ok(job.eligibility, 'jobs carry eligibility');
  assert.ok(['suitable', 'review'].includes(job.eligibility.bucket));

  // 2. capture import (reviewed fields only) — no guessing
  r = await s.api('/api/captures/import', { method: 'POST', body: JSON.stringify({ fields: {
    title: 'SWE Intern', company: 'Beta Corp', location: 'Mumbai', pay: '₹50,000/month',
    type: 'Internship', requirements: 'React, Node', description: 'Summer internship', remote: false,
  }, source_url: 'https://beta.example/careers/1' }) });
  assert.equal(r.status, 200);
  const imp = await r.json();
  assert.equal(imp.job.title, 'SWE Intern');
  assert.equal(imp.job.company, 'Beta Corp');
  assert.equal(imp.job.location, 'Mumbai');

  // 3. create company + contact, link them to the imported job via pipeline
  r = await s.api('/api/companies', { method: 'POST', body: JSON.stringify({ name: 'Beta Corp', data: { grade: 'A', cities: 'Mumbai' } }) });
  const company = await r.json();
  assert.ok(company.id);
  r = await s.api('/api/contacts', { method: 'POST', body: JSON.stringify({ name: 'Asha R', company_id: company.id, job_id: imp.job.id, data: { email: 'asha@example.com', link: 'https://linkedin.com/in/asha', verification: 'public profile' } }) });
  const contact = await r.json();
  assert.ok(contact.id);

  r = await s.api('/api/pipeline', { method: 'POST', body: JSON.stringify({ job_id: imp.job.id, company_id: company.id, contact_id: contact.id, status: 'drafting', next_action: 'Send intro', next_action_date: '2026-11-01' }) });
  assert.equal(r.status, 200);
  const pipe = await r.json();
  assert.equal(pipe.status, 'drafting');
  assert.equal(pipe.company_id, company.id);
  assert.equal(pipe.contact_id, contact.id);

  // 4. factual brief, editable + saved
  r = await s.api(`/api/jobs/${imp.job.id}/brief`);
  const brief = await r.json();
  assert.match(brief.generated, /Application brief/);
  assert.match(brief.generated, /Beta Corp/);
  r = await s.api(`/api/jobs/${imp.job.id}/brief`, { method: 'POST', body: JSON.stringify({ markdown: '# edited brief' }) });
  assert.equal(r.status, 200);

  // 5. exports — CSV is present and formula-safe
  r = await s.api('/api/export/jobs.csv');
  assert.equal(r.status, 200);
  const csv = await r.text();
  assert.match(csv, /eligibility/);
  assert.match(csv, /SWE Intern/);

  // 6. pipeline export joins the links
  r = await s.api('/api/export/pipeline.json');
  const pj = await r.json();
  assert.ok(pj.some((p) => p.job_id === imp.job.id && p.contact === 'Asha R' && p.company === 'Beta Corp'));

  // 7. per-job markdown download
  r = await s.api(`/api/jobs/${imp.job.id}/brief.md`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /edited brief/);
});

test('CSV export escapes spreadsheet formula injection', async (t) => {
  const db = tmpDb();
  const port = 9300 + Math.floor(Math.random() * 400);
  const s = await startServer(db, port);
  t.after(() => s.child.kill('SIGKILL'));
  const evil = '=HYPERLINK("http://evil","x")';
  await s.api('/ext/ingest', { method: 'POST', body: JSON.stringify({ source: 'hn', items: [{ title: evil, company: '+cmd', location: 'Pune', description: '@x' }] }) });
  const csv = await (await s.api('/api/export/jobs.csv')).text();
  const lines = csv.split('\n');
  const bad = lines.slice(1).join('\n');
  // The dangerous leading characters must be neutralised with a leading quote.
  assert.ok(!/(^|,)"?=HYPERLINK/.test(bad), 'title formula not neutralised: ' + bad.slice(0, 200));
  assert.ok(bad.includes("'=HYPERLINK") || bad.includes('"\'=HYPERLINK'), 'expected leading-quote escape');
});

test('mutations reject a non-JSON content type and oversized bodies', async (t) => {
  const db = tmpDb();
  const port = 9700 + Math.floor(Math.random() * 200);
  const s = await startServer(db, port);
  t.after(() => s.child.kill('SIGKILL'));
  const r = await fetch(`${s.base}/api/criteria`, { method: 'POST', headers: { 'content-type': 'text/plain', host: s.host }, body: 'nope' });
  assert.equal(r.status, 415);
  const big = await fetch(`${s.base}/api/captures/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: s.host },
    body: JSON.stringify({ fields: { title: 'x'.repeat(3 * 1024 * 1024) } }),
  });
  assert.equal(big.status, 413);
});

test('cross-origin web requests are rejected', async (t) => {
  const db = tmpDb();
  const port = 9850 + Math.floor(Math.random() * 100);
  const s = await startServer(db, port);
  t.after(() => s.child.kill('SIGKILL'));
  const status = (headers) => new Promise((resolve, reject) => {
    // fetch() strips the forbidden Origin header, so use raw http.
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject); req.end();
    });
  });
  assert.equal(await status({ origin: 'https://evil.example', host: s.host }), 403);
  assert.equal(await status({ host: 'evil.example' }), 403);
  assert.equal(await status({ host: s.host }), 200);
});

test('Browsy argument validation matches the real schema', () => {
  assert.equal(validateArgs(BROWSY_TOOLS.browser_navigate, { tabId: 1, url: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_navigate, { tabId: 1, url: 'https://example.com' }).ok, true);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_click, { tabId: 1, ref: 'e1', x: 5, y: 5 }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_click, { tabId: 1, ref: 'e1' }).ok, true);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_click, { tabId: 1, x: 5 }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_scroll, { tabId: 1, direction: 'sideways' }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_scroll, { tabId: 1, direction: 'down', amount: 999999 }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_type, { tabId: 1, text: 'x'.repeat(100001) }).ok, false);
  assert.equal(validateArgs(BROWSY_TOOLS.browser_list_tabs, { bogus: 1 }).ok, false);
  assert.equal(validateArgs(CLINQY_TOOLS.clinqy_run, { task: 'hello' }).ok, true);
  assert.equal(validateArgs(CLINQY_TOOLS.clinqy_run, { dry: true }).ok, false, 'task is required');
  assert.equal(validateArgs(CLINQY_TOOLS.clinqy_look, { mode: 'telepathy' }).ok, false);
});

test('unknown tool names are rejected by preview', async () => {
  const { BrowsyAdapter, ClinqyAdapter } = await import('../server/adapters.js');
  const b = new BrowsyAdapter({});
  assert.equal(b.preview('browser_launch_missiles', {}).ok, false);
  const c = new ClinqyAdapter({});
  assert.equal(c.preview('clinqy_destroy', {}).ok, false);
});

test('MCP client: protocol timeout is reported as an unknown outcome', async () => {
  const client = new McpStdioClient({
    name: 'slow-fixture',
    command: process.execPath,
    args: [path.join(FIX, 'slow-mcp.mjs')],
    requestTimeoutMs: 400,
  });
  try {
    await assert.rejects(
      () => client.callTool('browser_list_tabs', {}, { timeoutMs: 400 }),
      (e) => e.unknownOutcome === true && /timed out/i.test(e.message)
    );
  } finally {
    client.close();
  }
});

test('MCP client: a server that exits mid-request fails the pending call and never replays it', async () => {
  const client = new McpStdioClient({
    name: 'crash-fixture',
    command: process.execPath,
    args: [path.join(FIX, 'crash-mcp.mjs')],
    requestTimeoutMs: 3000,
  });
  await assert.rejects(() => client.callTool('browser_list_tabs', {}), (e) => e.unknownOutcome === true);
  assert.equal(client.alive, false);
  client.close();
});

test('MCP client: spawn failure surfaces as a clean error', async () => {
  const client = new McpStdioClient({ name: 'missing', command: '/definitely/not/here', args: [], requestTimeoutMs: 500 });
  await assert.rejects(() => client.start());
  client.close();
});
