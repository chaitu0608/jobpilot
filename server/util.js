import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/** Strip HTML tags/entities and normalize whitespace. */
export function cleanText(s, maxLen = 20000) {
  if (!s) return '';
  let t = String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/â€™/g, '’')
    .replace(/â€˜/g, '‘')
    .replace(/â€œ/g, '“')
    .replace(/â€\u009d|â€/g, '”')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—')
    .replace(/â€¦/g, '…')
    .replace(/â€¢/g, '•')
    .replace(/Â (?=[a-z])|Â(?=[,.!;:])/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Legacy encodings: "QuÃ©" → "Qué" (only when cleanly reversible) and
  // RemoteOK's lossy "Weâre" → "We’re".
  t = demojibake(t).replace(/([A-Za-z])â(?=[a-z])/g, '$1’');
  if (t.length > maxLen) t = t.slice(0, maxLen) + '…';
  return t;
}

function demojibake(s) {
  // Trigger on 'Ã' (classic UTF-8→latin1) or C1 control chars (U+0080–U+009F),
  // which only appear when UTF-8 bytes were decoded as Latin-1 ("Weâ\x80\x99re").
  if (!/Ã|[\u0080-\u009f]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD')) return fixed;
  } catch {
    /* ignore */
  }
  return s;
}

export const stripEmoji = (s) =>
  String(s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\uFE0F/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function daysSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

export function humanizeToken(t) {
  return String(t || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function safeParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Polite JSON fetch with timeout + one retry. */
export async function fetchJson(url, { timeoutMs = 15000, headers = {}, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent':
            'jobpilot/0.1 (personal job search tool; local use)',
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function spawnLines(out) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) out(l.trim());
  };
}
