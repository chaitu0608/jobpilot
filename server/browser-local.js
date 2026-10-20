/**
 * Local browser engine — Browsy's 17-tool surface, implemented by our own
 * Chrome extension instead of the external Browsy MCP server.
 *
 * The extension long-polls the local server for commands; this adapter queues
 * `browser` commands and waits for the result. Mutating tools need
 * `confirmed: true`; consequential in-page clicks (submit/pay/delete) also need
 * `approved: true` inside the arguments. Unknown outcomes latch the tab until a
 * fresh snapshot, exactly like the external adapter.
 */

import { BROWSY_TOOLS, validateArgs, auditArgs } from './adapters.js';
import { enqueue, waitForCommand } from './commands.js';
import { McpError, redact } from './mcp-client.js';

const T_STR = (o = {}) => ({ type: 'string', ...o });
const T_INT = (o = {}) => ({ type: 'int', ...o });
const T_NUM = (o = {}) => ({ type: 'number', ...o });
const T_BOOL = (o = {}) => ({ type: 'bool', ...o });
const T_URL = (o = {}) => ({ type: 'url', ...o });

/** Same inventory as Browsy, plus selector/approved/active extensions. */
export const LOCAL_BROWSER_TOOLS = {
  ...BROWSY_TOOLS,
  browser_open_tab: {
    ...BROWSY_TOOLS.browser_open_tab,
    params: { ...BROWSY_TOOLS.browser_open_tab.params, active: T_BOOL() },
  },
  browser_click: {
    ...BROWSY_TOOLS.browser_click,
    params: {
      ...BROWSY_TOOLS.browser_click.params,
      selector: T_STR({ max: 2000 }),
      approved: T_BOOL(),
    },
    validate: (a) => {
      const ways = [a.ref != null, a.selector != null, a.x != null || a.y != null].filter(Boolean).length;
      if (ways !== 1) return 'browser_click takes exactly one of ref, selector, or x+y';
      if ((a.x != null) !== (a.y != null)) return 'browser_click needs both x and y';
      return null;
    },
  },
  browser_type: {
    ...BROWSY_TOOLS.browser_type,
    params: {
      ...BROWSY_TOOLS.browser_type.params,
      selector: T_STR({ max: 2000 }),
    },
    validate: (a) => (a.ref != null && a.selector != null ? 'browser_type takes ref or selector, not both' : null),
  },
};

export class LocalBrowserAdapter {
  /**
   * @param {object} o
   * @param {import('node:sqlite').DatabaseSync} o.db
   * @param {() => boolean} [o.isConnected]
   * @param {(entry: object) => void} [o.onAudit]
   */
  constructor({ db, isConnected = () => true, onAudit = () => {} }) {
    this.db = db;
    this.isConnected = isConnected;
    this.onAudit = onAudit;
    this.lastUnknownTab = new Set();
    this.lastUnknownGlobal = false;
    this.lastTabs = null;
  }

  _audit(entry) {
    try { this.onAudit({ adapter: 'extension', ...entry }); } catch { /* ignore */ }
  }

  preview(tool, input) {
    const spec = LOCAL_BROWSER_TOOLS[tool];
    if (!spec) return { ok: false, errors: [`unknown tool "${tool}"`] };
    const v = validateArgs(spec, input);
    if (!v.ok) return { ok: false, errors: v.errors };
    return {
      ok: true,
      tool,
      mutating: Boolean(spec.mutating),
      engine: 'extension',
      arguments: auditArgs(tool, spec, v.args),
      summary: describeLocalAction(tool, v.args),
    };
  }

  async call(tool, input, { confirmed = false, timeoutMs } = {}) {
    const spec = LOCAL_BROWSER_TOOLS[tool];
    if (!spec) {
      this._audit({ tool, outcome: 'rejected', reason: 'unknown tool' });
      throw new McpError(`unknown browser tool "${tool}"`);
    }
    const v = validateArgs(spec, input);
    if (!v.ok) {
      this._audit({ tool, outcome: 'rejected', reason: v.errors.join('; '), args: auditArgs(tool, spec, input || {}) });
      throw new McpError(`invalid arguments: ${v.errors.join('; ')}`);
    }

    if (!this.isConnected()) {
      throw new McpError('browser extension offline — open Chrome with the Job Pilot extension loaded (chrome://extensions → Load unpacked → extension/), keep Chrome running');
    }

    if (spec.mutating) {
      if (!confirmed) {
        this._audit({ tool, outcome: 'rejected', reason: 'confirmation required', args: auditArgs(tool, spec, v.args) });
        throw new McpError(`"${tool}" changes the browser — confirmation required (pass confirmed=true after asking the user)`);
      }
      const tabId = v.args.tabId;
      if (tabId != null && this.lastUnknownTab.has(tabId)) {
        throw new McpError(`tab ${tabId} had an unknown outcome — take a fresh snapshot before acting again`);
      }
      if (tabId == null && this.lastUnknownGlobal) {
        throw new McpError('a previous browser action had an unknown outcome — list tabs again before acting');
      }
    }

    const cmd = enqueue(this.db, 'browser', { tool, args: v.args });
    let done;
    try {
      done = await waitForCommand(this.db, cmd.id, {
        timeoutMs: timeoutMs || (spec.mutating ? 60000 : 45000),
      });
    } catch (err) {
      if (v.args.tabId != null) this.lastUnknownTab.add(v.args.tabId);
      else this.lastUnknownGlobal = true;
      this._audit({ tool, outcome: 'unknown', reason: err.message, args: auditArgs(tool, spec, v.args), tabId: v.args.tabId ?? null });
      throw new McpError(`browser ${tool} had an unknown outcome: ${err.message}`, { unknownOutcome: true });
    }

    const payload = done.result || {};
    if (done.status === 'failed' || payload.error) {
      const msg = redact(payload.error || 'extension reported failure', 400);
      this._audit({ tool, outcome: 'error', reason: msg, args: auditArgs(tool, spec, v.args), tabId: v.args.tabId ?? null });
      throw new McpError(msg);
    }

    const result = payload.result || {};
    if (!spec.mutating && (tool === 'browser_snapshot' || tool === 'browser_get_html')) {
      if (v.args.tabId != null) this.lastUnknownTab.delete(v.args.tabId);
    }
    if (tool === 'browser_list_tabs') this.lastUnknownGlobal = false;

    const out = normalizeResult(tool, result);
    if (tool === 'browser_list_tabs') this.lastTabs = out.parsed;
    this._audit({
      tool,
      outcome: out.needsApproval ? 'needs-approval' : 'ok',
      args: auditArgs(tool, spec, v.args),
      tabId: v.args.tabId ?? null,
      resultSummary: out.images.length ? `${out.images.length} image` : redact(String(out.text || '').slice(0, 160), 160),
    });
    return { ...out, engine: 'extension', needsInspection: this.needsInspection(v.args.tabId ?? null) };
  }

  needsInspection(tabId) {
    return tabId == null ? this.lastUnknownGlobal : this.lastUnknownTab.has(tabId);
  }

  async listTabs() { return this.call('browser_list_tabs', {}, {}); }
  async snapshot(tabId) { return this.call('browser_snapshot', { tabId }, {}); }
  async screenshot(tabId) { return this.call('browser_screenshot', { tabId }, {}); }
  async navigate(tabId, url, opts) { return this.call('browser_navigate', { tabId, url }, opts); }
  async openTab(url, opts) { return this.call('browser_open_tab', { url }, opts); }
}

export function isAvailable() {
  return true; // the extension engine ships with the app; connectivity is dynamic
}

function normalizeResult(tool, result) {
  if (tool === 'browser_snapshot') {
    const meta = result.meta || {};
    const snapshot = result.snapshot || '';
    const pageText = result.pageText ? `\n\n--- visible text ---\n${result.pageText}` : '';
    return {
      ok: true,
      text: `${JSON.stringify(meta)}\n${snapshot}${pageText}`,
      parsed: { meta, snapshot, pageText: result.pageText || '' },
      images: [],
      target: null,
      needsApproval: false,
    };
  }
  if (tool === 'browser_get_html') {
    return {
      ok: true,
      text: result.html || '',
      parsed: result,
      images: [],
      target: null,
      needsApproval: false,
    };
  }
  if (tool === 'browser_screenshot') {
    const mimeType = result.mimeType || 'image/png';
    const data = String(result.data || '');
    return {
      ok: Boolean(data),
      text: data ? `Screenshot captured (${mimeType}${result.width ? `, ${result.width}x${result.height}` : ''}).` : 'Screenshot failed.',
      parsed: { mimeType, width: result.width ?? null, height: result.height ?? null },
      images: data ? [{ mimeType, data }] : [],
      target: null,
      needsApproval: false,
    };
  }
  if (tool === 'browser_list_tabs') {
    const tabs = result.tabs || [];
    return { ok: true, text: JSON.stringify(tabs), parsed: tabs, images: [], target: null, needsApproval: false };
  }
  if (tool === 'browser_open_tab') {
    return { ok: true, text: JSON.stringify(result), parsed: result, images: [], target: null, needsApproval: false };
  }
  if (result.needsApproval) {
    return {
      ok: false,
      text: result.message || 'This control needs explicit approval.',
      parsed: result,
      images: [],
      target: result.target || null,
      needsApproval: true,
    };
  }
  return {
    ok: result.ok !== false,
    text: result.message || JSON.stringify(result),
    parsed: result,
    images: [],
    target: result.target || null,
    needsApproval: false,
  };
}

function describeLocalAction(tool, args) {
  const map = {
    browser_open_tab: `Open a new tab at ${args.url}`,
    browser_focus_tab: `Focus tab ${args.tabId}`,
    browser_close_tab: `Close tab ${args.tabId}`,
    browser_click: args.ref
      ? `Click element ${args.ref} in tab ${args.tabId}`
      : args.selector
        ? `Click "${args.selector}" in tab ${args.tabId}`
        : `Click at (${args.x}, ${args.y}) in tab ${args.tabId}`,
    browser_type: `Type ${String(args.text || '').length} characters ${args.ref ? 'into ' + args.ref : args.selector ? 'into ' + args.selector : 'at the caret'} in tab ${args.tabId}`,
    browser_press_key: `Press ${args.key} in tab ${args.tabId}`,
    browser_scroll: `Scroll ${args.direction} ${args.amount || 600}px in tab ${args.tabId}`,
    browser_navigate: `Navigate tab ${args.tabId} to ${args.url}`,
    browser_back: `Go back in tab ${args.tabId}`,
    browser_forward: `Go forward in tab ${args.tabId}`,
    browser_reload: `Reload tab ${args.tabId}`,
    browser_release: `Release refs in tab ${args.tabId}`,
    browser_wait: `Wait ${args.milliseconds || 500}ms`,
  };
  return map[tool] || tool;
}
