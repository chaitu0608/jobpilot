import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../server/mcp-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-mcp-test-')), 'test.db');
}

async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/http.js'], {
    cwd: ROOT,
    env: { ...process.env, JOBPILOT_DB: dbPath, JOBPILOT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;
  const api = async (p, opts = {}) => fetch(base + p, { headers: { 'content-type': 'application/json', host }, ...opts });
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await api('/api/state');
      if (r.ok) return { child, api, base, log: () => out };
    } catch { /* retry */ }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${out}`);
}

/** Simulated Chrome extension: polls the command queue and reports results. */
function startFakeExtension(base) {
  let stopped = false;
  const events = [];
  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await fetch(`${base}/ext/poll?wait=1`);
        const { command } = await r.json();
        if (command) {
          events.push({ type: command.type, payload: command.payload });
          const result = fakeResult(command);
          await fetch(`${base}/ext/result`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: command.id, ok: true, result }),
          });
        }
      } catch {
        await sleep(100);
      }
    }
  })();
  return {
    events,
    stop: () => { stopped = true; return loop.catch(() => {}); },
  };
}

function fakeResult(command) {
  const tool = command.type === 'browser' ? command.payload?.tool : command.type;
  const args = command.payload?.args || {};
  switch (tool) {
    case 'browser_list_tabs':
      return { tabs: [
        { id: 1, title: 'Example Form', url: 'https://example.com/apply', active: true, windowId: 1, pinned: false },
        { id: 2, title: 'Other', url: 'https://example.org', active: false, windowId: 1, pinned: false },
      ] };
    case 'browser_snapshot':
      return { snapshot: '[e1] textbox "Email" value="" required\n[e2] button "Submit"', meta: { url: 'https://example.com/apply', title: 'Example Form', refs: 2, truncated: false }, pageText: 'Apply to Acme. Email us.' };
    case 'browser_click':
      return { ok: true, target: { selector: args.selector || '#submit', role: 'button', name: 'Submit', text: 'Submit' }, message: 'clicked button "Submit"' };
    case 'browser_type':
      return { ok: true, target: { selector: args.selector || '#email', role: 'textbox', name: 'Email', text: '' }, message: `typed ${String(args.text || '').length} characters (replaced)` };
    case 'browser_screenshot':
      return { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', width: 1600, height: 900 };
    case 'browser_open_tab':
      return { id: 3, windowId: 1, url: args.url, active: false, status: 'loading' };
    default:
      return { ok: true, message: `${tool} ok` };
  }
}

test('MCP: initialize, tools/list, jobs, browser, memory, workflows', async (t) => {
  const db = tmpDb();
  const port = 9400 + Math.floor(Math.random() * 400);
  const s = await startServer(db, port);
  const ext = startFakeExtension(s.base);
  const client = new McpStdioClient({
    name: 'jobpilot-test',
    command: process.execPath,
    args: [path.join(ROOT, 'server', 'mcp.js')],
    cwd: ROOT,
    env: { JOBPILOT_PORT: String(port), JOBPILOT_DB: db },
    requestTimeoutMs: 30000,
  });
  t.after(async () => {
    client.close();
    await ext.stop();
    s.child.kill('SIGKILL');
  });

  await client.start();
  assert.equal(client.serverInfo?.name, 'jobpilot');

  // --- tool inventory -----------------------------------------------------
  const tools = await client.listTools();
  const names = new Set(tools.map((x) => x.name));
  for (const n of ['jobpilot_status', 'jobpilot_list_jobs', 'jobpilot_apply', 'browser_list_tabs', 'browser_snapshot', 'browser_click', 'clinqy_look', 'clinqy_run', 'memory_remember', 'workflow_record_start']) {
    assert.ok(names.has(n), `missing tool ${n}`);
  }
  assert.ok(tools.length >= 35, `expected a full surface, got ${tools.length}`);
  assert.equal(tools.find((x) => x.name === 'jobpilot_scan').annotations.readOnlyHint, false);
  assert.equal(tools.find((x) => x.name === 'browser_snapshot').annotations.readOnlyHint, true);

  // --- seed + list --------------------------------------------------------
  const seed = { source: 'greenhouse', items: [{
    title: 'Backend Engineer', company: 'Acme', location: 'Pune, India',
    source_url: 'https://boards.greenhouse.io/acme/jobs/1',
    description: 'Build services in Node. 2+ years experience. Remote friendly India.',
    tags: ['full-time'],
  }] };
  let r = await s.api('/ext/ingest', { method: 'POST', body: JSON.stringify(seed) });
  assert.equal(r.status, 200);

  let out = await client.callTool('jobpilot_list_jobs', {});
  assert.equal(out.ok, true);
  assert.match(out.text, /Backend Engineer/);
  assert.match(out.text, /Acme/);
  assert.match(out.text, /#\d+/);

  const id = Number(out.text.match(/#(\d+)/)[1]);
  out = await client.callTool('jobpilot_get_job', { id });
  assert.match(out.text, /Eligibility:/);
  assert.match(out.text, /boards\.greenhouse\.io/);

  // --- status + profile readiness ----------------------------------------
  out = await client.callTool('jobpilot_status', {});
  assert.match(out.text, /Extension: connected/);
  assert.match(out.text, /Auto-submit: off/);

  // --- browser tools ------------------------------------------------------
  out = await client.callTool('browser_list_tabs', {});
  assert.equal(out.ok, true);
  assert.match(out.text, /Example Form/);

  out = await client.callTool('browser_snapshot', { tabId: 1 });
  assert.match(out.text, /\[e1\] textbox "Email"/);
  assert.match(out.text, /Example Form/);

  // mutation gate
  out = await client.callTool('browser_click', { tabId: 1, ref: 'e2' });
  assert.equal(out.ok, false);
  assert.match(out.text, /confirmation required/i);

  out = await client.callTool('browser_click', { tabId: 1, ref: 'e2', confirmed: true });
  assert.equal(out.ok, true);
  assert.match(out.text, /clicked button "Submit"/);

  out = await client.callTool('browser_type', { tabId: 1, ref: 'e1', text: 'a@example.com', confirmed: true });
  assert.equal(out.ok, true);
  assert.match(out.text, /typed 13 characters/);

  out = await client.callTool('browser_screenshot', { tabId: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mimeType, 'image/png');

  // --- memory -------------------------------------------------------------
  out = await client.callTool('memory_remember', { text: 'Prefers remote-only roles; no on-call.', tags: ['preference'] });
  assert.equal(out.ok, true);
  const memId = Number(out.text.match(/#(\d+)/)[1]);
  out = await client.callTool('memory_recall', { query: 'remote-only' });
  assert.match(out.text, /no on-call/);
  out = await client.callTool('memory_forget', { id: memId });
  assert.equal(out.ok, true);

  // --- watch & learn workflow --------------------------------------------
  out = await client.callTool('workflow_record_start', { name: 'apply-demo' });
  assert.equal(out.ok, true);
  await client.callTool('browser_click', { tabId: 1, ref: 'e2', confirmed: true });
  await client.callTool('browser_type', { tabId: 1, ref: 'e1', text: 'a@example.com', confirmed: true });
  await client.callTool('browser_wait', { tabId: 1, milliseconds: 10 });
  out = await client.callTool('workflow_record_stop', {});
  assert.equal(out.ok, true);
  assert.match(out.text, /3 step/);

  out = await client.callTool('workflow_list', {});
  assert.match(out.text, /apply-demo/);

  out = await client.callTool('workflow_run', { name: 'apply-demo', dryRun: true });
  assert.match(out.text, /browser_click/);
  assert.match(out.text, /#submit/);

  const before = ext.events.length;
  out = await client.callTool('workflow_run', { name: 'apply-demo' });
  assert.equal(out.ok, false, 'workflow_run must require confirmation');
  out = await client.callTool('workflow_run', { name: 'apply-demo', confirmed: true });
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /Replayed "apply-demo"/);
  const replayEvents = ext.events.slice(before).filter((e) => e.type === 'browser');
  assert.ok(replayEvents.some((e) => e.payload.tool === 'browser_click' && e.payload.args.selector === '#submit'));
  assert.ok(replayEvents.every((e) => e.payload.args.ref == null), 'replay uses selectors, not ephemeral refs');

  out = await client.callTool('workflow_delete', { name: 'apply-demo' });
  assert.equal(out.ok, true);
});
