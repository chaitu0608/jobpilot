import { nowIso, safeParse } from './util.js';

const waiters = new Set();

export const onWake = (fn) => {
  waiters.add(fn);
  return () => waiters.delete(fn);
};

function wake() {
  for (const w of [...waiters]) {
    try {
      w();
    } catch {
      /* ignore */
    }
  }
  waiters.clear();
}

export function getCommand(db, id) {
  const row = db.prepare('SELECT * FROM ext_commands WHERE id = ?').get(Number(id));
  return row ? { ...row, payload: safeParse(row.payload, {}), result: safeParse(row.result, null) } : null;
}

export function enqueue(db, type, payload = {}) {
  const info = db
    .prepare('INSERT INTO ext_commands (type, payload, status, created_at) VALUES (?,?,?,?)')
    .run(type, JSON.stringify(payload), 'pending', nowIso());
  wake();
  return getCommand(db, Number(info.lastInsertRowid));
}

/** Fail commands the extension never reported back on (tab closed, browser quit…). */
function reap(db) {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE ext_commands SET status='failed', finished_at=?, result=? WHERE status='dispatched' AND claimed_at < ?"
  ).run(nowIso(), JSON.stringify({ error: 'timeout — extension did not report back' }), cutoff);
}

export function claimNext(db) {
  reap(db);
  const row = db.prepare("SELECT * FROM ext_commands WHERE status='pending' ORDER BY id LIMIT 1").get();
  if (!row) return null;
  db.prepare("UPDATE ext_commands SET status='dispatched', claimed_at=? WHERE id=?").run(nowIso(), row.id);
  return { ...row, payload: safeParse(row.payload, {}) };
}

export function complete(db, id, { ok, result = null, error = null }) {
  db.prepare("UPDATE ext_commands SET status=?, finished_at=?, result=? WHERE id=?").run(
    ok ? 'done' : 'failed',
    nowIso(),
    JSON.stringify({ result, error }),
    Number(id)
  );
  return getCommand(db, id);
}

/** Wait for the extension to report back on a queued command (local polling). */
export function waitForCommand(db, id, { timeoutMs = 45000, intervalMs = 100 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let cmd;
      try { cmd = getCommand(db, id); } catch (e) { return reject(e); }
      if (!cmd) return reject(new Error('command not found'));
      if (cmd.status === 'done' || cmd.status === 'failed') return resolve(cmd);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`extension did not report back within ${Math.round(timeoutMs / 1000)}s`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function commandsState(db, limit = 8) {
  return db
    .prepare('SELECT * FROM ext_commands ORDER BY id DESC LIMIT ?')
    .all(Number(limit))
    .map((r) => ({ ...r, payload: safeParse(r.payload, {}), result: safeParse(r.result, null) }));
}

export function pendingCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM ext_commands WHERE status IN ('pending','dispatched')").get().n;
}
