/**
 * Real local adapters for Browsy and Clinqy.
 *
 * Both are wired to their ACTUAL installed local MCP servers over stdio. There
 * is no fake/pretend "online" state: capability discovery really spawns the
 * server and reads its tools/list. If the executable or the native bridge is not
 * present, the adapter reports "disconnected" with the real reason.
 *
 * Nothing here executes a shell, interpolates user input into a command, or
 * runs arbitrary code. Executables and arguments are fixed; URLs are validated
 * http/https; every argument is validated against the real tool schemas below.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpStdioClient, McpError, redact } from './mcp-client.js';

/* ------------------------------------------------------------------ resolvers */

function findInPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}
function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

const BROWSY_HOME = process.env.JOBPILOT_BROWSY_HOME || path.join(os.homedir(), '.agent-native');

function resolveBrowsy() {
  const override = process.env.JOBPILOT_BROWSY_CLI;
  const candidates = [];
  if (override) candidates.push(override);
  const bin = findInPath('browsy');
  if (bin) candidates.push(realpath(bin));
  const agentNative = findInPath('agent-native');
  if (agentNative) candidates.push(realpath(agentNative));
  const cli = candidates.find((c) => c && fs.existsSync(c));
  if (!cli) return null;
  return { command: process.execPath, args: [cli, 'mcp', '--home', BROWSY_HOME], cli };
}

const CLINQY_BIN = process.env.JOBPILOT_CLINQY_BIN || '/Applications/Clinqy.app/Contents/MacOS/Clinqy';
function resolveClinqy() {
  if (!fs.existsSync(CLINQY_BIN)) return null;
  return { command: CLINQY_BIN, args: ['mcp'], cli: CLINQY_BIN };
}

/* ------------------------------------------------------------------ schemas */

const T_STR = (o = {}) => ({ type: 'string', ...o });
const T_INT = (o = {}) => ({ type: 'int', ...o });
const T_NUM = (o = {}) => ({ type: 'number', ...o });
const T_BOOL = (o = {}) => ({ type: 'bool', ...o });
const T_URL = (o = {}) => ({ type: 'url', ...o });
const tabId = () => T_INT({ required: true, min: 0 });

/** Browsy — the complete 17-tool inventory, validated against the real schema. */
export const BROWSY_TOOLS = {
  browser_list_tabs: { mutating: false, readOnly: true, params: {} },
  browser_open_tab: { mutating: true, readOnly: false, params: { url: T_URL({ required: true, max: 8192 }) }, urlParams: ['url'] },
  browser_focus_tab: { mutating: true, params: { tabId: tabId() } },
  browser_close_tab: { mutating: true, params: { tabId: tabId() } },
  browser_snapshot: { mutating: false, readOnly: true, params: { tabId: tabId() } },
  browser_get_html: { mutating: false, readOnly: true, params: { tabId: tabId(), selector: T_STR({ max: 2000 }), maxLength: T_INT({ min: 1, max: 2000000 }) } },
  browser_screenshot: { mutating: false, readOnly: true, params: { tabId: tabId() } },
  browser_click: {
    mutating: true, params: { tabId: tabId(), ref: T_STR({ max: 100 }), x: T_NUM({ min: 0 }), y: T_NUM({ min: 0 }) },
    validate: (a) => {
      const hasRef = a.ref != null;
      const hasXY = a.x != null && a.y != null;
      if (hasRef && hasXY) return 'browser_click takes either ref or x+y, never both';
      if (!hasRef && !hasXY) return 'browser_click needs ref, or both x and y';
      if (a.x != null && a.y == null) return 'browser_click needs both x and y';
      return null;
    },
  },
  browser_type: { mutating: true, params: { tabId: tabId(), ref: T_STR({ max: 100 }), text: T_STR({ required: true, max: 100000 }), replaceExisting: T_BOOL() }, secretParams: ['text'] },
  browser_press_key: { mutating: true, params: { tabId: tabId(), key: T_STR({ required: true, max: 100 }) } },
  browser_scroll: { mutating: true, params: { tabId: tabId(), direction: { type: 'enum', values: ['up', 'down', 'left', 'right'], required: true }, amount: T_INT({ min: 1, max: 10000 }) } },
  browser_navigate: { mutating: true, params: { tabId: tabId(), url: T_URL({ required: true, max: 8192 }) }, urlParams: ['url'] },
  browser_back: { mutating: true, params: { tabId: tabId() } },
  browser_forward: { mutating: true, params: { tabId: tabId() } },
  browser_reload: { mutating: true, params: { tabId: tabId() } },
  browser_wait: { mutating: false, readOnly: true, params: { tabId: tabId(), milliseconds: T_INT({ min: 0, max: 10000 }) } },
  browser_release: { mutating: true, params: { tabId: tabId() } },
};

/** Clinqy — the complete 3-tool inventory. */
export const CLINQY_TOOLS = {
  clinqy_look: { readOnly: true, params: { mode: { type: 'enum', values: ['page', 'read', 'url'] } } },
  clinqy_stats: { readOnly: true, params: { days: T_NUM({ min: 0, max: 365 }), last: T_BOOL() } },
  clinqy_run: { readOnly: false, params: { task: T_STR({ required: true, max: 4000 }), dry: T_BOOL(), timeout: T_INT({ min: 1, max: 900 }) } },
};

/** Validate + normalise arguments against a known schema. Returns {ok, errors, args}. */
export function validateArgs(spec, input) {
  const args = {};
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const [name, def] of Object.entries(spec.params || {})) {
    let v = src[name];
    if (v === undefined || v === null || v === '') {
      if (def.required) errors.push(`missing required argument "${name}"`);
      continue;
    }
    switch (def.type) {
      case 'string': case 'url': {
        if (typeof v !== 'string') { errors.push(`"${name}" must be a string`); break; }
        if (def.max && v.length > def.max) { errors.push(`"${name}" exceeds ${def.max} characters`); break; }
        if (def.type === 'url') {
          let u; try { u = new URL(v); } catch { errors.push(`"${name}" is not a valid URL`); break; }
          if (!/^https?:$/i.test(u.protocol)) { errors.push(`"${name}" must be an http(s) URL`); break; }
        }
        args[name] = v;
        break;
      }
      case 'int': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isInteger(n)) { errors.push(`"${name}" must be an integer`); break; }
        if (def.min != null && n < def.min) { errors.push(`"${name}" must be >= ${def.min}`); break; }
        if (def.max != null && n > def.max) { errors.push(`"${name}" must be <= ${def.max}`); break; }
        args[name] = n;
        break;
      }
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) { errors.push(`"${name}" must be a number`); break; }
        if (def.min != null && n < def.min) { errors.push(`"${name}" must be >= ${def.min}`); break; }
        if (def.max != null && n > def.max) { errors.push(`"${name}" must be <= ${def.max}`); break; }
        args[name] = n;
        break;
      }
      case 'bool': {
        if (typeof v !== 'boolean') { errors.push(`"${name}" must be a boolean`); break; }
        args[name] = v;
        break;
      }
      case 'enum': {
        if (!def.values.includes(String(v))) { errors.push(`"${name}" must be one of ${def.values.join(', ')}`); break; }
        args[name] = String(v);
        break;
      }
      default: errors.push(`"${name}" has an unknown type`);
    }
  }
  // reject unknown keys (the real servers are strict too)
  for (const k of Object.keys(src)) if (!(spec.params || {})[k]) errors.push(`unknown argument "${k}"`);
  if (!errors.length && typeof spec.validate === 'function') {
    const msg = spec.validate(args);
    if (msg) errors.push(msg);
  }
  return { ok: errors.length === 0, errors, args };
}

/** Everything the audit log is allowed to keep: never secret field contents. */
export function auditArgs(tool, spec, args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if ((spec.secretParams || []).includes(k)) { out[k] = `[${String(v).length} chars]`; continue; }
    out[k] = typeof v === 'string' && v.length > 160 ? redact(v, 160) : v;
  }
  return out;
}

/* ------------------------------------------------------------------ adapters */

class Adapter {
  constructor({ name, label, resolve }) {
    this.name = name; // 'browsy' | 'clinqy'
    this.label = label;
    this.resolve = resolve;
    this.client = null;
    this.tools = null;
    this.discoveredAt = 0;
    this.discoveryError = null;
    this._lastUnknownTab = new Set();   // tabIds whose mutating outcome is unknown
    this._lastUnknownGlobal = false;    // a non-tab mutating call with unknown outcome
  }

  resolved() { try { return this.resolve(); } catch { return null; } }

  _client() {
    if (this.client && this.client.alive) return this.client;
    const r = this.resolved();
    if (!r) throw new McpError(`${this.label} executable not found`);
    this.client = new McpStdioClient({
      name: this.name,
      command: r.command,
      args: r.args,
      requestTimeoutMs: this.name === 'clinqy' ? 300000 : 60000,
    });
    this.client.cliPath = r.cli;
    return this.client;
  }

  /** Connect + read tools/list. Cached for `ttlMs` unless refresh. */
  async discover({ refresh = false, ttlMs = 45000 } = {}) {
    const r = this.resolved();
    if (!r) { this.discoveryError = `${this.label} executable not found`; this.tools = null; return { available: false, error: this.discoveryError }; }
    if (!refresh && this.tools && Date.now() - this.discoveredAt < ttlMs) {
      return { available: true, tools: this.tools, serverInfo: this.client ? this.client.serverInfo : null };
    }
    try {
      const c = this._client();
      await c.start();
      this.tools = await c.listTools({ refresh: true });
      this.discoveredAt = Date.now();
      this.discoveryError = null;
      return { available: true, tools: this.tools, serverInfo: c.serverInfo };
    } catch (e) {
      this.discoveryError = redact(e.message, 240);
      this.tools = null;
      return { available: false, error: this.discoveryError };
    }
  }

  status() {
    const r = this.resolved();
    const tools = this.tools ? this.tools.map((t) => t.name) : null;
    return {
      name: this.name,
      label: this.label,
      kind: 'local-mcp',
      transport: 'stdio',
      executable: r ? r.cli : null,
      available: Boolean(r),
      connected: Boolean(this.client && this.client.alive && this.client.serverInfo),
      serverInfo: this.client ? this.client.serverInfo : null,
      discovered: Boolean(this.tools),
      toolCount: tools ? tools.length : 0,
      tools: tools || [],
      error: this.discoveryError || (r ? null : `${this.label} executable not found`),
      stderr: this.client ? (this.client.status().stderr || null) : null,
    };
  }

  async callRaw(tool, args, { timeoutMs } = {}) {
    const c = this._client();
    await c.start();
    return c.callTool(tool, args, { timeoutMs });
  }

  close() { if (this.client) { this.client.close(); this.client = null; } this.tools = null; this.discoveredAt = 0; }
}

/* ------------------------------------------------------ Browsy adapter (17) */

export class BrowsyAdapter extends Adapter {
  constructor({ onAudit } = {}) {
    super({ name: 'browsy', label: 'Browsy', resolve: resolveBrowsy });
    this.onAudit = onAudit || (() => {});
    this.lastTabs = null;
  }

  _audit(entry) { try { this.onAudit({ adapter: 'browsy', ...entry }); } catch { /* ignore */ } }

  /** Show the exact mutation preview without executing it. */
  preview(tool, input) {
    const spec = BROWSY_TOOLS[tool];
    if (!spec) return { ok: false, errors: [`unknown tool "${tool}"`] };
    const v = validateArgs(spec, input);
    if (!v.ok) return { ok: false, errors: v.errors };
    return {
      ok: true,
      tool,
      mutating: spec.mutating,
      arguments: auditArgs(tool, spec, v.args),
      summary: describeBrowsyAction(tool, v.args),
    };
  }

  /**
   * Execute a Browsy tool. Read-only tools run directly; mutating tools need
   * `confirmed:true`. A tab whose previous mutating call had an unknown outcome
   * must be freshly inspected (snapshot/get_html/list_tabs) before it can be
   * mutated again.
   */
  async call(tool, input, { confirmed = false, timeoutMs } = {}) {
    const spec = BROWSY_TOOLS[tool];
    if (!spec) { this._audit({ tool, outcome: 'rejected', reason: 'unknown tool' }); throw new McpError(`unknown Browsy tool "${tool}"`); }
    const v = validateArgs(spec, input);
    if (!v.ok) { this._audit({ tool, outcome: 'rejected', reason: v.errors.join('; '), args: auditArgs(tool, spec, input || {}) }); throw new McpError(`invalid arguments: ${v.errors.join('; ')}`); }

    if (spec.mutating) {
      if (!confirmed) throw new McpError(`"${tool}" changes the browser — confirmation required`);
      const tabId = v.args.tabId;
      if (tabId != null && this._lastUnknownTab.has(tabId)) {
        throw new McpError(`tab ${tabId} had an unknown outcome — inspect it again (snapshot) before acting`);
      }
      if (tabId == null && this._lastUnknownGlobal) {
        throw new McpError('a previous browser action had an unknown outcome — list tabs again before acting');
      }
    }

    let res;
    try {
      res = await this.callRaw(tool, v.args, { timeoutMs });
    } catch (e) {
      const unknown = Boolean(e.unknownOutcome);
      if (unknown) {
        if (v.args.tabId != null) this._lastUnknownTab.add(v.args.tabId); else this._lastUnknownGlobal = true;
      }
      this._audit({ tool, outcome: unknown ? 'unknown' : 'error', reason: redact(e.message, 200), args: auditArgs(tool, spec, v.args), tabId: v.args.tabId ?? null });
      throw e;
    }

    // Fresh inspection clears the "unknown" latch for the inspected tab.
    if (!spec.mutating && (tool === 'browser_snapshot' || tool === 'browser_get_html')) {
      if (v.args.tabId != null) this._lastUnknownTab.delete(v.args.tabId);
    }
    if (tool === 'browser_list_tabs') this._lastUnknownGlobal = false;

    if (res.unknownOutcome) {
      if (v.args.tabId != null) this._lastUnknownTab.add(v.args.tabId); else this._lastUnknownGlobal = true;
      this._audit({ tool, outcome: 'unknown', args: auditArgs(tool, spec, v.args), tabId: v.args.tabId ?? null });
      return { ...res, preview: this.preview(tool, v.args) };
    }

    this._audit({
      tool, outcome: res.ok ? 'ok' : 'error', isError: res.isError,
      args: auditArgs(tool, spec, v.args), tabId: v.args.tabId ?? null,
      resultSummary: summarizeBrowsyResult(tool, res),
    });

    if (tool === 'browser_list_tabs') this.lastTabs = parseTabs(res.text);
    return { ...res, parsed: parseBrowsyResult(tool, res) };
  }

  needsInspection(tabId) { return tabId == null ? this._lastUnknownGlobal : this._lastUnknownTab.has(tabId); }

  async listTabs() { return this.call('browser_list_tabs', {}, {}); }
  async snapshot(tabId) { return this.call('browser_snapshot', { tabId }, {}); }
  async screenshot(tabId) { return this.call('browser_screenshot', { tabId }, {}); }
  async navigate(tabId, url, opts) { return this.call('browser_navigate', { tabId, url }, opts); }
  async openTab(url, opts) { return this.call('browser_open_tab', { url }, opts); }
}

function parseTabs(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}
function parseBrowsyResult(tool, res) {
  if (tool === 'browser_list_tabs' || tool === 'browser_open_tab' || tool === 'browser_get_html') {
    try { return JSON.parse(res.text); } catch { return { text: res.text.slice(0, 2000) }; }
  }
  if (tool === 'browser_snapshot') {
    const nl = res.text.indexOf('\n');
    const header = nl > 0 ? res.text.slice(0, nl) : '';
    let meta = null; try { meta = JSON.parse(header); } catch { meta = null; }
    return { meta, snapshot: nl > 0 ? res.text.slice(nl + 1) : res.text };
  }
  return { text: res.text.slice(0, 4000) };
}
function describeBrowsyAction(tool, args) {
  const map = {
    browser_open_tab: `Open a new tab at ${args.url}`,
    browser_focus_tab: `Focus tab ${args.tabId}`,
    browser_close_tab: `Close tab ${args.tabId}`,
    browser_click: args.ref ? `Click element ${args.ref} in tab ${args.tabId}` : `Click at (${args.x}, ${args.y}) in tab ${args.tabId}`,
    browser_type: `Type ${String(args.text || '').length} characters ${args.ref ? 'into ' + args.ref : 'at the caret'} in tab ${args.tabId}`,
    browser_press_key: `Press ${args.key} in tab ${args.tabId}`,
    browser_scroll: `Scroll ${args.direction} ${args.amount || 600}px in tab ${args.tabId}`,
    browser_navigate: `Navigate tab ${args.tabId} to ${args.url}`,
    browser_back: `Go back in tab ${args.tabId}`,
    browser_forward: `Go forward in tab ${args.tabId}`,
    browser_reload: `Reload tab ${args.tabId}`,
    browser_release: `Release tab ${args.tabId} (detach debugger, expire refs)`,
  };
  return map[tool] || tool;
}
function summarizeBrowsyResult(tool, res) {
  if (!res.ok) return 'error';
  if (tool === 'browser_list_tabs') { const t = parseTabs(res.text); return `${t.length} tabs`; }
  if (tool === 'browser_screenshot') return `${res.images.length} image`;
  return redact(res.text || 'ok', 160);
}

/* ------------------------------------------------------ Clinqy adapter (3) */

export class ClinqyAdapter extends Adapter {
  constructor({ onAudit } = {}) {
    super({ name: 'clinqy', label: 'Clinqy', resolve: resolveClinqy });
    this.onAudit = onAudit || (() => {});
    this.running = null; // { id, task, startedAt }
  }
  _audit(entry) { try { this.onAudit({ adapter: 'clinqy', ...entry }); } catch { /* ignore */ } }

  preview(tool, input) {
    const spec = CLINQY_TOOLS[tool];
    if (!spec) return { ok: false, errors: [`unknown tool "${tool}"`] };
    const v = validateArgs(spec, input);
    if (!v.ok) return { ok: false, errors: v.errors };
    return { ok: true, tool, readOnly: spec.readOnly, arguments: v.args, summary: describeClinqyAction(tool, v.args) };
  }

  async call(tool, input, { confirmed = false, timeoutMs } = {}) {
    const spec = CLINQY_TOOLS[tool];
    if (!spec) throw new McpError(`unknown Clinqy tool "${tool}"`);
    const v = validateArgs(spec, input);
    if (!v.ok) { this._audit({ tool, outcome: 'rejected', reason: v.errors.join('; ') }); throw new McpError(`invalid arguments: ${v.errors.join('; ')}`); }
    if (!spec.readOnly && !confirmed) throw new McpError(`"${tool}" changes your Mac — confirmation required`);
    let res;
    try {
      res = await this.callRaw(tool, v.args, { timeoutMs });
    } catch (e) {
      this._audit({ tool, outcome: e.unknownOutcome ? 'unknown' : 'error', reason: redact(e.message, 200), args: adaptClinqyArgs(tool, v.args) });
      throw e;
    }
    this._audit({ tool, outcome: res.ok ? 'ok' : 'error', args: adaptClinqyArgs(tool, v.args), dry: Boolean(v.args.dry) });
    return res;
  }

  async look(mode) { return this.call('clinqy_look', mode ? { mode } : {}, {}); }
  async stats(days, last) { const a = {}; if (days != null) a.days = days; if (last != null) a.last = last; return this.call('clinqy_stats', a, {}); }
  async run(task, { dry = false, timeoutSec = 120, confirmed = false } = {}) {
    // Bounded so a run never blocks the server forever; the app keeps going and
    // can be cancelled with notifications/cancelled (see cancelCurrent).
    const timeoutMs = (Math.min(timeoutSec, 300) + 10) * 1000;
    const c = this._client();
    await c.start();
    const id = c.seq + 1;
    this.running = { id, task, dry, startedAt: Date.now() };
    try {
      const res = await this.call('clinqy_run', { task, dry, timeout: Math.min(timeoutSec, 900) }, { confirmed, timeoutMs });
      return res;
    } finally {
      this.running = null;
    }
  }
  cancelCurrent() {
    if (!this.running || !this.client) return false;
    this.client.cancel(this.running.id);
    return true;
  }
}

function describeClinqyAction(tool, args) {
  if (tool === 'clinqy_look') return `Read the screen (mode: ${args.mode || 'page'})`;
  if (tool === 'clinqy_stats') return `Read run statistics (last ${args.days ?? 7} days${args.last ? ', most recent run' : ''})`;
  if (tool === 'clinqy_run') return `${args.dry ? 'Dry-run' : 'Run'} native task: “${String(args.task || '').slice(0, 140)}”`;
  return tool;
}
function adaptClinqyArgs(tool, args) {
  if (tool === 'clinqy_run') return { taskLength: String(args.task || '').length, dry: Boolean(args.dry), timeout: args.timeout ?? 300 };
  return args;
}

/* ------------------------------------------------------------------ registry */

export function createAdapters({ onAudit } = {}) {
  const browsy = new BrowsyAdapter({ onAudit });
  const clinqy = new ClinqyAdapter({ onAudit });
  return { browsy, clinqy };
}

/** Truthful capability map for Clinqy's native-only features. */
export function clinqyCapabilities(status) {
  const native = (tool) => ({ kind: 'native', via: tool, state: status.connected ? 'available' : 'disconnected' });
  const handoff = (scheme) => ({ kind: 'native-handoff', via: scheme, state: status.available ? 'available' : 'disconnected' });
  return [
    { id: 'look', label: 'Look at the screen', ...native('clinqy_look') },
    { id: 'stats', label: 'Run statistics', ...native('clinqy_stats') },
    { id: 'run', label: 'Run a native task', ...native('clinqy_run') },
    { id: 'voice', label: 'Voice (push-to-talk)', kind: 'native-only', via: 'Clinqy menu bar ⌃⌥', state: status.available ? 'native-app' : 'disconnected', note: 'No MCP tool — open the Clinqy app and use the command bar.' },
    { id: 'watch', label: 'Watch & learn (replay)', ...handoff('clinqy://watch'), note: 'Opens the Clinqy recorder in the native app.' },
    { id: 'workflows', label: 'Workflows / learned skills', ...handoff('clinqy://workflow'), note: 'Saved routines live in the native app.' },
    { id: 'memory', label: 'Memories', kind: 'native-only', via: 'clinqy memory / Edit Memory…', state: status.available ? 'native-app' : 'disconnected', note: 'Read via the Clinqy app; not an MCP tool.' },
    { id: 'calendar', label: 'Calendar & reminders', ...native('clinqy_run'), note: 'Reached through a native task (clinqy_run), e.g. “add a reminder”.' },
    { id: 'files', label: 'Files (search / organise)', ...native('clinqy_run'), note: 'Reached through a native task (clinqy_run).' },
    { id: 'browser-ext', label: 'Browser page context', ...native('clinqy_look'), note: 'Used by clinqy_look for browser tabs when the Clinqy extension is connected.' },
  ];
}
