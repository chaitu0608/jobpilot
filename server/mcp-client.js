/**
 * Minimal, bounded MCP stdio client for talking to the REAL Browsy and Clinqy
 * local servers. No shell, no arbitrary commands — a fixed executable + fixed
 * args are supplied by the adapters.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout (what both Browsy
 * and Clinqy implement). See docs/capabilities.md.
 *
 * Safety properties:
 *  - spawn() only, never a shell string; the executable and args are fixed by
 *    the adapter (allow-listed), never taken from a request.
 *  - every request has a hard timeout; a timeout rejects and marks the outcome
 *    "unknown" so callers can require fresh inspection before repeating.
 *  - stderr is captured, truncated and redacted before it is surfaced.
 *  - close()/kill tears the child process down; the process is never detached.
 */

import { spawn } from 'node:child_process';

const SECRET_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /((?:token|secret|password|passwd|apikey|api[_-]?key|authorization|cookie|session)\s*[:=]\s*)\S+/gi,
  /(clinqy:\/\/[^\s]*[?&](?:token|key)=)[^\s&]+/gi,
];

export function redact(s, max = 600) {
  let out = String(s == null ? '' : s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '$1[redacted]');
  // never echo a long base64/data blob
  out = out.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '[blob]');
  return out.slice(0, max);
}

export class McpError extends Error {
  constructor(message, { code = null, unknownOutcome = false } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.unknownOutcome = unknownOutcome;
  }
}

export class McpStdioClient {
  /**
   * @param {object} o
   * @param {string} o.name           human label ("browsy", "clinqy")
   * @param {string} o.command        absolute executable
   * @param {string[]} [o.args]       fixed args (never interpolated)
   * @param {string} [o.cwd]
   * @param {object} [o.env]          extra env (merged over process.env)
   * @param {number} [o.requestTimeoutMs]
   * @param {string} [o.protocolVersion]
   */
  constructor({ name, command, args = [], cwd, env, requestTimeoutMs = 45000, protocolVersion = '2025-06-18' }) {
    this.name = name || 'mcp';
    this.command = command;
    this.args = args.map(String);
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.protocolVersion = protocolVersion;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.serverInfo = null;
    this.capabilities = null;
    this.tools = null;
    this._stderr = '';
    this._ready = null;
    this._closed = false;
    this.lastError = null;
    this.startedAt = null;
  }

  get alive() { return Boolean(this.child && !this.child.killed && this.child.exitCode == null); }

  _spawn() {
    if (this.alive) return;
    this._closed = false;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.startedAt = Date.now();
    this.child.on('error', (err) => {
      this.lastError = `spawn failed: ${err.code || err.message}`;
      this._failAll(new McpError(this.lastError));
    });
    this.child.on('exit', (code, signal) => {
      this.lastError = `process exited (code=${code}${signal ? ', signal=' + signal : ''})`;
      this._failAll(new McpError(`MCP server "${this.name}" exited (${code ?? signal})`, { unknownOutcome: true }));
      this.child = null;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this._stderr = redact((this._stderr + chunk).slice(-4000), 1200);
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    // newline-delimited framing; guard against a runaway buffer.
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (Array.isArray(msg)) { for (const m of msg) this._dispatch(m); continue; }
      this._dispatch(msg);
    }
    if (this.buf.length > 8 * 1024 * 1024) this.buf = '';
  }

  _dispatch(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) return reject(new McpError(`${this.name} ${method}: ${redact(msg.error.message || 'error')}`, { code: msg.error.code }));
      return resolve(msg.result);
    }
    // server→client notifications (tools/list_changed etc.) are ignored.
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _write(obj) {
    if (!this.child || !this.child.stdin.writable) throw new McpError(`MCP server "${this.name}" is not running`);
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs } = {}) {
    this._spawn();
    const id = ++this.seq;
    const t = timeoutMs || this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${this.name} ${method} timed out after ${t}ms`, { unknownOutcome: true }));
      }, t);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._write({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  notify(method, params = {}) {
    try { this._write({ jsonrpc: '2.0', method, params }); } catch { /* not running */ }
  }

  /** Start + handshake (idempotent). */
  async start() {
    if (this.serverInfo) return this;
    if (this._ready) return this._ready;
    this._ready = (async () => {
      this._spawn();
      const res = await this.request('initialize', {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'jobpilot', version: '0.2.0' },
      }, { timeoutMs: Math.min(this.requestTimeoutMs, 20000) });
      this.serverInfo = res && res.serverInfo ? res.serverInfo : { name: this.name };
      this.capabilities = (res && res.capabilities) || {};
      this.notify('notifications/initialized', {});
      return this;
    })().catch((e) => { this._ready = null; throw e; });
    return this._ready;
  }

  /** tools/list, cached. */
  async listTools({ refresh = false } = {}) {
    if (this.tools && !refresh) return this.tools;
    await this.start();
    const res = await this.request('tools/list', {});
    this.tools = (res && res.tools) || [];
    return this.tools;
  }

  /** tools/call. Returns { ok, text, images, raw, isError, unknownOutcome }. */
  async callTool(name, args = {}, { timeoutMs } = {}) {
    await this.start();
    let res;
    try {
      res = await this.request('tools/call', { name, arguments: args }, { timeoutMs });
    } catch (e) {
      if (e.unknownOutcome) return { ok: false, unknownOutcome: true, error: e.message };
      throw e;
    }
    const content = (res && res.content) || [];
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    const images = content.filter((c) => c && c.type === 'image').map((c) => ({ mimeType: c.mimeType, data: c.data }));
    return { ok: !(res && res.isError), isError: Boolean(res && res.isError), text, images, raw: res, unknownOutcome: false };
  }

  /** Ask the server to cancel an in-flight request (Clinqy supports this). */
  cancel(id) { this.notify('notifications/cancelled', { requestId: id }); }

  close() {
    this._closed = true;
    try { if (this.child) { this.child.stdin.end(); this.child.kill('SIGTERM'); } } catch { /* ignore */ }
    const c = this.child;
    if (c) setTimeout(() => { try { if (c.exitCode == null) c.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref?.();
    this.child = null;
    this.serverInfo = null;
    this.tools = null;
    this._ready = null;
    this._failAll(new McpError(`MCP client "${this.name}" closed`));
  }

  status() {
    return {
      name: this.name,
      command: this.command,
      args: this.args,
      alive: this.alive,
      ready: Boolean(this.serverInfo),
      serverInfo: this.serverInfo,
      toolCount: this.tools ? this.tools.length : null,
      stderr: this._stderr ? redact(this._stderr) : null,
      lastError: this.lastError,
    };
  }
}
