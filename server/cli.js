#!/usr/bin/env node
import readline from 'node:readline/promises';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG, CONFIG_PATH, ROOT_DIR, buildPacket } from './config.js';
import { humanizeToken, truncate } from './util.js';

const PORT = () => Number(process.env.JOBPILOT_PORT || loadConfig().port || 8787);
const BASE = () => `http://127.0.0.1:${PORT()}`;

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'),
  yellow: paint('33'), blue: paint('34'), cyan: paint('36'), mag: paint('35'),
};
const scorePaint = (s) => (s >= 80 ? C.green : s >= 60 ? C.cyan : s >= 40 ? C.yellow : C.dim)(String(s));

async function apiFetch(pathname, opts = {}, timeoutMs = 25000) {
  const res = await fetch(BASE() + pathname, {
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function ensureServer({ quiet = false } = {}) {
  try {
    await apiFetch('/api/state', {}, 1500);
    return false;
  } catch {
    /* not running */
  }
  const child = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', path.join(ROOT_DIR, 'server', 'http.js')],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    try {
      await apiFetch('/api/state', {}, 700);
      if (!quiet) console.log(C.dim(`  (started local server → ${BASE()})`));
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('Could not start the local server. Run "node server/http.js" manually to see the error.');
}

function pad(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
}

const ago = (iso) => {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (!isFinite(d)) return '—';
  if (d < 1 / 24) return Math.max(1, Math.round(d * 1440)) + 'm';
  if (d < 1) return Math.round(d * 24) + 'h';
  if (d < 60) return Math.round(d) + 'd';
  return 'old';
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------- commands

async function cmdSetup() {
  const cfg = loadConfig();
  const existing = fs.existsSync(CONFIG_PATH);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n${C.bold('Clinqy × Browsy setup')} ${C.dim(existing ? '(editing ' + CONFIG_PATH + ')' : '(creating ' + CONFIG_PATH + ')')}\n`);
  console.log(C.dim('Enter = keep the value shown in [brackets].\n'));

  const ask = async (label, current) => {
    const a = (await rl.question(`${label}${current ? C.dim(` [${current}]`) : ''}: `)).trim();
    return a || current || '';
  };

  const p = cfg.profile;
  p.firstName = await ask('First name', p.firstName);
  p.lastName = await ask('Last name', p.lastName);
  p.email = await ask('Email', p.email);
  p.phone = await ask('Phone', p.phone);
  p.location = await ask('Location', p.location || 'Bengaluru, India');
  p.linkedin = await ask('LinkedIn URL', p.linkedin);
  p.github = await ask('GitHub URL', p.github);
  p.portfolio = await ask('Portfolio / website (optional)', p.portfolio);
  p.twitter = await ask('X/Twitter URL (optional)', p.twitter);
  p.resumePath = await ask('Resume file path (pdf; ~ is fine)', p.resumePath);
  p.currentTitle = await ask('Current title', p.currentTitle || 'Software Engineer');
  p.yearsExperience = await ask('Years of experience', p.yearsExperience);
  p.noticePeriod = await ask('Notice period', p.noticePeriod || '30 days');
  p.expectedSalary = await ask('Expected salary/CTC (optional)', p.expectedSalary);

  rl.close();

  if (p.resumePath) {
    const rp = p.resumePath.replace(/^~(?=$|\/)/, process.env.HOME || '');
    if (!fs.existsSync(rp)) console.log(C.yellow(`⚠️  resume not found at ${rp} — fix it in config.json`));
  }
  saveConfig(cfg);
  console.log(`\n${C.green('✓')} saved ${CONFIG_PATH}`);
  console.log(`
next steps
  ${C.bold('1.')} start the server + dashboard:   ${C.cyan('node server/cli.js serve')}
  ${C.bold('2.')} load the extension once:         chrome://extensions → Developer mode → "Load unpacked" → pick
                                    ${C.cyan(path.join(ROOT_DIR, 'extension'))}
  ${C.bold('3.')} log into X & Reddit in Chrome (the extension uses your real session)
  ${C.bold('4.')} first scan:                      ${C.cyan('node server/cli.js scan')}  and  ${C.cyan('node server/cli.js scan-x')}
  ${C.bold('5.')} see what came in:                ${C.cyan('node server/cli.js list')}
`);
}

async function cmdServe() {
  await import('./http.js');
}

async function cmdScan(flags) {
  await ensureServer();
  const sources = flags.sources ? String(flags.sources).split(',') : ['boards', 'hn', 'reddit'];
  console.log(`scanning ${C.bold(sources.join(', '))}… (this can take ~30–90s)`);
  const r = await apiFetch('/api/scan', { method: 'POST', body: JSON.stringify({ sources, await: true }) }, 300000);
  console.log('');
  for (const [k, v] of Object.entries(r.bySource || {})) {
    console.log(`  ${pad(k, 12)} found ${pad(v.found, 6)} new ${pad(v.added, 5)} merged ${pad(v.merged, 5)} filtered ${v.skipped}`);
  }
  console.log(`\n${C.green('✓')} ${r.added} new · ${r.merged} merged from other sources · ${r.skipped} filtered out`);
  if (r.errors?.length) console.log(C.yellow('warnings: ' + r.errors.slice(0, 3).join(' | ')));
}

async function cmdExtScan(target, flags) {
  await ensureServer();
  const st = await apiFetch('/ext/status');
  if (!st.connected) {
    console.log(C.yellow('⚠️  the Chrome extension is not connected.'));
    console.log(C.dim('   Load it: chrome://extensions → Developer mode → Load unpacked → ') + path.join(ROOT_DIR, 'extension'));
    console.log(C.dim('   Then keep Chrome open and this server running.'));
    process.exitCode = 1;
    return;
  }
  const body = { target };
  if (flags.queries) body.queries = String(flags.queries).split('|');
  if (flags.subs) body.subs = String(flags.subs).split(',');
  const r = await apiFetch('/api/ext/scan', { method: 'POST', body: JSON.stringify(body) });
  console.log(`${C.green('✓')} queued ${target} scan (#${r.queued}). Chrome will open tabs and scroll them.`);
  console.log(C.dim('   watch progress in the dashboard: ' + BASE()));
}

async function cmdList(flags) {
  await ensureServer();
  const q = new URLSearchParams();
  if (flags.status) q.set('status', flags.status);
  if (flags.source) q.set('source', flags.source);
  if (flags.q) q.set('q', flags.q);
  q.set('minScore', flags['min-score'] ?? '0');
  q.set('sort', flags.sort || 'score');
  q.set('limit', flags.limit || '25');
  if (flags.remote) q.set('remote', '1');
  if (flags.since) q.set('sinceDays', flags.since);
  const d = await apiFetch('/api/jobs?' + q.toString());
  if (flags.json) return console.log(JSON.stringify(d, null, 2));

  console.log(`\n${d.total} jobs match ${C.dim('(showing ' + d.rows.length + ')')}\n`);
  console.log(C.dim(pad('ID', 6) + pad('SC', 4) + pad('TITLE', 52) + pad('COMPANY', 20) + pad('LOCATION', 18) + pad('SOURCE', 12) + pad('AGE', 5) + 'STATUS'));
  for (const j of d.rows) {
    console.log(
      pad(j.id, 6) +
      pad(scorePaint(j.score), 4 + (TTY ? 9 : 0)) +
      pad(truncate(j.title, 50), 52) +
      pad(truncate(j.company || j.author || '—', 18), 20) +
      pad(truncate(j.location || (j.remote ? 'remote' : '—'), 16), 18) +
      pad(j.source, 12) +
      pad(ago(j.posted_at), 5) +
      j.status
    );
  }
  console.log(C.dim('\n  Clinqy × Browsy show <id> · save/skip/applied <id> · apply <id> · digest\n'));
}

async function cmdShow(id) {
  await ensureServer();
  const j = await apiFetch('/api/jobs/' + id);
  console.log(`\n${C.bold(j.title)}  ${C.dim('#' + j.id)}`);
  const why = j.extra?.why || [];
  console.log(`  ${scorePaint(j.score)} ${C.dim('score')}  ${C.dim(why.join(' · '))}`);
  console.log(`  company   ${j.company || j.author || '—'}`);
  console.log(`  location  ${j.location || '—'}${j.remote ? C.dim(' · remote') : ''}`);
  console.log(`  salary    ${j.salary || '—'}`);
  console.log(`  source    ${j.source} · ${ago(j.posted_at)} ago · status ${j.status}`);
  console.log(`  posting   ${j.source_url}`);
  console.log(`  apply     ${j.apply_url || '—'}`);
  if (j.apply_email) console.log(`  email     ${j.apply_email}`);
  if (j.notes) console.log(`  notes     ${j.notes}`);
  console.log(`\n${C.dim('── description ────────────────')}\n`);
  console.log(truncate(j.description || '(none)', 3000));
  console.log('');
}

async function cmdSetStatus(id, status) {
  await ensureServer();
  await apiFetch(`/api/jobs/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  console.log(`${C.green('✓')} job #${id} → ${status}`);
}

async function cmdApply(id, flags) {
  await ensureServer();
  const st = await apiFetch('/ext/status');
  const j = await apiFetch('/api/jobs/' + id);
  const packet = await apiFetch('/api/jobs/' + id + '/packet');
  const url = j.apply_url || j.source_url;

  if (flags.packet || !st.connected) {
    if (!st.connected) console.log(C.yellow('⚠️  extension offline — copy-paste mode. Load it: chrome://extensions → Load unpacked → ') + path.join(ROOT_DIR, 'extension'));
    console.log(`\n${C.bold('application packet')} ${C.dim('for ' + j.title)}\n`);
    for (const [k, v] of Object.entries(packet.profile)) {
      if (k === 'resumePath') continue;
      console.log(`  ${pad(k, 16)} ${v}`);
    }
    if (packet.resume) console.log(`  ${pad('resume', 16)} ${packet.resume.name}${packet.resume.missing ? C.red(' (file missing!)') : ''}`);
    console.log(`\n  apply at  ${url}`);
    try {
      execFile('open', [url]);
      console.log(C.dim('  (opened in your browser)'));
    } catch { /* ignore */ }
    return;
  }

  if (flags['no-profile'] !== true && (!packet.profile.firstName || !packet.profile.email)) {
    console.log(C.yellow('⚠️  profile is empty — run "node server/cli.js setup" first, then try again.'));
    return;
  }
  const r = await apiFetch('/api/apply/' + id, { method: 'POST' });
  console.log(`${C.green('✓')} queued autofill (#${r.queued}) for ${C.bold(j.title)}`);
  console.log(C.dim('  a Chrome tab is opening with the form pre-filled — review the fields, then hit "Submit application" in the green bar.'));
  console.log(C.dim('  the job is marked applied only when you submit.'));
}

async function cmdDigest(flags) {
  await ensureServer();
  const d = await apiFetch('/api/digest');
  const md = d.markdown;
  const file = path.join(ROOT_DIR, `digest-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, md + '\n');
  console.log(md);
  console.log(C.dim(`\n(saved to ${file})`));
  if (flags.open) execFile('open', [file]);
}

async function cmdRescore() {
  await ensureServer();
  const r = await apiFetch('/api/rescore', { method: 'POST' }, 120000);
  console.log(`${C.green('✓')} rescored ${r.rescored} jobs with the current targets in config.json`);
}

async function cmdStats() {  await ensureServer();
  const s = await apiFetch('/api/state');
  console.log(`\n${C.bold('Clinqy × Browsy stats')}\n`);
  console.log(`  total jobs      ${s.stats.total}`);
  console.log(`  new             ${s.stats.byStatus.new || 0}  ${C.dim('(hot ≥60: ' + s.stats.highScore + ')')}`);
  console.log(`  saved           ${s.stats.byStatus.saved || 0}`);
  console.log(`  applied         ${s.stats.byStatus.applied || 0}`);
  console.log(`  skipped         ${s.stats.byStatus.skipped || 0}`);
  console.log(`  last 24h        ${s.stats.last24h}`);
  console.log(`  by source       ${Object.entries(s.stats.bySource).map(([k, v]) => k + ':' + v).join('  ') || '—'}`);
  console.log(`  extension       ${s.ext.connected ? C.green('connected') : C.red('offline')} ${C.dim('(last poll ' + (s.ext.lastPoll ? ago(s.ext.lastPoll) : 'never') + ')')}`);
  console.log(`\n  recent scans:`);
  for (const r of s.runs.slice(0, 6)) {
    console.log(`    ${pad(r.source, 12)} found ${pad(r.found, 6)} new ${pad(r.added, 5)} ${C.dim(ago(r.finished_at) + ' ago')}${r.error ? C.yellow('  ' + r.error) : ''}`);
  }
  console.log('');
}

async function cmdOpen(id) {
  await ensureServer();
  const j = await apiFetch('/api/jobs/' + id);
  execFile('open', [j.apply_url || j.source_url]);
  console.log(`${C.green('✓')} opened ${j.apply_url || j.source_url}`);
}

const capState = (available, connected) => (connected ? C.green('connected') : available ? C.yellow('available') : C.red('disconnected'));

async function cmdConnections(flags) {
  await ensureServer();
  const d = await apiFetch('/api/connections' + (flags.refresh ? '?refresh=1' : ''), {}, 60000);
  console.log(`\n${C.bold('local tool connections')}\n`);
  const lb = d.localBrowser || {};
  console.log(`  ${pad('browser', 10)} ${lb.connected ? C.green('connected') : C.dim(lb.available ? 'available (extension offline)' : 'unavailable')}  ${C.dim(`${lb.toolCount || 0} tools · built-in engine`)}`);
  for (const key of ['browsy', 'clinqy']) {
    const a = d[key] || {};
    console.log(`  ${pad(a.label || key, 10)} ${capState(a.available, a.connected)}  ${C.dim(`${a.toolCount || 0} tools`)}${a.serverInfo?.version ? C.dim('  v' + a.serverInfo.version) : ''}`);
    if (!a.available && a.error) console.log(`    ${C.dim(a.error)}`);
    if (a.tools?.length) console.log(`    ${C.dim(a.tools.join(', '))}`);
  }
  console.log(`  ${pad('extension', 10)} ${d.extension?.connected ? C.green('connected') : C.dim('offline')}`);
  if (d.clinqyCapabilities?.length) {
    console.log(`\n${C.bold('clinqy capabilities')}\n`);
    for (const c of d.clinqyCapabilities) {
      console.log(`  ${pad(c.label || c.id, 24)} ${c.state === 'native' ? C.green('native app') : c.state === 'available' ? C.yellow('available') : C.dim('disconnected')}`);
    }
  }
  if (d.audit?.length) {
    console.log(`\n${C.bold('recent adapter calls')} ${C.dim('(credentials never logged)')}`);
    for (const e of d.audit.slice(0, 8)) console.log(`  ${pad(e.tool || e.action || '—', 26)} ${C.dim(ago(e.at || e.created_at))} ${e.outcome === 'error' || e.outcome === 'unknown' ? C.red(e.outcome) : ''}`);
  }
  console.log(`\n  ${C.dim('MCP:')} node server/cli.js mcp ${C.dim('— run or register the stdio server')}\n`);
}

async function cmdMcp(flags) {
  const mcpPath = path.join(ROOT_DIR, 'server', 'mcp.js');
  if (flags.stdio) {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', mcpPath], { stdio: 'inherit', env: process.env });
    return await new Promise((resolve) => {
      child.on('exit', (code) => { process.exitCode = code ?? 0; resolve(); });
      child.on('error', (err) => { throw err; });
    });
  }

  console.log(`
${C.bold('Job Pilot MCP')} ${C.dim('— one stdio server for jobs + browser + Clinqy + memory + workflows')}

  ${C.bold('Run directly')}   node server/mcp.js
  ${C.bold('Via the CLI')}    node server/cli.js mcp --stdio

  ${C.bold('Register with OpenCode')} ${C.dim('(global)')}
    opencode mcp add --global jobpilot -- ${process.execPath} ${mcpPath}

  ${C.bold('Any MCP client')} ${C.dim('(~/.config/opencode/opencode.json style)')}
    {
      "mcp": {
        "servers": {
          "jobpilot": {
            "type": "local",
            "command": ["${process.execPath}", "${mcpPath}"],
            "enabled": true
          }
        }
      }
    }

  ${C.bold('Tool surface')}
    jobpilot_*   status, scan, list/get, digest, apply packet, fill, capture, research, brief
    browser_*    17 Browsy-parity tools served by the Job Pilot Chrome extension
    clinqy_*     look, stats, run (confirmed), native handoff
    memory_*     remember / recall / forget local facts
    workflow_*   record and replay browser workflows

  ${C.bold('Safety')} mutations require confirmed=true · submit-like clicks require approved=true
           applications are pre-filled and never submitted
`);

  try {
    await ensureServer({ quiet: true });
    const d = await apiFetch('/api/connections');
    const lb = d.localBrowser || {};
    const ex = d.extension || {};
    console.log(`  ${C.green('server')}  http://127.0.0.1:${PORT()} · browser engine ${lb.connected ? C.green('connected') : C.yellow('offline (load extension/)')}` +
      ` · external Browsy ${d.browsy?.available ? C.green('available') : C.dim('not installed')}` +
      ` · Clinqy ${d.clinqy?.available ? C.green('available') : C.dim('not found')}` +
      ` · extension ${ex.connected ? C.green('connected') : C.dim('offline')}\n`);
  } catch (e) {
    console.log(`  ${C.dim('(local server not running yet — it will auto-start on first MCP tool call; ' + e.message + ')')}\n`);
  }
}

async function cmdTabs() {
  await ensureServer();
  const d = await apiFetch('/api/browsy/tabs', {}, 60000);
  if (!d.tabs?.length) { console.log(C.dim('\n  no browser tabs found — load extension/ in Chrome and keep Chrome open\n')); return; }
  console.log(`\n${C.bold(d.tabs.length + ' open tab(s)')} ${C.dim('via ' + (d.engine === 'browsy' ? 'Browsy' : 'the built-in browser engine'))}\n`);
  for (const t of d.tabs) console.log(`  ${pad(t.id, 12)} ${t.active ? C.green('●') : ' '} ${truncate(t.title || t.url, 70)}`);
  console.log(C.dim('\n  capture one with:  node server/cli.js capture --tab=<id>\n'));
}

async function cmdCapture(flags) {
  await ensureServer();
  const tabId = Number(flags.tab);
  if (!Number.isInteger(tabId)) {
    console.log(C.yellow('⚠️  pass a tab id: ') + C.cyan('node server/cli.js capture --tab=<id>'));
    const t = await apiFetch('/api/browsy/tabs', {}, 60000).catch(() => null);
    for (const tab of t?.tabs || []) console.log(`  ${pad(tab.id, 12)} ${truncate(tab.title || tab.url, 60)}`);
    return;
  }
  const d = await apiFetch('/api/browsy/capture', { method: 'POST', body: JSON.stringify({ tabId }) }, 60000);
  console.log(`\n${C.green('✓')} captured tab ${tabId} → capture #${d.captureId}  ${C.dim(d.pageTitle || '')}`);
  console.log(`  ${C.dim(d.url || '')}\n`);
  printExtraction(d.extraction);
  console.log(C.dim(`\n  review + import:  node server/cli.js import-capture ${d.captureId}\n`));
}

function printExtraction(x) {
  if (!x) return;
  const rows = [['title', x.title], ['company', x.company], ['location', x.location], ['type', x.type], ['salary', x.salary], ['deadline', x.deadline]];
  for (const [k, v] of rows) if (v) console.log(`  ${pad(k, 10)} ${v}`);
  if (x.warnings?.length) console.log(C.yellow('  warnings   ' + x.warnings.join('; ')));
}

async function cmdCaptures() {
  await ensureServer();
  const d = await apiFetch('/api/captures');
  if (!d.captures?.length) { console.log(C.dim('\n  no captures yet — use "capture --tab=<id>"\n')); return; }
  console.log(`\n${C.bold(d.captures.length + ' capture(s)')}\n`);
  for (const c of d.captures) {
    console.log(`  ${pad(c.id, 6)} ${pad(c.job_id ? 'linked#' + c.job_id : 'unlinked', 12)} ${pad(ago(c.captured_at || c.created_at), 5)} ${truncate(c.title || c.source_url, 60)}`);
  }
  console.log('');
}

async function cmdImportCapture(id, flags) {
  await ensureServer();
  if (!id) return console.log(C.yellow('⚠️  pass a capture id'));
  const overrides = {};
  if (flags.title) overrides.title = flags.title;
  if (flags.company) overrides.company = flags.company;
  if (flags.location) overrides.location = flags.location;
  const d = await apiFetch('/api/captures/import', { method: 'POST', body: JSON.stringify({ captureId: Number(id), overrides }) }, 60000);
  const j = d.job;
  console.log(`\n${C.green('✓')} imported capture #${id} → job #${d.id}  ${C.dim(j?.title || '')}`);
  if (j) console.log(`  ${j.company || '—'} · ${j.location || '—'} · eligibility ${C.bold(j.eligibility?.bucket || '?')}`);
  console.log(C.dim(`\n  open the drawer in the dashboard to link a company/contact.\n`));
}

async function cmdExport(what, flags) {
  await ensureServer();
  const kind = what || 'jobs';
  const format = flags.format || 'csv';
  const map = {
    jobs: `/api/export/jobs.${format}`,
    pipeline: `/api/export/pipeline.${format}`,
    companies: '/api/export/companies.csv',
    contacts: '/api/export/contacts.csv',
  };
  const pathname = map[kind];
  if (!pathname) return console.log(C.yellow(`⚠️  unknown export "${kind}" — use jobs, pipeline, companies, contacts`));
  const res = await fetch(BASE() + pathname);
  if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = flags.out || path.join(ROOT_DIR, `jobpilot-${kind}-${new Date().toISOString().slice(0, 10)}.${format}`);
  fs.writeFileSync(out, buf);
  console.log(`${C.green('✓')} wrote ${out} ${C.dim(`(${buf.length} bytes)`)}`);
  if (flags.print) console.log('\n' + buf.toString('utf8'));
}

async function cmdCriteria(flags) {
  await ensureServer();
  if (flags.file) {
    const raw = fs.readFileSync(flags.file.replace(/^~(?=$|\/)/, process.env.HOME || ''), 'utf8');
    let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('criteria file must be valid JSON'); }
    const d = await apiFetch('/api/criteria', { method: 'POST', body: JSON.stringify({ criteria: parsed }) });
    console.log(`${C.green('✓')} criteria updated from ${flags.file}`);
    printCriteria(d.criteria);
    return;
  }
  const d = await apiFetch('/api/criteria');
  console.log(`\n${C.bold('candidate criteria')} ${C.dim('(editable, stored separately from config.json)')}`);
  printCriteria(d.criteria);
  console.log(C.dim(`\n  update:  node server/cli.js criteria --file=criteria.json\n`));
}

function printCriteria(c) {
  if (!c) return;
  console.log(`  ${pad('cities', 16)} ${(c.cities || []).join(' > ') || '—'}`);
  console.log(`  ${pad('roles', 16)} ${(c.roleFamilies || []).join(', ') || '—'}`);
  console.log(`  ${pad('types', 16)} ${(c.preferredTypes || []).join(', ') || '—'}`);
  console.log(`  ${pad('employers', 16)} ${(c.employerPreference || []).join(' > ') || '—'}`);
  console.log(`  ${pad('grad year', 16)} ${c.candidate?.graduationYear ?? '—'} ${C.dim(c.candidate?.status ? '(' + c.candidate.status + ')' : '')}`);
}

async function cmdPipeline() {
  await ensureServer();
  const d = await apiFetch('/api/pipeline');
  if (!d.rows?.length) { console.log(C.dim('\n  pipeline is empty — link a job to a company/contact first\n')); return; }
  console.log(`\n${C.bold(d.rows.length + ' pipeline item(s)')}\n`);
  console.log(C.dim(pad('#', 6) + pad('JOB', 7) + pad('COMPANY', 22) + pad('STATUS', 12) + pad('NEXT', 22) + 'DATE'));
  for (const p of d.rows) {
    console.log(
      pad(p.id, 6) + pad(p.job_id || '—', 7) +
      pad(truncate(p.job?.company || p.company?.name || '—', 20), 22) +
      pad(p.status || '—', 12) +
      pad(truncate(p.next_action || '—', 20), 22) +
      (p.next_action_date || '—')
    );
  }
  console.log('');
}

async function cmdBrief(id) {
  await ensureServer();
  if (!id) return console.log(C.yellow('⚠️  pass a job id'));
  const res = await fetch(BASE() + `/api/jobs/${id}/brief.md`);
  if (!res.ok) throw new Error(`could not build a brief for job ${id}`);
  const md = await res.text();
  const file = path.join(ROOT_DIR, `brief-job-${id}.md`);
  fs.writeFileSync(file, md);
  console.log(md);
  console.log(C.dim(`\n(saved to ${file})`));
}

async function cmdResearch() {
  await ensureServer();
  const d = await apiFetch('/api/research/runs');
  if (!d.runs?.length) { console.log(C.dim('\n  no research runs yet — create one in the dashboard Research section\n')); return; }
  console.log(`\n${C.bold(d.runs.length + ' research run(s)')}\n`);
  for (const r of d.runs) {
    console.log(`  ${pad(r.id, 6)} ${pad(r.status, 12)} ${pad(ago(r.created_at), 5)} ${truncate(r.title || r.query || '—', 60)}`);
  }
  console.log('');
}

// ---------------------------------------------------------------- main

const HELP = `
${C.bold('Job Pilot')} — local job-search cockpit ${C.dim('(Clinqy × Browsy engine)')}

  ${C.bold('setup')}                      first-run wizard → writes config.json
  ${C.bold('serve')}                      start server + dashboard (http://127.0.0.1:${PORT()})
  ${C.bold('mcp')} [--stdio]              run Job Pilot as an MCP server (stdio) / print setup

  ${C.bold('scan')} [--sources=boards,hn,reddit]   server-side scan (job boards, HN, reddit RSS)
                                        --sources also takes single names: greenhouse, lever, ashby, remoteok
  ${C.bold('scan-x')} [--queries="a|b|c"]           X scan through your logged-in Chrome (extension)
  ${C.bold('scan-reddit')} [--subs=a,b]             reddit scan through your session (extension)

  ${C.bold('list')} [--min-score=55] [--status=new] [--source=greenhouse] [--q=backend] [--remote] [--limit=25] [--json]
  ${C.bold('show')} <id>                  full description + why it scored
  ${C.bold('save|skip|applied|archive')} <id>
  ${C.bold('apply')} <id> [--packet]      queue autofill in Chrome (or print copy-paste packet)
  ${C.bold('open')} <id>                  open the posting in your browser
  ${C.bold('digest')} [--open]            markdown digest of the best new jobs
  ${C.bold('rescore')}                    re-score every job after editing targets in config.json
  ${C.bold('stats')}                      counts, sources, extension status

  ${C.bold('connections')} [--refresh]    browser engine + Browsy + Clinqy availability and tools
  ${C.bold('tabs')}                       list open browser tabs (read-only)
  ${C.bold('capture')} --tab=<id>         snapshot a tab → editable capture (no submit)
  ${C.bold('captures')}                   list saved captures
  ${C.bold('import-capture')} <id> [--title= --company= --location=]
  ${C.bold('pipeline')}                   list linked pipeline items
  ${C.bold('brief')} <id>                 write a per-job markdown brief
  ${C.bold('research')}                   list research runs + steps
  ${C.bold('criteria')} [--file=f.json]   show or update candidate criteria
  ${C.bold('export')} [jobs|pipeline|companies|contacts] [--format=csv|json] [--out=path] [--print]
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift() || (flags.help ? 'help' : '');

  try {
    switch (cmd) {
      case 'setup': return await cmdSetup();
      case 'serve': return await cmdServe();
      case 'mcp': return await cmdMcp(flags);
      case 'scan': return await cmdScan(flags);
      case 'scan-x': return await cmdExtScan('x', flags);
      case 'scan-reddit': return await cmdExtScan('reddit', flags);
      case 'list': return await cmdList(flags);
      case 'show': return await cmdShow(positional[0]);
      case 'save': case 'skip': case 'applied': case 'archive':
        return await cmdSetStatus(positional[0], cmd);
      case 'apply': return await cmdApply(positional[0], flags);
      case 'open': return await cmdOpen(positional[0]);
      case 'digest': return await cmdDigest(flags);
      case 'rescore': return await cmdRescore();
      case 'stats': return await cmdStats();
      case 'connections': case 'adapters': return await cmdConnections(flags);
      case 'tabs': return await cmdTabs();
      case 'capture': return await cmdCapture(flags);
      case 'captures': return await cmdCaptures();
      case 'import-capture': return await cmdImportCapture(positional[0], flags);
      case 'pipeline': return await cmdPipeline();
      case 'brief': return await cmdBrief(positional[0]);
      case 'research': return await cmdResearch();
      case 'criteria': return await cmdCriteria(flags);
      case 'export': return await cmdExport(positional[0], flags);
      default:
        console.log(HELP);
    }
  } catch (err) {
    console.error(C.red('✗ ' + err.message));
    process.exitCode = 1;
  }
}

main();
